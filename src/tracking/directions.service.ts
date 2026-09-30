import { Injectable, Logger } from '@nestjs/common';

export interface GuideRoute {
  polyline: string; // overview polyline codificada de Google
  distanceText: string;
  durationText: string;
  durationInTrafficText: string; // tiempo estimado CON tráfico actual
  hasTraffic: boolean; // true si el tráfico agrega tiempo notable
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
    // departure_time=now + traffic_model + alternatives -> Google devuelve varias
    // rutas con tiempo EN TRÁFICO; elegimos la de menor tráfico.
    const url =
      `https://maps.googleapis.com/maps/api/directions/json` +
      `?origin=${origin.lat},${origin.lng}` +
      `&destination=${dest.lat},${dest.lng}` +
      `&mode=driving&language=es&alternatives=true` +
      `&departure_time=now&traffic_model=best_guess&key=${key}`;

    const res = await fetch(url);
    const json = (await res.json()) as {
      status: string;
      error_message?: string;
      routes?: {
        overview_polyline: { points: string };
        legs: {
          distance: { text: string; value: number };
          duration: { text: string; value: number };
          duration_in_traffic?: { text: string; value: number };
        }[];
      }[];
    };

    if (json.status !== 'OK' || !json.routes?.[0]?.legs?.[0]) {
      this.logger.error(
        `Directions ${json.status}: ${json.error_message ?? 'sin ruta'}`,
      );
      throw new Error(`No se pudo calcular la ruta (${json.status}).`);
    }

    // Elegir la ruta con MENOS tráfico (menor duration_in_traffic).
    const trafficSecs = (r: (typeof json.routes)[number]) =>
      r.legs[0].duration_in_traffic?.value ?? r.legs[0].duration.value;
    const route = json.routes.reduce((best, r) =>
      trafficSecs(r) < trafficSecs(best) ? r : best,
    );
    const leg = route.legs[0];
    const durSecs = leg.duration.value;
    const trafSecs = leg.duration_in_traffic?.value ?? durSecs;
    return {
      polyline: route.overview_polyline.points,
      distanceText: leg.distance.text,
      durationText: leg.duration.text,
      durationInTrafficText: leg.duration_in_traffic?.text ?? leg.duration.text,
      // "hay tráfico" si el tiempo real supera al normal en >20%.
      hasTraffic: trafSecs > durSecs * 1.2,
      distanceMeters: leg.distance.value,
      durationSeconds: trafSecs,
    };
  }
}
