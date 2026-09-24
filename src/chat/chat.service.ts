import {
  ForbiddenException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConversationType, Prisma } from '../generated/prisma/client';
import { PushService } from '../notifications/push.service';
import { PrismaService } from '../prisma/prisma.service';
import { ChatGateway } from './chat.gateway';
import { CreateConversationDto, SendMessageDto } from './dto/chat.dto';

const memberUser = {
  select: { id: true, name: true, nickname: true, avatarKey: true, isOnline: true },
} satisfies Prisma.UserDefaultArgs;

@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => ChatGateway))
    private readonly gateway: ChatGateway,
    private readonly push: PushService,
  ) {}

  async listConversations(userId: string) {
    const conversations = await this.prisma.conversation.findMany({
      where: { members: { some: { userId } } },
      orderBy: { lastMessageAt: 'desc' },
      include: {
        members: { include: { user: memberUser } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });

    // Contadores de no leídos por conversación
    return Promise.all(
      conversations.map(async (c) => {
        const me = c.members.find((m) => m.userId === userId);
        const unread = await this.prisma.message.count({
          where: {
            conversationId: c.id,
            senderId: { not: userId },
            createdAt: me?.lastReadAt ? { gt: me.lastReadAt } : undefined,
          },
        });
        return { ...c, unread, lastMessage: c.messages[0] ?? null };
      }),
    );
  }

  async getConversation(id: string, userId: string, limit = 50) {
    await this.ensureMember(id, userId);
    const conversation = await this.prisma.conversation.findUnique({
      where: { id },
      include: { members: { include: { user: memberUser } } },
    });
    const messages = await this.prisma.message.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
      include: { sender: memberUser },
    });
    return { conversation, messages: messages.reverse() };
  }

  async createConversation(userId: string, dto: CreateConversationDto) {
    const memberIds = Array.from(new Set([userId, ...dto.memberIds]));

    // Para conversaciones directas, reutiliza la existente
    if (dto.type === ConversationType.DIRECT && memberIds.length === 2) {
      const existing = await this.prisma.conversation.findFirst({
        where: {
          type: ConversationType.DIRECT,
          AND: memberIds.map((id) => ({ members: { some: { userId: id } } })),
        },
        include: { members: { include: { user: memberUser } } },
      });
      if (existing) return existing;
    }

    return this.prisma.conversation.create({
      data: {
        type: dto.type,
        title: dto.title,
        createdById: userId,
        members: {
          create: memberIds.map((id) => ({
            userId: id,
            isAdmin: id === userId && dto.type === ConversationType.GROUP,
          })),
        },
      },
      include: { members: { include: { user: memberUser } } },
    });
  }

  async sendMessage(conversationId: string, userId: string, dto: SendMessageDto) {
    await this.ensureMember(conversationId, userId);

    const message = await this.prisma.message.create({
      data: {
        conversationId,
        senderId: userId,
        type: dto.type ?? 'TEXT',
        body: dto.body,
        attachmentKey: dto.attachmentKey,
        durationSec: dto.durationSec,
        lat: dto.lat,
        lng: dto.lng,
        locationLabel: dto.locationLabel,
      },
      include: { sender: memberUser },
    });

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: message.createdAt },
    });

    // Recibos "entregado" para el resto de miembros
    const members = await this.prisma.conversationMember.findMany({
      where: { conversationId, userId: { not: userId } },
    });
    if (members.length) {
      await this.prisma.messageReceipt.createMany({
        data: members.map((m) => ({
          messageId: message.id,
          userId: m.userId,
          deliveredAt: new Date(),
        })),
      });
    }

    this.gateway.emitMessage(conversationId, message);

    // Push a los demás miembros (fire-and-forget).
    if (members.length) {
      void this.push
        .sendToUsers(
          members.map((m) => m.userId),
          {
            category: 'chatMessages',
            title: message.sender?.name ?? 'Nuevo mensaje',
            body: this.previewFor(message.type, message.body),
            data: {
              kind: 'chat',
              conversationId,
              messageId: message.id,
            },
          },
        )
        .catch(() => undefined);
    }

    return message;
  }

  /** Texto corto para la notificación según el tipo de mensaje. */
  private previewFor(type: string, body: string | null): string {
    switch (type) {
      case 'VOICE':
        return '🎤 Nota de voz';
      case 'IMAGE':
        return '📷 Foto';
      case 'VIDEO':
        return '🎬 Video';
      case 'LOCATION':
        return '📍 Ubicación';
      default:
        return body?.slice(0, 140) || 'Nuevo mensaje';
    }
  }

  async markRead(conversationId: string, userId: string) {
    await this.ensureMember(conversationId, userId);
    const now = new Date();
    await this.prisma.conversationMember.update({
      where: { conversationId_userId: { conversationId, userId } },
      data: { lastReadAt: now },
    });
    await this.prisma.messageReceipt.updateMany({
      where: { userId, readAt: null, message: { conversationId } },
      data: { readAt: now },
    });
    return { ok: true };
  }

  private async ensureMember(conversationId: string, userId: string) {
    const member = await this.prisma.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId, userId } },
    });
    if (!member) {
      const convo = await this.prisma.conversation.findUnique({
        where: { id: conversationId },
      });
      if (!convo) throw new NotFoundException('Conversación no encontrada');
      throw new ForbiddenException('No perteneces a esta conversación');
    }
  }
}
