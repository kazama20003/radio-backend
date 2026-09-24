import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { authenticateSocket } from '../common/ws/ws-auth.util';

@WebSocketGateway({ namespace: '/alerts', cors: { origin: '*' } })
export class AlertsGateway implements OnGatewayConnection {
  private readonly logger = new Logger(AlertsGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(private readonly jwt: JwtService) {}

  async handleConnection(client: Socket) {
    const user = await authenticateSocket(client, this.jwt);
    if (!user) {
      client.disconnect();
      return;
    }
    client.data.user = user;
  }

  emitNew(alert: unknown) {
    this.server.emit('alert:new', alert);
  }

  emitUpdated(alert: unknown) {
    this.server.emit('alert:updated', alert);
  }
}
