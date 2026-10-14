# THE VIEW: back office de BRASPER

Equipo: the VIEW · MVP de BRASPER. Pantalla del equipo para validar pagos, exportar órdenes al Dashboard y emitir facturas, conectada al proyecto Firebase **`aibrasper`** (el mismo que usa la app de clientes).

```
Cliente (app Expo / asistente) ──► Firestore + Storage ◄──► THE VIEW (esta app)
                                        ▲                       │ Cloud Functions
                                        └───────────────────────┘ reviewOrder · exportOrders · runFact · getReceipt · createManualOrder
```

Flujo de una operación: `pending → validating → approved → exported → factura (Fact)`; también `rejected` y `cancelled`.

## Qué hace

| Acción | Quién puede (rol) | Función de Firebase |
|---|---|---|
| Ver todas las operaciones en vivo, filtrar, buscar, ver la foto del comprobante y todos los datos | cualquier rol de equipo | lectura de Firestore y Storage (reglas) |
| Aprobar o rechazar (con motivo) una operación **En validación** | `validator`, `admin` | `reviewOrder` |
| Exportar las aprobadas (CSV para el Dashboard); pasan a **Exportada** | `operator`, `admin` | `exportOrders` |
| Correr Fact (prueba): factura, XML y PDF de las exportadas | `billing`, `admin` | `runFact` |
| Descargar el PDF de una factura | cualquier rol de equipo | `getReceipt` |
| **+ Nueva operación** cerrada con un vendedor (tasa negociada) y adjuntar su comprobante | `validator`, `operator`, `admin` | `createManualOrder` + `submitProof` |

Los botones se activan según tu rol y el servidor lo vuelve a comprobar. El impuesto, el monto a recibir y el total los calcula el servidor. Fact corre en **modo prueba**: las facturas no tienen validez fiscal.

## Cómo correrlo

```bash
npm install
cp .env.example .env     # y completa FIREBASE_API_KEY, FIREBASE_MESSAGING_SENDER_ID y FIREBASE_APP_ID (ver abajo)
npm start                # http://localhost:3000   (o doble clic en iniciar.bat en Windows)
```

Los valores salen de `firebase apps:sdkconfig WEB --project aibrasper` (o de la consola de Firebase > Configuración del proyecto > Tus apps). **`.env` no se sube a git.**

Entra con un correo de equipo. **Solo funciona con usuarios que tengan un rol** (custom claim `role`); un usuario sin rol ve el aviso y no puede leer nada.

### Crear usuarios de equipo

Necesita credenciales de Google en tu máquina (una vez: `gcloud auth application-default login`) y permiso en el proyecto:

```bash
npm run grant-staff -- tu@correo.com admin --password 'una-clave-segura'   # crea el usuario y le da el rol
npm run grant-staff -- otra@correo.com validator                         # a un usuario que ya existe
```

Roles: `admin` (todo), `validator`, `operator`, `billing`. Después de cambiar un rol, cierra sesión y vuelve a entrar.

### Probar sin tocar producción (emuladores)

En el repo de la app (`iathon_fintech`): `bun run emulators`. Luego:

```bash
FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 npm run grant-staff -- demo@brasper.test admin --password test-pass-123
# abre http://localhost:3000/?emulator   (aparece la etiqueta EMULADOR)
```

Para generar operaciones de prueba: `STOP_AFTER=proof node functions/scripts/e2e-emulator.mjs` en `iathon_fintech` (deja una operación En validación).

## Firebase en este repo

- `.firebaserc`: proyecto `aibrasper`; el target de hosting `view` apunta al sitio `aibrasper-view`.
- `firebase.json`: hosting estático de `public/` con cabeceras de seguridad. El sitio por defecto de `aibrasper` es de la app de clientes, por eso la VIEW usa su propio sitio. Para publicarla (una vez):
  ```bash
  firebase hosting:sites:create aibrasper-view --app <APP_ID de la app web> --project aibrasper   # --app enlaza la app web para que Hosting sirva /__/firebase/init.json
  npm run deploy
  ```
- `public/firebase-config.js`: **no contiene claves**. Pide la configuración web a `/__/firebase/init.json`: en Hosting la sirve Firebase, y en local la sirve `server.js` desde `.env`.
- Todo el código del servidor está en `iathon_fintech/functions`; aquí `server.js` solo sirve los archivos en local.

## Secretos

- Nada secreto se versiona: `.env`, `.env.*`, `serviceAccount*.json` y `*-adminsdk-*.json` están en `.gitignore`.
- La clave web de Firebase (`apiKey`) **no es una contraseña**, pero los escáneres de secretos la marcan y conviene restringirla: en Google Cloud Console > APIs y servicios > Credenciales, limítala por **referente HTTP** (`localhost:3000/*` y el dominio de la VIEW) y a las APIs que usa (Identity Toolkit, Firestore, Cloud Functions, Cloud Storage).
- Lo que sí protege los datos son Firebase Auth, las reglas y los roles: sin un usuario con rol no se lee nada.
- Para crear usuarios se usan credenciales de Google de tu máquina (`gcloud auth application-default login`); no hay cuentas de servicio en el repo.
- Si algún día se sube un secreto por error, rótalo primero y luego límpialo del historial.

## Qué cambió respecto a la versión con SQLite

La versión anterior guardaba todo en SQLite local (`db.js`, `uploads/`) con datos de ejemplo. Ahora la fuente de verdad es Firestore, las fotos viven en Storage (privadas) y las reglas de negocio están en las Cloud Functions, así que la app de clientes y la VIEW ven las mismas operaciones. Se quitaron `db.js`, `multer` y `node:sqlite`.

## Pendiente / límites del MVP

- No hay pantalla de usuarios: los roles se dan con `grant-staff`.
- Fact es simulado (sin KeyFácil/Omni) y no envía el PDF por correo: se descarga desde la VIEW.
- Sin paginación: se muestran las últimas 300 operaciones.
- El CSV exportado sigue las columnas del plan; falta confirmar el formato exacto que importa el Dashboard.
