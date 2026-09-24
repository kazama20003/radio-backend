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
import { ChatService } from './chat.service';
import { SendMessageDto } from './dto/chat.dto';

@WebSocketGateway({ namespace: '/chat', cors: { origin: '*' } })
export class ChatGateway implements OnGatewayConnection {
  private readonly logger = new Logger(ChatGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwt: JwtService,
    @Inject(forwardRef(() => ChatService))
    private readonly chat: ChatService,
  ) {}
  // forwardRef en ambos lados: ver ChatService

  async handleConnection(client: Socket) {
    const user = await authenticateSocket(client, this.jwt);
    if (!user) {
      client.disconnect();
      return;
    }
    client.data.user = user;
    // Sala personal para notificaciones dirigidas
    client.join(`user:${user.id}`);
  }

  @SubscribeMessage('conversation:join')
  onJoin(@ConnectedSocket() client: Socket, @MessageBody() id: string) {
    client.join(`conversation:${id}`);
    return { joined: id };
  }

  @SubscribeMessage('conversation:leave')
  onLeave(@ConnectedSocket() client: Socket, @MessageBody() id: string) {
    client.leave(`conversation:${id}`);
    return { left: id };
  }

  @SubscribeMessage('message:send')
  async onMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string } & SendMessageDto,
  ) {
    const { conversationId, ...dto } = data;
    return this.chat.sendMessage(conversationId, client.data.user.id, dto);
  }

  @SubscribeMessage('typing')
  onTyping(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    client.to(`conversation:${data.conversationId}`).emit('typing', {
      conversationId: data.conversationId,
      user: client.data.user,
    });
  }

  emitMessage(conversationId: string, message: unknown) {
    this.server.to(`conversation:${conversationId}`).emit('message:new', message);
  }
}
