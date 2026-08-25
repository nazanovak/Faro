// Envio de mails via la API HTTPS de Brevo (antes Sendinblue).
// Se usa API en vez de SMTP porque Railway (y otros hosts similares)
// bloquean las conexiones SMTP salientes en sus planes gratuitos/hobby.
// La API funciona igual en cualquier plan porque viaja por HTTPS (puerto 443).

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const SENDER_EMAIL = process.env.SENDER_EMAIL;
const APP_NAME = process.env.APP_NAME || 'Check-In';

async function sendEmail({ to, subject, html }) {
  if (!BREVO_API_KEY || !SENDER_EMAIL) {
    console.error('[email] Falta BREVO_API_KEY o SENDER_EMAIL en .env — no se pudo enviar el mail a', to);
    return { ok: false, error: 'missing_brevo_credentials' };
  }

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': BREVO_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { name: APP_NAME, email: SENDER_EMAIL },
        to: [{ email: to }],
        subject,
        htmlContent: html,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('[email] Error enviando a', to, res.status, errText);
      return { ok: false, error: errText };
    }

    const data = await res.json();
    console.log('[email] Enviado a', to, '-> id', data.messageId);
    return { ok: true, id: data.messageId };
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
