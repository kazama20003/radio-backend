import { IsEnum, IsNumber, IsOptional, IsString } from 'class-validator';
import { ChannelType } from '../../generated/prisma/client';

export class CreateChannelDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsEnum(ChannelType)
  type?: ChannelType;

  @IsOptional()
  @IsString()
  description?: string;
}

export class TransmissionDto {
  @IsOptional()
  @IsString()
  audioKey?: string;

  @IsNumber()
  durationSec!: number;
}
