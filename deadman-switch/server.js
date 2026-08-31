require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const db = require('./db');
const { startScheduler } = require('./cron');
const { sendEmail, alertEmailHtml, warningEmailHtml, firstName } = require('./email');
const push = require('./push');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'cambia-este-secreto-en-produccion';

// Lista de emails con permisos de Administrador, separados por coma
// (ej: ADMIN_EMAILS=vos@ejemplo.com,otro@ejemplo.com). Se define por .env
// en vez de guardarse en data.json para no tener que migrar nada: alcanza
// con agregar el mail ahí y reiniciar el servidor.
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

function isAdminEmail(email) {
  return ADMIN_EMAILS.includes((email || '').toLowerCase());
}

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Helpers ----------
function authRequired(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'No autenticado' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch {
    return res.status(401).json({ error: 'Sesion invalida' });
  }
}

// Además de estar logueado, el mail de la cuenta tiene que estar en
// ADMIN_EMAILS. Se fija siempre contra la base (no contra el JWT) para que
// sacar a alguien de ADMIN_EMAILS lo deslogueé del panel al toque.
function adminRequired(req, res, next) {
  const user = db.findUserById(req.userId);
  if (!user || !isAdminEmail(user.email)) {
    return res.status(403).json({ error: 'No tenés permisos de administrador' });
  }
  req.adminUser = user;
  next();
}

function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    checkin_interval_hours: u.checkin_interval_hours,
    last_checkin_at: u.last_checkin_at,
    send_reminders: u.send_reminders !== false,
    send_reminder_emails: u.send_reminder_emails !== false,
    has_push_subscriptions: db.getPushSubscriptionsByUser(u.id).length > 0,
    alert_sent: !!u.alert_sent,
    paused: !!u.paused,
    default_message: u.default_message || '',
    share_location: !!u.share_location,
    last_lat: u.last_lat ?? null,
    last_lng: u.last_lng ?? null,
    last_location_at: u.last_location_at ?? null,
    is_admin: isAdminEmail(u.email),
  };
}

// El check-in se puede configurar entre 2 horas y 30 días (720 horas).
const MIN_CHECKIN_HOURS = 2;
const MAX_CHECKIN_HOURS = 24 * 30;
const DEFAULT_CHECKIN_HOURS = 24;

function clampCheckinInterval(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(MAX_CHECKIN_HOURS, Math.max(MIN_CHECKIN_HOURS, n));
}

// ---------- Auth ----------
app.post('/api/register', async (req, res) => {
  const { email, password, name, checkin_interval_hours } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Falta email o password' });
  if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });

  const normalizedEmail = email.toLowerCase();
  if (db.findUserByEmail(normalizedEmail)) {
    return res.status(409).json({ error: 'Ya existe una cuenta con ese email' });
  }

  const hash = bcrypt.hashSync(password, 10);
  const interval = clampCheckinInterval(checkin_interval_hours, DEFAULT_CHECKIN_HOURS);

  const user = db.createUser({
    email: normalizedEmail,
    password_hash: hash,
    name: name || '',
    checkin_interval_hours: interval,
  });

  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '90d' });
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 90 * 24 * 60 * 60 * 1000 });
  res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db.findUserByEmail((email || '').toLowerCase());
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Email o contraseña incorrectos' });
  }
  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '90d' });
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 90 * 24 * 60 * 60 * 1000 });
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

// ---------- Usuario / dashboard ----------
app.get('/api/me', authRequired, (req, res) => {
  const user = db.findUserById(req.userId);
  const contacts = db.getContactsByUser(req.userId);
  const referencePeople = db.getReferencePeopleByUser(req.userId);
  res.json({ user: publicUser(user), contacts, referencePeople });
});

