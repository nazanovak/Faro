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

## 2. Configurar el envío de mails (con tu Gmail, gratis)

La app manda los mails usando tu propia cuenta de Gmail vía SMTP. No hace
falta verificar ningún dominio y podés mandar a cualquier destinatario
(Gmail permite hasta ~500 mails/día, de sobra para esto).

1. Entrá a tu cuenta de Google y activá la **verificación en 2 pasos**
   (myaccount.google.com/security) si todavía no la tenés activada — es un
   requisito de Google para poder generar el siguiente paso.
2. Andá a https://myaccount.google.com/apppasswords y generá una
   **"Contraseña de aplicación"**. Te va a dar un código de 16 letras.
3. En tu `.env`, completá:
   - `SMTP_USER` = tu dirección de Gmail completa
   - `SMTP_PASS` = el código de 16 letras que te dio Google (no tu contraseña normal de Gmail)
4. Listo, no hace falta tocar `SMTP_HOST` ni `SMTP_PORT`.

> Alternativa: si en algún momento tenés muchos usuarios y Gmail se queda
> corto, `email.js` es un archivo chico y se puede migrar a un servicio como
> Resend o SendGrid — avisame si llegás a ese punto.

## 3. Desplegarlo para que corra 24/7 (recomendado: Railway)

Para que el check funcione **sin que tengas nada abierto**, tiene que vivir en
un servidor. La forma más simple y gratis para este tamaño de proyecto:

### Railway (más simple)
1. Subí esta carpeta a un repo de GitHub
2. Entrá a https://railway.app → **New Project** → **Deploy from GitHub repo**
3. En **Variables**, cargá las mismas variables de tu `.env` (`RESEND_API_KEY`,
   `FROM_EMAIL`, `APP_NAME`, `JWT_SECRET`)
4. Railway detecta que es Node.js y lo levanta solo
5. **Importante**: agregá un **Volume** en Railway y montalo en `/app`, así
   `data.sqlite` no se borra cada vez que se redeploya el servicio

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
