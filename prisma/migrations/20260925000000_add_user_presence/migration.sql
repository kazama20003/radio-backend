-- AlterTable: presencia por usuario (última ubicación conocida en el mapa)
ALTER TABLE "User" ADD COLUMN     "lastLat" DOUBLE PRECISION;
ALTER TABLE "User" ADD COLUMN     "lastLng" DOUBLE PRECISION;
ALTER TABLE "User" ADD COLUMN     "lastSpeedKmh" DOUBLE PRECISION;
ALTER TABLE "User" ADD COLUMN     "lastHeading" DOUBLE PRECISION;
ALTER TABLE "User" ADD COLUMN     "lastPositionAt" TIMESTAMP(3);