app.post('/api/checkin', authRequired, (req, res) => {
  const { lat, lng } = req.body || {};
  const user = db.findUserById(req.userId);
  const nowAt = db.nowIso();
  const patch = {
    last_checkin_at: nowAt,
    warning_half_sent: false,
    warning_1h_sent: false,
    warning_15m_sent: false,
    alert_sent: false,
  };
  // Solo guardamos coordenadas si el usuario activó "compartir ubicación"
  const hasLocation = user.share_location && typeof lat === 'number' && typeof lng === 'number';
  if (hasLocation) {
    patch.last_lat = lat;
    patch.last_lng = lng;
    patch.last_location_at = nowAt;
  }
  const updated = db.updateUser(req.userId, patch);
  // Guarda un registro en el historial de check-ins (para que el admin lo vea)
  db.addCheckinRecord({
    user_id: req.userId,
    at: nowAt,
    lat: hasLocation ? lat : null,
    lng: hasLocation ? lng : null,
  });
  res.json({ ok: true, last_checkin_at: updated.last_checkin_at, last_lat: updated.last_lat, last_lng: updated.last_lng, last_location_at: updated.last_location_at });
});

// No se puede desactivar el mail de los recordatorios si el usuario no
// tiene ninguna notificación push activa: sin eso se quedaría sin forma
// de enterarse. Devuelve el valor final que hay que guardar.
function resolveSendReminderEmails(userId, requestedValue, currentValue) {
  if (requestedValue === undefined) return currentValue;
  if (requestedValue === false && db.getPushSubscriptionsByUser(userId).length === 0) {
    return { error: 'Para desactivar los mails de recordatorio primero tenés que activar las notificaciones push.' };
  }
  return !!requestedValue;
}

app.put('/api/settings', authRequired, (req, res) => {
  const { name, checkin_interval_hours, paused, default_message, send_reminder_emails } = req.body || {};
  const user = db.findUserById(req.userId);

  if (checkin_interval_hours !== undefined) {
    const n = Number(checkin_interval_hours);
    if (!Number.isFinite(n) || n < MIN_CHECKIN_HOURS || n > MAX_CHECKIN_HOURS) {
      return res.status(400).json({
        error: `El intervalo de check-in tiene que estar entre ${MIN_CHECKIN_HOURS} horas y ${MAX_CHECKIN_HOURS / 24} días.`,
      });
    }
  }

  const resolvedEmails = resolveSendReminderEmails(req.userId, send_reminder_emails, user.send_reminder_emails !== false);
  if (resolvedEmails && resolvedEmails.error) return res.status(400).json({ error: resolvedEmails.error });
  db.updateUser(req.userId, {
    name: name !== undefined ? name : user.name,
    checkin_interval_hours:
      checkin_interval_hours !== undefined ? clampCheckinInterval(checkin_interval_hours, user.checkin_interval_hours) : user.checkin_interval_hours,
    paused: paused !== undefined ? !!paused : user.paused,
    default_message: default_message !== undefined ? default_message : user.default_message,
    send_reminder_emails: resolvedEmails,
    // La ubicación y los recordatorios siempre están activos por defecto,
    // no son configurables desde acá.
    share_location: true,
    send_reminders: true,
  });
  res.json({ ok: true });
});

// Cambiar la propia contraseña (pidiendo la actual, como corresponde).
// Sirve tanto para cuentas de administrador como para cuentas normales:
// cada una cambia la suya. Para resetear la contraseña de OTRO usuario
// que la olvidó, el admin lo hace desde /admin.html sin pedir la actual.
app.put('/api/change-password', authRequired, (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body || {};
  if (!currentPassword || !newPassword || !confirmPassword) {
    return res.status(400).json({ error: 'Faltan datos' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres' });
  }
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ error: 'Las dos contraseñas nuevas no coinciden' });
  }
  const user = db.findUserById(req.userId);
  if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(401).json({ error: 'La contraseña actual no es correcta' });
  }
  db.updateUser(req.userId, { password_hash: bcrypt.hashSync(newPassword, 10) });
  res.json({ ok: true });
});

