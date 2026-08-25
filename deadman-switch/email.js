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
        replyTo: { email: SENDER_EMAIL },
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

// Convierte números de teléfono sueltos en un texto a links tel: tocables,
// así en el celular el destinatario puede tocar y llamar directo.
function linkifyPhones(text) {
  return text.replace(/(\+\d[\d\s\-\u2011]{6,}\d)/g, (match) => {
    const clean = match.replace(/[\s\-\u2011]/g, '');
    return `<a href="tel:${clean}" style="color:#0f172a;font-weight:600;text-decoration:none;border-bottom:1px solid #0f172a;">${match}</a>`;
  });
}

const EMAIL_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif";

function emailShell({ iconGradient, title, subtitle, bodyHtml }) {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;">
  <div style="background:#fdf6ec;padding:36px 16px;font-family:${EMAIL_FONT};">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:20px;padding:8px;box-shadow:0 4px 16px rgba(30,27,20,0.08);">
      <div style="border:1px solid #eee0c8;border-radius:16px;padding:36px 32px;">
        <div style="text-align:center;margin-bottom:20px;">
          <div style="width:64px;height:64px;border-radius:50%;background:${iconGradient};margin:0 auto 16px;box-shadow:0 0 0 6px #fef3c7;"></div>
          <h1 style="color:#1c1917;font-size:21px;margin:0;font-weight:400;font-family:Georgia,'Times New Roman',serif;">${title}</h1>
          <p style="color:#a8a29e;font-size:12.5px;margin:6px 0 0;">${subtitle}</p>
        </div>
        ${bodyHtml}
      </div>
    </div>
    <p style="color:#c4b89a;font-size:11px;text-align:center;margin:18px 0 0;">Enviado automáticamente por Faro, tu app de check-in.</p>
  </div>
</body></html>`;
}

function alertEmailHtml({ userName, contactName, personalMessage, lastCheckinAt }) {
  const safeMessage = linkifyPhones((personalMessage || '').replace(/\n/g, '<br>'));
  const fecha = new Date(lastCheckinAt).toLocaleString('es-AR', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Argentina/Buenos_Aires',
  });
  const bodyHtml = `
        <p style="color:#44403c;font-size:14.5px;line-height:1.7;margin:0 0 22px;">
          Hola ${contactName || ''},
        </p>
        <p style="color:#44403c;font-size:14.5px;line-height:1.7;margin:-14px 0 22px;">
          <strong style="color:#1c1917;">${userName}</strong> no hizo check-in dentro del plazo configurado en su
          app de seguridad (último check-in: ${fecha}). Por eso te llega este mensaje automático, con lo que
          ${userName} dejó preparado para vos:
        </p>
        <div style="background:#fdf6ec;border-radius:12px;padding:22px 24px;margin:0 0 22px;">
          <p style="color:#292524;font-size:14.5px;line-height:1.85;margin:0;">
            ${safeMessage || '(No se escribió un mensaje personalizado.)'}
          </p>
        </div>
        <p style="color:#a8a29e;font-size:12.5px;line-height:1.6;margin:0;">
          Esto no significa necesariamente que algo malo haya pasado — puede ser un olvido, un viaje o un problema
          con el teléfono. Pero si te parece razonable, intentá contactar a ${userName} o pasar a verificar que esté bien.
        </p>`;
  return emailShell({
    iconGradient: 'radial-gradient(circle at 35% 30%,#fde68a,#d97706)',
    title: `${userName} no hizo check-in`,
    subtitle: fecha,
    bodyHtml,
  });
}

function warningEmailHtml({ userName }) {
  const bodyHtml = `
        <p style="color:#44403c;font-size:14.5px;line-height:1.7;margin:0 0 22px;">
          Hola ${userName},
        </p>
        <p style="color:#44403c;font-size:14.5px;line-height:1.7;margin:-14px 0 22px;">
          Todavía no hiciste check-in en Faro. Si no lo hacés antes de que se cumpla tu intervalo configurado,
          se les va a avisar automáticamente a tus contactos de emergencia.
        </p>
        <p style="color:#44403c;font-size:14.5px;line-height:1.7;margin:0;">
          Entrá a la app y tocá <strong style="color:#1c1917;">"Hacer check-in ahora"</strong> para reiniciar el contador.
        </p>`;
  return emailShell({
    iconGradient: 'radial-gradient(circle at 35% 30%,#fef3c7,#f59e0b)',
    title: 'Falta poco para tu check-in',
    subtitle: '',
    bodyHtml,
  });
}

module.exports = { sendEmail, alertEmailHtml, warningEmailHtml };
