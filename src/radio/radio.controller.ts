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
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../generated/prisma/client';
import { CreateChannelDto } from './dto/radio.dto';
import { RadioService } from './radio.service';

@ApiTags('radio')
@ApiBearerAuth()
@Controller('radio/channels')
export class RadioController {
  constructor(private readonly radio: RadioService) {}

  @Get()
  list(@CurrentUser('id') userId: string) {
    return this.radio.listChannels(userId);
  }

  @Roles(Role.ADMIN, Role.SUPERVISOR)
  @Post()
  create(@Body() dto: CreateChannelDto) {
    return this.radio.createChannel(dto);
  }

  @Post(':id/join')
  join(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.radio.join(id, userId);
  }

  @Post(':id/leave')
  leave(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.radio.leave(id, userId);
  }

  @Get(':id/history')
  history(@Param('id') id: string, @Query('limit') limit?: string) {
    return this.radio.history(id, limit ? Number(limit) : 50);
  }

  /** Token de acceso LiveKit para transmitir/escuchar audio PTT en el canal. */
  @Post(':id/token')
  token(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.radio.createAccessToken(id, user);
  }
}
