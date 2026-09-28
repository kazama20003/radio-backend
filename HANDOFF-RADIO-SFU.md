# Handoff — Radio en vivo + grabado (mediasoup SFU)

Objetivo: en la app "mape", el usuario mantiene **HABLAR** → los demás del canal
**escuchan en tiempo real** (SFU mediasoup) y, **al soltar, se guarda la nota de
voz** en el chat del canal (ffmpeg graba en el servidor).

Falta implementar **Etapa 3 (grabación ffmpeg)** y **Etapa 4 (cliente app)**.
Etapas 1 y 2 (servidor) YA están hechas y desplegadas.

## Repos y ramas
- Backend NestJS: `C:\kazama-works\mape-app-backend` — repo `github.com/kazama20003/radio-backend`, rama **`radio-channel-chat`** (deploy: server `/var/www/syemape/radio-backend`, pm2 `radio-backend`, puerto 3050, URL pública `https://radio.syemape.com`).
- Frontend Expo RN: `C:\kazama-works\mape` — repo `github.com/kazama20003/mape-app`, rama **`mape-session-updates`**. Build APK: `cd android && ./gradlew assembleRelease`.
- Señalización va por Socket.IO namespace **`/radio`** (ya autenticado con JWT en `handshake.auth.token`). El cliente ya usa `getSocket('/radio', token)` (`src/lib/socket.ts`) y se une al canal con `socket.emit('channel:join', channelId)`.

## HECHO (Etapa 1 y 2 — backend)
- `src/radio/mediasoup.service.ts`: worker + router (opus 48000/2), `getRtpCapabilities()`, `createWebRtcTransport()`, `canConsume()`. Init tolerante a fallos.
- `src/radio/radio.gateway.ts`: estado por socket (`MsPeer`), `channelProducer` (un hablante/canal), y handlers Socket.IO:
  - `ms:rtpCapabilities` → devuelve rtpCapabilities del router.
  - `ms:getProducer` `{channelId}` → `{socketId, producerId}` del hablante actual o null.
  - `ms:createTransport` `{direction:'send'|'recv'}` → params del WebRtcTransport (id, iceParameters, iceCandidates, dtlsParameters).
  - `ms:connectTransport` `{direction, dtlsParameters}` → conecta.
  - `ms:produce` `{channelId, rtpParameters}` → crea producer audio, guarda `channelProducer`, emite `ms:newProducer {producerId, socketId}` al room `channel:<id>`, devuelve `{id}`.
  - `ms:consume` `{producerId, rtpCapabilities}` → consumer PAUSADO, devuelve `{id, producerId, kind, rtpParameters}`.
  - `ms:resume` `{consumerId}` → resume.
  - `ms:closeProducer` → cierra producer, emite `ms:producerClosed {channelId}`.
  - Limpieza en `handleDisconnect` (`cleanupMsPeer`).
- Módulo: `MediasoupService` registrado en `RadioModule`.
- Chat de canal ya funciona: eventos `channel:text {channelId,text}`, `channel:image {channelId,imageKey}` → emiten `channel:post {transmission}`; historial `GET /api/radio/channels/:id/history`. La nota de voz se guarda creando un `RadioTransmission` con `audioKey` (columna existente) vía `RadioService.recordTransmission(channelId, userId, {audioKey, durationSec})` y el gateway emite `ptt:ended {transmission}` (el cliente lo agrega al chat).

## Deploy del servidor mediasoup (ya resuelto, para referencia)
VPS Ubuntu 20.04, 1.9GB RAM (se creó **swap 2GB**), 2 vCPU, IP `161.132.49.197`.
Compilar el worker requirió (por SO viejo):
- `apt-get install -y python3-pip build-essential gcc-10 g++-10`
- Variables para compilar: `PYTHON=$(which python3.9)`, `MESON_VERSION=1.7.2`, `CC=gcc-10`, `CXX=g++-10`, `PIP_BREAK_SYSTEM_PACKAGES=1`, luego `pnpm rebuild mediasoup`.
- `.env` del server: `MEDIASOUP_ANNOUNCED_IP=161.132.49.197`, `MEDIASOUP_RTC_MIN_PORT=40000`, `MEDIASOUP_RTC_MAX_PORT=40100`. Firewall: `ufw allow 40000:40100/udp`.
- Verificado: log `[MediasoupService] mediasoup listo (RTC 40000-40100)`.

## FALTA — Etapa 3: grabación ffmpeg (backend)
Cuando un peer hace `ms:produce`, además de crear el producer WebRTC, hay que
grabar su audio a un archivo y, al cerrar (`ms:closeProducer`/disconnect),
subirlo/guardarlo como nota de voz. Plan:
1. En `MediasoupService`, crear un **PlainTransport** por producer para sacar el
   RTP: `router.createPlainTransport({ listenIp:{ip:'127.0.0.1'}, rtcpMux:true, comedia:false })`.
   Luego `plainTransport.consume({ producerId, rtpCapabilities: router.rtpCapabilities, paused:true })`.
2. Lanzar **ffmpeg** con un SDP que describa el stream opus (payload 100,
   48000/2) apuntando al puerto local del plainTransport, grabando a
   `uploads/radio-<id>.ogg` (o `.m4a`): p.ej.
   `ffmpeg -protocol_whitelist file,udp,rtp -i input.sdp -c:a copy out.ogg`
   (o transcodificar a m4a/aac). Resume el consumer del plainTransport tras
   arrancar ffmpeg.
