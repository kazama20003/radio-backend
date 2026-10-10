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
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../generated/prisma/client';
import { CreateChannelDto } from './dto/radio.dto';
import { RadioService } from './radio.service';
import { RadioGateway } from './radio.gateway';

@ApiTags('radio')
@ApiBearerAuth()
@Controller('radio/channels')
export class RadioController {
  constructor(
    private readonly radio: RadioService,
    private readonly gateway: RadioGateway,
  ) {}

  @Get()
  list(@CurrentUser('id') userId: string) {
    return this.radio.listChannels(userId);
  }

  @Roles(Role.ADMIN)
  @Post()
  async create(@Body() dto: CreateChannelDto) {
    const channel = await this.radio.createChannel(dto);
    if (channel.isImportant) this.gateway.announceImportantChannelChanged(channel.id);
    return channel;
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
  history(
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
    @Query('after') after?: string,
  ) {
    return this.radio.history(id, limit ? Number(limit) : 50, before, after);
  }
}