// Mandar a la propia cuenta un mail de prueba del recordatorio de "falta
// poco para dar señal" (el mismo que se dispara automáticamente cuando
// queda la mitad del plazo, 1 hora antes y 15 minutos antes de que se cumpla el intervalo).
app.post('/api/test-reminder', authRequired, async (req, res) => {
  const user = db.findUserById(req.userId);
  const { urgencyLabel } = req.body || {};

  const result = await sendEmail({
    to: user.email,
    subject: '[PRUEBA] Falta poco para enviar tu señal',
    html:
      '<p style="color:#b45309"><strong>Este es un mail de prueba — no significa que se te esté por vencer el plazo de verdad.</strong></p>' +
      warningEmailHtml({
        userName: user.name || user.email,
        urgencyLabel: urgencyLabel || '15 minutos',
      }),
  });

  if (!result.ok) return res.status(500).json({ error: 'No se pudo enviar el mail. Revisá la configuración de BREVO_API_KEY.' });
  res.json({ ok: true });
});

// Borra la cuenta y todos sus contactos, sin vuelta atrás
app.delete('/api/me', authRequired, (req, res) => {
  db.deleteUser(req.userId);
  res.clearCookie('token');
  res.json({ ok: true });
});

// ---------- Contactos ----------
app.post('/api/contacts', authRequired, (req, res) => {
  const { name, email, message } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: 'Falta nombre o email del contacto' });
  const contact = db.createContact({ user_id: req.userId, name, email, message: message || '' });
  res.json({ ok: true, id: contact.id });
});

app.put('/api/contacts/:id', authRequired, (req, res) => {
  const { name, email, message } = req.body || {};
  const contact = db.findContact(req.params.id, req.userId);
  if (!contact) return res.status(404).json({ error: 'Contacto no encontrado' });
  db.updateContact(req.params.id, req.userId, {
    name: name ?? contact.name,
    email: email ?? contact.email,
    message: message ?? contact.message,
  });
  res.json({ ok: true });
});

app.delete('/api/contacts/:id', authRequired, (req, res) => {
  db.deleteContact(req.params.id, req.userId);
  res.json({ ok: true });
});

// Mandar un mail de prueba a un contacto, con el mensaje real que se usaria
app.post('/api/contacts/:id/test', authRequired, async (req, res) => {
  const contact = db.findContact(req.params.id, req.userId);
  if (!contact) return res.status(404).json({ error: 'Contacto no encontrado' });
  const user = db.findUserById(req.userId);
  const fullName = user.name || user.email;
  const shortName = firstName(user.name) || user.email;

  const combinedMessage = [user.default_message, contact.message].filter(Boolean).join('\n\n');
  const location = user.share_location && user.last_lat != null
    ? { lat: user.last_lat, lng: user.last_lng, at: user.last_location_at }
    : null;
  const referencePeople = db.getReferencePeopleByUser(req.userId);

  const result = await sendEmail({
    to: contact.email,
    subject: `[PRUEBA] Faro no recibió la señal de ${shortName}`,
    html:
      '<p style="color:#b45309"><strong>Este es un mail de prueba — no significa que haya pasado nada.</strong></p>' +
      alertEmailHtml({
        userName: fullName,
        shortName,
        contactName: contact.name,
        personalMessage: combinedMessage,
        lastCheckinAt: user.last_checkin_at,
        location,
        referencePeople,
      }),
  });

  if (!result.ok) return res.status(500).json({ error: 'No se pudo enviar el mail. Revisá la configuración de BREVO_API_KEY.' });
  res.json({ ok: true });
});

