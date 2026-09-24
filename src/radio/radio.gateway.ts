import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { authenticateSocket } from '../common/ws/ws-auth.util';
import { RadioFloorService } from './radio-floor.service';
import { RadioService } from './radio.service';

/** Tamaño máximo de un chunk de audio (bytes). Evita abusos de memoria/ancho. */
const MAX_CHUNK_BYTES = 64 * 1024; // 64 KB por chunk (~muy holgado para voz)

/**
 * Señalización y streaming push-to-talk medio dúplex: un solo hablante a la vez
 * por canal, con cola de "pedir la palabra". El audio se transmite en vivo como
 * chunks binarios que el servidor reenvía (relay) al resto del canal.
 */
@WebSocketGateway({ namespace: '/radio', cors: { origin: '*' } })
export class RadioGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RadioGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly radio: RadioService,
    private readonly floor: RadioFloorService,
  ) {}

  async handleConnection(client: Socket) {
    const user = await authenticateSocket(client, this.jwt);
    if (!user) {
      client.disconnect();
      return;
    }
    client.data.user = user;
  }

  /** Al desconectar: libera la palabra o saca de la cola en cada canal afectado. */
  handleDisconnect(client: Socket) {
    const user = client.data.user;
    if (!user) return;
    const changes = this.floor.handleDisconnect(user.id);
    for (const change of changes) {
      if (change.wasSpeaker) {
        this.server
          .to(`channel:${change.channelId}`)
          .emit('ptt:ended', { channelId: change.channelId });
        this.grantFloor(change.channelId, change.next);
      }
      this.emitQueue(change.channelId);
    }
  }

  @SubscribeMessage('channel:join')
  async onJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() channelId: string,
  ) {
    await this.radio.join(channelId, client.data.user.id);
    client.join(`channel:${channelId}`);
    // Estado actual del canal para el que acaba de entrar.
    const current = this.floor.current(channelId);
    return {
      joined: channelId,
      speaking: current ? current.user : null,
      queue: this.floor.queue(channelId),
    };
  }

  @SubscribeMessage('channel:leave')
  onLeave(@ConnectedSocket() client: Socket, @MessageBody() channelId: string) {
    // Si tenía la palabra o estaba en cola, libera/limpia antes de salir.
    this.releaseIfSpeaker(channelId, client.data.user.id);
    this.floor.cancel(channelId, client.data.user.id);
    this.emitQueue(channelId);
    client.leave(`channel:${channelId}`);
    return { left: channelId };
  }

  /**
   * Pedir la palabra. Si el canal está libre se concede y empieza a transmitir;
   * si está ocupado, el usuario queda en cola.
   */
  @SubscribeMessage('ptt:request')
  onRequestFloor(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { channelId: string },
  ) {
    const user = client.data.user;
    const result = this.floor.request(data.channelId, {
      socketId: client.id,
      user,
    });

    if (result.status === 'granted') {
      // Avisa al canal quién habla ahora.
      this.server.to(`channel:${data.channelId}`).emit('ptt:speaking', {
        channelId: data.channelId,
        user,
      });
      this.emitQueue(data.channelId);
      return { status: 'granted', channelId: data.channelId };
    }

    // Ocupado: encolado.
    this.emitQueue(data.channelId);
    return {
      status: 'queued',
      channelId: data.channelId,
      position: result.position,
    };
  }

  /** Relay del chunk de audio en vivo. Solo lo reenvía si el emisor tiene la palabra. */
  @SubscribeMessage('ptt:audio')
  onPttAudio(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: { channelId: string; chunk: ArrayBuffer | Buffer; mime?: string },
  ) {
    const user = client.data.user;
    if (!this.floor.isSpeaker(data.channelId, user.id)) return; // no tiene la palabra
    if (!data?.chunk) return;

    const size =
      data.chunk instanceof ArrayBuffer
        ? data.chunk.byteLength
        : (data.chunk as Buffer).length;
    if (size > MAX_CHUNK_BYTES) {
      this.logger.warn(`Chunk de ${size} bytes descartado (máx ${MAX_CHUNK_BYTES}).`);
      return;
    }

    client.to(`channel:${data.channelId}`).emit('ptt:audio', {
      channelId: data.channelId,
      senderId: user.id,
      chunk: data.chunk,
      mime: data.mime ?? 'audio/ogg;codecs=opus',
    });
  }

  /**
   * Soltar la palabra: persiste la transmisión, avisa al canal y concede el
   * turno al siguiente de la cola.
   */
  @SubscribeMessage('ptt:release')
  async onPttRelease(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: { channelId: string; audioKey?: string; durationSec?: number },
  ) {
    const user = client.data.user;
    if (!this.floor.isSpeaker(data.channelId, user.id)) {
      return { released: false };
    }

    const next = this.floor.release(data.channelId, user.id);

    // Persiste metadatos de la transmisión (audioKey opcional si se grabó).
    const transmission = await this.radio.recordTransmission(
      data.channelId,
      user.id,
      { audioKey: data.audioKey, durationSec: data.durationSec ?? 0 },
    );
    this.server
      .to(`channel:${data.channelId}`)
      .emit('ptt:ended', { channelId: data.channelId, transmission });

    // Push a los miembros que NO están escuchando en vivo (app cerrada).
    const room = `channel:${data.channelId}`;
    const listening = await this.server.in(room).fetchSockets();
    const connectedUserIds = listening
      .map((s) => s.data.user?.id)
      .filter((id): id is string => Boolean(id));
    void this.radio.notifyBroadcast(data.channelId, user, connectedUserIds);

    // Concede al siguiente (si hay) y reemite la cola.
    this.grantFloor(data.channelId, next);
    this.emitQueue(data.channelId);
    return { released: true, transmission };
  }

  /** Cancelar la solicitud: sale de la cola sin haber hablado. */
  @SubscribeMessage('ptt:cancel')
  onPttCancel(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { channelId: string },
  ) {
    const removed = this.floor.cancel(data.channelId, client.data.user.id);
    if (removed) this.emitQueue(data.channelId);
    return { cancelled: removed };
  }

  // ── Helpers ──────────────────────────────────────────────────

  /** Notifica al nuevo hablante (si existe) y avisa al canal quién habla. */
  private grantFloor(
    channelId: string,
    next: { socketId: string; user: unknown } | null,
  ) {
    if (!next) return;
    this.server.to(next.socketId).emit('ptt:granted', { channelId });
    this.server
      .to(`channel:${channelId}`)
      .emit('ptt:speaking', { channelId, user: next.user });
  }

  /** Si el usuario es el hablante, libera y concede al siguiente. */
  private releaseIfSpeaker(channelId: string, userId: string) {
    if (!this.floor.isSpeaker(channelId, userId)) return;
    const next = this.floor.release(channelId, userId);
    this.server.to(`channel:${channelId}`).emit('ptt:ended', { channelId });
    this.grantFloor(channelId, next);
  }

  /** Reemite el estado de la cola a todo el canal. */
  private emitQueue(channelId: string) {
    this.server
      .to(`channel:${channelId}`)
      .emit('ptt:queue', { channelId, waiting: this.floor.queue(channelId) });
  }
}
