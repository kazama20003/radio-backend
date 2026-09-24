import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, StopStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateRouteDto,
  ListRoutesQueryDto,
  UpdateRouteStatusDto,
} from './dto/route.dto';

@Injectable()
export class RoutesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(query: ListRoutesQueryDto) {
    const where: Prisma.RouteWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.unitId) where.unitId = query.unitId;
    return this.prisma.route.findMany({
      where,
      include: {
        unit: { select: { id: true, code: true, plate: true } },
        operator: { select: { id: true, name: true } },
        stops: { orderBy: { order: 'asc' } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const route = await this.prisma.route.findUnique({
      where: { id },
      include: {
        unit: true,
        operator: { select: { id: true, name: true, avatarKey: true, phone: true } },
        stops: { orderBy: { order: 'asc' } },
      },
    });
    if (!route) throw new NotFoundException('Ruta no encontrada');
    return route;
  }

  async create(dto: CreateRouteDto) {
    const { stops, plannedDate, ...rest } = dto;
    return this.prisma.route.create({
      data: {
        ...rest,
        plannedDate: plannedDate ? new Date(plannedDate) : undefined,
        stops: stops?.length
          ? {
              create: stops.map((s) => ({
                order: s.order,
                kind: s.kind,
                name: s.name,
                address: s.address,
                lat: s.lat,
                lng: s.lng,
                plannedAt: s.plannedAt ? new Date(s.plannedAt) : undefined,
              })),
            }
          : undefined,
      },
      include: { stops: { orderBy: { order: 'asc' } } },
    });
  }

  async updateStatus(id: string, dto: UpdateRouteStatusDto) {
    await this.ensureExists(id);
    const data: Prisma.RouteUpdateInput = { status: dto.status };
    if (dto.status === 'EN_CURSO') data.startedAt = new Date();
    if (dto.status === 'COMPLETADA') data.completedAt = new Date();
    return this.prisma.route.update({ where: { id }, data });
  }

  async updateStop(stopId: string, status: StopStatus) {
    const stop = await this.prisma.routeStop.findUnique({
      where: { id: stopId },
    });
    if (!stop) throw new NotFoundException('Parada no encontrada');
    return this.prisma.routeStop.update({
      where: { id: stopId },
      data: {
        status,
        arrivedAt: status === StopStatus.COMPLETADA ? new Date() : stop.arrivedAt,
      },
    });
  }

  private async ensureExists(id: string) {
    const exists = await this.prisma.route.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('Ruta no encontrada');
  }
}