// ---------- Amigos ----------
// A diferencia de los "contactos de emergencia" (que son mails externos),
// un amigo es otro usuario de la app. Una vez que se aceptan mutuamente,
// cada uno puede ver la última ubicación que el otro compartió al hacer
// check-in (si tiene "compartir ubicación" activado).
function publicFriend(link, meId) {
  const otherId = link.from_user_id === Number(meId) ? link.to_user_id : link.from_user_id;
  const other = db.findUserById(otherId);
  if (!other) return null;
  const direction = link.from_user_id === Number(meId) ? 'outgoing' : 'incoming';
  const base = {
    link_id: link.id,
    status: link.status,
    direction,
    id: other.id,
    name: other.name || other.email,
    email: other.email,
    last_checkin_at: other.last_checkin_at,
  };
  if (link.status === 'accepted' && other.share_location && other.last_lat != null) {
    base.location = { lat: other.last_lat, lng: other.last_lng, at: other.last_location_at };
  } else {
    base.location = null;
  }
  return base;
}

app.get('/api/friends', authRequired, (req, res) => {
  const links = db.getFriendLinksForUser(req.userId);
  const friends = links.map((l) => publicFriend(l, req.userId)).filter(Boolean);
  res.json({ friends });
});

app.post('/api/friends', authRequired, (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Falta el email' });
  const normalizedEmail = String(email).toLowerCase().trim();

  const me = db.findUserById(req.userId);
  if (normalizedEmail === (me.email || '').toLowerCase()) {
    return res.status(400).json({ error: 'No podés agregarte a vos mismo' });
  }

  const target = db.findUserByEmail(normalizedEmail);
  if (!target) {
    return res.status(404).json({ error: 'No hay ninguna cuenta de Faro con ese email' });
  }

  const existing = db.findFriendLinkBetween(req.userId, target.id);
  if (existing) {
    return res.status(409).json({ error: 'Ya existe un pedido o amistad con esa persona' });
  }

  const link = db.createFriendRequest({ from_user_id: req.userId, to_user_id: target.id });
  res.json({ ok: true, friend: publicFriend(link, req.userId) });
});

app.post('/api/friends/:id/accept', authRequired, (req, res) => {
  const link = db.findFriendLink(req.params.id);
  if (!link || link.to_user_id !== req.userId) {
    return res.status(404).json({ error: 'Pedido no encontrado' });
  }
  const updated = db.acceptFriendLink(link.id);
  res.json({ ok: true, friend: publicFriend(updated, req.userId) });
});

app.delete('/api/friends/:id', authRequired, (req, res) => {
  const link = db.findFriendLink(req.params.id);
  if (!link || (link.from_user_id !== req.userId && link.to_user_id !== req.userId)) {
    return res.status(404).json({ error: 'No encontrado' });
  }
  db.deleteFriendLink(link.id);
  res.json({ ok: true });
});

// Cooldown para que no se pueda estar mandando el mismo pedido cada rato.
const CHECKIN_REQUEST_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 horas

// Pedirle a un amigo que "encienda el Faro" (haga check-in), mandándole una
// notificación push. Solo funciona si ya son amigos aceptados y el otro
// tiene al menos un dispositivo suscripto a notificaciones push.
app.post('/api/friends/:id/request-checkin', authRequired, async (req, res) => {
  const link = db.findFriendLink(req.params.id);
  if (!link || link.status !== 'accepted' || (link.from_user_id !== req.userId && link.to_user_id !== req.userId)) {
    return res.status(404).json({ error: 'Amigo no encontrado' });
  }

  const requesterIsFrom = link.from_user_id === req.userId;
  const otherId = requesterIsFrom ? link.to_user_id : link.from_user_id;
  const other = db.findUserById(otherId);
  if (!other) return res.status(404).json({ error: 'Amigo no encontrado' });

  const cooldownField = requesterIsFrom ? 'last_checkin_request_from_at' : 'last_checkin_request_to_at';
  const lastRequestAt = link[cooldownField];
  if (lastRequestAt) {
    const elapsed = Date.now() - new Date(lastRequestAt).getTime();
    if (elapsed < CHECKIN_REQUEST_COOLDOWN_MS) {
      const waitMin = Math.max(1, Math.ceil((CHECKIN_REQUEST_COOLDOWN_MS - elapsed) / 60000));
      return res.status(429).json({ error: `Ya le pediste hace poco. Esperá ${waitMin} min para volver a pedirle.` });
    }
  }

  const subs = db.getPushSubscriptionsByUser(other.id);
  if (!subs.length) {
    return res.status(400).json({ error: `${other.name || other.email} no tiene notificaciones push activadas, no se le puede avisar desde acá.` });
  }

  const me = db.findUserById(req.userId);
  const myName = me.name || me.email;
  const expired = await push.sendPushToUser(subs, {
    title: 'Te están pidiendo que enciendas el Faro',
    body: `${myName} quiere saber que estás bien. Abrí Faro y hacé check-in.`,
    url: '/',
    tag: 'faro-checkin-request',
  });
  expired.forEach((endpoint) => db.deletePushSubscriptionByEndpoint(endpoint));

  db.updateFriendLink(link.id, { [cooldownField]: new Date().toISOString() });

  res.json({ ok: true });
});

