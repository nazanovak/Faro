const cron = require('node-cron');
const db = require('./db');
const { sendEmail, alertEmailHtml, warningEmailHtml, firstName } = require('./email');

const WARNING_THRESHOLD = 0.75; // avisa al usuario cuando pasó el 75% del intervalo

async function checkAllUsers() {
  const users = db.getActiveUsers();
  const now = Date.now();

  for (const user of users) {
    const lastCheckin = new Date(user.last_checkin_at).getTime();
    const intervalMs = user.checkin_interval_hours * 60 * 60 * 1000;
    const elapsed = now - lastCheckin;

    // Ya se cumplió el plazo y todavía no se mandó la alerta -> avisar a los contactos
    if (elapsed >= intervalMs && !user.alert_sent) {
      const contacts = db.getContactsByUser(user.id);
      console.log(`[cron] Usuario ${user.email} no hizo check-in a tiempo. Notificando a ${contacts.length} contacto(s).`);
      const fullName = user.name || user.email;
      const shortName = firstName(user.name) || user.email;
      const location = user.share_location && user.last_lat != null
        ? { lat: user.last_lat, lng: user.last_lng, at: user.last_location_at }
        : null;

      for (const c of contacts) {
        const combinedMessage = [user.default_message, c.message].filter(Boolean).join('\n\n');
        await sendEmail({
          to: c.email,
          subject: `Alerta: ${shortName} no hizo check-in`,
          html: alertEmailHtml({
            userName: fullName,
            contactName: c.name,
            personalMessage: combinedMessage,
            lastCheckinAt: user.last_checkin_at,
            location,
          }),
        });
      }

      db.updateUser(user.id, { alert_sent: true });
      continue;
    }

    // Pasó el 75% del intervalo y todavía no se avisó al propio usuario
    if (elapsed >= intervalMs * WARNING_THRESHOLD && !user.warning_sent && !user.alert_sent) {
      console.log(`[cron] Aviso preventivo a ${user.email}.`);
      await sendEmail({
        to: user.email,
        subject: 'Recordatorio: hacé tu check-in pronto',
        html: warningEmailHtml({ userName: user.name || user.email }),
      });
      db.updateUser(user.id, { warning_sent: true });
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
