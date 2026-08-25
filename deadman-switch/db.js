// Base de datos simple guardada en un archivo JSON (data.json).
// No necesita compilar nada nativo, así que funciona en cualquier
// sistema operativo con solo tener Node.js instalado.

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.json');

function load() {
  if (!fs.existsSync(DB_PATH)) {
    return { users: [], contacts: [], nextUserId: 1, nextContactId: 1 };
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function save(data) {
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
      warning_sent: false,
      alert_sent: false,
      paused: false,
      default_message: '',
      share_location: false,
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
};
