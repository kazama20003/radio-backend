import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role, UnitStatus } from '../generated/prisma/client';
import { PushService } from '../notifications/push.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  AssignOperatorDto,
  CreateUnitDto,
  ListUnitsQueryDto,
  UpdateUnitDto,
} from './dto/unit.dto';

const operatorSelect = {
  id: true,
  name: true,
  avatarKey: true,
  phone: true,
  isOnline: true,
} satisfies Prisma.UserSelect;

@Injectable()
export class UnitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
  ) {}

  /** Etiquetas legibles de estado para las notificaciones. */
  private static readonly STATUS_LABEL: Record<UnitStatus, string> = {
    EN_RUTA: 'En ruta',
    DETENIDO: 'Detenido',
    DISPONIBLE: 'Disponible',
    DESCONECTADO: 'Desconectado',
    MANTENIMIENTO: 'En mantenimiento',
  };

  async findAll(query: ListUnitsQueryDto) {
    const where: Prisma.UnitWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.search) {
      where.OR = [
        { code: { contains: query.search, mode: 'insensitive' } },
        { plate: { contains: query.search, mode: 'insensitive' } },
        { operator: { name: { contains: query.search, mode: 'insensitive' } } },
      ];
    }
    return this.prisma.unit.findMany({
      where,
      include: { operator: { select: operatorSelect } },
      orderBy: { code: 'asc' },
    });
  }

  /** Resumen para el mapa: contadores por estado. */
  async summary() {
    const [total, enRuta, detenidos] = await Promise.all([
      this.prisma.unit.count({ where: { isActive: true } }),
      this.prisma.unit.count({ where: { status: UnitStatus.EN_RUTA } }),
      this.prisma.unit.count({ where: { status: UnitStatus.DETENIDO } }),
    ]);
    return { total, enRuta, detenidos };
  }

  async findOne(id: string) {
    const unit = await this.prisma.unit.findUnique({
      where: { id },
      include: {
        operator: { select: operatorSelect },
        routes: {
          where: { status: { in: ['EN_CURSO', 'PLANIFICADA'] } },
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: { stops: { orderBy: { order: 'asc' } } },
        },
      },
    });
    if (!unit) throw new NotFoundException('Unidad no encontrada');
    return unit;
  }

  async create(dto: CreateUnitDto) {
    return this.prisma.unit.create({
      data: dto,
      include: { operator: { select: operatorSelect } },
    });
  }

  async update(id: string, dto: UpdateUnitDto) {
    const before = await this.ensureExists(id);
    const unit = await this.prisma.unit.update({
      where: { id },
      data: dto,
      include: { operator: { select: operatorSelect } },
    });
    if (dto.status && dto.status !== before.status) {
      void this.notifyStatusChange(unit.id, unit.code, unit.operatorId, dto.status);
    }
    return unit;
  }

  /**
   * Push a monitoreo (ADMIN/SUPERVISOR) y al operador cuando cambia el estado
   * de una unidad manualmente. Fire-and-forget.
   */
  private async notifyStatusChange(
    unitId: string,
    code: string,
    operatorId: string | null,
    status: UnitStatus,
  ): Promise<void> {
    const monitors = await this.prisma.user.findMany({
      where: { role: { in: [Role.ADMIN, Role.SUPERVISOR] }, isActive: true },
      select: { id: true },
    });
    const recipients = monitors.map((m) => m.id);
    if (operatorId) recipients.push(operatorId);

    await this.push
      .sendToUsers(recipients, {
        category: 'unitStatus',
        title: `Unidad ${code}`,
        body: `Nuevo estado: ${UnitsService.STATUS_LABEL[status]}`,
        data: { kind: 'unitStatus', unitId, status },
      })
      .catch(() => undefined);
  }

  async assignOperator(id: string, dto: AssignOperatorDto) {
    await this.ensureExists(id);
    const already = await this.prisma.unit.findUnique({
      where: { operatorId: dto.operatorId },
    });
    if (already && already.id !== id) {
      throw new BadRequestException('El operador ya tiene una unidad asignada');
    }
    return this.prisma.unit.update({
      where: { id },
      data: { operatorId: dto.operatorId },
      include: { operator: { select: operatorSelect } },
    });
  }

  private async ensureExists(id: string) {
    const exists = await this.prisma.unit.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('Unidad no encontrada');
    return exists;
  }
}
