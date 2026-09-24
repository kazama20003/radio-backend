import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import {
  RouteStatus,
  StopKind,
  StopStatus,
} from '../../generated/prisma/client';

export class CreateStopDto {
  @IsNumber()
  order!: number;

  @IsOptional()
  @IsEnum(StopKind)
  kind?: StopKind;

  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsNumber()
  lat?: number;

  @IsOptional()
  @IsNumber()
  lng?: number;

  @IsOptional()
  @IsString()
  plannedAt?: string;
}

export class CreateRouteDto {
  @IsString()
  code!: string;

  @IsOptional()
  @IsString()
  unitId?: string;

  @IsOptional()
  @IsString()
  operatorId?: string;

  @IsOptional()
  @IsString()
  plannedDate?: string;

  @IsOptional()
  @IsString()
  cargoDescription?: string;

  @IsOptional()
  @IsNumber()
  cargoPallets?: number;

  @IsOptional()
  @IsNumber()
  cargoWeightTons?: number;

  @IsOptional()
  @IsString()
  guiaRemision?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateStopDto)
  stops?: CreateStopDto[];
}

export class UpdateRouteStatusDto {
  @IsEnum(RouteStatus)
  status!: RouteStatus;
}

export class UpdateStopStatusDto {
  @IsEnum(StopStatus)
  status!: StopStatus;
}

export class ListRoutesQueryDto {
  @IsOptional()
  @IsEnum(RouteStatus)
  status?: RouteStatus;

  @IsOptional()
  @IsString()
  unitId?: string;
}
