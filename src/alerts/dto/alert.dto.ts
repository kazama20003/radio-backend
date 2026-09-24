import {
  IsEnum,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';
import {
  AlertSeverity,
  AlertStatus,
  AlertType,
} from '../../generated/prisma/client';

export class CreateAlertDto {
  @IsEnum(AlertType)
  type!: AlertType;

  @IsOptional()
  @IsEnum(AlertSeverity)
  severity?: AlertSeverity;

  @IsOptional()
  @IsString()
  unitId?: string;

  @IsOptional()
  @IsString()
  operatorId?: string;

  @IsString()
  title!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsNumber()
  lat?: number;

  @IsOptional()
  @IsNumber()
  lng?: number;

  @IsOptional()
  @IsString()
  locationLabel?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class ListAlertsQueryDto {
  @IsOptional()
  @IsEnum(AlertType)
  type?: AlertType;

  @IsOptional()
  @IsEnum(AlertStatus)
  status?: AlertStatus;

  @IsOptional()
  @IsEnum(AlertSeverity)
  severity?: AlertSeverity;
}
