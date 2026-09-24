import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../generated/prisma/client';
import { CreateGeofenceDto, UpdateGeofenceDto } from './dto/geofence.dto';
import { GeofencesService } from './geofences.service';

@ApiTags('geofences')
@ApiBearerAuth()
@Controller('geofences')
export class GeofencesController {
  constructor(private readonly geofences: GeofencesService) {}

  @Get()
  findAll() {
    return this.geofences.findAll();
  }

  @Roles(Role.ADMIN, Role.SUPERVISOR)
  @Post()
  create(@Body() dto: CreateGeofenceDto) {
    return this.geofences.create(dto);
  }

  @Roles(Role.ADMIN, Role.SUPERVISOR)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateGeofenceDto) {
    return this.geofences.update(id, dto);
  }

  @Roles(Role.ADMIN, Role.SUPERVISOR)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.geofences.remove(id);
  }
}
