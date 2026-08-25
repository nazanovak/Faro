require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const db = require('./db');
const { startScheduler } = require('./cron');
const { sendEmail, alertEmailHtml } = require('./email');

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
    warning_sent: !!u.warning_sent,
    alert_sent: !!u.alert_sent,
    paused: !!u.paused,
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
  res.json({ user: publicUser(user), contacts });
});

app.post('/api/checkin', authRequired, (req, res) => {
  const user = db.updateUser(req.userId, {
    last_checkin_at: db.nowIso(),
    warning_sent: false,
    alert_sent: false,
  });
  res.json({ ok: true, last_checkin_at: user.last_checkin_at });
});

app.put('/api/settings', authRequired, (req, res) => {
  const { name, checkin_interval_hours, paused } = req.body || {};
  const user = db.findUserById(req.userId);
  db.updateUser(req.userId, {
    name: name !== undefined ? name : user.name,
    checkin_interval_hours:
      checkin_interval_hours !== undefined ? Number(checkin_interval_hours) : user.checkin_interval_hours,
    paused: paused !== undefined ? !!paused : user.paused,
  });
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

  const result = await sendEmail({
    to: contact.email,
    subject: `[PRUEBA] Mensaje de check-in de ${user.name || user.email}`,
    html:
      '<p style="color:#b45309"><strong>Este es un mail de prueba — no significa que haya pasado nada.</strong></p>' +
      alertEmailHtml({
        userName: user.name || user.email,
        contactName: contact.name,
        personalMessage: contact.message,
        lastCheckinAt: user.last_checkin_at,
      }),
  });

  if (!result.ok) return res.status(500).json({ error: 'No se pudo enviar el mail. Revisá la configuración de RESEND_API_KEY.' });
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
  startScheduler();
});
