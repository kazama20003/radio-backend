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
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AlertsService } from './alerts.service';
import { CreateAlertDto, ListAlertsQueryDto } from './dto/alert.dto';

@ApiTags('alerts')
@ApiBearerAuth()
@Controller('alerts')
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  findAll(@Query() query: ListAlertsQueryDto) {
    return this.alerts.findAll(query);
  }

  @Get('metrics')
  metrics() {
    return this.alerts.metrics();
  }

  @Post()
  create(@Body() dto: CreateAlertDto) {
    return this.alerts.create(dto);
  }

  @Patch('read-all')
  markAllRead() {
    return this.alerts.markAllRead();
  }

  @Patch(':id/acknowledge')
  acknowledge(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.alerts.acknowledge(id, userId);
  }

  @Patch(':id/resolve')
  resolve(@Param('id') id: string) {
    return this.alerts.resolve(id);
  }
}
