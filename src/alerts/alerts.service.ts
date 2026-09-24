import { Injectable, NotFoundException } from '@nestjs/common';
import {
  AlertSeverity,
  AlertStatus,
  Prisma,
  Role,
} from '../generated/prisma/client';
import { PushService } from '../notifications/push.service';
import { PrismaService } from '../prisma/prisma.service';
import { AlertsGateway } from './alerts.gateway';
import { CreateAlertDto, ListAlertsQueryDto } from './dto/alert.dto';

const include = {
  unit: { select: { id: true, code: true, plate: true } },
  operator: { select: { id: true, name: true, avatarKey: true } },
} satisfies Prisma.AlertInclude;

@Injectable()
export class AlertsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: AlertsGateway,
    private readonly push: PushService,
  ) {}

  async create(dto: CreateAlertDto) {
    const alert = await this.prisma.alert.create({
      data: {
        ...dto,
        metadata: dto.metadata as Prisma.InputJsonValue,
        severity: dto.severity ?? AlertSeverity.ADVERTENCIA,
      },
      include,
    });
    this.gateway.emitNew(alert);
    void this.notify(alert);
    return alert;
  }

  /**
   * Notifica por push a monitoreo (ADMIN/SUPERVISOR) y al operador implicado.
   * No bloquea la respuesta HTTP (fire-and-forget).
   */
  private async notify(alert: {
    id: string;
    title: string;
    description: string | null;
    severity: AlertSeverity;
    operatorId: string | null;
    unit: { code: string } | null;
  }): Promise<void> {
    const monitors = await this.prisma.user.findMany({
      where: { role: { in: [Role.ADMIN, Role.SUPERVISOR] }, isActive: true },
      select: { id: true },
    });
    const recipients = monitors.map((m) => m.id);
    if (alert.operatorId) recipients.push(alert.operatorId);

    const prefix = alert.unit?.code ? `[${alert.unit.code}] ` : '';
    await this.push
      .sendToUsers(recipients, {
        category: 'criticalAlerts',
        title: `${prefix}${alert.title}`,
        body: alert.description ?? 'Nueva alerta registrada',
        data: {
          kind: 'alert',
          alertId: alert.id,
          severity: alert.severity,
        },
      })
      .catch(() => undefined);
  }

  async findAll(query: ListAlertsQueryDto) {
    const where: Prisma.AlertWhereInput = {};
    if (query.type) where.type = query.type;
    if (query.status) where.status = query.status;
    if (query.severity) where.severity = query.severity;
    return this.prisma.alert.findMany({
      where,
      include,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async metrics() {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const [criticas, pendientes, hoy] = await Promise.all([
      this.prisma.alert.count({
        where: { severity: AlertSeverity.CRITICA, status: AlertStatus.ABIERTA },
      }),
      this.prisma.alert.count({ where: { status: AlertStatus.ABIERTA } }),
      this.prisma.alert.count({ where: { createdAt: { gte: startOfDay } } }),
    ]);
    return { criticas, pendientes, hoy };
  }

  async acknowledge(id: string, userId: string) {
    await this.ensureExists(id);
    const alert = await this.prisma.alert.update({
      where: { id },
      data: {
        status: AlertStatus.ATENDIDA,
        acknowledgedById: userId,
        acknowledgedAt: new Date(),
      },
      include,
    });
    this.gateway.emitUpdated(alert);
    return alert;
  }

  async resolve(id: string) {
    await this.ensureExists(id);
    const alert = await this.prisma.alert.update({
      where: { id },
      data: { status: AlertStatus.RESUELTA, resolvedAt: new Date() },
      include,
    });
    this.gateway.emitUpdated(alert);
    return alert;
  }

  async markAllRead() {
    await this.prisma.alert.updateMany({
      where: { status: AlertStatus.ABIERTA },
      data: { status: AlertStatus.ATENDIDA, acknowledgedAt: new Date() },
    });
    return { ok: true };
  }

  private async ensureExists(id: string) {
    const exists = await this.prisma.alert.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('Alerta no encontrada');
  }
}
