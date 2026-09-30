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
import type * as mediasoup from 'mediasoup';
import { type ChildProcess, spawn } from 'child_process';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { authenticateSocket } from '../common/ws/ws-auth.util';
import { UPLOAD_DIR } from '../media/media.controller';
import { MediasoupService } from './mediasoup.service';
import { RadioFloorService } from './radio-floor.service';
import { RadioService } from './radio.service';

/** Grabación en curso de una transmisión. */
interface MsRecording {
  ffmpeg: ChildProcess;
  transport: mediasoup.types.PlainTransport;
  file: string; // key /uploads/xxx
  startedAt: number;
}

/** Estado mediasoup por conexión (socket). */
interface MsPeer {
  channelId?: string;
  sendTransport?: mediasoup.types.WebRtcTransport;
  recvTransport?: mediasoup.types.WebRtcTransport;
  producer?: mediasoup.types.Producer;
  consumers: Map<string, mediasoup.types.Consumer>;
  recording?: MsRecording;
}

/** Puerto UDP rotatorio para el RTP de grabación (ffmpeg). */
let recPortCounter = 41000;
function nextRecPort() {
  recPortCounter += 2;
  if (recPortCounter > 41998) recPortCounter = 41000;
  return recPortCounter;
}

/**
 * Tamaño máximo de un mensaje de audio. El cliente envía el clip PTT completo
 * (base64) al soltar el botón, no chunks en vivo, así que necesita holgura para
 * mensajes de hasta ~60 s.
 */
const MAX_CHUNK_BYTES = 4 * 1024 * 1024; // 4 MB

/**
 * Señalización y streaming push-to-talk medio dúplex: un solo hablante a la vez
 * por canal, con cola de "pedir la palabra". El audio se transmite en vivo como
 * chunks binarios que el servidor reenvía (relay) al resto del canal.
 */
