import {
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';
import { ConversationType, MessageType } from '../../generated/prisma/client';

export class CreateConversationDto {
  @IsEnum(ConversationType)
  type!: ConversationType;

  @IsOptional()
  @IsString()
  title?: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  memberIds!: string[];
}

export class SendMessageDto {
  @IsOptional()
  @IsEnum(MessageType)
  type?: MessageType;

  @IsOptional()
  @IsString()
  body?: string;

  @IsOptional()
  @IsString()
  attachmentKey?: string;

  @IsOptional()
  @IsNumber()
  durationSec?: number;

  @IsOptional()
  @IsNumber()
  lat?: number;

  @IsOptional()
  @IsNumber()
  lng?: number;

  @IsOptional()
  @IsString()
  locationLabel?: string;
}
