import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../generated/prisma/client';
import {
  CreateRouteDto,
  ListRoutesQueryDto,
  UpdateRouteStatusDto,
  UpdateStopStatusDto,
} from './dto/route.dto';
import { RoutesService } from './routes.service';

@ApiTags('routes')
@ApiBearerAuth()
@Controller('routes')
export class RoutesController {
  constructor(private readonly routes: RoutesService) {}

  @Get()
  findAll(@Query() query: ListRoutesQueryDto) {
    return this.routes.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.routes.findOne(id);
  }

  @Roles(Role.ADMIN, Role.SUPERVISOR)
  @Post()
  create(@Body() dto: CreateRouteDto) {
    return this.routes.create(dto);
  }

  @Patch(':id/status')
  updateStatus(@Param('id') id: string, @Body() dto: UpdateRouteStatusDto) {
    return this.routes.updateStatus(id, dto);
  }

  @Patch('stops/:stopId/status')
  updateStop(
    @Param('stopId') stopId: string,
    @Body() dto: UpdateStopStatusDto,
  ) {
    return this.routes.updateStop(stopId, dto.status);
  }
}
