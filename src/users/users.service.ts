import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CloudinaryService } from '../common/cloudinary.service';
import {
  CreateUserDto,
  ListUsersQueryDto,
  UpdateProfileDto,
  UpdateUserDto,
} from './dto/user.dto';

const publicSelect = {
  id: true,
  email: true,
  name: true,
  nickname: true,
  role: true,
  shift: true,
  positionTitle: true,
  phone: true,
  avatarKey: true,
  photoUrl: true,
  operatorCode: true,
  isActive: true,
  isOnline: true,
  lastSeenAt: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  /** Sube la foto de perfil a Cloudinary y guarda la URL en el usuario. */
  async setPhoto(id: string, file?: Express.Multer.File) {
    if (!file?.buffer) throw new BadRequestException('Falta la imagen.');
    const url = await this.cloudinary.uploadImage(file.buffer, file.originalname);
    return this.prisma.user.update({
      where: { id },
      data: { photoUrl: url },
      select: publicSelect,
    });
  }

  async findAll(query: ListUsersQueryDto) {
    const where: Prisma.UserWhereInput = {};
    if (query.role) where.role = query.role;
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { email: { contains: query.search, mode: 'insensitive' } },
        { operatorCode: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    return this.prisma.user.findMany({
      where,
      select: publicSelect,
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { ...publicSelect, drivenUnit: true },
    });
    if (!user) throw new NotFoundException('Usuario no encontrado');
    return user;
  }

  async me(id: string) {
    return this.findOne(id);
  }

  async create(dto: CreateUserDto) {
    const { password, email, operatorCode, ...rest } = dto;

    // Personal sin correo: se identifica por DNI (operatorCode). El correo es
    // sintético (solo para la restricción única) y la contraseña inicial es el
    // DNI si no se indica otra.
    if (!email && !operatorCode) {
      throw new BadRequestException('Indica un correo o un DNI (código).');
    }
    const finalEmail = (email ?? `${operatorCode}@syemape.com`).toLowerCase();
    const initialPassword = password ?? operatorCode;
    if (!initialPassword || initialPassword.length < 6) {
      throw new BadRequestException(
        'La contraseña (o el DNI usado como contraseña) debe tener al menos 6 caracteres.',
      );
    }
    const passwordHash = await bcrypt.hash(initialPassword, 10);

    return this.prisma.user.create({
      data: { ...rest, email: finalEmail, operatorCode, passwordHash },
      select: publicSelect,
    });
  }

  async updateProfile(id: string, dto: UpdateProfileDto) {
    return this.prisma.user.update({
      where: { id },
      data: dto,
      select: publicSelect,
    });
  }

  async update(id: string, dto: UpdateUserDto) {
    await this.ensureExists(id);
    return this.prisma.user.update({
      where: { id },
      data: dto,
      select: publicSelect,
    });
  }

  async setOnline(id: string, isOnline: boolean) {
    return this.prisma.user.update({
      where: { id },
      data: { isOnline, lastSeenAt: new Date() },
      select: { id: true, isOnline: true, lastSeenAt: true },
    });
  }

  private async ensureExists(id: string) {
    const exists = await this.prisma.user.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('Usuario no encontrado');
  }
}
