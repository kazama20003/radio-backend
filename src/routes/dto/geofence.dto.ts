import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';
import { GeofenceType } from '../../generated/prisma/client';

export class CreateGeofenceDto {
  @IsString()
  name!: string;

  @IsEnum(GeofenceType)
  type!: GeofenceType;

  @IsNumber()
  centerLat!: number;

  @IsNumber()
  centerLng!: number;

  @IsNumber()
  radiusMeters!: number;
}

export class UpdateGeofenceDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsNumber()
  radiusMeters?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
