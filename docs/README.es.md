<div align="center">

<img src="assets/logo.png" alt="Aevistle" width="104" height="104">

# Aevistle

**Recordatorios por correo programados que sí llegan.**

Escribe un correo una vez —con archivos, imágenes o comprimidos adjuntos— y
Aevistle lo envía a su hora, incluso con la ventana cerrada. Una sola vez, cada
día laborable a las 09:00, el día 1 de cada mes o según cualquier expresión
cron. Conoce tus festivos oficiales, así que el informe del lunes no sale un
lunes en el que no trabaja nadie. Windows y Android, sin cuenta, sin servidor,
sin telemetría. Dos dispositivos se mantienen sincronizados por tu propia red,
sin ninguna nube de por medio.

*El informe semanal del viernes. La factura del día 1. La felicitación de
cumpleaños a medianoche, mientras duermes.*

[![Release](https://img.shields.io/github/v/release/Aevorine/Aevistle?style=flat-square&color=4f46e5)](https://github.com/Aevorine/Aevistle/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/Aevorine/Aevistle/ci.yml?branch=main&style=flat-square&color=4f46e5&label=checks)](https://github.com/Aevorine/Aevistle/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-4f46e5?style=flat-square)](../LICENSE)
[![Windows](https://img.shields.io/badge/Windows-x64-4f46e5?style=flat-square&logo=windows)](https://github.com/Aevorine/Aevistle/releases/latest)
[![Android](https://img.shields.io/badge/Android-7.0%2B-4f46e5?style=flat-square&logo=android)](https://github.com/Aevorine/Aevistle/releases/latest)
[![Languages](https://img.shields.io/badge/languages-6-4f46e5?style=flat-square)](#language)

### [⬇ Descargar](https://github.com/Aevorine/Aevistle/releases/latest) · [Qué hace](#qué-hace) · [Privacidad](#privacidad) · [Seguridad](#seguridad)

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

**La gente lo usa para** enviar un informe semanal cada viernes a las 17:00 · recordar los deberes a una clase la noche anterior · mandar una factura el día 1 de cada mes · publicar una felicitación de cumpleaños a medianoche mientras duerme · reclamar el alquiler cada 30 días · programar un seguimiento que llegue por la mañana y no a las 02:00 · conseguir un código de acceso en el momento en que llega sin cambiar de aplicación.

**Puede que no sea para ti si** quieres un cliente de correo completo —sin gestión de carpetas, sin sincronización push IDLE, sin borrado en el servidor, a propósito—, una herramienta de marketing con píxeles de seguimiento y tasas de apertura, o un servicio alojado que siga enviando con tus dispositivos apagados. Aevistle envía y lee desde *tu* equipo con *tu* buzón, que es justo por lo que no necesita una cuenta propia ni recoge nada.

## Privacidad

Aevistle no tiene servidor. No hay cuenta que crear, ni telemetría, ni informes
de fallos.

Una lista corta y fija de cosas sale de tu dispositivo, y nada más: **la
conexión SMTP con tu propio proveedor de correo**; **la conexión IMAP con ese
mismo proveedor**, solo para las cuentas donde activaste la recepción; **una
imagen remota dentro de un mensaje recibido**, solo cuando pides expresamente
esa; **una comprobación de actualizaciones** a `api.github.com`, si la dejas
activada; y **los festivos oficiales de un año**, solo cuando pulsas «comprobar
en línea». Las dos últimas están en una lista blanca fijada al host *y* a la
ruta exacta, y salen desde el proceso de confianza, no desde la parte de la
aplicación que representa el correo, que no tiene ningún alcance de red hacia
fuera.

Emparejar dos dispositivos no añade nada a esa lista: hablan entre ellos
directamente en tu propia red, sin nube y sin retransmisor de por medio.

> Con las actualizaciones desactivadas, cada petición que queda en esa lista es
> una para la que has pulsado un botón.

Dónde se guarda cada cosa, qué hace mover la carpeta de datos y las dos cosas
que se quedan a propósito → **[PRIVACY.md](PRIVACY.md)**.

## Qué hace

| | |
|---|---|
| ⏰ **Se dispara con la ventana cerrada** | Un proceso en la bandeja en Windows, una alarma exacta más WorkManager en Android. Cerrar la ventana no cancela nada. [→](FEATURES.md#fires-when-closed) |
| 🔁 **Recurrencia de verdad** | Una vez, cada N minutos, diaria, semanal, mensual, anual, o una expresión cron completa de 5 campos. [→](FEATURES.md#real-recurrence) |
| 📎 **Adjuntos que aguantan la espera** | Los archivos se copian al programar, así que mover o renombrar el original no rompe el envío en silencio. [→](FEATURES.md#attachment-snapshots) |
| 🎌 **Calendarios laborales** | Festivos oficiales, tus propios fines de semana, días de recuperación 调休, seis países de un clic y `.ics` en ambos sentidos. Cada recordatorio elige. [→](FEATURES.md#working-days-you-define) |
| 🌐 **Ventanas de entrega** | El recordatorio cae dentro del día laboral del *destinatario*, no del tuyo; si las ventanas no se pueden cumplir, se te avisa y el mensaje sale igual. [→](FEATURES.md#delivery-windows) |
| 📆 **La cuadrícula del mes es la programación** | Arrastra para mover, pulsa para abrir, teñida según la carga del día, con destinatarios, vista previa del cuerpo y estado de entrega. [→](FEATURES.md#the-month-grid-is-the-schedule) |
| 📥 **Bandeja de entrada opcional** | IMAP, unificada entre cuentas, imágenes remotas bloqueadas por defecto y códigos de verificación en una pantalla propia. [→](FEATURES.md#optional-inbox) |
| 🔤 **Variables de combinación** | Campos de contacto por destinatario más variables de calendario como `{{nextWorkday}}`, resueltas al enviar, con Cc y Cco fuera de las copias. [→](FEATURES.md#merge-variables) |
| 🔐 **Las contraseñas se quedan** | Cifradas por el sistema: DPAPI en Windows, Keystore con respaldo de hardware en Android. Nunca en los ajustes ni en una exportación. [→](FEATURES.md#passwords-stay-put) |
| 🎨 **Siete estilos visuales** | Cada uno con una forma clara y una oscura de verdad, y uno de ellos WCAG AAA de principio a fin, no aproximadamente. [→](FEATURES.md#seven-visual-styles) |

Treinta y seis entradas como estas, cada una con el razonamiento detrás →
**[FEATURES.md](FEATURES.md)**

## Novedades de 0.1.14

- **🔗 Empareja dos dispositivos por tu red local, y por nada más.** Escanea un
  código QR en el otro dispositivo: ECDH P-256 + AES-GCM, un token de un solo
  uso que caduca a los dos minutos, y ninguna nube ni servidor de retransmisión
  en ningún momento. Eliges qué se sincroniza —cuentas, programación, contactos,
  plantillas, apariencia— y gestionas los dispositivos emparejados desde una
  sola pantalla. Dos dispositivos que no se ven intercambian en su lugar un
  archivo cifrado con PIN.
- **📅 El calendario sabe del correo.** Destinatarios y número de envíos por día,
  mapa de densidad, vista previa del cuerpo sin salir de la cuadrícula, la hora
  local del destinatario *mientras* arrastras para reprogramar, una sugerencia
  de cambio cuando un envío cae en festivo, acciones en bloque sobre toda una
  serie repetida, filtro por cuenta o destinatario, distintivos de estado de
  entrega y una dirección local de suscripción `.ics` para el calendario
  laboral.
- **🎨 Un estilo visual nuevo: runecircuit.** La tinta clásica china se encuentra
  con el neón cyberpunk, con forma diurna y nocturna, un mando de intensidad de
  atmósfera y un selector de acento de dos ejes. El séptimo estilo, y el primero
  que tiene clima.
- **🌾 Los 24 términos solares (节气), calculados en vez de consultados.** La
  posición solar de Meeus, no una tabla incrustada: no hay ningún año en el que
  la cobertura se acabe. Tiñe el calendario; nunca toca una hora de envío.

Contado en detalle en **[FEATURES.md](FEATURES.md)**; lo anterior está en los
archivos `release-notes-0.1.*.md` de la raíz del repositorio.

## Descarga

La última versión está en **[Releases](https://github.com/Aevorine/Aevistle/releases/latest)**.

| Plataforma | Archivo | Notas |
|---|---|---|
| Windows 10/11 (x64) | `Aevistle-<version>-win-x64-setup.exe` | Instalador, crea accesos directos en el menú Inicio y el escritorio |
| Windows 10/11 (x64) | `Aevistle-<version>-win-x64-portable.exe` | Un solo archivo, sin instalación, funciona desde un USB |
| Android 7.0+ | `Aevistle-<version>.apk` | Móviles y tabletas. Activa antes «instalar aplicaciones desconocidas» para tu navegador o gestor de archivos. |

`<version>` es el número que muestre la página de la
[última versión](https://github.com/Aevorine/Aevistle/releases/latest); la
insignia de arriba lo lee del mismo sitio. A propósito no se escribe aquí, para
que esta tabla no pueda quedarse anticuada.

> **Verificar una descarga.** Cada versión publica `SHA256SUMS.txt`, una firma
> separada `SHA256SUMS.txt.asc` y la clave pública que la generó:
>
> ```bash
> gpg --import aevistle-public-key.asc
> gpg --verify SHA256SUMS.txt.asc SHA256SUMS.txt
> sha256sum -c SHA256SUMS.txt
> ```
>
> Las sumas de comprobación demuestran que el archivo llegó intacto; la firma
> demuestra que procede de la clave de este proyecto. La huella está en
> [SECURITY.md](../SECURITY.md).

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

Puedes comprobarlo tú mismo con `npm run audit:self`: **21 comprobaciones**,
salida en lenguaje llano, código de salida 1 si algo requiere atención.

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
| Auditoría de seguridad (21 comprobaciones) | `npm run audit:self` |
| Todo lo que ejecuta la CI (42 comprobaciones) | `npm run check` |
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
src/             la interfaz React (seis idiomas, siete estilos visuales, cada
                 uno con una forma clara y una oscura de verdad)
    ↓ PlatformBridge — la única junta entre la interfaz y un sistema operativo
electron/        Windows: nodemailer + imapflow, secretos con DPAPI, bandeja,
                 planificador híbrido de tics y precisión, saneado de HTML del
                 correo recibido
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

- [ ] OAuth 2.0 para Gmail y Microsoft 365, para dejar de necesitar contraseñas
      de aplicación
- [ ] Un editor de texto enriquecido. Las imágenes en línea ya funcionan; el
      cuadro en sí sigue siendo texto plano con Markdown
- [ ] Versiones de escritorio para macOS y Linux (el código ya las contempla)
- [ ] `FEATURES.md` en los otros cinco idiomas
- [ ] iOS

¿Falta algo? [Abre una incidencia](https://github.com/Aevorine/Aevistle/issues):
las peticiones de funciones son bienvenidas de verdad.

## Contribuir

Las pull requests son bienvenidas. Consulta **[CONTRIBUTING.md](../CONTRIBUTING.md)**
para la organización del código y cómo es un buen cambio, y
**[CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md)** para cómo se espera que se trate
aquí la gente. Añadir un séptimo idioma es un solo archivo y no necesita
herramientas de compilación: el sistema de tipos te dice exactamente qué cadenas
faltan.

Los informes de error y las peticiones de funciones tienen
[plantillas](https://github.com/Aevorine/Aevistle/issues/new/choose); cada pull
request ejecuta el mismo `npm run check` que ejecutarías en local.

## Language

| | | |
|---|---|---|
| [English](../README.md) | [简体中文](README.zh-CN.md) | [Français](README.fr.md) |
| [Español](README.es.md) | [Русский](README.ru.md) | [العربية](README.ar.md) |

## Licencia

[MIT](../LICENSE) © Aevistle contributors
