import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import type * as mediasoup from 'mediasoup';
import { type ChildProcess, spawn } from 'child_process';
import { statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { authenticateSocket, type WsUser } from '../common/ws/ws-auth.util';
import { UPLOAD_DIR } from '../media/media.controller';
import { MediasoupService } from './mediasoup.service';
import { RadioFloorService } from './radio-floor.service';
import { RadioService } from './radio.service';

/** Grabación en curso de una transmisión. */
interface MsRecording {
  ffmpeg: ChildProcess;
  transport: mediasoup.types.PlainTransport;
  file: string; // key /uploads/xxx
  filepath: string; // ruta absoluta en disco (para verificar que se grabó audio)
  startedAt: number;
  failed?: boolean; // ffmpeg no arrancó / falló
  stderr?: string; // últimas líneas de stderr para diagnóstico
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
export class RadioGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(RadioGateway.name);

  @WebSocketServer()
  server!: Server;

  /** Estado mediasoup por socket.id. */
  private readonly msPeers = new Map<string, MsPeer>();
  /** Producer activo por canal (un hablante a la vez): channelId -> {socketId, producerId}. */
  private readonly channelProducer = new Map<
    string,
    {
      socketId: string;
      producerId: string;
      user: Pick<WsUser, 'id' | 'name' | 'nickname'>;
    }
  >();
  /** Palabra asignada mientras el cliente configura su producer WebRTC. */
  private readonly channelReservations = new Map<
    string,
    { socketId: string; user: Pick<WsUser, 'id' | 'name' | 'nickname'> }
  >();

  constructor(
    private readonly jwt: JwtService,
    private readonly radio: RadioService,
    private readonly floor: RadioFloorService,
    private readonly ms: MediasoupService,
  ) {}

  afterInit() {
    // Si mediasoup se recrea tras morir el worker, limpiamos el estado de audio
    // y forzamos la reconexión de los sockets: cada cliente reconstruye sus
    // transportes con el router nuevo (reusa su propia lógica de reconexión).
    this.ms.onReset(() => {
      this.logger.warn('Reiniciando sesiones de audio tras recrear mediasoup.');
      this.msPeers.clear();
      this.channelProducer.clear();
      this.channelReservations.clear();
      void this.server.disconnectSockets(true);
    });
  }

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
    // Actualiza conectados en vivo del canal que el usuario tenía abierto.
    const openChannel = client.data.channelId as string | undefined;
    if (openChannel) void this.emitPresence(openChannel);
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

  /**
   * Usuarios ÚNICOS conectados en vivo a un canal (por socket) y los emite al
   * canal, con id/nombre/alias para que el cliente muestre QUIÉN está conectado.
   */
  private async emitPresence(channelId: string) {
    const sockets = await this.server.in(`channel:${channelId}`).fetchSockets();
    const byId = new Map<
      string,
      { id: string; name?: string; nickname?: string | null }
    >();
    for (const s of sockets) {
      const u = s.data?.user as WsUser | undefined;
      if (u?.id && !byId.has(u.id)) {
        byId.set(u.id, { id: u.id, name: u.name, nickname: u.nickname });
      }
    }
    const users = [...byId.values()];
    this.server
      .to(`channel:${channelId}`)
      .emit('channel:presence', { channelId, count: users.length, users });
  }

  @SubscribeMessage('channel:join')
  async onJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() channelId: string,
  ) {
    await this.radio.join(channelId, client.data.user.id);
    // Salir de CUALQUIER otro canal antes de entrar: un socket solo debe estar
    // en un canal a la vez, si no se cruzan el audio y el chat entre canales.
    const left: string[] = [];
    for (const room of client.rooms) {
      if (room.startsWith('channel:') && room !== `channel:${channelId}`) {
        client.leave(room);
        left.push(room.substring('channel:'.length));
      }
    }
    client.join(`channel:${channelId}`);
    client.data.channelId = channelId;
    // Conectados en vivo: actualiza el canal nuevo y los que acaba de dejar.
    await this.emitPresence(channelId);
    for (const cid of left) await this.emitPresence(cid);
    // Estado actual del canal para el que acaba de entrar.
    const current = this.floor.current(channelId);
    return {
      joined: channelId,
      speaking: current ? current.user : null,
      queue: this.floor.queue(channelId),
    };
  }

  @SubscribeMessage('channel:leave')
  async onLeave(
    @ConnectedSocket() client: Socket,
    @MessageBody() channelId: string,
  ) {
    if (this.channelReservations.get(channelId)?.socketId === client.id) {
      this.channelReservations.delete(channelId);
    }
    // Si tenía la palabra o estaba en cola, libera/limpia antes de salir.
    this.releaseIfSpeaker(channelId, client.data.user.id);
    this.floor.cancel(channelId, client.data.user.id);
    this.emitQueue(channelId);
    client.leave(`channel:${channelId}`);
    if (client.data.channelId === channelId) client.data.channelId = undefined;
    await this.emitPresence(channelId);
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

  /**
   * Compartir un adjunto multimedia en el canal (imagen, video o archivo).
   * El cliente sube el archivo por `POST /api/media/upload`, obtiene la `key`
   * (`/uploads/...`) y envía este evento con `kind` + metadatos.
   */
  @SubscribeMessage('channel:media')
  async onChannelMedia(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      channelId: string;
      kind: 'image' | 'video' | 'file';
      key: string;
      fileName?: string;
      fileSize?: number;
      mimeType?: string;
    },
  ) {
    const user = client.data.user;
    const kind =
      data?.kind === 'video' || data?.kind === 'file' ? data.kind : 'image';
    if (!data?.channelId || !data?.key) return { ok: false };
    const transmission = await this.radio.recordMedia(data.channelId, user.id, {
      kind,
      key: data.key,
      fileName: data.fileName?.slice(0, 255),
      fileSize:
        typeof data.fileSize === 'number' && data.fileSize >= 0
          ? Math.round(data.fileSize)
          : undefined,
      mimeType: data.mimeType?.slice(0, 120),
    });
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
    // Nunca devolver null: Nest no envía ack para null y el cliente espera el timeout.
    const rtpCapabilities = this.ms.getRtpCapabilities();
    return rtpCapabilities
      ? { ready: true, rtpCapabilities }
      : { ready: false, rtpCapabilities: null };
  }

  /** Producer activo del canal (para que quien entra sepa a quién consumir). */
  @SubscribeMessage('ms:getProducer')
  onGetProducer(@MessageBody() data: { channelId: string }) {
    // Devolver SIEMPRE un objeto (nunca null): con null, NestJS no envía el ack y el
    // cliente espera el timeout (~4s) cada vez que NADIE está hablando, retrasando la
    // conexión. producerId vacío = no hay nadie transmitiendo ahora.
    const p = this.channelProducer.get(data.channelId);
    return {
      producerId: p?.producerId ?? '',
      socketId: p?.socketId ?? '',
      user: p?.user ?? null,
    };
  }

  /** Reserva el canal antes de activar el micrófono y crear el producer nativo. */
  @SubscribeMessage('ms:reserve')
  onReserveProducer(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { channelId: string },
  ) {
    const channelId = data?.channelId;
    if (!channelId) return { ok: false, error: 'canal inválido' };

    const active = this.channelProducer.get(channelId);
    if (active && active.socketId !== client.id) {
      if (this.msPeers.has(active.socketId)) {
        return {
          ok: false,
          busy: true,
          producerId: active.producerId,
          user: active.user,
        };
      }
      this.channelProducer.delete(channelId);
    } else if (active?.socketId === client.id) {
      return { ok: false, busy: true, producerId: active.producerId, user: active.user };
    }

    const held = this.channelReservations.get(channelId);
    if (held && held.socketId !== client.id) {
      return { ok: false, busy: true, user: held.user };
    }

    const user = client.data.user as WsUser;
    this.channelReservations.set(channelId, {
      socketId: client.id,
      user: { id: user.id, name: user.name, nickname: user.nickname },
    });
    return { ok: true };
  }

  @SubscribeMessage('ms:releaseReservation')
  onReleaseProducerReservation(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { channelId: string },
  ) {
    if (this.channelReservations.get(data?.channelId)?.socketId === client.id) {
      this.channelReservations.delete(data.channelId);
    }
    return { released: true };
  }

  @SubscribeMessage('ms:createTransport')
  async onCreateTransport(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { direction: 'send' | 'recv' },
  ) {
    const p = this.peer(client);
    // Cerrar el transporte anterior de esta dirección ANTES de crear otro. Si el
    // cliente re-arma la sesión sin desconectarse (reconexión, watchdog cada 4s,
    // o el reintento de HABLAR), el transporte viejo quedaba huérfano ocupando
    // sus puertos UDP/TCP del rango RTC. Con solo ~101 puertos (40000-40100),
    // unos pocos teléfonos reconectando agotaban el rango y createWebRtcTransport
    // empezaba a fallar/colgarse -> en la app "No se puede transmitir" (txFailed).
    const old = data.direction === 'send' ? p.sendTransport : p.recvTransport;
    if (old) {
      try {
        old.close();
      } catch {
        /* noop */
      }
      if (data.direction === 'send') p.sendTransport = undefined;
      else p.recvTransport = undefined;
    }
    try {
      const { transport, params } = await this.ms.createWebRtcTransport();
      if (data.direction === 'send') p.sendTransport = transport;
      else p.recvTransport = transport;
      return params;
    } catch (e) {
      // Sin puertos libres u otro fallo del worker: devolver error limpio en vez
      // de dejar colgado el ack del cliente (esperaría 8s y reintentaría, lo que
      // empeora la presión de puertos).
      this.logger.error(
        `createWebRtcTransport falló (${data.direction}): ` +
          (e instanceof Error ? e.message : String(e)),
      );
      return { error: 'no se pudo crear el transporte' };
    }
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
        return { error: 'ocupado', busy: true, user: busy.user };
      }
      this.channelProducer.delete(data.channelId);
    }
    const held = this.channelReservations.get(data.channelId);
    if (held && held.socketId !== client.id) {
      return { error: 'ocupado', busy: true, user: held.user };
    }
    const user = client.data.user as WsUser;
    if (busy?.socketId === client.id) {
      return { error: 'ya estás transmitiendo', busy: true, user: busy.user };
    }
    // Compatibilidad con clientes antiguos: reserva de forma síncrona antes del
    // primer await para que dos ms:produce simultáneos no ocupen el mismo canal.
    if (!held) {
      this.channelReservations.set(data.channelId, {
        socketId: client.id,
        user: { id: user.id, name: user.name, nickname: user.nickname },
      });
    }
    let producer: mediasoup.types.Producer;
    try {
      producer = await p.sendTransport.produce({
        kind: 'audio',
        rtpParameters: data.rtpParameters,
      });
    } catch (error) {
      if (this.channelReservations.get(data.channelId)?.socketId === client.id) {
        this.channelReservations.delete(data.channelId);
      }
      throw error;
    }
    p.producer = producer;
    p.channelId = data.channelId;
    this.channelProducer.set(data.channelId, {
      socketId: client.id,
      producerId: producer.id,
      user: { id: user.id, name: user.name, nickname: user.nickname },
    });
    if (this.channelReservations.get(data.channelId)?.socketId === client.id) {
      this.channelReservations.delete(data.channelId);
    }
    // Avisar al canal que hay un nuevo hablante en vivo.
    client
      .to(`channel:${data.channelId}`)
      .emit('ms:newProducer', {
        producerId: producer.id,
        socketId: client.id,
        channelId: data.channelId,
        user: { id: user.id, name: user.name, nickname: user.nickname },
      });
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
      // ADTS AAC (.aac): contenedor "streamable" que escribe el audio en el acto.
      // (El .m4a/AAC solo finaliza el archivo al cerrar -> al revisar el tamaño
      //  estaba en 0 bytes y la nota se descartaba.)
      const filename = `radio-${Date.now()}-${Math.round(Math.random() * 1e6)}.aac`;
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
        '-flush_packets',
        '1', // vuelca cada paquete a disco al instante (no lo retiene en búfer)
        '-f',
        'adts',
        '-y',
        filepath,
      ]);
      const recording: MsRecording = {
        ffmpeg,
        transport: rec.transport,
        file: `/uploads/${filename}`,
        filepath,
        startedAt: Date.now(),
      };
      // CRÍTICO: sin este handler, si ffmpeg no está instalado el evento 'error'
      // (ENOENT) sube como excepción no capturada y TUMBA el backend (reinicios).
      ffmpeg.on('error', (err) => {
        recording.failed = true;
        this.logger.error(
          `ffmpeg no se pudo ejecutar; instálalo en el servidor ('apt install -y ffmpeg'): ${err.message}`,
        );
      });
      ffmpeg.stderr?.on('data', (d: Buffer) => {
        recording.stderr = ((recording.stderr ?? '') + d.toString()).slice(-2000);
      });
      this.peer(client).recording = recording;
      await rec.consumer.resume(); // empieza a fluir RTP hacia ffmpeg
    } catch (err) {
      // si la grabación falla, la transmisión en vivo sigue funcionando
      this.logger.error(
        `No se pudo iniciar la grabación de voz: ${(err as Error).message}`,
      );
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
      if (saved) return;
      saved = true;
      if (!userId) {
        this.logger.warn(`Nota de voz NO guardada: sin userId (socket ${client.id}).`);
        return;
      }
      // No guardar notas rotas: ffmpeg falló o el archivo quedó sin audio real.
      let size = 0;
      try {
        size = statSync(rec.filepath).size;
      } catch {
        size = 0;
      }
      if (rec.failed || size < 800) {
        this.logger.warn(
          `Nota de voz descartada (failed=${rec.failed ?? false}, size=${size} bytes).` +
            (rec.stderr ? ` ffmpeg: ${rec.stderr.slice(-300)}` : ''),
        );
        return;
      }
      void this.radio
        .recordTransmission(channelId, userId, { audioKey: rec.file, durationSec })
        .then((transmission) => {
          this.logger.log(
            `Nota de voz guardada (${size} bytes, ${durationSec.toFixed(1)}s) en canal ${channelId}.`,
          );
          this.server
            .to(`channel:${channelId}`)
            .emit('ptt:ended', { channelId, transmission });
        })
        .catch((err) => {
          this.logger.error(
            `Error guardando la nota de voz en BD: ${(err as Error)?.message ?? String(err)}`,
          );
        });
    };

    // Guardar SOLO cuando ffmpeg CIERRE: ahí el archivo ya está volcado a disco.
    // (Antes un timer llamaba a save() a los 2.5s, cuando ffmpeg aún tenía el
    //  audio en su búfer y el archivo estaba en 0 bytes -> la nota se descartaba
    //  aunque luego ffmpeg escribiera el archivo completo.)
    rec.ffmpeg.once('close', save);
    // Con -flush_packets el archivo ya está completo en disco, así que si el
    // SIGINT no cierra ffmpeg rápido lo forzamos a los 2s (no se pierde audio);
    // el 'close' resultante dispara save.
    const killTimer = setTimeout(() => {
      try {
        rec.ffmpeg.kill('SIGKILL');
      } catch {
        /* noop */
      }
    }, 2000);
    rec.ffmpeg.once('close', () => clearTimeout(killTimer));
    // Último recurso por si 'close' nunca llega.
    setTimeout(save, 4000);

    try {
      rec.ffmpeg.kill('SIGINT'); // pide finalizar y cerrar el archivo -> 'close'
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
      .emit('ms:producerClosed', {
        channelId,
        producerId: active?.socketId === client.id ? active.producerId : undefined,
      });
    this.finishRecording(client, channelId); // detiene ffmpeg y guarda la nota
  }

  private cleanupMsPeer(client: Socket) {
    this.closeMsProducer(client);
    for (const [channelId, reservation] of this.channelReservations) {
      if (reservation.socketId === client.id) this.channelReservations.delete(channelId);
    }
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
