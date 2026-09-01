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
    return {
      users: [],
      contacts: [],
      reference_people: [],
      friends: [],
      nextUserId: 1,
      nextContactId: 1,
      nextReferencePersonId: 1,
      nextFriendId: 1,
    };
  }
  const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  // Compatibilidad con data.json viejos que todavía no tienen estos campos
  if (!data.reference_people) data.reference_people = [];
  if (!data.nextReferencePersonId) data.nextReferencePersonId = 1;
  if (!data.push_subscriptions) data.push_subscriptions = [];
  if (!data.checkins) data.checkins = [];
  if (!data.nextCheckinId) data.nextCheckinId = 1;
  if (!data.friends) data.friends = [];
  if (!data.nextFriendId) data.nextFriendId = 1;
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
      send_reminder_emails: true,
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

  getAllUsers() {
    return load().users;
  },

  deleteUser(id) {
    const data = load();
    data.users = data.users.filter((u) => u.id !== Number(id));
    data.contacts = data.contacts.filter((c) => c.user_id !== Number(id));
    data.reference_people = data.reference_people.filter((p) => p.user_id !== Number(id));
    data.push_subscriptions = data.push_subscriptions.filter((s) => s.user_id !== Number(id));
    data.checkins = (data.checkins || []).filter((c) => c.user_id !== Number(id));
    data.friends = (data.friends || []).filter(
      (f) => f.from_user_id !== Number(id) && f.to_user_id !== Number(id)
    );
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

  // ---------- suscripciones push ----------
  // Cada suscripción representa un dispositivo/navegador donde el usuario
  // activó las notificaciones. Puede haber varias por usuario.
  getPushSubscriptionsByUser(userId) {
    return load().push_subscriptions.filter((s) => s.user_id === Number(userId));
  },

  savePushSubscription({ user_id, subscription }) {
    const data = load();
    const endpoint = subscription.endpoint;
    // Si ya existe una suscripción con el mismo endpoint, la reemplaza
    // (por ejemplo, cuando el navegador rota las claves).
    data.push_subscriptions = data.push_subscriptions.filter((s) => s.endpoint !== endpoint);
    data.push_subscriptions.push({
      user_id: Number(user_id),
      endpoint,
      keys: subscription.keys,
      created_at: nowIso(),
    });
    save(data);
  },

  deletePushSubscriptionByEndpoint(endpoint) {
    const data = load();
    data.push_subscriptions = data.push_subscriptions.filter((s) => s.endpoint !== endpoint);
    save(data);
  },

  // ---------- historial de check-ins ----------
  // Cada vez que alguien toca "Estoy bien" queda un registro acá, con la
  // ubicación de ese momento (si la tenía activada). Sirve para que el
  // administrador pueda ver el historial completo de una cuenta.
  MAX_CHECKINS_PER_USER: 500,

  addCheckinRecord({ user_id, at, lat, lng }) {
    const data = load();
    const record = {
      id: data.nextCheckinId++,
      user_id: Number(user_id),
      at: at || nowIso(),
      lat: lat ?? null,
      lng: lng ?? null,
    };
    data.checkins.push(record);
    // Evita que el archivo crezca sin límite: se queda con los últimos
    // MAX_CHECKINS_PER_USER registros de cada usuario.
    const forUser = data.checkins.filter((c) => c.user_id === record.user_id);
    if (forUser.length > module.exports.MAX_CHECKINS_PER_USER) {
      const toDrop = forUser
        .sort((a, b) => a.id - b.id)
        .slice(0, forUser.length - module.exports.MAX_CHECKINS_PER_USER)
        .map((c) => c.id);
      data.checkins = data.checkins.filter((c) => !toDrop.includes(c.id));
    }
    save(data);
    return record;
  },

  // Más reciente primero
  getCheckinsByUser(userId) {
    return load()
      .checkins.filter((c) => c.user_id === Number(userId))
      .sort((a, b) => new Date(b.at) - new Date(a.at));
  },

  // ---------- amigos ----------
  // Cada fila es un vínculo entre dos usuarios de la app (a diferencia de
  // los "contactos de emergencia", que no tienen cuenta). Se crea en estado
  // "pending" cuando alguien pide agregar a otro por email, y pasa a
  // "accepted" cuando el otro lo confirma. Mientras no esté aceptado, nadie
  // ve la ubicación de nadie.
  getFriendLinksForUser(userId) {
    const uid = Number(userId);
    return load().friends.filter((f) => f.from_user_id === uid || f.to_user_id === uid);
  },

  findFriendLink(id) {
    return load().friends.find((f) => f.id === Number(id)) || null;
  },

  findFriendLinkBetween(userIdA, userIdB) {
    const a = Number(userIdA);
    const b = Number(userIdB);
    return (
      load().friends.find(
        (f) =>
          (f.from_user_id === a && f.to_user_id === b) ||
          (f.from_user_id === b && f.to_user_id === a)
      ) || null
    );
  },

  createFriendRequest({ from_user_id, to_user_id }) {
    const data = load();
    const link = {
      id: data.nextFriendId++,
      from_user_id: Number(from_user_id),
      to_user_id: Number(to_user_id),
      status: 'pending',
      created_at: nowIso(),
    };
    data.friends.push(link);
    save(data);
    return link;
  },

  acceptFriendLink(id) {
    const data = load();
    const link = data.friends.find((f) => f.id === Number(id));
    if (!link) return null;
    link.status = 'accepted';
    link.accepted_at = nowIso();
    save(data);
    return link;
  },

  deleteFriendLink(id) {
    const data = load();
    data.friends = data.friends.filter((f) => f.id !== Number(id));
    save(data);
  },

  // Usado para guardar cuándo fue el último "pedime que encienda el Faro"
  // en cada dirección del link (from -> to y to -> from), y así poder
  // aplicar un cooldown y que no se pueda spamear al amigo.
  updateFriendLink(id, patch) {
    const data = load();
    const link = data.friends.find((f) => f.id === Number(id));
    if (!link) return null;
    Object.assign(link, patch);
    save(data);
    return link;
  },
};