// ---------- Personas de contacto ----------
// No reciben ningún mail: solo sus datos (nombre, relación y teléfono) se
// incluyen dentro del mail que reciben los contactos de emergencia.
const MAX_REFERENCE_PEOPLE = 5;

app.post('/api/reference-people', authRequired, (req, res) => {
  const { name, relation, phone, email } = req.body || {};
  if (!name || !(phone || email)) {
    return res.status(400).json({ error: 'Falta nombre y al menos un teléfono o email' });
  }
  const existing = db.getReferencePeopleByUser(req.userId);
  if (existing.length >= MAX_REFERENCE_PEOPLE) {
    return res.status(400).json({ error: `Ya tenés el máximo de ${MAX_REFERENCE_PEOPLE} personas de contacto` });
  }
  const person = db.createReferencePerson({
    user_id: req.userId,
    name,
    relation: relation || '',
    phone: phone || '',
    email: email || '',
  });
  res.json({ ok: true, id: person.id });
});

app.put('/api/reference-people/:id', authRequired, (req, res) => {
  const { name, relation, phone, email } = req.body || {};
  const person = db.findReferencePerson(req.params.id, req.userId);
  if (!person) return res.status(404).json({ error: 'Persona de contacto no encontrada' });
  if (!(name ?? person.name) || !((phone ?? person.phone) || (email ?? person.email))) {
    return res.status(400).json({ error: 'Falta nombre y al menos un teléfono o email' });
  }
  db.updateReferencePerson(req.params.id, req.userId, {
    name: name ?? person.name,
    relation: relation ?? person.relation,
    phone: phone ?? person.phone,
    email: email ?? person.email,
  });
  res.json({ ok: true });
});

app.delete('/api/reference-people/:id', authRequired, (req, res) => {
  db.deleteReferencePerson(req.params.id, req.userId);
  res.json({ ok: true });
});

// ---------- Notificaciones push ----------
// La clave pública VAPID no es secreta: el frontend la necesita para
// suscribirse. isConfigured indica si el server tiene las claves cargadas.
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: push.publicKey, configured: push.isConfigured });
});

app.post('/api/push/subscribe', authRequired, (req, res) => {
  const { subscription } = req.body || {};
  if (!subscription || !subscription.endpoint || !subscription.keys) {
    return res.status(400).json({ error: 'Suscripción inválida' });
  }
  db.savePushSubscription({ user_id: req.userId, subscription });
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', authRequired, (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint) db.deletePushSubscriptionByEndpoint(endpoint);
  res.json({ ok: true });
});

