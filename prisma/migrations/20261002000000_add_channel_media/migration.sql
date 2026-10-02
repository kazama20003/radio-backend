-- Adjuntos multimedia en el chat de canal: video, archivo genérico y metadatos
ALTER TABLE "RadioTransmission" ADD COLUMN "videoKey" TEXT;
ALTER TABLE "RadioTransmission" ADD COLUMN "fileKey" TEXT;
ALTER TABLE "RadioTransmission" ADD COLUMN "fileName" TEXT;
ALTER TABLE "RadioTransmission" ADD COLUMN "fileSize" INTEGER;
ALTER TABLE "RadioTransmission" ADD COLUMN "mimeType" TEXT;
