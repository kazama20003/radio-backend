import { Module } from '@nestjs/common';
import { PersonalSyncService } from './personal-sync.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  controllers: [UsersController],
  providers: [UsersService, PersonalSyncService],
  exports: [UsersService],
})
export class UsersModule {}
