import { Injectable } from '@nestjs/common';
import { DevicePlatform } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  RegisterDeviceDto,
  UpdateAppSettingDto,
  UpdateNotificationPrefDto,
} from './dto/preferences.dto';

@Injectable()
export class PreferencesService {
  constructor(private readonly prisma: PrismaService) {}

  // ── Notificaciones ───────────────────────────────────────────
  async getNotificationPref(userId: string) {
    return this.prisma.notificationPreference.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
  }

  async updateNotificationPref(userId: string, dto: UpdateNotificationPrefDto) {
    return this.prisma.notificationPreference.upsert({
      where: { userId },
      create: { userId, ...dto },
      update: dto,
    });
  }

  // ── Device tokens (push) ─────────────────────────────────────
  async registerDevice(userId: string, dto: RegisterDeviceDto) {
    return this.prisma.deviceToken.upsert({
      where: { token: dto.token },
      create: { userId, token: dto.token, platform: dto.platform },
      update: { userId, platform: dto.platform },
    });
  }

  async removeDevice(userId: string, token: string) {
    await this.prisma.deviceToken
      .deleteMany({ where: { userId, token } })
      .catch(() => undefined);
    return { ok: true };
  }

  // ── Ajustes de la app ────────────────────────────────────────
  async getAppSetting(userId: string) {
    return this.prisma.appSetting.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
  }

  async updateAppSetting(userId: string, dto: UpdateAppSettingDto) {
    return this.prisma.appSetting.upsert({
      where: { userId },
      create: { userId, ...dto },
      update: dto,
    });
  }
}
