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
  ) {}

  async handleConnection(client: Socket) {
    const user = await authenticateSocket(client, this.jwt);
    if (!user) {
      client.disconnect();
      return;
    }
    client.data.user = user;
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

  emitPosition(payload: unknown) {
    this.server.emit('position:update', payload);
  }

  emitPresence(payload: unknown) {
    this.server.emit('presence:update', payload);
  }
}
