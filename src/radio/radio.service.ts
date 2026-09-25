import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AccessToken } from 'livekit-server-sdk';
import { Prisma } from '../generated/prisma/client';
import { PushService } from '../notifications/push.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateChannelDto, TransmissionDto } from './dto/radio.dto';

const senderSelect = {
  select: { id: true, name: true, nickname: true, avatarKey: true },
} satisfies Prisma.UserDefaultArgs;

@Injectable()
export class RadioService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
  ) {}

  async listChannels(userId: string) {
    const channels = await this.prisma.channel.findMany({
      where: { isActive: true },
      include: { _count: { select: { members: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const memberships = await this.prisma.channelMember.findMany({
      where: { userId },
      select: { channelId: true },
    });
    const mine = new Set(memberships.map((m) => m.channelId));
    return channels.map((c) => ({
      ...c,
      memberCount: c._count.members,
      joined: mine.has(c.id),
    }));
  }

  async createChannel(dto: CreateChannelDto) {
    return this.prisma.channel.create({ data: dto });
  }

  async join(channelId: string, userId: string) {
    await this.ensureChannel(channelId);
    await this.prisma.channelMember.upsert({
      where: { channelId_userId: { channelId, userId } },
      create: { channelId, userId },
      update: {},
    });
    return { ok: true };
  }

  async leave(channelId: string, userId: string) {
    await this.prisma.channelMember
      .delete({ where: { channelId_userId: { channelId, userId } } })
      .catch(() => undefined);
    return { ok: true };
  }

  async recordTransmission(
    channelId: string,
    senderId: string,
    dto: TransmissionDto,
  ) {
    await this.ensureChannel(channelId);
    return this.prisma.radioTransmission.create({
      data: {
        channelId,
        senderId,
        audioKey: dto.audioKey,
        durationSec: dto.durationSec,
      },
      include: { sender: senderSelect },
    });
  }

  /**
   * Notifica por push a los miembros del canal que una transmisión terminó.
   * Excluye al emisor y a quienes están escuchando en vivo (`excludeUserIds`),
   * pensado para avisar a los que tienen la app cerrada.
   */
  async notifyBroadcast(
    channelId: string,
    sender: { id: string; name?: string | null },
    excludeUserIds: string[] = [],
  ): Promise<void> {
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
      select: { name: true },
    });
    if (!channel) return;

    const exclude = new Set([sender.id, ...excludeUserIds]);
    const members = await this.prisma.channelMember.findMany({
      where: { channelId },
      select: { userId: true },
    });
    const recipients = members
      .map((m) => m.userId)
      .filter((id) => !exclude.has(id));
    if (!recipients.length) return;

    await this.push
      .sendToUsers(recipients, {
        category: 'radioBroadcasts',
        title: `📻 ${channel.name}`,
        body: `${sender.name ?? 'Alguien'} transmitió por radio`,
        data: { kind: 'radio', channelId },
      })
      .catch(() => undefined);
  }

  async history(channelId: string, limit = 50) {
    return this.prisma.radioTransmission.findMany({
      where: { channelId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
      include: { sender: senderSelect },
    });
  }

  /**
   * Genera un token de acceso a LiveKit para que el usuario entre a la "sala"
   * del canal y transmita/escuche audio PTT en tiempo real. El audio viaja por
   * LiveKit, no por el WebSocket de señalización.
   */
  async createAccessToken(
    channelId: string,
    user: { id: string; email: string },
  ) {
    await this.ensureChannel(channelId);

    const url = process.env.LIVEKIT_URL;
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    if (!url || !apiKey || !apiSecret) {
      throw new ServiceUnavailableException(
        'LiveKit no está configurado (define LIVEKIT_URL, LIVEKIT_API_KEY y LIVEKIT_API_SECRET).',
      );
    }

    const room = `channel:${channelId}`;
    const at = new AccessToken(apiKey, apiSecret, {
      identity: user.id,
      name: user.email,
    });
    at.addGrant({
      room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    });

    const token = await at.toJwt();
    return { url, room, token };
  }

  private async ensureChannel(id: string) {
    const channel = await this.prisma.channel.findUnique({ where: { id } });
    if (!channel) throw new NotFoundException('Canal no encontrado');
  }
}
