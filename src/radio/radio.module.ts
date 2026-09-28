import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { MediasoupService } from './mediasoup.service';
import { RadioController } from './radio.controller';
import { RadioFloorService } from './radio-floor.service';
import { RadioGateway } from './radio.gateway';
import { RadioService } from './radio.service';

@Module({
  imports: [JwtModule.register({})],
  controllers: [RadioController],
  providers: [RadioService, RadioGateway, RadioFloorService, MediasoupService],
  exports: [RadioService],
})
export class RadioModule {}