@WebSocketGateway({
  namespace: '/radio',
  cors: { origin: '*' },
  // El audio PTT viaja como base64 en un solo mensaje; ampliamos el buffer.
  maxHttpBufferSize: 6 * 1024 * 1024, // 6 MB
})
export class RadioGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RadioGateway.name);

  @WebSocketServer()
  server!: Server;

  /** Estado mediasoup por socket.id. */
  private readonly msPeers = new Map<string, MsPeer>();
  /** Producer activo por canal (un hablante a la vez): channelId -> {socketId, producerId}. */
  private readonly channelProducer = new Map<
    string,
    { socketId: string; producerId: string }
  >();

  constructor(
    private readonly jwt: JwtService,
    private readonly radio: RadioService,
    private readonly floor: RadioFloorService,
    private readonly ms: MediasoupService,
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
    this.cleanupMsPeer(client); // libera transportes/producer/consumers de mediasoup
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
    // Salir de CUALQUIER otro canal antes de entrar: un socket solo debe estar
    // en un canal a la vez, si no se cruzan el audio y el chat entre canales.
    for (const room of client.rooms) {
      if (room.startsWith('channel:') && room !== `channel:${channelId}`) {
        client.leave(room);
      }
    }
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

  /** Compartir una imagen en el canal (chat del canal: audios + imágenes). */
  @SubscribeMessage('channel:image')
  async onChannelImage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { channelId: string; imageKey: string },
  ) {
    const user = client.data.user;
    if (!data?.channelId || !data?.imageKey) return { ok: false };
    const transmission = await this.radio.recordImage(
      data.channelId,
      user.id,
      data.imageKey,
    );
    // Avisa a todo el canal (incluido el emisor) para actualizar el chat en vivo.
    this.server
      .to(`channel:${data.channelId}`)
      .emit('channel:post', { channelId: data.channelId, transmission });
    return { ok: true, transmission };
  }

  /** Enviar un mensaje de texto al chat del canal. */
  @SubscribeMessage('channel:text')
  async onChannelText(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { channelId: string; text: string },
  ) {
    const user = client.data.user;
    const text = (data?.text ?? '').trim();
    if (!data?.channelId || !text) return { ok: false };
    const transmission = await this.radio.recordText(
      data.channelId,
      user.id,
      text.slice(0, 2000),
    );
    this.server
      .to(`channel:${data.channelId}`)
      .emit('channel:post', { channelId: data.channelId, transmission });
    return { ok: true, transmission };
  }

  // ── WebRTC (audio en vivo) — señalización ────────────────────
  // El socket solo REENVÍA los mensajes de señalización entre pares del canal.

  /** El que habla avisa al canal que empezó a transmitir en vivo. */
  @SubscribeMessage('rtc:speaking-start')
  onRtcSpeakingStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { channelId: string },
  ) {
    client
      .to(`channel:${data.channelId}`)
      .emit('rtc:peer-speaking', { fromSocket: client.id });
  }

  /** El que habla avisa que terminó. */
  @SubscribeMessage('rtc:speaking-stop')
  onRtcSpeakingStop(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { channelId: string },
  ) {
    client
      .to(`channel:${data.channelId}`)
      .emit('rtc:peer-stopped', { fromSocket: client.id });
  }

  /** Reenvía una oferta SDP al socket destino. */
  @SubscribeMessage('rtc:offer')
  onRtcOffer(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { toSocket: string; sdp: unknown },
  ) {
    this.server
      .to(data.toSocket)
      .emit('rtc:offer', { fromSocket: client.id, sdp: data.sdp });
  }

  /** Reenvía una respuesta SDP al socket destino. */
  @SubscribeMessage('rtc:answer')
  onRtcAnswer(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { toSocket: string; sdp: unknown },
  ) {
    this.server
      .to(data.toSocket)
      .emit('rtc:answer', { fromSocket: client.id, sdp: data.sdp });
  }

  /** Reenvía un candidato ICE al socket destino. */
  @SubscribeMessage('rtc:ice')
  onRtcIce(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { toSocket: string; candidate: unknown },
  ) {
    this.server
      .to(data.toSocket)
      .emit('rtc:ice', { fromSocket: client.id, candidate: data.candidate });
  }

  // ── mediasoup (audio en vivo por SFU) ────────────────────────
  private peer(client: Socket): MsPeer {
    let p = this.msPeers.get(client.id);
    if (!p) {
      p = { consumers: new Map() };
      this.msPeers.set(client.id, p);
    }
    return p;
  }

  @SubscribeMessage('ms:rtpCapabilities')
  onRtpCapabilities() {
    return this.ms.getRtpCapabilities();
  }

  /** Producer activo del canal (para que quien entra sepa a quién consumir). */
  @SubscribeMessage('ms:getProducer')
  onGetProducer(@MessageBody() data: { channelId: string }) {
    return this.channelProducer.get(data.channelId) ?? null;
  }

  @SubscribeMessage('ms:createTransport')
  async onCreateTransport(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { direction: 'send' | 'recv' },
  ) {
    const { transport, params } = await this.ms.createWebRtcTransport();
    const p = this.peer(client);
    if (data.direction === 'send') p.sendTransport = transport;
    else p.recvTransport = transport;
    return params;
  }

  @SubscribeMessage('ms:connectTransport')
  async onConnectTransport(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: { direction: 'send' | 'recv'; dtlsParameters: mediasoup.types.DtlsParameters },
  ) {
    const p = this.peer(client);
    const t = data.direction === 'send' ? p.sendTransport : p.recvTransport;
    if (!t) return { error: 'sin transporte' };
    await t.connect({ dtlsParameters: data.dtlsParameters });
    return { connected: true };
  }

  /** Publicar el micrófono (empezar a hablar en vivo). */
  @SubscribeMessage('ms:produce')
  async onProduce(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: { channelId: string; rtpParameters: mediasoup.types.RtpParameters },
  ) {
    const p = this.peer(client);
    if (!p.sendTransport) return { error: 'sin transporte de envío' };
    // Half-duplex: un solo hablante a la vez por canal. Si el "ocupante" sigue
    // conectado (msPeers lo tiene), hay otro hablando de verdad -> ocupado. Si
    // no, es un productor FANTASMA que quedó de una desconexión (p.ej. tras
    // reconectar con otro socket.id): se limpia y se deja producir.
    const busy = this.channelProducer.get(data.channelId);
    if (busy && busy.socketId !== client.id) {
      if (this.msPeers.has(busy.socketId)) {
        return { error: 'ocupado', busy: true };
      }
      this.channelProducer.delete(data.channelId);
    }
    const producer = await p.sendTransport.produce({
      kind: 'audio',
      rtpParameters: data.rtpParameters,
    });
    p.producer = producer;
    p.channelId = data.channelId;
    this.channelProducer.set(data.channelId, {
      socketId: client.id,
      producerId: producer.id,
    });
    // Avisar al canal que hay un nuevo hablante en vivo.
    client
      .to(`channel:${data.channelId}`)
      .emit('ms:newProducer', { producerId: producer.id, socketId: client.id });
    // Grabar en el servidor (ffmpeg) para guardar la nota al terminar.
    void this.startRecording(client, producer.id, data.channelId);
    return { id: producer.id };
  }

  /** Arranca ffmpeg para grabar el audio del producer (best-effort). */
  private async startRecording(
    client: Socket,
    producerId: string,
    channelId: string,
  ) {
    try {
      const port = nextRecPort();
      const rec = await this.ms.createRecordingConsumer(producerId, port);
      const filename = `radio-${Date.now()}-${Math.round(Math.random() * 1e6)}.m4a`;
      const filepath = join(UPLOAD_DIR, filename);
      const sdpPath = join(UPLOAD_DIR, `${filename}.sdp`);
      const sdp =
        `v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=mape\r\nc=IN IP4 127.0.0.1\r\n` +
        `t=0 0\r\nm=audio ${port} RTP/AVP ${rec.payloadType}\r\n` +
        `a=rtpmap:${rec.payloadType} opus/${rec.clockRate}/${rec.channels}\r\na=recvonly\r\n`;
      writeFileSync(sdpPath, sdp);
      const ffmpeg = spawn('ffmpeg', [
        '-protocol_whitelist',
        'file,udp,rtp',
        '-i',
        sdpPath,
        '-c:a',
        'aac',
        '-y',
        filepath,
      ]);
      await rec.consumer.resume(); // empieza a fluir RTP hacia ffmpeg
      this.peer(client).recording = {
        ffmpeg,
        transport: rec.transport,
        file: `/uploads/${filename}`,
        startedAt: Date.now(),
      };
    } catch {
      // si la grabación falla, la transmisión en vivo sigue funcionando
    }
  }

  /** Detiene ffmpeg y guarda la nota de voz en el chat del canal. */
  private finishRecording(client: Socket, channelId: string) {
    const p = this.msPeers.get(client.id);
    const rec = p?.recording;
    if (!rec || !p) return;
    p.recording = undefined;
    const durationSec = Math.max(0.5, (Date.now() - rec.startedAt) / 1000);
    const userId = client.data.user?.id as string | undefined;

    let saved = false;
    const save = () => {
      if (saved || !userId) return;
      saved = true;
      void this.radio
        .recordTransmission(channelId, userId, { audioKey: rec.file, durationSec })
        .then((transmission) => {
          this.server
            .to(`channel:${channelId}`)
            .emit('ptt:ended', { channelId, transmission });
        })
        .catch(() => undefined);
    };

    // Guardar EN CUANTO ffmpeg cierre el archivo (rápido, sin espera fija). Un
    // respaldo por si el proceso se cuelga.
    const fallback = setTimeout(save, 2500);
    rec.ffmpeg.once('close', () => {
      clearTimeout(fallback);
      save();
    });

    try {
      rec.ffmpeg.kill('SIGINT'); // finaliza y cierra el archivo -> dispara 'close'
    } catch {
      /* noop */
    }
    try {
      rec.transport.close();
    } catch {
      /* noop */
    }
  }

  /** Consumir el audio de un producer (escuchar en vivo). */
  @SubscribeMessage('ms:consume')
  async onConsume(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: { producerId: string; rtpCapabilities: mediasoup.types.RtpCapabilities },
  ) {
    const p = this.peer(client);
    if (!p.recvTransport) return { error: 'sin transporte de recepción' };
    if (!this.ms.canConsume(data.producerId, data.rtpCapabilities)) {
      return { error: 'no se puede consumir' };
    }
    const consumer = await p.recvTransport.consume({
      producerId: data.producerId,
      rtpCapabilities: data.rtpCapabilities,
      paused: true,
    });
    p.consumers.set(consumer.id, consumer);
    return {
      id: consumer.id,
      producerId: data.producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
    };
  }

  @SubscribeMessage('ms:resume')
  async onResume(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { consumerId: string },
  ) {
    const c = this.peer(client).consumers.get(data.consumerId);
    if (c) await c.resume();
    return { resumed: !!c };
  }

  /** Dejar de hablar: cierra el producer y avisa al canal. */
  @SubscribeMessage('ms:closeProducer')
  onCloseProducer(@ConnectedSocket() client: Socket) {
    this.closeMsProducer(client);
    return { closed: true };
  }

  private closeMsProducer(client: Socket) {
    const p = this.msPeers.get(client.id);
    if (!p?.producer || !p.channelId) return;
    const channelId = p.channelId;
    try {
      p.producer.close();
    } catch {
      /* noop */
    }
    p.producer = undefined;
    const active = this.channelProducer.get(channelId);
    if (active?.socketId === client.id) this.channelProducer.delete(channelId);
    this.server
      .to(`channel:${channelId}`)
      .emit('ms:producerClosed', { channelId });
    this.finishRecording(client, channelId); // detiene ffmpeg y guarda la nota
  }

  private cleanupMsPeer(client: Socket) {
    this.closeMsProducer(client);
    const p = this.msPeers.get(client.id);
    if (!p) return;
    p.consumers.forEach((c) => {
      try {
        c.close();
      } catch {
        /* noop */
      }
    });
    try {
      p.sendTransport?.close();
    } catch {
      /* noop */
    }
    try {
      p.recvTransport?.close();
    } catch {
      /* noop */
    }
    this.msPeers.delete(client.id);
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