// Mandar una push de prueba a todos los dispositivos del usuario logueado.
// Solo cuentas de Administrador pueden hacerlo (las cuentas normales no
// pueden mandarse push de prueba a sí mismas); el admin puede probar la de
// cualquier usuario desde el panel de administración (/api/admin/.../push/test).
app.post('/api/push/test', authRequired, async (req, res) => {
  const requester = db.findUserById(req.userId);
  if (!requester || !isAdminEmail(requester.email)) {
    return res.status(403).json({ error: 'Esta función es solo para administradores' });
  }
  const subs = db.getPushSubscriptionsByUser(req.userId);
  if (!subs.length) return res.status(400).json({ error: 'No hay dispositivos suscriptos a notificaciones' });
  const expired = await push.sendPushToUser(subs, {
    title: 'Notificación de prueba',
    body: 'Esto es una notificación de prueba. Si la ves, las push están funcionando.',
    url: '/',
  });
  expired.forEach((endpoint) => db.deletePushSubscriptionByEndpoint(endpoint));
  res.json({ ok: true });
});

// ---------- Panel de administración ----------
// Todo lo que sigue requiere estar logueado Y tener el mail en ADMIN_EMAILS.

function fullUser(u) {
  return {
    ...publicUser(u),
    contacts: db.getContactsByUser(u.id),
    referencePeople: db.getReferencePeopleByUser(u.id),
    pushSubscriptionsCount: db.getPushSubscriptionsByUser(u.id).length,
  };
}

// Lista completa de usuarios con sus contactos, personas de contacto y
// configuración. Es la "base de datos" que ve el administrador.
app.get('/api/admin/users', authRequired, adminRequired, (req, res) => {
  const users = db.getAllUsers().map(fullUser);
  res.json({ users });
});

app.get('/api/admin/users/:id', authRequired, adminRequired, (req, res) => {
  const user = db.findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json({ user: fullUser(user) });
});

// Historial completo de check-ins de un usuario (fecha + ubicación de cada uno)
app.get('/api/admin/users/:id/checkins', authRequired, adminRequired, (req, res) => {
  const user = db.findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json({ checkins: db.getCheckinsByUser(req.params.id) });
});

// Editar los datos/configuración de cualquier usuario
app.put('/api/admin/users/:id', authRequired, adminRequired, (req, res) => {
  const user = db.findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  const { name, email, checkin_interval_hours, paused, default_message, share_location, send_reminders, send_reminder_emails, password, confirmPassword } = req.body || {};

  if (email !== undefined && email.toLowerCase() !== user.email) {
    const normalizedEmail = email.toLowerCase();
    const existing = db.findUserByEmail(normalizedEmail);
    if (existing && existing.id !== user.id) {
      return res.status(409).json({ error: 'Ya existe una cuenta con ese email' });
    }
  }

  const resolvedEmails = resolveSendReminderEmails(req.params.id, send_reminder_emails, user.send_reminder_emails !== false);
  if (resolvedEmails && resolvedEmails.error) return res.status(400).json({ error: resolvedEmails.error });

  const patch = {
    name: name !== undefined ? name : user.name,
    email: email !== undefined ? email.toLowerCase() : user.email,
    checkin_interval_hours: checkin_interval_hours !== undefined ? clampCheckinInterval(checkin_interval_hours, user.checkin_interval_hours) : user.checkin_interval_hours,
    paused: paused !== undefined ? !!paused : user.paused,
    default_message: default_message !== undefined ? default_message : user.default_message,
    share_location: share_location !== undefined ? !!share_location : user.share_location,
    send_reminders: send_reminders !== undefined ? !!send_reminders : user.send_reminders,
    send_reminder_emails: resolvedEmails,
  };
  if (password) {
    if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    if (password !== confirmPassword) return res.status(400).json({ error: 'Las dos contraseñas no coinciden' });
    patch.password_hash = bcrypt.hashSync(password, 10);
  }

  const updated = db.updateUser(req.params.id, patch);
  res.json({ ok: true, user: fullUser(updated) });
});

app.delete('/api/admin/users/:id', authRequired, adminRequired, (req, res) => {
  db.deleteUser(req.params.id);
  res.json({ ok: true });
});

