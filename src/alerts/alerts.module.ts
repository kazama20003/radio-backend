import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AlertsController } from './alerts.controller';
import { AlertsGateway } from './alerts.gateway';
import { AlertsService } from './alerts.service';

@Module({
  imports: [JwtModule.register({})],
  controllers: [AlertsController],
  providers: [AlertsService, AlertsGateway],
  exports: [AlertsService],
})
export class AlertsModule {}
