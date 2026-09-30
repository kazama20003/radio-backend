import { Injectable, Logger } from '@nestjs/common';

export interface GuideRoute {
  polyline: string; // overview polyline codificada de Google
  distanceText: string;
  durationText: string;
  distanceMeters: number;
  durationSeconds: number;
}

/**
 * Calcula rutas por calle con la Google Directions API. La key va SOLO en el
 * .env del servidor: GOOGLE_MAPS_SERVER_KEY (restringida por IP + Directions).
 */
@Injectable()
export class DirectionsService {
  private readonly logger = new Logger(DirectionsService.name);

  async getRoute(
    origin: { lat: number; lng: number },
    dest: { lat: number; lng: number },
  ): Promise<GuideRoute> {
    const key = process.env.GOOGLE_MAPS_SERVER_KEY;
    if (!key) throw new Error('Falta GOOGLE_MAPS_SERVER_KEY en el servidor.');
    const url =
      `https://maps.googleapis.com/maps/api/directions/json` +
      `?origin=${origin.lat},${origin.lng}` +
      `&destination=${dest.lat},${dest.lng}` +
      `&mode=driving&language=es&key=${key}`;

    const res = await fetch(url);
    const json = (await res.json()) as {
      status: string;
      error_message?: string;
      routes?: {
        overview_polyline: { points: string };
        legs: {
          distance: { text: string; value: number };
          duration: { text: string; value: number };
        }[];
      }[];
    };

    if (json.status !== 'OK' || !json.routes?.[0]?.legs?.[0]) {
      this.logger.error(
        `Directions ${json.status}: ${json.error_message ?? 'sin ruta'}`,
      );
      throw new Error(`No se pudo calcular la ruta (${json.status}).`);
    }
    const route = json.routes[0];
    const leg = route.legs[0];
    return {
      polyline: route.overview_polyline.points,
      distanceText: leg.distance.text,
      durationText: leg.duration.text,
      distanceMeters: leg.distance.value,
      durationSeconds: leg.duration.value,
    };
  }
}
