// Envio de mails via Gmail (SMTP), usando tu propia cuenta de Gmail con una
// "Contraseña de aplicación". Gratis, sin límite de dominio verificado,
// y podés mandar a cualquier destinatario (hasta ~500 mails/día).

const nodemailer = require('nodemailer');

const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const APP_NAME = process.env.APP_NAME || 'Check-In';

let transporter = null;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: Number(process.env.SMTP_PORT) || 587,
      secure: false,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  }
  return transporter;
}

async function sendEmail({ to, subject, html }) {
  if (!SMTP_USER || !SMTP_PASS) {
    console.error('[email] Falta SMTP_USER o SMTP_PASS en .env — no se pudo enviar el mail a', to);
    return { ok: false, error: 'missing_smtp_credentials' };
  }

  try {
    const info = await getTransporter().sendMail({
      from: `"${APP_NAME}" <${SMTP_USER}>`,
      to,
      subject,
      html,
    });
    console.log('[email] Enviado a', to, '-> id', info.messageId);
    return { ok: true, id: info.messageId };
  } catch (err) {
    console.error('[email] Error enviando a', to, err.message);
    return { ok: false, error: err.message };
  }
}

function alertEmailHtml({ userName, contactName, personalMessage, lastCheckinAt }) {
  const safeMessage = (personalMessage || '').replace(/\n/g, '<br>');
  return `
  <div style="font-family: -apple-system, Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a1a;">
    <h2 style="color:#b91c1c;">Alerta de check-in no realizado</h2>
    <p>Hola ${contactName || ''},</p>
    <p><strong>${userName}</strong> no hizo check-in dentro del plazo configurado en su app de seguridad
    (ultimo check-in: ${lastCheckinAt}). Por eso te llega este mensaje, que ${userName} dejo preparado para vos:</p>
    <blockquote style="background:#f4f4f5; border-left:4px solid #b91c1c; padding:12px 16px; margin:16px 0;">
      ${safeMessage || '(No se escribio un mensaje personalizado.)'}
    </blockquote>
    <p style="color:#555; font-size: 14px;">Esto no significa necesariamente que algo malo haya pasado — puede ser
    un olvido, un viaje o un problema con el telefono. Pero si te parece razonable, te sugerimos intentar contactar
    a ${userName} o pasar a verificar que este bien.</p>
    <p style="color:#999; font-size: 12px; margin-top: 24px;">Mensaje automatico enviado por la app de check-in de ${userName}.</p>
  </div>`;
}

function warningEmailHtml({ userName, hoursLeftPercent }) {
  return `
  <div style="font-family: -apple-system, Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a1a;">
    <h2 style="color:#b45309;">Falta poco para tu limite de check-in</h2>
    <p>Hola ${userName},</p>
    <p>Todavia no hiciste check-in en tu app. Si no lo hacés antes de que se cumpla tu intervalo configurado,
    se les va a enviar automaticamente un mail a tus contactos de emergencia.</p>
    <p>Entrá a la app y tocá "Check-in ahora" para reiniciar el contador.</p>
  </div>`;
}

module.exports = { sendEmail, alertEmailHtml, warningEmailHtml };
