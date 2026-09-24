import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { DevicePlatform } from '../../generated/prisma/client';

export class UpdateNotificationPrefDto {
  @IsOptional() @IsBoolean() criticalAlerts?: boolean;
  @IsOptional() @IsBoolean() chatMessages?: boolean;
  @IsOptional() @IsBoolean() radioBroadcasts?: boolean;
  @IsOptional() @IsBoolean() unitStatus?: boolean;
  @IsOptional() @IsBoolean() dailyDigest?: boolean;
  @IsOptional() @IsBoolean() soundVibration?: boolean;
  @IsOptional() @IsBoolean() doNotDisturb?: boolean;
  @IsOptional() @IsString() dndFrom?: string;
  @IsOptional() @IsString() dndTo?: string;
}

export class RegisterDeviceDto {
  @IsString()
  token!: string;

  @IsEnum(DevicePlatform)
  platform!: DevicePlatform;
}

export class UpdateAppSettingDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(300)
  refreshIntervalSec?: number;

  @IsOptional() @IsBoolean() liveLocation?: boolean;
  @IsOptional() @IsBoolean() transitMap?: boolean;
  @IsOptional() @IsBoolean() radioSound?: boolean;
  @IsOptional() @IsBoolean() criticalAlerts?: boolean;
  @IsOptional() @IsBoolean() darkMode?: boolean;
}
