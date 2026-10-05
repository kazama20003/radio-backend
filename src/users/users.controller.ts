import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
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
import { PersonalSyncService } from './personal-sync.service';
import { UsersService } from './users.service';

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly personalSync: PersonalSyncService,
  ) {}

  /**
   * Importa/actualiza usuarios de la app desde el sistema de personal (RRHH).
   * Idempotente: se puede llamar cuantas veces se quiera.
   */
  @Roles(Role.ADMIN, Role.SUPERVISOR)
  @Post('sync-personal')
  syncPersonal() {
    return this.personalSync.syncFromPersonal();
  }

  @Get('me')
  me(@CurrentUser('id') id: string) {
    return this.users.me(id);
  }

  @Patch('me')
  updateMe(@CurrentUser('id') id: string, @Body() dto: UpdateProfileDto) {
    return this.users.updateProfile(id, dto);
  }

  /** Sube/actualiza la foto de perfil (multipart, campo "file"). */
  @Post('me/photo')
  @UseInterceptors(FileInterceptor('file'))
  uploadPhoto(
    @CurrentUser('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.users.setPhoto(id, file);
  }

  /** Administra la foto de cualquier usuario desde la pantalla de personal. */
  @Roles(Role.ADMIN, Role.SUPERVISOR)
  @Post(':id/photo')
  @UseInterceptors(FileInterceptor('file'))
  uploadUserPhoto(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.users.setPhoto(id, file);
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
