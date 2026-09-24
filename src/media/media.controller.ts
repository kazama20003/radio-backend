import {
  BadRequestException,
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { mkdirSync } from 'fs';
import { diskStorage } from 'multer';
import { extname, join } from 'path';

export const UPLOAD_DIR = join(process.cwd(), 'uploads');
mkdirSync(UPLOAD_DIR, { recursive: true });

/**
 * Subida de archivos (fotos de perfil, notas de voz, imágenes/video del chat).
 * Guarda en disco local bajo ./uploads y devuelve una `key` relativa
 * (`/uploads/<archivo>`). El cliente arma la URL final con su API_ORIGIN.
 * Los archivos se sirven de forma estática (ver main.ts) sin autenticación.
 */
@ApiTags('media')
@ApiBearerAuth()
@Controller('media')
export class MediaController {
  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: UPLOAD_DIR,
        filename: (_req, file, cb) => {
          const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
          cb(null, `${unique}${extname(file.originalname) || ''}`);
        },
      }),
      limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
    }),
  )
  upload(@UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('No se recibió ningún archivo');
    const key = `/uploads/${file.filename}`;
    return { key, url: key, mime: file.mimetype, size: file.size };
  }
}
