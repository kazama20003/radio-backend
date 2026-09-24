import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { AlertsModule } from './alerts/alerts.module';
import { AuthModule } from './auth/auth.module';
import { ChatModule } from './chat/chat.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { MediaModule } from './media/media.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PreferencesModule } from './preferences/preferences.module';
import { PrismaModule } from './prisma/prisma.module';
import { RadioModule } from './radio/radio.module';
import { RoutesModule } from './routes/routes.module';
import { TrackingModule } from './tracking/tracking.module';
import { UnitsModule } from './units/units.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    NotificationsModule,
    AuthModule,
    UsersModule,
    UnitsModule,
    AlertsModule,
    TrackingModule,
    RoutesModule,
    ChatModule,
    RadioModule,
    PreferencesModule,
    MediaModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
