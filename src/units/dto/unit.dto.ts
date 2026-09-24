import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';
import { UnitStatus } from '../../generated/prisma/client';

export class CreateUnitDto {
  @IsString()
  code!: string;

  @IsString()
  plate!: string;

  @IsOptional()
  @IsString()
  brand?: string;

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @IsNumber()
  capacityTons?: number;

  @IsOptional()
  @IsString()
  operatorId?: string;
}

export class UpdateUnitDto {
  @IsOptional()
  @IsString()
  brand?: string;

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @IsNumber()
  capacityTons?: number;

  @IsOptional()
  @IsEnum(UnitStatus)
  status?: UnitStatus;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class AssignOperatorDto {
  @IsString()
  operatorId!: string;
}

export class ListUnitsQueryDto {
  @IsOptional()
  @IsEnum(UnitStatus)
  status?: UnitStatus;

  @IsOptional()
  @IsString()
  search?: string;
}
