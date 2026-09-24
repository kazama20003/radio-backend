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
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../generated/prisma/client';
import {
  CreateUserDto,
  ListUsersQueryDto,
  UpdateProfileDto,
  UpdateUserDto,
} from './dto/user.dto';
import { UsersService } from './users.service';

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  me(@CurrentUser('id') id: string) {
    return this.users.me(id);
  }

  @Patch('me')
  updateMe(@CurrentUser('id') id: string, @Body() dto: UpdateProfileDto) {
    return this.users.updateProfile(id, dto);
  }

  @Get()
  findAll(@Query() query: ListUsersQueryDto) {
    return this.users.findAll(query);
  }

  @Roles(Role.ADMIN, Role.SUPERVISOR)
  @Post()
  create(@Body() dto: CreateUserDto) {
    return this.users.create(dto);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.users.findOne(id);
  }

  @Roles(Role.ADMIN, Role.SUPERVISOR)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.users.update(id, dto);
  }
}
