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
import { ChatService } from './chat.service';
import { CreateConversationDto, SendMessageDto } from './dto/chat.dto';

@ApiTags('chat')
@ApiBearerAuth()
@Controller('conversations')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get()
  list(@CurrentUser('id') userId: string) {
    return this.chat.listConversations(userId);
  }

  @Post()
  create(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateConversationDto,
  ) {
    return this.chat.createConversation(userId, dto);
  }

  @Get(':id')
  getOne(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Query('limit') limit?: string,
  ) {
    return this.chat.getConversation(id, userId, limit ? Number(limit) : 50);
  }

  @Post(':id/messages')
  send(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() dto: SendMessageDto,
  ) {
    return this.chat.sendMessage(id, userId, dto);
  }

  @Post(':id/read')
  markRead(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.chat.markRead(id, userId);
  }
}
