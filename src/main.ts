import 'dotenv/config';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { INestApplicationContext } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { ServerOptions } from 'socket.io';
import { AppModule } from './app.module';
import { UPLOAD_DIR } from './media/media.controller';

/**
 * Adapter de Socket.IO con buffer ampliado para permitir clips de audio
 * (push-to-talk) e imágenes por el WebSocket sin partirlos manualmente.
 */
class AudioIoAdapter extends IoAdapter {
  constructor(app: INestApplicationContext) {
    super(app);
  }
  createIOServer(port: number, options?: ServerOptions) {
    return super.createIOServer(port, {
      ...options,
      maxHttpBufferSize: 1e7, // 10 MB
      cors: { origin: '*' },
    });
  }
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  app.useWebSocketAdapter(new AudioIoAdapter(app));
  app.setGlobalPrefix('api');
  // Archivos subidos (fotos de perfil, media del chat) servidos en /uploads.
  app.useStaticAssets(UPLOAD_DIR, { prefix: '/uploads' });
  app.enableCors({
    origin: process.env.CORS_ORIGIN?.split(',') ?? '*',
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const config = new DocumentBuilder()
    .setTitle('Mape API')
    .setDescription('Monitoreo y coordinación de flota en tiempo real')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  const port = process.env.PORT ?? 3000;
  // Escuchar en todas las interfaces para que los teléfonos de la LAN puedan
  // conectarse (no solo localhost).
  await app.listen(port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`Mape API escuchando en http://0.0.0.0:${port}/api (usa la IP LAN de tu PC desde el teléfono)`);
}
void bootstrap();
