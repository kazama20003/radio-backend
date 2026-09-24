import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../generated/prisma/client';
import {
  AssignOperatorDto,
  CreateUnitDto,
  ListUnitsQueryDto,
  UpdateUnitDto,
} from './dto/unit.dto';
import { UnitsService } from './units.service';

@ApiTags('units')
@ApiBearerAuth()
@Controller('units')
export class UnitsController {
  constructor(private readonly units: UnitsService) {}

  @Get()
  findAll(@Query() query: ListUnitsQueryDto) {
    return this.units.findAll(query);
  }

  @Get('summary')
  summary() {
    return this.units.summary();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.units.findOne(id);
  }

  @Roles(Role.ADMIN, Role.SUPERVISOR)
  @Post()
  create(@Body() dto: CreateUnitDto) {
    return this.units.create(dto);
  }

  @Roles(Role.ADMIN, Role.SUPERVISOR)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateUnitDto) {
    return this.units.update(id, dto);
  }

  @Roles(Role.ADMIN, Role.SUPERVISOR)
  @Patch(':id/operator')
  assignOperator(@Param('id') id: string, @Body() dto: AssignOperatorDto) {
    return this.units.assignOperator(id, dto);
  }
}
