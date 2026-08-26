require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const db = require('./db');
const { startScheduler } = require('./cron');
const { sendEmail, alertEmailHtml, warningEmailHtml, firstName } = require('./email');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'cambia-este-secreto-en-produccion';

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

function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    checkin_interval_hours: u.checkin_interval_hours,
    last_checkin_at: u.last_checkin_at,
    send_reminders: u.send_reminders !== false,
    alert_sent: !!u.alert_sent,
    paused: !!u.paused,
    default_message: u.default_message || '',
    share_location: !!u.share_location,
    last_lat: u.last_lat ?? null,
    last_lng: u.last_lng ?? null,
    last_location_at: u.last_location_at ?? null,
  };
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
  const interval = Number(checkin_interval_hours) > 0 ? Number(checkin_interval_hours) : 24;

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
  const patch = {
    last_checkin_at: db.nowIso(),
    warning_half_sent: false,
    warning_1h_sent: false,
    warning_15m_sent: false,
    alert_sent: false,
  };
  // Solo guardamos coordenadas si el usuario activó "compartir ubicación"
  if (user.share_location && typeof lat === 'number' && typeof lng === 'number') {
    patch.last_lat = lat;
    patch.last_lng = lng;
    patch.last_location_at = db.nowIso();
  }
  const updated = db.updateUser(req.userId, patch);
  res.json({ ok: true, last_checkin_at: updated.last_checkin_at, last_lat: updated.last_lat, last_lng: updated.last_lng, last_location_at: updated.last_location_at });
});

app.put('/api/settings', authRequired, (req, res) => {
  const { name, checkin_interval_hours, paused, default_message, share_location, send_reminders } = req.body || {};
  const user = db.findUserById(req.userId);
  db.updateUser(req.userId, {
    name: name !== undefined ? name : user.name,
    checkin_interval_hours:
      checkin_interval_hours !== undefined ? Number(checkin_interval_hours) : user.checkin_interval_hours,
    paused: paused !== undefined ? !!paused : user.paused,
    default_message: default_message !== undefined ? default_message : user.default_message,
    share_location: share_location !== undefined ? !!share_location : user.share_location,
    send_reminders: send_reminders !== undefined ? !!send_reminders : (user.send_reminders !== false),
  });
  res.json({ ok: true });
});

// Mandar a la propia cuenta un mail de prueba del recordatorio de "falta
// poco para tu check-in" (el mismo que se dispara automáticamente a mitad
// de plazo, 1 hora antes y 15 minutos antes de que se cumpla el intervalo).
app.post('/api/test-reminder', authRequired, async (req, res) => {
  const user = db.findUserById(req.userId);
  const { urgencyLabel } = req.body || {};

  const result = await sendEmail({
    to: user.email,
    subject: '[PRUEBA] Falta poco para tu check-in',
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
    subject: `[PRUEBA] Mensaje de check-in de ${shortName}`,
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

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
  startScheduler();
});
