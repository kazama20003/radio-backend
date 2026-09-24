import { Injectable, Logger } from '@nestjs/common';
import { Expo, ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';
import { PrismaService } from '../prisma/prisma.service';

/** Categorías que se mapean 1:1 con los toggles de NotificationPreference. */
export type PushCategory =
  | 'criticalAlerts'
  | 'chatMessages'
  | 'radioBroadcasts'
  | 'unitStatus';

export interface PushPayload {
  title: string;
  body: string;
  /** Datos arbitrarios que la app recibe para navegar (deep-link). */
  data?: Record<string, unknown>;
  /** Categoría para respetar las preferencias del usuario. */
  category: PushCategory;
}

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly expo = new Expo({
    accessToken: process.env.EXPO_ACCESS_TOKEN || undefined,
  });

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Envía una notificación push a un conjunto de usuarios respetando sus
   * preferencias (categoría + No Molestar). Los tokens Expo inválidos se
   * eliminan automáticamente según los tickets/errores devueltos.
   */
  async sendToUsers(
    userIds: string[],
    payload: PushPayload,
  ): Promise<void> {
    const ids = Array.from(new Set(userIds)).filter(Boolean);
    if (!ids.length) return;

    // Solo usuarios que permiten esta categoría y no están en No Molestar.
    const eligible = await this.filterEligible(ids, payload.category);
    if (!eligible.length) return;

    const devices = await this.prisma.deviceToken.findMany({
      where: { userId: { in: eligible } },
    });

    const messages: ExpoPushMessage[] = [];
    const invalidTokens: string[] = [];

    for (const device of devices) {
      if (!Expo.isExpoPushToken(device.token)) {
        invalidTokens.push(device.token);
        continue;
      }
      messages.push({
        to: device.token,
        title: payload.title,
        body: payload.body,
        data: payload.data ?? {},
        sound: 'default',
        priority: payload.category === 'criticalAlerts' ? 'high' : 'default',
        channelId: payload.category,
      });
    }

    if (invalidTokens.length) await this.removeTokens(invalidTokens);
    if (!messages.length) return;

    const tickets = await this.sendChunks(messages);
    await this.handleTickets(messages, tickets);
  }

  /** Envía a un único usuario (helper). */
  sendToUser(userId: string, payload: PushPayload): Promise<void> {
    return this.sendToUsers([userId], payload);
  }

  // ── internos ───────────────────────────────────────────────────

  private async filterEligible(
    userIds: string[],
    category: PushCategory,
  ): Promise<string[]> {
    const prefs = await this.prisma.notificationPreference.findMany({
      where: { userId: { in: userIds } },
    });
    const byUser = new Map(prefs.map((p) => [p.userId, p]));

    return userIds.filter((userId) => {
      const pref = byUser.get(userId);
      // Sin preferencias guardadas → se asumen los defaults (todo activo).
      if (!pref) return true;
      if (pref[category] === false) return false;
      if (this.isWithinDnd(pref.doNotDisturb, pref.dndFrom, pref.dndTo)) {
        // Las alertas críticas ignoran el modo No Molestar.
        return category === 'criticalAlerts';
      }
      return true;
    });
  }

  /**
   * Determina si "ahora" (hora local del servidor) cae dentro de la ventana
   * No Molestar "HH:mm"–"HH:mm". Soporta ventanas que cruzan medianoche.
   */
  private isWithinDnd(
    enabled: boolean,
    from?: string | null,
    to?: string | null,
  ): boolean {
    if (!enabled || !from || !to) return false;
    const now = new Date();
    const cur = now.getHours() * 60 + now.getMinutes();
    const start = this.toMinutes(from);
    const end = this.toMinutes(to);
    if (start === null || end === null) return false;
    return start <= end
      ? cur >= start && cur < end
      : cur >= start || cur < end; // cruza medianoche
  }

  private toMinutes(hhmm: string): number | null {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  }

  private async sendChunks(
    messages: ExpoPushMessage[],
  ): Promise<ExpoPushTicket[]> {
    const chunks = this.expo.chunkPushNotifications(messages);
    const tickets: ExpoPushTicket[] = [];
    for (const chunk of chunks) {
      try {
        const res = await this.expo.sendPushNotificationsAsync(chunk);
        tickets.push(...res);
      } catch (err) {
        this.logger.error(
          `Fallo enviando chunk de push: ${(err as Error).message}`,
        );
      }
    }
    return tickets;
  }

  /** Limpia tokens que Expo marca como no registrados (DeviceNotRegistered). */
  private async handleTickets(
    messages: ExpoPushMessage[],
    tickets: ExpoPushTicket[],
  ): Promise<void> {
    const toRemove: string[] = [];
    tickets.forEach((ticket, i) => {
      if (ticket.status === 'error') {
        const to = messages[i]?.to;
        const token = Array.isArray(to) ? to[0] : to;
        if (
          ticket.details?.error === 'DeviceNotRegistered' &&
          typeof token === 'string'
        ) {
          toRemove.push(token);
        } else {
          this.logger.warn(
            `Ticket push con error: ${ticket.message ?? ticket.details?.error}`,
          );
        }
      }
    });
    if (toRemove.length) await this.removeTokens(toRemove);
  }

  private async removeTokens(tokens: string[]): Promise<void> {
    await this.prisma.deviceToken
      .deleteMany({ where: { token: { in: tokens } } })
      .catch((err) =>
        this.logger.error(
          `No se pudieron eliminar tokens inválidos: ${(err as Error).message}`,
        ),
      );
    this.logger.log(`${tokens.length} token(s) push inválido(s) eliminado(s).`);
  }
}
