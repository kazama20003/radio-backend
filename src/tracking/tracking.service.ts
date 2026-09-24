import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  AlertSeverity,
  AlertType,
  UnitStatus,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AlertsService } from '../alerts/alerts.service';
import { IngestPositionDto } from './dto/tracking.dto';
import { TrackingGateway } from './tracking.gateway';

// Límite de velocidad configurable por entorno (km/h). Default 90.
const SPEED_LIMIT_KMH = Number(process.env.SPEED_LIMIT_KMH) || 90;
// Margen por encima del límite a partir del cual la alerta se marca CRÍTICA.
const SPEED_CRITICAL_MARGIN_KMH =
  Number(process.env.SPEED_CRITICAL_MARGIN_KMH) || 20;
const ALERT_DEDUP_MINUTES = 5;

// Velocidad por debajo de la cual se considera que la unidad está detenida.
const STOP_SPEED_KMH = 3;
// Minutos detenida (sin superar STOP_SPEED_KMH) para disparar PARADA_PROLONGADA.
const STOP_DURATION_MINUTES = 10;
// La unidad debe seguir reportando (no estar desconectada) para contar la parada.
const REPORTING_GRACE_MINUTES = 3;
// Ventana de deduplicación específica para paradas prolongadas (evita repetir
// la misma alerta cada pocos minutos mientras la unidad sigue estacionada).
const STOP_ALERT_DEDUP_MINUTES = 30;

/** Distancia en metros entre dos coordenadas (fórmula de Haversine). */
function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6_371_000; // radio terrestre en metros
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

@Injectable()
export class TrackingService {
  private readonly logger = new Logger(TrackingService.name);

