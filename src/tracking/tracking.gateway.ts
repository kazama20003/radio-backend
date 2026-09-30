import { forwardRef, Inject, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { authenticateSocket } from '../common/ws/ws-auth.util';
import { DirectionsService } from './directions.service';
import { IngestPositionDto } from './dto/tracking.dto';
import { TrackingService } from './tracking.service';

@WebSocketGateway({ namespace: '/tracking', cors: { origin: '*' } })
export class TrackingGateway implements OnGatewayConnection {
  private readonly logger = new Logger(TrackingGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwt: JwtService,
    @Inject(forwardRef(() => TrackingService))
    private readonly tracking: TrackingService,
    private readonly directions: DirectionsService,
  ) {}

  async handleConnection(client: Socket) {
    const user = await authenticateSocket(client, this.jwt);
    if (!user) {
      client.disconnect();
      return;
    }
    client.data.user = user;
    // Sala por usuario: permite expulsar las sesiones anteriores al hacer login
    // en otro dispositivo con la misma cuenta (sesión única).
    client.join(`user:${user.id}`);
  }

  /** Expulsa las sesiones (sockets) del usuario: usado al iniciar sesión en otro dispositivo. */
  revokeUserSessions(userId: string) {
    this.server.to(`user:${userId}`).emit('session:revoked');
  }

  /** El supervisor recibe las actualizaciones; el operador puede enviarlas por WS. */
  @SubscribeMessage('position:report')
  async onPositionReport(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: IngestPositionDto,
  ) {
    const position = await this.tracking.ingest(dto);
    return position;
  }

  /**
   * Un supervisor asigna una GUÍA/ruta a un usuario en línea: se calcula la ruta
   * por calle (Directions) desde la posición del usuario hasta el destino y se
   * le envía en vivo para que la vea en su mapa y pueda "Cómo llegar".
   */
  @SubscribeMessage('guide:assign')
  async onGuideAssign(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: { targetUserId: string; dest: { lat: number; lng: number; name?: string } },
  ) {
    const user = client.data.user;
    if (!user || (user.role !== 'ADMIN' && user.role !== 'SUPERVISOR')) {
      return { error: 'No autorizado.' };
    }
    if (!data?.targetUserId || !data?.dest) return { error: 'Datos incompletos.' };
    const origin = await this.tracking.userPosition(data.targetUserId);
    if (!origin) return { error: 'El usuario no tiene ubicación conocida.' };
    try {
      const route = await this.directions.getRoute(origin, data.dest);
      const guide = {
        route,
        origin,
        dest: data.dest,
        assignedBy: user.name ?? user.nickname ?? 'Supervisor',
        targetUserId: data.targetUserId,
      };
      // Al usuario objetivo: su app dibuja la ruta + botón "Cómo llegar".
      this.server.to(`user:${data.targetUserId}`).emit('guide:assigned', guide);
      // Se devuelve al que asigna para que también la dibuje en su mapa.
      return { ok: true, guide };
    } catch (e) {
      return { error: e instanceof Error ? e.message : 'Error al calcular la ruta.' };
    }
  }

  /** Quita la guía asignada a un usuario. */
  @SubscribeMessage('guide:clear')
  onGuideClear(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { targetUserId: string },
  ) {
    const user = client.data.user;
    if (!user || (user.role !== 'ADMIN' && user.role !== 'SUPERVISOR')) {
      return { error: 'No autorizado.' };
    }
    this.server.to(`user:${data.targetUserId}`).emit('guide:cleared');
    return { ok: true };
  }

  emitPosition(payload: unknown) {
    this.server.emit('position:update', payload);
  }

  emitPresence(payload: unknown) {
    this.server.emit('presence:update', payload);
  }
}
