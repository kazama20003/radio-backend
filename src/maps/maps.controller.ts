import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { MapsService } from './maps.service';

/**
 * Rutas/navegación. Hace de proxy a la Google Directions API con la server key
 * del backend; la app solo pide la ruta por coordenadas.
 */
@ApiTags('maps')
@ApiBearerAuth()
@Controller('maps')
export class MapsController {
  constructor(private readonly maps: MapsService) {}

  /** GET /api/maps/directions?originLat&originLng&destLat&destLng&mode */
  @Get('directions')
  directions(
    @Query('originLat') originLat: string,
    @Query('originLng') originLng: string,
    @Query('destLat') destLat: string,
    @Query('destLng') destLng: string,
    @Query('mode') mode?: string,
  ) {
    return this.maps.directions(
      { lat: Number(originLat), lng: Number(originLng) },
      { lat: Number(destLat), lng: Number(destLng) },
      mode ?? 'driving',
    );
  }
}
