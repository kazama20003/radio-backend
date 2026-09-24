import { Injectable } from '@nestjs/common';
import type { WsUser } from '../common/ws/ws-auth.util';

/** Un participante que tiene o pide la palabra en un canal. */
export interface FloorUser {
  socketId: string;
  user: WsUser;
}

interface ChannelState {
  /** Quién tiene la palabra ahora mismo (null = canal libre). */
  current: FloorUser | null;
  /** Cola de quienes esperan turno, en orden de llegada. */
  queue: FloorUser[];
}

/**
 * Gestiona los turnos de habla (push-to-talk medio dúplex) de cada canal de
 * radio: un solo hablante a la vez y una cola de "pedir la palabra". Todo el
 * estado es en memoria porque es efímero y por instancia (una radio en vivo).
 */
@Injectable()
export class RadioFloorService {
  private readonly channels = new Map<string, ChannelState>();

  private state(channelId: string): ChannelState {
    let s = this.channels.get(channelId);
    if (!s) {
      s = { current: null, queue: [] };
      this.channels.set(channelId, s);
    }
    return s;
  }

  /**
   * Intenta tomar la palabra. Si el canal está libre la concede; si está
   * ocupado, encola al usuario y devuelve su posición.
   */
  request(
    channelId: string,
    user: FloorUser,
  ): { status: 'granted' } | { status: 'queued'; position: number } {
    const s = this.state(channelId);

    if (!s.current) {
      s.current = user;
      return { status: 'granted' };
    }
    // Ya tiene la palabra: refresca su socket por si reconectó.
    if (s.current.user.id === user.user.id) {
      s.current = user;
      return { status: 'granted' };
    }
    // Ya está en la cola: devuelve su posición actual.
    const existing = s.queue.findIndex((q) => q.user.id === user.user.id);
    if (existing >= 0) {
      s.queue[existing] = user;
      return { status: 'queued', position: existing + 1 };
    }
    s.queue.push(user);
    return { status: 'queued', position: s.queue.length };
  }

  /** ¿Este usuario tiene la palabra en el canal? */
  isSpeaker(channelId: string, userId: string): boolean {
    return this.state(channelId).current?.user.id === userId;
  }

  /**
   * Libera la palabra si `userId` es el hablante actual y promueve al siguiente
   * de la cola. Devuelve el nuevo hablante (o null si nadie esperaba).
   */
  release(channelId: string, userId: string): FloorUser | null {
    const s = this.state(channelId);
    if (s.current?.user.id !== userId) return null;
    s.current = s.queue.shift() ?? null;
    return s.current;
  }

  /** Quita a un usuario de la cola. Devuelve true si estaba en ella. */
  cancel(channelId: string, userId: string): boolean {
    const s = this.state(channelId);
    const before = s.queue.length;
    s.queue = s.queue.filter((q) => q.user.id !== userId);
    return s.queue.length !== before;
  }

  /**
   * Procesa una desconexión en todos los canales: si el usuario era el hablante
   * libera y promueve al siguiente; si estaba en cola, lo quita. Devuelve los
   * canales afectados para que el gateway reemita el estado.
   */
  handleDisconnect(
    userId: string,
  ): { channelId: string; next: FloorUser | null; wasSpeaker: boolean }[] {
    const changes: {
      channelId: string;
      next: FloorUser | null;
      wasSpeaker: boolean;
    }[] = [];

    for (const [channelId, s] of this.channels) {
      if (s.current?.user.id === userId) {
        s.current = s.queue.shift() ?? null;
        changes.push({ channelId, next: s.current, wasSpeaker: true });
      } else {
        const before = s.queue.length;
        s.queue = s.queue.filter((q) => q.user.id !== userId);
        if (s.queue.length !== before) {
          changes.push({ channelId, next: null, wasSpeaker: false });
        }
      }
    }
    return changes;
  }

  /** Hablante actual del canal (o null). */
  current(channelId: string): FloorUser | null {
    return this.state(channelId).current;
  }

  /** Cola de espera del canal como lista de usuarios con su posición. */
  queue(channelId: string): { position: number; user: WsUser }[] {
    return this.state(channelId).queue.map((q, i) => ({
      position: i + 1,
      user: q.user,
    }));
  }
}
