import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateGeofenceDto, UpdateGeofenceDto } from './dto/geofence.dto';

@Injectable()
export class GeofencesService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.geofence.findMany({ orderBy: { name: 'asc' } });
  }

  create(dto: CreateGeofenceDto) {
    return this.prisma.geofence.create({ data: dto });
  }

  async update(id: string, dto: UpdateGeofenceDto) {
    await this.ensureExists(id);
    return this.prisma.geofence.update({ where: { id }, data: dto });
  }

  async remove(id: string) {
    await this.ensureExists(id);
    await this.prisma.geofence.delete({ where: { id } });
    return { ok: true };
  }

  private async ensureExists(id: string) {
    const exists = await this.prisma.geofence.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('Geocerca no encontrada');
  }
}
