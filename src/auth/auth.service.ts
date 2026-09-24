import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { OtpPurpose, User } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  ForgotPasswordDto,
  LoginDto,
  RegisterDto,
  ResetPasswordDto,
  VerifyOtpDto,
} from './dto/auth.dto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  // ── Registro (admin/supervisor crea operadores) ──────────────
  async register(dto: RegisterDto) {
    const exists = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (exists) throw new BadRequestException('El correo ya está registrado');

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        passwordHash,
        name: dto.name,
        operatorCode: dto.operatorCode,
      },
    });
    return this.buildSession(user);
  }

  // ── Login ────────────────────────────────────────────────────
  async login(dto: LoginDto) {
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [
          { email: dto.identifier.toLowerCase() },
          { operatorCode: dto.identifier },
        ],
        isActive: true,
      },
    });
    if (!user) throw new UnauthorizedException('Credenciales inválidas');

    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('Credenciales inválidas');

    await this.prisma.user.update({
      where: { id: user.id },
      data: { isOnline: true, lastSeenAt: new Date() },
    });
    return this.buildSession(user);
  }

  // ── Refresh de tokens ────────────────────────────────────────
  async refresh(refreshToken: string) {
    let payload: { sub: string };
    try {
      payload = await this.jwt.verifyAsync(refreshToken, {
        secret: process.env.JWT_REFRESH_SECRET ?? 'dev-refresh-secret',
      });
    } catch {
      throw new UnauthorizedException('Refresh token inválido');
    }

    const tokens = await this.prisma.refreshToken.findMany({
      where: { userId: payload.sub, revokedAt: null },
    });
    const match = await this.findMatchingToken(refreshToken, tokens);
    if (!match) throw new UnauthorizedException('Sesión no reconocida');

    // Rotación: revoca el anterior
    await this.prisma.refreshToken.update({
      where: { id: match.id },
      data: { revokedAt: new Date() },
    });

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
    });
    if (!user) throw new UnauthorizedException('Usuario no encontrado');
    return this.buildSession(user);
  }

  async logout(userId: string) {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.prisma.user.update({
      where: { id: userId },
      data: { isOnline: false, lastSeenAt: new Date() },
    });
    return { ok: true };
  }

  // ── Recuperación de acceso por OTP ───────────────────────────
  async forgotPassword(dto: ForgotPasswordDto) {
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [{ email: dto.destination.toLowerCase() }, { phone: dto.destination }],
      },
    });

    // Respuesta uniforme para no filtrar si el destino existe
    if (!user) return { sent: true, destination: this.mask(dto.destination) };

    const code = this.generateCode();
    const codeHash = await bcrypt.hash(code, 10);
    const ttl = Number(process.env.OTP_TTL_MINUTES ?? 10);

    await this.prisma.otpCode.create({
      data: {
        userId: user.id,
        destination: dto.destination,
        codeHash,
        purpose: OtpPurpose.PASSWORD_RESET,
        expiresAt: new Date(Date.now() + ttl * 60_000),
      },
    });

    // TODO: integrar envío real (email/SMS). Por ahora se registra en log.
    this.logger.log(`OTP para ${dto.destination}: ${code}`);
    return { sent: true, destination: this.mask(dto.destination) };
  }

  async verifyOtp(dto: VerifyOtpDto) {
    await this.consumeOtp(dto.destination, dto.code, false);
    return { valid: true };
  }

  async resetPassword(dto: ResetPasswordDto) {
    const otp = await this.consumeOtp(dto.destination, dto.code, true);
    const passwordHash = await bcrypt.hash(dto.newPassword, 10);
    await this.prisma.user.update({
      where: { id: otp.userId! },
      data: { passwordHash },
    });
    // Revoca sesiones activas
    await this.prisma.refreshToken.updateMany({
      where: { userId: otp.userId!, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { ok: true };
  }

  // ── Helpers ──────────────────────────────────────────────────
  private async buildSession(user: User) {
    const payload = { sub: user.id, email: user.email, role: user.role };
    const accessToken = await this.jwt.signAsync(payload, {
      secret: process.env.JWT_ACCESS_SECRET ?? 'dev-access-secret',
      expiresIn: (process.env.JWT_ACCESS_TTL ?? '15m') as unknown as number,
    });
    const refreshToken = await this.jwt.signAsync(
      { sub: user.id },
      {
        secret: process.env.JWT_REFRESH_SECRET ?? 'dev-refresh-secret',
        expiresIn: (process.env.JWT_REFRESH_TTL ?? '30d') as unknown as number,
      },
    );

    const tokenHash = await bcrypt.hash(refreshToken, 10);
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        shift: user.shift,
        positionTitle: user.positionTitle,
        avatarKey: user.avatarKey,
      },
    };
  }

  private async findMatchingToken(
    plain: string,
    tokens: { id: string; tokenHash: string }[],
  ) {
    for (const t of tokens) {
      if (await bcrypt.compare(plain, t.tokenHash)) return t;
    }
    return null;
  }

  private async consumeOtp(destination: string, code: string, consume: boolean) {
    const otp = await this.prisma.otpCode.findFirst({
      where: {
        destination,
        purpose: OtpPurpose.PASSWORD_RESET,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!otp) throw new BadRequestException('Código inválido o expirado');
    if (otp.attempts >= 5)
      throw new BadRequestException('Demasiados intentos, solicita otro código');

    const ok = await bcrypt.compare(code, otp.codeHash);
    if (!ok) {
      await this.prisma.otpCode.update({
        where: { id: otp.id },
        data: { attempts: { increment: 1 } },
      });
      throw new BadRequestException('Código incorrecto');
    }

    if (consume) {
      await this.prisma.otpCode.update({
        where: { id: otp.id },
        data: { consumedAt: new Date() },
      });
    }
    return otp;
  }

  private generateCode(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  private mask(value: string): string {
    if (value.includes('@')) {
      const [name, domain] = value.split('@');
      return `${name.slice(0, 2)}***@${domain}`;
    }
    return `***${value.slice(-3)}`;
  }
}
