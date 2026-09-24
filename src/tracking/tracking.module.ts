import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AlertsModule } from '../alerts/alerts.module';
import { TrackingController } from './tracking.controller';
import { TrackingGateway } from './tracking.gateway';
import { TrackingService } from './tracking.service';

@Module({
  imports: [JwtModule.register({}), AlertsModule],
  controllers: [TrackingController],
  providers: [TrackingService, TrackingGateway],
  exports: [TrackingService],
})
export class TrackingModule {}
