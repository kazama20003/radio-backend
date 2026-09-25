import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { IngestPositionDto, IngestUserPositionDto } from './dto/tracking.dto';
import { TrackingService } from './tracking.service';

@ApiTags('tracking')
@ApiBearerAuth()
@Controller('tracking')
export class TrackingController {
  constructor(private readonly tracking: TrackingService) {}

  /** Ingesta de posición desde la app del operador. */
  @Post('positions')
  ingest(@Body() dto: IngestPositionDto) {
    return this.tracking.ingest(dto);
  }

  /** Mapa en vivo: última posición de cada unidad. */
  @Get('live')
  live() {
    return this.tracking.liveMap();
  }

  /** Reporte de posición del propio usuario autenticado (cualquier rol). */
  @Post('me/position')
  reportMyPosition(
    @CurrentUser('id') userId: string,
    @Body() dto: IngestUserPositionDto,
  ) {
    return this.tracking.ingestPresence(userId, dto);
  }

  /** Presencia en vivo: última posición de cada persona conectada. */
  @Get('people')
  people() {
    return this.tracking.livePeople();
  }

  @Get('units/:unitId/history')
  history(
    @Param('unitId') unitId: string,
    @Query('limit') limit?: string,
  ) {
    return this.tracking.history(unitId, limit ? Number(limit) : 100);
  }
}