// ---- Contactos de un usuario, desde el admin ----
// El admin solo puede VER y BORRAR contactos, no modificar sus datos
// (nombre/email/mensaje son del usuario, no se tocan desde acá).
app.delete('/api/admin/users/:id/contacts/:cid', authRequired, adminRequired, (req, res) => {
  db.deleteContact(req.params.cid, req.params.id);
  res.json({ ok: true });
});

// Mail de prueba a un contacto puntual, disparado por el admin
app.post('/api/admin/users/:id/contacts/:cid/test', authRequired, adminRequired, async (req, res) => {
  const contact = db.findContact(req.params.cid, req.params.id);
  if (!contact) return res.status(404).json({ error: 'Contacto no encontrado' });
  const user = db.findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  const fullName = user.name || user.email;
  const shortName = firstName(user.name) || user.email;

  const combinedMessage = [user.default_message, contact.message].filter(Boolean).join('\n\n');
  const location = user.share_location && user.last_lat != null
    ? { lat: user.last_lat, lng: user.last_lng, at: user.last_location_at }
    : null;
  const referencePeople = db.getReferencePeopleByUser(user.id);

  const result = await sendEmail({
    to: contact.email,
    subject: `[PRUEBA - admin] Faro no recibió la señal de ${shortName}`,
    html:
      '<p style="color:#b45309"><strong>Este es un mail de prueba enviado por un administrador — no significa que haya pasado nada.</strong></p>' +
      alertEmailHtml({
        userName: fullName,
        shortName,
        contactName: contact.name,
        personalMessage: combinedMessage,
        lastCheckinAt: user.last_checkin_at,
        location,
        referencePeople,
      }),
  });

  if (!result.ok) return res.status(500).json({ error: 'No se pudo enviar el mail. Revisá la configuración de BREVO_API_KEY.' });
  res.json({ ok: true });
});

// ---- Personas de contacto de un usuario, desde el admin ----
// Igual que con los contactos de emergencia: el admin solo puede VER y
// BORRAR, no modificar los datos (son del usuario).
app.delete('/api/admin/users/:id/reference-people/:rid', authRequired, adminRequired, (req, res) => {
  db.deleteReferencePerson(req.params.rid, req.params.id);
  res.json({ ok: true });
});

// Mail de prueba del recordatorio "falta poco para dar señal", a nombre de
// cualquier usuario, disparado por el admin
app.post('/api/admin/users/:id/test-reminder', authRequired, adminRequired, async (req, res) => {
  const user = db.findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  const { urgencyLabel } = req.body || {};

  const result = await sendEmail({
    to: user.email,
    subject: '[PRUEBA - admin] Falta poco para enviar tu señal',
    html:
      '<p style="color:#b45309"><strong>Este es un mail de prueba enviado por un administrador — no significa que se te esté por vencer el plazo de verdad.</strong></p>' +
      warningEmailHtml({
        userName: user.name || user.email,
        urgencyLabel: urgencyLabel || '15 minutos',
      }),
  });

  if (!result.ok) return res.status(500).json({ error: 'No se pudo enviar el mail. Revisá la configuración de BREVO_API_KEY.' });
  res.json({ ok: true });
});

// Push de prueba a todos los dispositivos de cualquier usuario, disparado
// por el admin (las cuentas normales no tienen forma de hacer esto ellas
// mismas, ver /api/push/test más arriba)
app.post('/api/admin/users/:id/push/test', authRequired, adminRequired, async (req, res) => {
  const subs = db.getPushSubscriptionsByUser(req.params.id);
  if (!subs.length) return res.status(400).json({ error: 'Ese usuario no tiene dispositivos suscriptos a notificaciones' });
  const { title, body } = req.body || {};
  const expired = await push.sendPushToUser(subs, {
    title: (title || '').trim() || 'Notificación de prueba (admin)',
    body: (body || '').trim() || 'Esto es una notificación de prueba enviada por un administrador.',
    url: '/',
  });
  expired.forEach((endpoint) => db.deletePushSubscriptionByEndpoint(endpoint));
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
  startScheduler();
});
