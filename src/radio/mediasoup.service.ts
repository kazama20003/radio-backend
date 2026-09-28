import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as mediasoup from 'mediasoup';

type Router = mediasoup.types.Router;
type Worker = mediasoup.types.Worker;
type WebRtcTransport = mediasoup.types.WebRtcTransport;

/**
 * SFU de AUDIO (mediasoup) para la radio en tiempo real.
 *
 * - Un worker + un router por proceso (suficiente para audio de un equipo
 *   pequeño; audio es liviano).
 * - Cada canal de radio usa el mismo router; los productores/consumidores se
 *   agrupan por canal en el gateway.
 *
 * Requiere en el servidor:
 *   MEDIASOUP_ANNOUNCED_IP=<IP pública del VPS>
 *   MEDIASOUP_RTC_MIN_PORT / MAX_PORT (rango UDP abierto en el firewall)
 */
@Injectable()
export class MediasoupService implements OnModuleInit {
  private readonly logger = new Logger(MediasoupService.name);
  private worker!: Worker;
  private router!: Router;

  /** Códecs de audio del router (solo Opus: liviano y estándar para voz). */
  private static readonly MEDIA_CODECS: mediasoup.types.RtpCodecCapability[] = [
    {
      kind: 'audio',
      mimeType: 'audio/opus',
      preferredPayloadType: 100,
      clockRate: 48000,
      channels: 2,
    },
  ];

  private ready = false;

  async onModuleInit() {
    const minPort = Number(process.env.MEDIASOUP_RTC_MIN_PORT ?? 40000);
    const maxPort = Number(process.env.MEDIASOUP_RTC_MAX_PORT ?? 40100);
    try {
      this.worker = await mediasoup.createWorker({
        rtcMinPort: minPort,
        rtcMaxPort: maxPort,
        logLevel: 'warn',
      });
      this.worker.on('died', () => {
        this.logger.error('mediasoup worker murió; reiniciando el proceso.');
        process.exit(1);
      });
      this.router = await this.worker.createRouter({
        mediaCodecs: MediasoupService.MEDIA_CODECS,
      });
      this.ready = true;
      this.logger.log(`mediasoup listo (RTC ${minPort}-${maxPort}).`);
    } catch (e) {
      // Si el worker no está compilado (falta pnpm approve-builds) NO tumbamos
      // el backend: la app sigue funcionando sin audio en vivo.
      this.logger.error(
        'mediasoup NO inició (¿falta compilar el worker? pnpm approve-builds). ' +
          'El backend sigue arriba sin audio en vivo. Detalle: ' +
          (e instanceof Error ? e.message : String(e)),
      );
    }
  }

  isReady() {
    return this.ready;
  }

  getRtpCapabilities() {
    return this.router.rtpCapabilities;
  }

  /** Crea un WebRtcTransport para enviar o recibir audio desde el cliente. */
  async createWebRtcTransport(): Promise<{
    transport: WebRtcTransport;
    params: {
      id: string;
      iceParameters: unknown;
      iceCandidates: unknown;
      dtlsParameters: unknown;
    };
  }> {
    const announcedIp = process.env.MEDIASOUP_ANNOUNCED_IP || undefined;
    const transport = await this.router.createWebRtcTransport({
      listenIps: [{ ip: '0.0.0.0', announcedIp }],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
    });
    return {
      transport,
      params: {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      },
    };
  }

  get routerInstance() {
    return this.router;
  }

  /** ¿El router puede enviar este producer a un cliente con estas capacidades? */
  canConsume(producerId: string, rtpCapabilities: mediasoup.types.RtpCapabilities) {
    return this.router.canConsume({ producerId, rtpCapabilities });
  }
}
