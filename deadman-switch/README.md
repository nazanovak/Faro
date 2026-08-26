# Check-In (dead man's switch)

App de "prueba de vida": hacés check-in cada tanto y, si te pasás del plazo, se les
manda automáticamente un mail a tus contactos con el mensaje que vos escribiste
para cada uno. Corre en un servidor propio, así que funciona aunque tengas el
teléfono apagado o sin batería.

## Qué incluye

- Registro/login de usuario (con contraseña)
- Botón de check-in que reinicia el contador
- Intervalo de check-in configurable (en horas)
- Contactos ilimitados, cada uno con **su propio mensaje personalizado**
- Botón para mandarte un mail de prueba a vos mismo y ver cómo queda
- Recordatorio automático por mail al 75% del plazo, antes de que se avise a nadie
- Revisión automática cada 15 minutos (cron interno, no depende de que tengas la app abierta)

## 1. Instalación local (para probarlo)

Necesitás [Node.js](https://nodejs.org) 18 o superior instalado.

```bash
npm install
cp .env.example .env
```

Editá `.env` y completá al menos `RESEND_API_KEY` (ver paso 2) y `JWT_SECRET`
(cualquier texto largo al azar).

```bash
npm start
```

Abrí `http://localhost:3000` en el navegador.

## 2. Configurar el envío de mails (con Brevo, gratis)

La app manda los mails a través de la **API HTTPS de Brevo** (no por SMTP).
Esto es a propósito: casi todos los hosts gratis/hobby (Railway incluido)
bloquean las conexiones SMTP salientes para prevenir spam, así que usar una
API que viaja por HTTPS evita ese problema por completo. El plan gratis de
Brevo permite hasta 300 mails/día, de sobra para esto.

1. Creá una cuenta gratis en https://www.brevo.com
2. Andá a **SMTP & API → API Keys** y generá una nueva API key.
3. Andá a **Senders, Domains & Dedicated IPs → Senders**, agregá el email
   que quieras que aparezca como remitente (puede ser tu Gmail normal) y
   verificalo — te va a llegar un mail de confirmación con un link.
4. En tu `.env`, completá:
   - `BREVO_API_KEY` = la API key del paso 2
   - `SENDER_EMAIL` = el email que verificaste en el paso 3

## 3. Desplegarlo para que corra 24/7 (recomendado: Railway)

Para que el check funcione **sin que tengas nada abierto**, tiene que vivir en
un servidor. La forma más simple y gratis para este tamaño de proyecto:

### Railway (más simple)
1. Subí esta carpeta a un repo de GitHub
2. Entrá a https://railway.app → **New Project** → **Deploy from GitHub repo**
3. En **Variables**, cargá las mismas variables de tu `.env` (`BREVO_API_KEY`,
   `SENDER_EMAIL`, `APP_NAME`, `JWT_SECRET`)
4. Railway detecta que es Node.js y lo levanta solo
5. **Importante, para que no se te borren los datos en cada redeploy**:
   - Andá al **canvas** del proyecto (la vista con las cajas de los servicios,
     no adentro de la configuración de uno) y hacé click derecho en un espacio
     vacío → creá un **Volume** (o abrí la paleta de comandos con `Cmd+K` /
     `Ctrl+K` y buscá "volume")
   - Conectalo a este servicio y poné `/data` como mount path
   - En la pestaña **Variables** del servicio, agregá `DATA_DIR=/data`
   - Con eso, `data.json` (usuarios y contactos) queda guardado en el Volume,
     que persiste aunque redeployes o reinicies el servicio. Si no configurás
     esto, el archivo vive en el disco temporal del contenedor y se pierde en
     cada deploy nuevo.
   - Hacelo **antes** de cargar datos reales: si conectás el volumen después
     de haber usado la app un tiempo, arranca con una carpeta vacía y perdés
     lo que tenías (a menos que migres el `data.json` a mano).

### Render (alternativa)
Mismo proceso: **New Web Service** desde el repo, variables de entorno iguales,
comando de build `npm install`, comando de start `npm start`. En el plan free,
Render "duerme" el servicio si no recibe tráfico — para que el cron nunca se
detenga conviene el plan pago mínimo, o usar Railway.

## 4. Cómo se usa día a día

1. Entrás, te registrás y elegís tu intervalo (por ejemplo 24 horas)
2. Agregás a tus contactos con el mensaje que querés que reciban
3. Guardás la página como acceso directo en el celular
4. Tocás **"Hacer check-in ahora"** con la frecuencia que elegiste
5. Si te pasás del plazo, a los contactos les llega el mail automáticamente,
   sin que vos hagas nada más

## Estructura del proyecto

```
server.js      → rutas de la API (registro, login, check-in, contactos)
db.js          → base de datos (usuarios y contactos, guardados en data.json)
cron.js        → revisa cada 15 min si alguien se pasó del plazo
email.js       → arma y envía los mails vía Resend
public/        → la app web (una sola página)
```

Los datos se guardan en un archivo `data.json` que se crea solo la primera vez
que arrancás el servidor (no lo edites a mano mientras el servidor está
corriendo). Se eligió este formato en vez de una base de datos SQL para que
`npm install` no necesite compilar nada — funciona igual en Windows, Mac y
Linux sin instalar Python ni herramientas de compilación.

## Seguridad

- Las contraseñas se guardan con hash (bcrypt), nunca en texto plano
- La sesión usa un JWT en cookie `httpOnly`
- Cambiá `JWT_SECRET` por un valor propio antes de desplegar — no uses el de ejemplo