3. En `ms:closeProducer`/disconnect: `SIGINT` a ffmpeg, cerrar plainTransport, y
   guardar la nota: `RadioService.recordTransmission(channelId, userId, { audioKey:'/uploads/'+file, durationSec })` y emitir `ptt:ended {transmission}` al room (ya existe el patrón) para que el chat lo muestre.
   - Nota: el `key` de storage es `/uploads/<archivo>` (ver `MediaController`, `UPLOAD_DIR=join(process.cwd(),'uploads')`, servido en `/uploads`).
4. ffmpeg audio-only es liviano (~50-150MB), cabe en el VPS. Requiere `apt-get install -y ffmpeg` en el server.
5. Alternativa más simple si el PlainTransport+SDP se complica: usar la lib
   `mediasoup` con `Consumer` en un plainTransport y `ffmpeg` leyendo el RTP; hay
   ejemplos en el repo oficial `mediasoup-demo` (server/lib/Room.js maneja
   PlainTransport para broadcasting/recording).

## FALTA — Etapa 4: cliente (app Expo RN)
La app quitó `react-native-webrtc`; hay que **volver a agregarlo** + `mediasoup-client`.
1. `pnpm add react-native-webrtc @config-plugins/react-native-webrtc mediasoup-client`
   y en `app.json` plugins agregar `["@config-plugins/react-native-webrtc",{"microphonePermission":"..."}]`. Luego `npx expo prebuild -p android --clean` + rebuild.
2. Crear hook `src/features/radio/use-radio-sfu.ts` que, con `channelId` + `token`:
   - `const socket = getSocket('/radio', token); socket.emit('channel:join', channelId)`.
   - Cargar device: `const caps = await emitAck('ms:rtpCapabilities'); const device = new mediasoupClient.Device(); await device.load({ routerRtpCapabilities: caps })`.
     (usar el handler de react-native-webrtc: `import { registerGlobals } from 'react-native-webrtc'; registerGlobals()` al inicio; mediasoup-client detecta el handler RN, o pasar `handlerFactory`).
   - **recvTransport** siempre: `const p = await emitAck('ms:createTransport',{direction:'recv'}); const recv = device.createRecvTransport(p); recv.on('connect', ({dtlsParameters},cb)=> emitAck('ms:connectTransport',{direction:'recv',dtlsParameters}).then(cb));`.
   - Escuchar `ms:newProducer {producerId}` → `consume(producerId)`: `const params = await emitAck('ms:consume',{producerId, rtpCapabilities: device.rtpCapabilities}); const consumer = await recv.consume(params); await emitAck('ms:resume',{consumerId:consumer.id});` → el audio remoto se reproduce solo (react-native-webrtc rutea al audio). Al entrar, `ms:getProducer` para consumir al que ya está hablando.
   - Escuchar `ms:producerClosed` → cerrar consumer.
   - **startTalking**: getUserMedia audio → sendTransport (`ms:createTransport {direction:'send'}` + connect) → `const producer = await send.produce({ track })`; en `send.on('produce', ({kind,rtpParameters},cb)=> emitAck('ms:produce',{channelId,rtpParameters}).then(({id})=>cb({id})))`.
   - **stopTalking**: `producer.close(); track.stop(); socket.emit('ms:closeProducer')`.
   - `mute`: no consumir / pausar consumers.
   - Ruteo a altavoz: si el audio sale por el auricular/bajo, agregar
     `react-native-incall-manager` y `InCallManager.setForceSpeakerphoneOn(true)` al escuchar/hablar.
3. En `src/app/(tabs)/radio.tsx`, usar `use-radio-sfu` para `talking/speaking/startTalking/stopTalking` (el botón PTT ya llama onPttIn/onPttOut). El chat del canal (texto/imagen/notas) sigue con `useChannelChat` en `/radio-chat`.
4. Helper de ack: socket.io con callback → envolver en promesa:
   `const emitAck=(ev,data)=>new Promise(res=>socket.emit(ev,data,res));`.

## Notas importantes / gotchas
- **TURN**: en datos móviles (NAT operadora) mediasoup con `announcedIp` público suele bastar (es servidor con IP pública), pero si algún cliente no conecta, configurar TURN. mediasoup no trae TURN; con IP pública + UDP abierto normalmente conecta.
- **Un hablante a la vez**: el gateway ya modela `channelProducer` por canal. Se puede combinar con el "floor" (`ptt:request/release`) existente para la cola.
- **Grabar + vivo al mismo tiempo**: en el TELÉFONO no se puede grabar y transmitir con el mismo micro (Android lo bloquea) — por eso la grabación es EN EL SERVIDOR (ffmpeg), no en el cliente.
- Backend ya compila (tsc 0). Frontend ya compila (tsc 0) SIN mediasoup (hay que re-agregarlo).
- Estado actual de la app radio (rama `mape-session-updates`): está en modo **grabado** (`useRadio`, nota de voz al soltar) porque se quitó WebRTC. Para SFU hay que hacer la Etapa 4.

## Probar
- Desplegar backend (Etapa 3), `apt-get install ffmpeg`, rebuild + restart.
- Instalar APK (Etapa 4) en **2 teléfonos reales**, entrar al mismo canal, uno HABLA y el otro debe oír en vivo; al soltar, aparece la nota en el chat del canal.
- Login de prueba: DNI `40420485`, contraseña = el mismo DNI (rol SUPERVISOR). Canal existente: "Canal 1" id `cmuineetg0004w2y4lhrrwhb8`.
