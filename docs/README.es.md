<div align="center">

<img src="assets/logo.png" alt="Aevistle" width="104" height="104">

# Aevistle

**Recordatorios por correo programados que sí llegan.**

Escribe un correo una vez —con archivos, imágenes o comprimidos adjuntos— y
Aevistle lo envía a su hora. Una sola vez, cada día laborable a las 09:00, el
día 1 de cada mes o según cualquier expresión cron. La misma aplicación en
Windows y en Android.

[![Release](https://img.shields.io/github/v/release/Aevorine/Aevistle?style=flat-square&color=4f46e5)](https://github.com/Aevorine/Aevistle/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-4f46e5?style=flat-square)](../LICENSE)
[![Windows](https://img.shields.io/badge/Windows-x64-4f46e5?style=flat-square&logo=windows)](https://github.com/Aevorine/Aevistle/releases/latest)
[![Android](https://img.shields.io/badge/Android-7.0%2B-4f46e5?style=flat-square&logo=android)](https://github.com/Aevorine/Aevistle/releases/latest)

[English](../README.md) ·
[简体中文](README.zh-CN.md) ·
[Français](README.fr.md) ·
**Español** ·
[Русский](README.ru.md) ·
[العربية](README.ar.md)

</div>

---

<div align="center">
<img src="assets/screenshot-compose.png" alt="La ventana de redacción de Aevistle" width="880">
</div>

---

## Por qué existe

Cualquier cliente de correo sabe enviar un mensaje. Casi ninguno puede
prometerte que saldrá el próximo martes a las 07:00 con el archivo correcto
adjunto, te acuerdes o no, esté la aplicación abierta o no.

Aevistle cumple primero esa promesa. No hay cuenta que crear: se conecta al
servidor SMTP que ya tienes (Gmail, Outlook, QQ, 163, el servidor de tu
empresa) y envía. La recepción también está, pero no se interpone hasta que la
activas: apunta una cuenta a su servidor IMAP y Aevistle trae una bandeja de
entrada unificada, extrae automáticamente los códigos de verificación y los
enlaces de acceso, y deja todo lo demás tal cual por defecto.

**La gente lo usa para** enviar un informe semanal cada viernes a las 17:00 · recordar los deberes a una clase la noche anterior · mandar una factura el día 1 de cada mes · publicar una felicitación de cumpleaños a medianoche mientras duerme · reclamar el alquiler cada 30 días · programar un seguimiento que llegue por la mañana y no a las 2:00 · conseguir un código de acceso en el momento en que llega sin cambiar de aplicación.

**Puede que no sea para ti si** quieres un cliente de correo completo —sin gestión de carpetas, sin sincronización push IDLE, sin borrado en el servidor, a propósito—, una herramienta de marketing con píxeles de seguimiento y tasas de apertura, o un servicio alojado que siga enviando con tus dispositivos apagados. Aevistle envía y lee desde *tu* equipo con *tu* buzón, que es justo por lo que no necesita una cuenta propia ni recoge nada.

## Qué hace

| | |
|---|---|
| 📮 **Enviar ahora o después** | Los dos botones que importan están fijos en la parte inferior de la pantalla de redacción, con cualquier tamaño de ventana. Nunca hay que desplazarse para enviar. |
| 📥 **Bandeja de entrada opcional** | Activa IMAP en una cuenta y Aevistle rellena el servidor, lo prueba antes de guardar y luego sincroniza una bandeja unificada con todas las cuentas — vista conjunta o filtrada por cuenta, comprobada con el intervalo que elijas. Al abrir un mensaje ocupa toda la ventana; `Esc` retrocede. `J`/`K` van de un mensaje a otro y `Ctrl+F` busca dentro. Los adjuntos recibidos se previsualizan en el momento — imágenes, PDF y texto — o se abren con la aplicación del sistema, se guardan donde quieras o se muestran en el explorador de archivos. Las imágenes remotas siguen bloqueadas y cada enlace pasa por una confirmación que muestra el destino real. |
| 🔑 **Códigos de verificación, en su propia pantalla** | Los códigos y enlaces de acceso se extraen automáticamente del correo que llega y se reúnen en una pantalla propia: remitente, asunto, hora de llegada y el código en un tamaño que se lee de un vistazo. Haz clic en cualquier parte de la tarjeta para copiarlo. Una notificación lleva el código consigo, así que no hace falta abrir nada, y el historial sobrevive al borrado del correo original. |
| ⚡ **Envío en ráfaga** | Un único disparo programado puede enviar el mismo mensaje varias veces seguidas, con el ritmo que fijes en milisegundos —para poner a prueba tu propio circuito de envío, no para hacer spam a nadie. |
| 📎 **Adjuntos e imágenes en el cuerpo** | Documentos, imágenes, archivos comprimidos: todo lo que quepa en el límite de tu proveedor. Pega una imagen copiada directamente en el mensaje para insertarla en línea; cualquier imagen adjunta también puede pasar de archivo adjunto a imagen dentro del mensaje, y volver. Aevistle muestra el tamaño real transmitido, porque base64 convierte un archivo de 20 MB en 27 MB y por eso rebotan adjuntos que «no superaban el límite». |
| 🖼️ **Imágenes que se ven de verdad** | Cada imagen de un mensaje —incrustada en el cuerpo, adjunta como archivo o recibida en la bandeja— aparece como una miniatura que se puede mirar, no como un nombre de archivo que hay que adivinar. Un clic abre el visor a pantalla completa: rueda para acercar, arrastrar para desplazar, doble clic para alternar entre tamaño ajustado y real, giro de un cuarto en ambos sentidos, espejo horizontal o vertical, flechas para recorrer el resto de imágenes del mensaje, y las dimensiones en píxeles, el tamaño y el formato a la vista antes de guardarla o copiarla al portapapeles. `Esc` cierra la imagen y nada más. |
| 🔁 **Recurrencia de verdad** | Una vez · cada N minutos · diaria · semanal en los días elegidos · mensual (con una regla sensata para el día 31) · anual · cron completo de 5 campos. |
| 🔒 **Copias de los adjuntos** | Programa un recordatorio para el mes que viene: Aevistle guarda su propia copia de los archivos, así que mover o renombrar los originales no lo rompe en silencio. |
| ⏰ **Se dispara con la ventana cerrada** | Windows mantiene un proceso en la bandeja; Android usa una alarma exacta más WorkManager. Cerrar la ventana no cancela tus recordatorios. |
| 🌙 **Política de recuperación** | ¿El portátil estuvo suspendido durante tres horas de envío? Elige un único envío de recuperación, o ninguno. No te despertarás con tres correos idénticos. |
| 🎲 **Dispersión y fines de semana** | Reparte los envíos dentro de una ventana para que tu proveedor no interprete una ráfaga como spam, y pasa al lunes lo que caiga en fin de semana. |
| 🔐 **Las contraseñas se quedan** | Cifradas por el sistema: DPAPI en Windows, Keystore con respaldo de hardware en Android. Nunca en el archivo de ajustes ni en una exportación. |
| 📂 **Tu carpeta, tus reglas** | Aevistle pregunta dónde guardar tus datos la primera vez que arranca, y **Ajustes → Carpeta de datos** lo cambia después. Mueve lo que ya hay **y corrige las rutas guardadas dentro de las programaciones**, de modo que un recordatorio creado el mes pasado sigue encontrando su adjunto. |
| 🔌 **Conexiones que salen bien** | ¿Puerto y cifrado descoordinados? Aevistle prueba la otra combinación que acepta tu proveedor en vez de fallar con «Unexpected socket close», y luego ofrece guardar lo que funcionó. Cada intento tiene un límite de tiempo: el botón de prueba siempre responde. |
| 🩺 **Dice qué ha pasado** | Una prueba correcta informa del punto de conexión utilizado y el tiempo de ida y vuelta; una fallida nombra la causa y qué cambiar. La pantalla de actividad lleva una tasa de éxito y un tiempo mediano. |
| 🌙 **Horas de silencio** | Los recordatorios nocturnos esperan a la mañana. El envío manual nunca se retiene: estás delante. |
| ⬆️ **Actualizaciones dentro de la app** | Consulta las Releases de GitHub, descarga el instalador, lo verifica contra el SHA-256 publicado y se lo entrega al sistema. En Android abre el APK para el instalador del sistema. Se puede desactivar; no envía nada salvo la petición. |
| 🌍 **Seis idiomas** | English, 简体中文, Français, Español, Русский, العربية — con diseño completo de derecha a izquierda para el árabe. |
| 🎨 **Agradable a la vista** | Claro y oscuro, siguiendo al sistema o fijado, seis colores de acento, dos densidades, y una elección tipográfica por escritura: Songti (宋体) para el chino y Times New Roman para el texto latino y la puntuación. |

## Descarga

La última versión está en **[Releases](https://github.com/Aevorine/Aevistle/releases/latest)**.

| Plataforma | Archivo | Notas |
|---|---|---|
| Windows 10/11 (x64) | `Aevistle-0.1.3-win-x64-setup.exe` | Instalador, crea accesos directos en el menú Inicio y el escritorio |
| Windows 10/11 (x64) | `Aevistle-0.1.3-win-x64-portable.exe` | Un solo archivo, sin instalación, funciona desde un USB |
| Android 7.0+ | `Aevistle-0.1.3.apk` | Móviles y tabletas. Activa antes «instalar aplicaciones desconocidas» para tu navegador o gestor de archivos. |

> Windows SmartScreen avisará de un editor desconocido. Así se ve una versión
> sin certificado de firma de pago: elige **Más información → Ejecutar de todas
> formas**, o comprueba antes el SHA-256 desde la página de la versión.

## Primeros pasos

1. **Añade tu buzón.** Ajustes → Añadir cuenta. Elige tu proveedor y Aevistle
   rellena servidor, puerto y cifrado por ti.
2. **Consigue una contraseña de aplicación.** Gmail, Outlook, Yahoo, iCloud, QQ
   y 163 rechazan tu contraseña normal desde una aplicación de terceros. El
   diálogo enlaza directamente con la página donde se crea.
3. **Prueba la conexión.** Un botón. Se autentica sin enviar nada, así que te
   enteras ahora y no a las 03:00.
4. **Escribe tu recordatorio**, adjunta lo necesario y elige **Programar**.

<div align="center">
<img src="assets/screenshot-settings.png" alt="Ajustes de Aevistle: la cuenta de correo y la carpeta de datos" width="880">
</div>

Para que los envíos programados salgan con la ventana cerrada, deja activado
*Mantener en la bandeja* (Windows) y permite alarmas exactas y notificaciones
cuando Android lo pida.

## Privacidad

Aevistle no tiene servidor. No hay cuenta que crear, ni telemetría, ni informes
de fallos.

Una lista corta y fija de cosas sale de tu dispositivo, y nada más:

1. **La conexión SMTP con tu propio proveedor de correo** — tu mensaje, hasta
   el buzón que configuraste.
2. **La conexión IMAP con tu propio proveedor de correo** — solo para las
   cuentas donde activaste la recepción, solo para traer el correo de esa
   cuenta.
3. **Una imagen remota dentro de un mensaje recibido, solo cuando pides
   expresamente cargarla** — toda imagen está bloqueada por defecto y se
   sustituye por un marcador de posición, porque un `<img>` remoto es el truco
   de seguimiento más viejo del correo electrónico. La propia descarga está
   protegida contra ser redirigida a tu propia red (sin IP internas, sin
   seguir redirecciones).
4. **Una comprobación de actualizaciones**, si la dejas activada: una petición
   `GET` sin autenticar a `api.github.com` que pregunta cuál es la última
   versión. No lleva datos de la cuenta, ni contenido de mensajes, ni datos de
   uso. Desactívala en **Ajustes → Actualizaciones** y la aplicación no hace
   ninguna petición por su cuenta.

Todo vive en tu dispositivo:

| | Windows | Android |
|---|---|---|
| Ajustes, programaciones, contactos, registro | `<carpeta de datos>\state.json` | almacenamiento de la app |
| Contraseñas de correo | `secrets.json`, cifrado con DPAPI | Android Keystore (con hardware cuando existe) |
| Contraseñas IMAP | El mismo archivo, el mismo cifrado, una entrada de Keystore distinta de la contraseña SMTP de esa cuenta | El mismo Keystore, entrada distinta |
| Copias de adjuntos | `<carpeta de datos>\attachments\` | `<carpeta de datos>/attachments` |
| Caché de correo recibido (cuerpos, adjuntos) | `<carpeta de datos>\inbox\` — una caché acotada con un límite de antigüedad y tamaño que puedes ajustar en **Ajustes**, se puede borrar sin problema: simplemente vuelve a sincronizar | `<carpeta de datos>/inbox` |

La carpeta de datos empieza en `%APPDATA%\Aevistle` en Windows y en el
almacenamiento privado en Android; **Ajustes → Carpeta de datos** la mueve a
donde puedas escribir. En Android la elección es entre los volúmenes que el
sistema permite escribir de verdad a una aplicación (privado, compartido,
tarjeta SD), porque una carpeta elegida con el selector de documentos no puede
abrirla el envío en segundo plano horas después.

Dos cosas se quedan a propósito: las contraseñas, cifradas contra tu cuenta del
sistema e inservibles en otro sitio, y —en Android— el calendario de alarmas,
para que quitar una tarjeta no impida que salga un recordatorio.

Exportar los ajustes nunca incluye una contraseña.

## Seguridad

El modelo de amenazas, las decisiones de endurecimiento y cómo informar de una
vulnerabilidad están en **[SECURITY.md](../SECURITY.md)**.

En resumen: el renderizador no tiene acceso a Node, con aislamiento de contexto
y una CSP estricta; toda cadena destinada a una cabecera de correo se rechaza si
contiene un salto de línea (así nacen los relés abiertos); los certificados TLS
se verifican salvo que lo desactives explícitamente por cuenta; el HTML de un
mensaje recibido se sanea en el proceso principal según una lista blanca
estricta antes de llegar siquiera al renderizador, y se muestra dentro de un
iframe aislado (sandbox) sin permitir la ejecución de ningún script bajo
ninguna circunstancia; y el receptor de alarmas de Android no está exportado,
así que ninguna otra aplicación puede hacer que Aevistle envíe correo.

Puedes comprobarlo tú mismo:

```bash
npm run audit:self
```

20 comprobaciones, salida en lenguaje llano, código de salida 1 si algo requiere
atención.

## Compilar desde el código

**Requisitos** — Node.js 20+, y para Android: JDK 17+, Android SDK
(plataforma 36, build-tools 35+). `npm run build:android` encuentra un JDK y un
SDK instalados aunque no estén en el `PATH`, así que `JAVA_HOME` es opcional.

```bash
git clone https://github.com/Aevorine/Aevistle.git
cd Aevistle
npm install
```

| Tarea | Comando |
|---|---|
| Ejecutar en el navegador (sin SMTP, el resto real) | `npm run dev` |
| Comprobación de tipos | `npm run typecheck` |
| Auditoría de seguridad | `npm run audit:self` |
| Ejecutar la aplicación de escritorio | `npm start` |
| Compilar instaladores de Windows | `npm run dist:win` |
| Compilar el APK de Android | `npm run build:android` |

La firma de publicación en Android lee `~/.aevistle/keystore.properties` o las
variables `AEVISTLE_KEYSTORE*`. Sin ninguna de las dos, la compilación recurre a
la clave de depuración: el APK sigue siendo instalable.

## Cómo está construido

Una interfaz React + TypeScript, dos envoltorios nativos.

```
src/core/        independiente de la plataforma: modelo, motor de recurrencia,
                 validación, ajustes SMTP — sin DOM, sin Node, sin Android
src/             la interfaz React (seis idiomas, dos temas)
    ↓ PlatformBridge — la única junta entre la interfaz y un sistema operativo
electron/        Windows: nodemailer + imapflow, secretos con DPAPI, bandeja,
                 saneado de HTML del correo recibido
android/         Android: JavaMail (envío y recepción), Keystore, AlarmManager + WorkManager
```

El motor de recurrencia vive deliberadamente solo en TypeScript. Precalcula una
lista de marcas de tiempo absolutas y el planificador de cada plataforma solo
responde «despiértame en T», de modo que cada regla de calendario (años
bisiestos, meses cortos, horario de verano, fines de semana) existe una vez, en
un solo lenguaje, y se puede probar sin emulador.

Más detalle en **[ARCHITECTURE.md](ARCHITECTURE.md)**.

## Hoja de ruta

No son promesas: lo más probable que venga a continuación.

- [ ] OAuth 2.0 para Gmail y Microsoft 365
- [ ] Editor enriquecido con imágenes incrustadas
- [ ] Importar y exportar programaciones
- [ ] Versiones para macOS y Linux (el código ya las contempla)
- [ ] Variables de plantilla por destinatario (`{{name}}`)
- [ ] iOS

¿Falta algo? [Abre una incidencia](https://github.com/Aevorine/Aevistle/issues):
las peticiones de funciones son bienvenidas de verdad.

## Contribuir

Las pull requests son bienvenidas. Consulta **[CONTRIBUTING.md](../CONTRIBUTING.md)**.
Añadir un séptimo idioma es un solo archivo y no necesita herramientas de
compilación: el sistema de tipos te dice exactamente qué cadenas faltan.

## Licencia

[MIT](../LICENSE) © Aevistle contributors
