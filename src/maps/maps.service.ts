import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';

export interface DirectionsStep {
  instruction: string; // texto plano (sin HTML)
  distanceText: string;
  distanceMeters: number;
  durationText: string;
  polyline: string; // polilínea codificada del tramo
  maneuver?: string; // p.ej. "turn-right", "roundabout-left"
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
}

export interface DirectionsResult {
  ok: boolean;
  distanceText: string;
  distanceMeters: number;
  durationText: string;
  durationSeconds: number;
  overviewPolyline: string; // ruta completa codificada (para dibujar en el mapa)
  endAddress?: string;
  steps: DirectionsStep[];
}

/** Quita etiquetas HTML de las instrucciones de Google y normaliza espacios. */
function stripHtml(html: string): string {
  return (html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Proxy de la Google Directions API. Usa la server key del backend
 * (GOOGLE_MAPS_SERVER_KEY) para no exponerla en la app. Devuelve la ruta
 * por carretera con polilínea e indicaciones paso a paso.
 */
@Injectable()
export class MapsService {
  private readonly logger = new Logger(MapsService.name);

  async directions(
    origin: { lat: number; lng: number },
    dest: { lat: number; lng: number },
    mode = 'driving',
  ): Promise<DirectionsResult> {
    const key = process.env.GOOGLE_MAPS_SERVER_KEY;
    if (!key) {
      throw new BadGatewayException(
        'GOOGLE_MAPS_SERVER_KEY no está configurada en el servidor',
      );
    }
    for (const v of [origin.lat, origin.lng, dest.lat, dest.lng]) {
      if (!Number.isFinite(v)) {
        throw new BadRequestException('Coordenadas inválidas');
      }
    }

    const allowedModes = ['driving', 'walking', 'bicycling', 'transit'];
    const travelMode = allowedModes.includes(mode) ? mode : 'driving';

    const url = new URL('https://maps.googleapis.com/maps/api/directions/json');
    url.searchParams.set('origin', `${origin.lat},${origin.lng}`);
    url.searchParams.set('destination', `${dest.lat},${dest.lng}`);
    url.searchParams.set('mode', travelMode);
    url.searchParams.set('language', 'es');
    url.searchParams.set('units', 'metric');
    url.searchParams.set('key', key);

    let json: any;
    try {
      const res = await fetch(url.toString());
      json = await res.json();
    } catch (err) {
      this.logger.error(`Fallo al consultar Directions: ${String(err)}`);
      throw new BadGatewayException('No se pudo contactar a Google Directions');
    }

    if (json.status !== 'OK' || !json.routes?.length) {
      this.logger.warn(
        `Directions status=${json.status} msg=${json.error_message ?? ''}`,
      );
      if (json.status === 'ZERO_RESULTS') {
        throw new BadRequestException('No hay ruta disponible hacia ese punto');
      }
      throw new BadGatewayException(
        `Google Directions: ${json.status}${json.error_message ? ` — ${json.error_message}` : ''}`,
      );
    }

    const route = json.routes[0];
    const leg = route.legs?.[0];
    const steps: DirectionsStep[] = (leg?.steps ?? []).map((s: any) => ({
      instruction: stripHtml(s.html_instructions),
      distanceText: s.distance?.text ?? '',
      distanceMeters: s.distance?.value ?? 0,
      durationText: s.duration?.text ?? '',
      polyline: s.polyline?.points ?? '',
      maneuver: s.maneuver,
      startLat: s.start_location?.lat,
      startLng: s.start_location?.lng,
      endLat: s.end_location?.lat,
      endLng: s.end_location?.lng,
    }));

    return {
      ok: true,
      distanceText: leg?.distance?.text ?? '',
      distanceMeters: leg?.distance?.value ?? 0,
      durationText: leg?.duration?.text ?? '',
      durationSeconds: leg?.duration?.value ?? 0,
      overviewPolyline: route.overview_polyline?.points ?? '',
      endAddress: leg?.end_address,
      steps,
    };
  }
}
