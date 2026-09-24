# Mape API (backend)

Backend de **Mape**: monitoreo y coordinación de flota de transporte en tiempo real.
NestJS 11 · Prisma 7 (PostgreSQL, driver adapter `pg`) · JWT · Socket.IO.

## Puesta en marcha

```bash
pnpm install                 # instala y genera el cliente Prisma (postinstall)
# Configura DATABASE_URL en .env (PostgreSQL)
pnpm db:migrate              # crea el esquema (prisma migrate dev)
pnpm db:seed                 # datos de ejemplo (login: brayan@mape.app / mape1234)
pnpm start:dev               # http://localhost:3000/api  ·  Swagger en /docs
```

## Arquitectura de módulos

| Módulo | Responsabilidad | Tiempo real |
|--------|-----------------|-------------|
| `auth` | Login (correo/código), refresh con rotación, OTP de recuperación | — |
| `users` | Perfil, cuenta, gestión de operadores | — |
| `units` | Flota, asignación de operador, última posición, filtros | — |
| `tracking` | Ingesta GPS, mapa en vivo, motor de reglas → alertas | `/tracking` |
| `alerts` | Listado/métricas, atender/resolver | `/alerts` |
| `routes` | Rutas + paradas + carga/guía; geocercas | — |
| `chat` | Conversaciones directas/grupales, mensajes, recibos, no leídos | `/chat` |
| `radio` | Canales y señalización push-to-talk | `/radio` |
| `preferences` | Notificaciones, device tokens (push), ajustes de la app | — |

Todas las rutas van bajo `/api` y requieren `Authorization: Bearer <accessToken>`
salvo las marcadas `@Public()` (auth). Guards globales: JWT + roles.

## WebSockets (Socket.IO)

Autenticación por handshake: `{ auth: { token: <accessToken> } }`.

- **`/tracking`** — `position:report` (operador→server); emite `position:update`.
- **`/alerts`** — emite `alert:new`, `alert:updated`.
- **`/chat`** — `conversation:join`, `message:send`, `typing`; emite `message:new`.
- **`/radio`** — `channel:join`, `ptt:start`, `ptt:audio`, `ptt:end`; emite `ptt:speaking`, `ptt:audio`, `ptt:ended`.

## Notas técnicas

- El cliente Prisma se genera en `src/generated/prisma` (gitignored) — `pnpm prisma:generate`.
- Los paquetes `@nestjs/*` están fijados a **v11** para casar con el core (v12 rompe por `loadPackageSync`).
- Pendiente de integración externa: envío real de OTP (email/SMS), push (Expo/FCM),
  audio PTT sobre WebRTC/LiveKit, y reglas de geocerca/parada prolongada (job programado).
