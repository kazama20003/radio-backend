import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';

/**
 * Subida de imágenes a Cloudinary por su API REST con firma (sin SDK, solo
 * fetch + crypto nativos). Las credenciales van SOLO en el .env del servidor:
 *   CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET,
 *   CLOUDINARY_FOLDER (opcional, default "syemape/perfiles").
 */
@Injectable()
export class CloudinaryService {
  private readonly logger = new Logger(CloudinaryService.name);

  isConfigured(): boolean {
    return Boolean(
      process.env.CLOUDINARY_CLOUD_NAME &&
        process.env.CLOUDINARY_API_KEY &&
        process.env.CLOUDINARY_API_SECRET,
    );
  }

  /** Sube un buffer de imagen y devuelve la URL segura (https). */
  async uploadImage(buffer: Buffer, filename = 'foto.jpg'): Promise<string> {
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;
    const folder = process.env.CLOUDINARY_FOLDER || 'syemape/perfiles';
    if (!cloudName || !apiKey || !apiSecret) {
      throw new Error('Cloudinary no está configurado (faltan variables de entorno).');
    }

    const timestamp = Math.round(Date.now() / 1000).toString();
    // Firma: params (excepto file/api_key) ordenados alfabéticamente + api_secret.
    const toSign = `folder=${folder}&timestamp=${timestamp}${apiSecret}`;
    const signature = createHash('sha1').update(toSign).digest('hex');

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(buffer)]), filename);
    form.append('api_key', apiKey);
    form.append('timestamp', timestamp);
    form.append('folder', folder);
    form.append('signature', signature);

    const res = await fetch(
      `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
      { method: 'POST', body: form },
    );
    const json = (await res.json()) as { secure_url?: string; error?: unknown };
    if (!res.ok || !json.secure_url) {
      this.logger.error(`Cloudinary error: ${JSON.stringify(json)}`);
      throw new Error('No se pudo subir la imagen a Cloudinary.');
    }
    return json.secure_url;
  }
}
