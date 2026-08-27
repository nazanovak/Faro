// Envío de notificaciones push (funciona en Android, escritorio, y en iOS
// 16.4+ siempre que la app haya sido agregada a la pantalla de inicio).
const webpush = require('web-push');

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:contacto@example.com';

const isConfigured = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

if (isConfigured) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn('[push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY no configuradas: las notificaciones push están desactivadas.');
}

// Manda una notificación a UNA suscripción puntual. Devuelve { ok, expired }
// para que el llamador pueda limpiar suscripciones vencidas.
async function sendPushToSubscription(subscription, payload) {
  if (!isConfigured) return { ok: false, expired: false };
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    return { ok: true, expired: false };
  } catch (err) {
    // 404/410 = la suscripción ya no existe (el usuario desinstaló la app,
    // borró datos del navegador, etc.) -> conviene borrarla de la DB.
    const expired = err && (err.statusCode === 404 || err.statusCode === 410);
    if (!expired) console.error('[push] Error enviando notificación:', err && err.message);
    return { ok: false, expired };
  }
}

// Manda la misma notificación a todas las suscripciones de un usuario
// (puede tener varias: celular, PC, etc.) y devuelve los endpoints vencidos.
async function sendPushToUser(subscriptions, payload) {
  const expiredEndpoints = [];
  await Promise.all(
    subscriptions.map(async (sub) => {
      const result = await sendPushToSubscription(sub, payload);
      if (result.expired) expiredEndpoints.push(sub.endpoint);
    })
  );
  return expiredEndpoints;
}

module.exports = {
  isConfigured,
  publicKey: VAPID_PUBLIC_KEY,
  sendPushToSubscription,
  sendPushToUser,
};
