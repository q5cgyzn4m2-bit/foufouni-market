'use strict';
/*
 * Stockage foûfoûni-Market sur PostgreSQL (Supabase).
 * Toutes les données sont chargées en mémoire au démarrage : les lectures sont instantanées.
 * Chaque écriture met à jour la mémoire puis est enregistrée dans Supabase, dans l'ordre.
 */
const { Pool } = require('pg');

function createStore({ pool, connectionString } = {}) {
  pool = pool || new Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 4, idleTimeoutMillis: 30000, connectionTimeoutMillis: 15000 });
  pool.on && pool.on('error', e => console.error('Connexion Supabase :', e.message));
  const q = (text, params) => pool.query(text, params);

  const docs = new Map();      // collection -> Map(id -> données)
  const users = new Map();     // id -> utilisateur
  const events = new Set();    // webhooks déjà traités
  let chain = Promise.resolve();
  let failures = 0;

  const colMap = c => { let m = docs.get(c); if (!m) { m = new Map(); docs.set(c, m); } return m; };
  const clone = v => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const parse = v => (typeof v === 'string' ? JSON.parse(v) : v);
  function enqueue(fn) {
    const p = chain.then(() => fn());
    chain = p.catch(e => { failures++; console.error('Écriture Supabase échouée :', e.message); });
    return p;
  }

  async function init() {
    await q(`CREATE TABLE IF NOT EXISTS ffm_docs (col TEXT NOT NULL, id TEXT NOT NULL, data JSONB NOT NULL, updated BIGINT, PRIMARY KEY (col, id))`);
    await q(`CREATE TABLE IF NOT EXISTS ffm_users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, role TEXT NOT NULL, hash TEXT NOT NULL, created BIGINT)`);
    await q(`CREATE TABLE IF NOT EXISTS ffm_events (id TEXT PRIMARY KEY, at BIGINT)`);
    // Bloque l'accès public via l'API Supabase : seul le serveur (propriétaire des tables) peut lire et écrire.
    for (const t of ['ffm_docs', 'ffm_users', 'ffm_events']) {
      try { await q(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`); } catch (e) { /* non pris en charge : sans effet */ }
    }
    for (const r of (await q('SELECT col, id, data FROM ffm_docs')).rows) colMap(r.col).set(r.id, parse(r.data));
    for (const r of (await q('SELECT id, email, name, role, hash, created FROM ffm_users')).rows) users.set(r.id, { ...r, created: Number(r.created) });
    const since = Date.now() - 30 * 864e5;
    for (const r of (await q('SELECT id FROM ffm_events WHERE at > $1', [since])).rows) events.add(r.id);
    let n = 0; for (const m of docs.values()) n += m.size;
    console.log(`Supabase connecté : ${n} enregistrements, ${users.size} compte(s) équipe.`);
  }

  return {
    init,
    get: (c, i) => clone(docs.get(c)?.get(i) ?? null),
    all: c => [...(docs.get(c) || new Map())].map(([id, d]) => ({ id, ...clone(d) })),
    put(c, i, d) {
      const v = clone(d); colMap(c).set(i, v);
      return enqueue(() => q(`INSERT INTO ffm_docs (col, id, data, updated) VALUES ($1, $2, $3, $4)
                              ON CONFLICT (col, id) DO UPDATE SET data = EXCLUDED.data, updated = EXCLUDED.updated`,
        [c, i, JSON.stringify(v), Date.now()]));
    },
    del(c, i) { docs.get(c)?.delete(i); return enqueue(() => q('DELETE FROM ffm_docs WHERE col = $1 AND id = $2', [c, i])); },
    users: {
      byId: id => { const u = users.get(id); return u ? { id: u.id, email: u.email, name: u.name, role: u.role } : null; },
      byEmail: email => { for (const u of users.values()) if (u.email === email) return { ...u }; return null; },
      list: () => [...users.values()].sort((a, b) => a.created - b.created).map(u => ({ id: u.id, email: u.email, name: u.name, role: u.role, created: u.created })),
      count: () => users.size,
      add(u) { users.set(u.id, { ...u }); return enqueue(() => q('INSERT INTO ffm_users (id, email, name, role, hash, created) VALUES ($1, $2, $3, $4, $5, $6)', [u.id, u.email, u.name, u.role, u.hash, u.created])); },
      setRole(id, role) { const u = users.get(id); if (u) u.role = role; return enqueue(() => q('UPDATE ffm_users SET role = $1 WHERE id = $2', [role, id])); },
      remove(id) { users.delete(id); return enqueue(() => q('DELETE FROM ffm_users WHERE id = $1', [id])); }
    },
    /* Renvoie false si l'événement a déjà été traité (webhook en double) */
    firstTime(id) {
      if (events.has(id)) return false;
      events.add(id);
      enqueue(() => q('INSERT INTO ffm_events (id, at) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [id, Date.now()]));
      return true;
    },
    /* Attend que toutes les écritures en cours soient enregistrées ; indique s'il y a eu un échec */
    async flush() { const before = failures; await chain; return failures === before; }
  };
}

module.exports = { createStore };