  /**
   * Geocercas en las que cada unidad se encuentra actualmente (unitId → set de
   * geofenceId). Se usa para detectar la transición dentro→fuera. Es estado en
   * memoria: al reiniciar el servidor se pierde y las salidas solo se detectan
   * tras un nuevo ingreso a la geocerca.
   */
  private readonly unitGeofences = new Map<string, Set<string>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: AlertsService,
    @Inject(forwardRef(() => TrackingGateway))
    private readonly gateway: TrackingGateway,
  ) {}

  /** Registra una posición GPS, actualiza la unidad, emite en vivo y evalúa reglas. */
  async ingest(dto: IngestPositionDto) {
    const recordedAt = dto.recordedAt ? new Date(dto.recordedAt) : new Date();
    const speed = dto.speedKmh ?? 0;

    const position = await this.prisma.position.create({
      data: {
        unitId: dto.unitId,
        lat: dto.lat,
        lng: dto.lng,
        speedKmh: speed,
        heading: dto.heading,
        accuracy: dto.accuracy,
        recordedAt,
      },
    });

    const unit = await this.prisma.unit.update({
      where: { id: dto.unitId },
      data: {
        lastLat: dto.lat,
        lastLng: dto.lng,
        lastSpeedKmh: speed,
        lastHeading: dto.heading,
        lastPositionAt: recordedAt,
        status: speed > 3 ? UnitStatus.EN_RUTA : UnitStatus.DETENIDO,
      },
      include: {
        operator: { select: { id: true, name: true, nickname: true, avatarKey: true } },
      },
    });

    const payload = {
      unitId: unit.id,
      code: unit.code,
      lat: dto.lat,
      lng: dto.lng,
      speedKmh: speed,
      heading: dto.heading,
      status: unit.status,
      operator: unit.operator,
      recordedAt,
    };
    this.gateway.emitPosition(payload);

    await this.evaluateRules(unit.id, unit.operatorId, speed, dto);

    return position;
  }

  async history(unitId: string, limit = 100) {
    return this.prisma.position.findMany({
      where: { unitId },
      orderBy: { recordedAt: 'desc' },
      take: Math.min(limit, 500),
    });
  }

  /** Posiciones actuales de todas las unidades activas (para pintar el mapa). */
  async liveMap() {
    const units = await this.prisma.unit.findMany({
      where: { isActive: true, lastLat: { not: null } },
      select: {
        id: true,
        code: true,
        status: true,
        lastLat: true,
        lastLng: true,
        lastSpeedKmh: true,
        lastHeading: true,
        lastPositionAt: true,
        operator: { select: { id: true, name: true, nickname: true, avatarKey: true } },
      },
    });
    return units;
  }

  // ── Motor de reglas ──────────────────────────────────────────
  private async evaluateRules(
    unitId: string,
    operatorId: string | null,
    speed: number,
    dto: IngestPositionDto,
  ) {
    if (speed > SPEED_LIMIT_KMH) {
      const critical = speed > SPEED_LIMIT_KMH + SPEED_CRITICAL_MARGIN_KMH;
      await this.maybeCreateAlert(unitId, AlertType.EXCESO_VELOCIDAD, {
        operatorId,
        severity: critical ? AlertSeverity.CRITICA : AlertSeverity.ADVERTENCIA,
        title: critical ? 'Exceso de velocidad grave' : 'Exceso de velocidad',
        description: `Unidad a ${Math.round(speed)} km/h (límite ${SPEED_LIMIT_KMH} km/h)`,
        lat: dto.lat,
        lng: dto.lng,
        metadata: {
          speed: Math.round(speed),
          limit: SPEED_LIMIT_KMH,
          over: Math.round(speed - SPEED_LIMIT_KMH),
        },
      });
    }
    // SALIDA_GEOCERCA: se evalúa aquí porque tenemos la posición actual y el
    // estado previo de membresía en memoria.
    await this.evaluateGeofences(unitId, operatorId, dto);
    // PARADA_PROLONGADA se evalúa en el cron `checkProlongedStops` porque
    // depende de la ausencia de movimiento a lo largo del tiempo.
  }

  /**
   * Detecta cuándo una unidad sale de una geocerca en la que estaba dentro
   * (transición dentro→fuera) y genera una alerta SALIDA_GEOCERCA.
   */
  private async evaluateGeofences(
    unitId: string,
    operatorId: string | null,
    dto: IngestPositionDto,
  ) {
    const geofences = await this.prisma.geofence.findMany({
      where: { isActive: true },
    });
    if (geofences.length === 0) return;

    const inside = new Set<string>();
    for (const g of geofences) {
      const distance = haversineMeters(dto.lat, dto.lng, g.centerLat, g.centerLng);
      if (distance <= g.radiusMeters) inside.add(g.id);
    }

    const previous = this.unitGeofences.get(unitId);
    if (previous) {
      for (const g of geofences) {
        if (previous.has(g.id) && !inside.has(g.id)) {
          await this.maybeCreateAlert(unitId, AlertType.SALIDA_GEOCERCA, {
            operatorId,
            severity:
              g.type === 'ZONA_RESTRINGIDA'
                ? AlertSeverity.CRITICA
                : AlertSeverity.ADVERTENCIA,
            title: `Salida de geocerca: ${g.name}`,
            description: `La unidad salió de la geocerca "${g.name}".`,
            lat: dto.lat,
            lng: dto.lng,
            locationLabel: g.name,
            metadata: { geofenceId: g.id, geofenceType: g.type },
          });
        }
      }
    }

    this.unitGeofences.set(unitId, inside);
  }

  /**
   * Job que detecta unidades detenidas (velocidad ≈ 0) durante más de
   * STOP_DURATION_MINUTES pero que siguen reportando, y genera la alerta
   * PARADA_PROLONGADA.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async checkProlongedStops() {
    const now = Date.now();
    const windowStart = new Date(now - STOP_DURATION_MINUTES * 60_000);
    const reportingSince = new Date(now - REPORTING_GRACE_MINUTES * 60_000);

    // Candidatas: unidades activas, detenidas y que siguen reportando.
    const units = await this.prisma.unit.findMany({
      where: {
        isActive: true,
        status: UnitStatus.DETENIDO,
        lastPositionAt: { gte: reportingSince },
      },
      select: {
        id: true,
        operatorId: true,
        lastLat: true,
        lastLng: true,
      },
    });

    for (const unit of units) {
      // ¿Se movió en la ventana? Si hay alguna posición por encima del umbral,
      // no es una parada prolongada.
      const moved = await this.prisma.position.findFirst({
        where: {
          unitId: unit.id,
          recordedAt: { gte: windowStart },
          speedKmh: { gt: STOP_SPEED_KMH },
        },
        select: { id: true },
      });
      if (moved) continue;

      // Debe haber estado reportando desde antes de que empiece la ventana,
      // para no alertar por unidades que recién comenzaron a transmitir.
      const olderPosition = await this.prisma.position.findFirst({
        where: { unitId: unit.id, recordedAt: { lte: windowStart } },
        select: { id: true },
      });
      if (!olderPosition) continue;

      await this.maybeCreateAlert(
        unit.id,
        AlertType.PARADA_PROLONGADA,
        {
          operatorId: unit.operatorId,
          severity: AlertSeverity.ADVERTENCIA,
          title: 'Parada prolongada',
          description: `La unidad lleva más de ${STOP_DURATION_MINUTES} min detenida.`,
          lat: unit.lastLat ?? undefined,
          lng: unit.lastLng ?? undefined,
          metadata: { minutes: STOP_DURATION_MINUTES },
        },
        STOP_ALERT_DEDUP_MINUTES,
      );
    }
  }

  /** Evita duplicar alertas del mismo tipo/unidad en una ventana corta. */
  private async maybeCreateAlert(
    unitId: string,
    type: AlertType,
    data: {
      operatorId: string | null;
      severity: AlertSeverity;
      title: string;
      description: string;
      lat?: number;
      lng?: number;
      locationLabel?: string;
      metadata?: Record<string, unknown>;
    },
    dedupMinutes = ALERT_DEDUP_MINUTES,
  ) {
    const since = new Date(Date.now() - dedupMinutes * 60_000);
    const recent = await this.prisma.alert.findFirst({
      where: { unitId, type, createdAt: { gt: since } },
    });
    if (recent) return;

    await this.alerts.create({
      type,
      unitId,
      operatorId: data.operatorId ?? undefined,
      severity: data.severity,
      title: data.title,
      description: data.description,
      lat: data.lat,
      lng: data.lng,
      locationLabel: data.locationLabel,
      metadata: data.metadata,
    });
  }
}
