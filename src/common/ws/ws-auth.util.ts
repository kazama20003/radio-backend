import { JwtService } from '@nestjs/jwt';
import type { Socket } from 'socket.io';

export interface WsUser {
  id: string;
  email: string;
  role: string;
  name?: string;
  nickname?: string | null;
}

/** Extrae y valida el JWT del handshake de Socket.IO. */
export async function authenticateSocket(
  client: Socket,
  jwt: JwtService,
): Promise<WsUser | null> {
  const raw =
    (client.handshake.auth?.token as string | undefined) ??
    client.handshake.headers?.authorization?.replace('Bearer ', '');
  if (!raw) return null;
  try {
    const payload = await jwt.verifyAsync(raw, {
      secret: process.env.JWT_ACCESS_SECRET ?? 'dev-access-secret',
    });
    return {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
      name: payload.name,
      nickname: payload.nickname,
    };
  } catch {
    return null;
  }
}
