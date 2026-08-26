const cron = require('node-cron');
const db = require('./db');
const { sendEmail, alertEmailHtml, warningEmailHtml, firstName } = require('./email');

// Después de cumplirse el plazo configurado, esperamos este margen extra
// antes de avisar a los contactos de emergencia (por si el usuario se
// olvidó pero todavía está a tiempo de hacer check-in).
const GRACE_PERIOD_MS = 2 * 60 * 60 * 1000; // 2 horas

// Recordatorios preventivos al propio usuario, medidos desde el check-in
// anterior (no desde el vencimiento del período de gracia).
const WARNING_STAGES = [
  {
    key: 'warning_half_sent',
    subject: 'Recordatorio: ya pasó la mitad de tu plazo de check-in',
    urgencyLabel: 'la mitad de tu tiempo',
    thresholdMs: (intervalMs) => intervalMs / 2,
  },
  {
    key: 'warning_1h_sent',
    subject: 'Recordatorio: te queda 1 hora para el check-in',
    urgencyLabel: '1 hora',
    thresholdMs: (intervalMs) => intervalMs - 60 * 60 * 1000,
  },
  {
    key: 'warning_15m_sent',
    subject: 'Recordatorio: te quedan 15 minutos para el check-in',
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
          subject: `Alerta: ${shortName} no dio señal`,
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
      continue;
    }

    // Recordatorios preventivos al propio usuario (si los tiene activados),
    // a mitad de plazo, 1 hora antes y 15 minutos antes de que se cumpla
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
          db.updateUser(user.id, { [stage.key]: true });
        }
      }
    }
  }
}

function startScheduler() {
  // Corre cada 15 minutos. Ajustable segun necesites mas o menos precision.
  cron.schedule('*/15 * * * *', () => {
    checkAllUsers().catch((err) => console.error('[cron] Error en checkAllUsers:', err));
  });
  console.log('[cron] Scheduler iniciado (corre cada 15 minutos).');
}

module.exports = { startScheduler, checkAllUsers };
