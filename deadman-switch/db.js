// Base de datos simple guardada en un archivo JSON (data.json).
// No necesita compilar nada nativo, así que funciona en cualquier
// sistema operativo con solo tener Node.js instalado.

const fs = require('fs');
const path = require('path');

// DATA_DIR permite guardar data.json fuera de la carpeta del código,
// por ejemplo en un Volume persistente de Railway (así los datos
// sobreviven a los redeploys). Si no se configura, usa la carpeta del
// proyecto como antes (sirve para correrlo local).
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_PATH = path.join(DATA_DIR, 'data.json');

function load() {
  if (!fs.existsSync(DB_PATH)) {
    return { users: [], contacts: [], reference_people: [], nextUserId: 1, nextContactId: 1, nextReferencePersonId: 1 };
  }
  const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  // Compatibilidad con data.json viejos que todavía no tienen estos campos
  if (!data.reference_people) data.reference_people = [];
  if (!data.nextReferencePersonId) data.nextReferencePersonId = 1;
  return data;
}

function save(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function nowIso() {
  return new Date().toISOString();
}

module.exports = {
  nowIso,

  // ---------- usuarios ----------
  findUserByEmail(email) {
    return load().users.find((u) => u.email === email) || null;
  },

  findUserById(id) {
    return load().users.find((u) => u.id === Number(id)) || null;
  },

  createUser({ email, password_hash, name, checkin_interval_hours }) {
    const data = load();
    const user = {
      id: data.nextUserId++,
      email,
      password_hash,
      name: name || '',
      checkin_interval_hours,
      last_checkin_at: nowIso(),
      send_reminders: true,
      warning_half_sent: false,
      warning_1h_sent: false,
      warning_15m_sent: false,
      alert_sent: false,
      paused: false,
      default_message: '',
      share_location: true,
      last_lat: null,
      last_lng: null,
      last_location_at: null,
      created_at: nowIso(),
    };
    data.users.push(user);
    save(data);
    return user;
  },

  updateUser(id, patch) {
    const data = load();
    const user = data.users.find((u) => u.id === Number(id));
    if (!user) return null;
    Object.assign(user, patch);
    save(data);
    return user;
  },

  getActiveUsers() {
    return load().users.filter((u) => !u.paused);
  },

  deleteUser(id) {
    const data = load();
    data.users = data.users.filter((u) => u.id !== Number(id));
    data.contacts = data.contacts.filter((c) => c.user_id !== Number(id));
    data.reference_people = data.reference_people.filter((p) => p.user_id !== Number(id));
    save(data);
  },

  // ---------- contactos ----------
  getContactsByUser(userId) {
    return load().contacts.filter((c) => c.user_id === Number(userId));
  },

  findContact(id, userId) {
    return (
      load().contacts.find((c) => c.id === Number(id) && c.user_id === Number(userId)) || null
    );
  },

  createContact({ user_id, name, email, message }) {
    const data = load();
    const contact = {
      id: data.nextContactId++,
      user_id: Number(user_id),
      name,
      email,
      message: message || '',
      created_at: nowIso(),
    };
    data.contacts.push(contact);
    save(data);
    return contact;
  },

  updateContact(id, userId, patch) {
    const data = load();
    const contact = data.contacts.find((c) => c.id === Number(id) && c.user_id === Number(userId));
    if (!contact) return null;
    Object.assign(contact, patch);
    save(data);
    return contact;
  },

  deleteContact(id, userId) {
    const data = load();
    data.contacts = data.contacts.filter(
      (c) => !(c.id === Number(id) && c.user_id === Number(userId))
    );
    save(data);
  },

  // ---------- personas de contacto ----------
  // A diferencia de los "contactos de emergencia", a estas personas nunca
  // se les manda un mail directamente. Solo se incluyen sus datos (nombre,
  // relación y teléfono) dentro del mail que reciben los contactos de
  // emergencia, para que sepan a quién más pueden recurrir.
  getReferencePeopleByUser(userId) {
    return load().reference_people.filter((p) => p.user_id === Number(userId));
  },

  findReferencePerson(id, userId) {
    return (
      load().reference_people.find((p) => p.id === Number(id) && p.user_id === Number(userId)) ||
      null
    );
  },

  createReferencePerson({ user_id, name, relation, phone, email }) {
    const data = load();
    const person = {
      id: data.nextReferencePersonId++,
      user_id: Number(user_id),
      name,
      relation: relation || '',
      phone: phone || '',
      email: email || '',
      created_at: nowIso(),
    };
    data.reference_people.push(person);
    save(data);
    return person;
  },

  updateReferencePerson(id, userId, patch) {
    const data = load();
    const person = data.reference_people.find(
      (p) => p.id === Number(id) && p.user_id === Number(userId)
    );
    if (!person) return null;
    Object.assign(person, patch);
    save(data);
    return person;
  },

  deleteReferencePerson(id, userId) {
    const data = load();
    data.reference_people = data.reference_people.filter(
      (p) => !(p.id === Number(id) && p.user_id === Number(userId))
    );
    save(data);
  },
};
