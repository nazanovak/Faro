const cron = require('node-cron');
const db = require('./db');
const { sendEmail, alertEmailHtml, warningEmailHtml, firstName } = require('./email');
const push = require('./push');

// Manda una notificación push a todos los dispositivos del usuario y
// limpia las suscripciones que ya vencieron (app desinstalada, etc.)
async function notifyUserPush(userId, payload) {
  const subs = db.getPushSubscriptionsByUser(userId);
  if (!subs.length) return;
  const expired = await push.sendPushToUser(subs, payload);
  expired.forEach((endpoint) => db.deletePushSubscriptionByEndpoint(endpoint));
}

// Después de cumplirse el plazo configurado, esperamos este margen extra
// antes de avisar a los contactos de emergencia (por si el usuario se
// olvidó pero todavía está a tiempo de hacer check-in).
const GRACE_PERIOD_MS = 2 * 60 * 60 * 1000; // 2 horas

// Recordatorios preventivos al propio usuario, medidos desde el check-in
// anterior (no desde el vencimiento del período de gracia).
const WARNING_STAGES = [
  {
    key: 'warning_quarter_sent',
    subject: 'Recordatorio: te queda 1/4 de tu tiempo para dar señal',
    urgencyLabel: '1/4 de tu tiempo',
    thresholdMs: (intervalMs) => intervalMs - intervalMs / 4,
  },
  {
    key: 'warning_1h_sent',
    subject: 'Recordatorio: te queda 1 hora para dar señal',
    urgencyLabel: '1 hora',
    thresholdMs: (intervalMs) => intervalMs - 60 * 60 * 1000,
  },
  {
    key: 'warning_15m_sent',
    subject: 'Recordatorio: te quedan 15 minutos para dar señal',
    urgencyLabel: '15 minutos',
    thresholdMs: (intervalMs) => intervalMs - 15 * 60 * 1000,
  },
];

async function checkAllUsers() {
  const users = db.getActiveUsers();
  const now = Date.now();

  for (const user of users) {
    const lastCheckin = new Date(user.last_checkin_at).getTime();
    const intervalMs = user.checkin_interval_hours * 60 * 60 * 1000;
    const elapsed = now - lastCheckin;

    // Ya se cumplió el plazo + el período de gracia y todavía no se mandó
    // la alerta -> avisar a los contactos
    if (elapsed >= intervalMs + GRACE_PERIOD_MS && !user.alert_sent) {
      const contacts = db.getContactsByUser(user.id);
      console.log(`[cron] Usuario ${user.email} no hizo check-in a tiempo (con margen de gracia incluido). Notificando a ${contacts.length} contacto(s).`);
      const fullName = user.name || user.email;
      const shortName = firstName(user.name) || user.email;
      const location = user.share_location && user.last_lat != null
        ? { lat: user.last_lat, lng: user.last_lng, at: user.last_location_at }
        : null;
      const referencePeople = db.getReferencePeopleByUser(user.id);

      for (const c of contacts) {
        const combinedMessage = [user.default_message, c.message].filter(Boolean).join('\n\n');
        await sendEmail({
          to: c.email,
          subject: `Faro no recibió la señal de ${shortName}`,
          html: alertEmailHtml({
            userName: fullName,
            shortName,
            contactName: c.name,
            personalMessage: combinedMessage,
            lastCheckinAt: user.last_checkin_at,
            location,
            referencePeople,
          }),
        });
      }

      db.updateUser(user.id, { alert_sent: true });
      await notifyUserPush(user.id, {
        title: 'No enviaste señal a tiempo',
        body: `No diste señal a tiempo. Ya se avisó a tus ${contacts.length} contacto(s) de emergencia.`,
        url: '/',
        tag: 'faro-alert',
      });
      continue;
    }

    // Recordatorios preventivos al propio usuario (si los tiene activados),
    // cuando queda 1/4 del plazo, 1 hora antes y 15 minutos antes de que se cumpla
    if (user.send_reminders !== false && !user.alert_sent) {
      for (const stage of WARNING_STAGES) {
        const threshold = stage.thresholdMs(intervalMs);
        if (threshold >= 0 && elapsed >= threshold && !user[stage.key]) {
          console.log(`[cron] Recordatorio (${stage.key}) a ${user.email}.`);
          await sendEmail({
            to: user.email,
            subject: stage.subject,
            html: warningEmailHtml({ userName: user.name || user.email, urgencyLabel: stage.urgencyLabel }),
          });
          await notifyUserPush(user.id, {
            title: 'Recordatorio de check-in',
            body: `Te queda ${stage.urgencyLabel} para dar señal.`,
            url: '/',
            tag: 'faro-warning',
          });
          db.updateUser(user.id, { [stage.key]: true });
        }
      }
    }
  }
}

function startScheduler() {
  // Corre cada 1 minuto para que los recordatorios (sobre todo el de "15
  // minutos antes") salgan con precisión y no lleguen tarde.
  cron.schedule('* * * * *', () => {
    checkAllUsers().catch((err) => console.error('[cron] Error en checkAllUsers:', err));
  });
  console.log('[cron] Scheduler iniciado (corre cada 1 minuto).');
}

module.exports = { startScheduler, checkAllUsers };
