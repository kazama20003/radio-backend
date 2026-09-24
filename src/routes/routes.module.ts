import { Module } from '@nestjs/common';
import { GeofencesController } from './geofences.controller';
import { GeofencesService } from './geofences.service';
import { RoutesController } from './routes.controller';
import { RoutesService } from './routes.service';

@Module({
  controllers: [RoutesController, GeofencesController],
  providers: [RoutesService, GeofencesService],
  exports: [RoutesService, GeofencesService],
})
export class RoutesModule {}
