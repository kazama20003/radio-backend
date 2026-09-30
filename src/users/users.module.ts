import { Module } from '@nestjs/common';
import { CloudinaryService } from '../common/cloudinary.service';
import { PersonalSyncService } from './personal-sync.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  controllers: [UsersController],
  providers: [UsersService, PersonalSyncService, CloudinaryService],
  exports: [UsersService],
})
export class UsersModule {}
