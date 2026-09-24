import { Global, Module } from '@nestjs/common';
import { PushService } from './push.service';

/**
 * Módulo global de notificaciones push (Expo). Se marca @Global para que
 * cualquier módulo (alerts, chat, radio…) pueda inyectar PushService sin
 * volver a importarlo.
 */
@Global()
@Module({
  providers: [PushService],
  exports: [PushService],
})
export class NotificationsModule {}
