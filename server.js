'use strict';
/* foûfoûni-Market — serveur de la boutique avec paiements réels Wave et Orange Money. */
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { createStore } = require('./store');

const env = process.env;
const PORT = Number(env.PORT || 3000);
const BASE_URL = (env.BASE_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const BASE_ORIGIN = new URL(BASE_URL).origin;
const SECURE = BASE_URL.startsWith('https://');
if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
  console.error('SESSION_SECRET manquant ou trop court (32 caractères minimum).');
  process.exit(1);
}

/* ================= Base de données (Supabase) ================= */
if (!env.DATABASE_URL) {
  console.error('DATABASE_URL manquant : collez la chaîne de connexion « Session pooler » de Supabase.');
  process.exit(1);
}
const store = createStore({ connectionString: env.DATABASE_URL });
const getDoc = (c, i) => store.get(c, i);
const allDocs = c => store.all(c);
const putDoc = (c, i, d) => store.put(c, i, d);
const patchDoc = (c, i, d) => { const o = getDoc(c, i); if (!o) return null; const n = { ...o, ...d }; putDoc(c, i, n); return n; };

/* ================= Outils ================= */
const hmacHex = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const randomToken = (n = 24) => crypto.randomBytes(n).toString('base64url');
const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rnd = n => Array.from(crypto.randomBytes(n), b => ALPH[b % ALPH.length]).join('');
const newOrderId = () => 'o' + Date.now().toString(36) + rnd(5).toLowerCase();
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const validId = id => /^[A-Za-z0-9._~:@+-]{1,64}$/.test(id);
const today = () => new Date().toISOString().slice(0, 10);

function hashPw(pw) { const salt = crypto.randomBytes(16); return salt.toString('hex') + ':' + crypto.scryptSync(pw, salt, 64).toString('hex'); }
function checkPw(pw, stored) {
  const [s, h] = String(stored).split(':'); if (!s || !h) return false;
  const d = crypto.scryptSync(String(pw), Buffer.from(s, 'hex'), 64);
  return crypto.timingSafeEqual(d, Buffer.from(h, 'hex'));
}

/* Limiteur simple en mémoire (anti force brute) */
const hits = new Map();
function limited(key, max, windowMs) {
  const t = Date.now(); const arr = (hits.get(key) || []).filter(x => t - x < windowMs);
  arr.push(t); hits.set(key, arr); return arr.length > max;
}
setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (!v.some(x => t - x < 3600e3)) hits.delete(k); }, 600e3).unref();

/* Premier gérant */
async function ensureManager() {
  if (store.users.count()) return;
  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 10) {
    console.error('Aucun compte : définissez ADMIN_EMAIL et ADMIN_PASSWORD (10 caractères minimum) pour créer le gérant.');
    process.exit(1);
  }
  await store.users.add({ id: 'u' + rnd(10).toLowerCase(), email: env.ADMIN_EMAIL.toLowerCase().trim(), name: env.ADMIN_NAME || 'Gérant', role: 'Gérant', hash: hashPw(env.ADMIN_PASSWORD), created: Date.now() });
  console.log('Compte gérant créé pour', env.ADMIN_EMAIL);
}

/* ================= Sessions ================= */
const COOKIE = 'ffm_s';
function signSession(uid) {
  const b = Buffer.from(JSON.stringify({ uid, exp: Date.now() + 7 * 864e5 })).toString('base64url');
  return b + '.' + hmacHex(env.SESSION_SECRET, b);
}
function readSession(tok) {
  const [b, sig] = String(tok || '').split('.'); if (!b || !sig || !safeEq(sig, hmacHex(env.SESSION_SECRET, b))) return null;
  try { const p = JSON.parse(Buffer.from(b, 'base64url').toString()); return p.exp > Date.now() ? p : null; } catch { return null; }
}
function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('='); if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
function currentUser(req) { const p = readSession(readCookie(req, COOKIE)); return p ? store.users.byId(p.uid) : null; }
const cookieOpts = maxAge => `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${SECURE ? '; Secure' : ''}`;

const requireStaff = (req, res, next) => { const u = currentUser(req); if (!u) return res.status(401).json({ error: 'Connexion requise.' }); req.user = u; next(); };
const requireManager = (req, res, next) => req.user.role === 'Gérant' ? next() : res.status(403).json({ error: 'Réservé au gérant.' });
const h = fn => (req, res) => Promise.resolve().then(() => fn(req, res)).catch(e => {
  const st = e.status || 500; if (st >= 500) console.error(e);
  res.status(st).json({ error: st === 500 ? 'Erreur serveur. Réessayez dans un instant.' : e.message });
});

/* ================= Réglages et moyens de paiement ================= */
const DEFAULT_SETTINGS = {
  shopName: 'foûfoûni-Market', currency: 'FCFA', deliveryFee: 1500, freeFrom: 50000, city: 'Bamako',
  processors: { orange: { enabled: true }, wave: { enabled: true }, cod: { enabled: true } }
};
function settings() {
  const s = getDoc('settings', 'main') || {};
  return { ...DEFAULT_SETTINGS, ...s, processors: { ...DEFAULT_SETTINGS.processors, ...(s.processors || {}) } };
}
const CONFIGURED = {
  wave: !!env.WAVE_API_KEY,
  orange: !!(env.OM_AUTH_HEADER && env.OM_MERCHANT_KEY && env.OM_API_BASE),
  cod: true
};
const providers = () => { const s = settings(); return Object.keys(CONFIGURED).filter(k => CONFIGURED[k] && s.processors?.[k]?.enabled !== false); };
function publicSettings() {
  const s = settings();
  const procs = {}; for (const [k, v] of Object.entries(s.processors || {})) procs[k] = { enabled: !!v.enabled }; // jamais d'identifiants côté public
  return { shopName: s.shopName, tagline: s.tagline, intro: s.intro, currency: s.currency, deliveryFee: s.deliveryFee, freeFrom: s.freeFrom, city: s.city, phone: s.phone, processors: procs,
    featuredPromo: s.featuredPromo && s.featuredPromo.code ? { code: s.featuredPromo.code, type: s.featuredPromo.type, value: s.featuredPromo.value, minOrder: s.featuredPromo.minOrder || 0, expiresAt: s.featuredPromo.expiresAt || '' } : null };
}

/* ================= Codes promo et calcul des totaux (toujours côté serveur) ================= */
function checkPromo(code, subtotal) {
  const c = String(code || '').trim().toUpperCase();
  const p = c && getDoc('promos', c);
  if (!p || !p.active) throw httpErr(400, 'Ce code n’existe pas ou n’est plus actif.');
  if (p.expiresAt && p.expiresAt < today()) throw httpErr(400, 'Ce code a expiré.');
  if (p.minOrder && subtotal < p.minOrder) throw httpErr(400, `Ce code s’applique dès ${p.minOrder} ${settings().currency} d’achat.`);
  if (p.maxUses) {
    const used = allDocs('orders').filter(o => o.promoCode === c && o.status !== 'annulee').length;
    if (used >= p.maxUses) throw httpErr(400, 'Ce code a atteint son nombre maximum d’utilisations.');
  }
  return { code: c, type: p.type, value: Number(p.value) || 0 };
}
const unitPrice = (p, qty) => (p.bulkMin > 1 && p.bulkPrice > 0 && qty >= p.bulkMin) ? Math.round(p.bulkPrice) : Math.round(Number(p.price) || 0);
function expandItems(items) {
  const m = new Map();
  for (const i of items || []) {
    if (i.bundle) for (const c of i.components || []) m.set(c.id, (m.get(c.id) || 0) + c.qty * i.qty);
    else m.set(i.id, (m.get(i.id) || 0) + i.qty);
  }
  return [...m].map(([id, qty]) => ({ id, qty }));
}
function computeOrder(items, promoCode, delivery) {
  if (!Array.isArray(items) || !items.length || items.length > 50) throw httpErr(400, 'Panier invalide.');
  const prodQty = new Map(), bundleQty = new Map();
  for (const it of items) {
    const q = Number(it && it.qty);
    if (!Number.isInteger(q) || q < 1 || q > 999) throw httpErr(400, 'Panier invalide.');
    if (it.bundle) { const id = String(it.bundle); if (!validId(id)) throw httpErr(400, 'Panier invalide.'); bundleQty.set(id, (bundleQty.get(id) || 0) + q); }
    else { const id = String(it.id); if (!validId(id)) throw httpErr(400, 'Panier invalide.'); prodQty.set(id, (prodQty.get(id) || 0) + q); }
  }
  const lines = [];
  for (const [id, qty] of prodQty) {
    const p = getDoc('products', id);
    if (!p || p.active === false) throw httpErr(400, 'Un article de votre panier n’est plus disponible.');
    lines.push({ id, name: p.name, price: unitPrice(p, qty), qty });
  }
  for (const [bid, qty] of bundleQty) {
    const b = getDoc('bundles', bid);
    if (!b || b.active === false || !Array.isArray(b.items) || !b.items.length) throw httpErr(400, 'Un lot de votre panier n’est plus disponible.');
    for (const c of b.items) { const p = getDoc('products', c.id); if (!p || p.active === false) throw httpErr(400, `Le lot ${b.name} n’est plus disponible.`); }
    lines.push({ id: 'b:' + bid, bundle: true, name: 'Lot · ' + b.name, price: Math.round(Number(b.price) || 0), qty, components: b.items.map(c => ({ id: c.id, qty: Number(c.qty) || 1 })) });
  }
  for (const { id, qty } of expandItems(lines)) {
    const p = getDoc('products', id);
    if (qty > (p.stock || 0)) throw httpErr(409, `Stock insuffisant pour ${p.name} (${p.stock || 0} disponible).`);
  }
  const s = settings();
  const subtotal = lines.reduce((t, l) => t + l.price * l.qty, 0);
  const shipping = delivery === 'livraison' ? (subtotal >= Number(s.freeFrom || 0) ? 0 : Math.round(Number(s.deliveryFee) || 0)) : 0;
  let discount = 0, code = '';
  if (promoCode) {
    const p = checkPromo(promoCode, subtotal); code = p.code;
    if (p.type === 'percent') discount = Math.round(subtotal * Math.min(p.value, 100) / 100);
    else if (p.type === 'fixed') discount = Math.min(p.value, subtotal);
    else if (p.type === 'shipping') discount = shipping;
  }
  return { lines, subtotal, shipping, discount, total: Math.max(0, subtotal + shipping - discount), promoCode: code };
}

/* Passage en « payée » : idempotent, déduit le stock une seule fois */
const markPaid = (orderId, info) => {
  const o = getDoc('orders', orderId);
  if (!o || o.status !== 'en_attente') return false;
  if (!o.stockApplied) for (const i of expandItems(o.items)) {
    const p = getDoc('products', i.id); if (p) putDoc('products', i.id, { ...p, stock: Math.max(0, (p.stock || 0) - i.qty) });
  }
  putDoc('orders', orderId, { ...o, status: 'payee', stockApplied: true, updatedAt: Date.now(),
    payment: { ...o.payment, status: 'réussi', ref: info.ref || o.payment.ref, paidAt: Date.now() } });
  console.log(`Paiement confirmé ${o.number} (${o.payment.method}) ${o.total}`);
  return true;
};
function markFailed(orderId, reason) {
  const o = getDoc('orders', orderId);
  if (!o || o.status !== 'en_attente') return;
  patchDoc('orders', orderId, { status: 'annulee', updatedAt: Date.now(), payment: { ...o.payment, status: reason } });
}

/* ================= Wave ================= */
async function waveRequest(method, p, body) {
  const raw = body ? JSON.stringify(body) : '';
  const headers = { Authorization: `Bearer ${env.WAVE_API_KEY}` };
  if (body) headers['Content-Type'] = 'application/json';
  if (env.WAVE_SIGNING_SECRET) { const t = Math.floor(Date.now() / 1000); headers['Wave-Signature'] = `t=${t},v1=${hmacHex(env.WAVE_SIGNING_SECRET, t + raw)}`; }
  const r = await fetch('https://api.wave.com' + p, { method, headers, body: body ? raw : undefined, signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw httpErr(502, `Wave : ${j.error_code || j.code || r.status} ${j.error_message || j.message || ''}`.trim());
  return j;
}
async function waveCreate(order, id) {
  const back = `${BASE_URL}/?order=${encodeURIComponent(id)}&t=${encodeURIComponent(order.token)}`;
  return waveRequest('POST', '/v1/checkout/sessions', {
    amount: String(order.total), currency: 'XOF', client_reference: id,
    success_url: back, error_url: back + '&err=1'
  });
}
async function waveRefresh(o, id) {
  const s = await waveRequest('GET', `/v1/checkout/sessions/${encodeURIComponent(o.payment.sessionId)}`);
  if (s.payment_status === 'succeeded' && String(s.amount) === String(o.total)) markPaid(id, { ref: s.transaction_id });
  else if (s.checkout_status === 'expired') markFailed(id, 'expiré');
}

/* ================= Orange Money Web Payment ================= */
let omTok = { v: null, exp: 0 };
async function omToken() {
  if (omTok.v && Date.now() < omTok.exp) return omTok.v;
  const r = await fetch('https://api.orange.com/oauth/v3/token', {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { Authorization: env.OM_AUTH_HEADER, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: 'grant_type=client_credentials'
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw httpErr(502, 'Orange Money : authentification refusée.');
  omTok = { v: j.access_token, exp: Date.now() + (Number(j.expires_in || 3600) - 60) * 1000 };
  return omTok.v;
}
async function omPost(p, body) {
  const r = await fetch(env.OM_API_BASE.replace(/\/$/, '') + p, {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${await omToken()}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) omTok = { v: null, exp: 0 };
  if (!r.ok) throw httpErr(502, `Orange Money : ${j.message || j.description || r.status}`);
  return j;
}
async function omCreate(order, id) {
  const back = `${BASE_URL}/?order=${encodeURIComponent(id)}&t=${encodeURIComponent(order.token)}`;
  return omPost('/webpayment', {
    merchant_key: env.OM_MERCHANT_KEY, currency: env.OM_CURRENCY || 'XOF', order_id: id, amount: order.total,
    return_url: back, cancel_url: back + '&err=1', notif_url: `${BASE_URL}/webhooks/orange`,
    lang: 'fr', reference: settings().shopName.slice(0, 30)
  });
}
async function omRefresh(o, id) {
  const j = await omPost('/transactionstatus', { order_id: id, amount: o.total, pay_token: o.payment.payToken });
  if (j.status === 'SUCCESS') markPaid(id, { ref: j.txnid });
  else if (j.status === 'FAILED') markFailed(id, 'refusé');
  else if (j.status === 'EXPIRED') markFailed(id, 'expiré');
}

const lastCheck = new Map();
async function refreshPayment(o, id, force) {
  if (o.status !== 'en_attente' || !['wave', 'orange'].includes(o.payment?.method)) return;
  const t = Date.now(); if (!force && t - (lastCheck.get(id) || 0) < 4000) return; lastCheck.set(id, t);
  try {
    if (o.payment.method === 'wave' && o.payment.sessionId) await waveRefresh(o, id);
    if (o.payment.method === 'orange' && o.payment.payToken) await omRefresh(o, id);
  } catch (e) { console.warn('Vérification paiement', id, e.message); }
}
/* Rattrapage : revérifie les paiements en attente de moins de 24 h (webhook manqué) */
setInterval(async () => {
  const lim = Date.now() - 864e5;
  for (const o of allDocs('orders').filter(o => o.status === 'en_attente' && o.createdAt > lim)) await refreshPayment(o, o.id, true);
}, 5 * 60e3).unref();

/* ================= Application ================= */
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  if (req.method === 'GET') return next();
  const send = res.send.bind(res);
  res.send = body => {
    store.flush().then(ok => {
      if (!ok && res.statusCode < 400) { res.status(503); return send(JSON.stringify({ error: 'Enregistrement dans la base impossible. Réessayez dans un instant.' })); }
      send(body);
    });
    return res;
  };
  next();
});
app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' }); next(); });

/* --- Webhook Wave : corps brut obligatoire pour vérifier la signature --- */
app.post('/webhooks/wave', express.raw({ type: () => true, limit: '200kb' }), (req, res) => {
  if (!env.WAVE_WEBHOOK_SECRET) return res.status(503).send('Webhook non configuré');
  const raw = req.body.toString('utf8');
  const parts = String(req.headers['wave-signature'] || '').split(',');
  const ts = (parts.find(p => p.startsWith('t=')) || '').slice(2);
  const sigs = parts.filter(p => p.startsWith('v1=')).map(p => p.slice(3));
  const expected = hmacHex(env.WAVE_WEBHOOK_SECRET, ts + raw);
  if (!ts || !sigs.some(s => safeEq(s, expected))) return res.status(401).send('Signature invalide');
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return res.status(401).send('Horodatage expiré');
  let ev; try { ev = JSON.parse(raw); } catch { return res.status(400).send('JSON invalide'); }
  if (ev.id && !store.firstTime('wave:' + ev.id)) return res.send('OK'); // doublon
  const d = ev.data || {}, id = d.client_reference, o = id && getDoc('orders', id);
  if (o && o.payment?.method === 'wave') {
    if (ev.type === 'checkout.session.completed' && d.payment_status === 'succeeded' && String(d.amount) === String(o.total) && d.currency === 'XOF') markPaid(id, { ref: d.transaction_id });
    if (ev.type === 'checkout.session.payment_failed') console.log('Wave : échec de paiement', o.number, d.last_payment_error?.code);
  }
  res.send('OK');
});

/* --- Notification Orange Money : on revérifie toujours auprès d'Orange --- */
app.post('/webhooks/orange', express.json({ limit: '50kb' }), h(async (req, res) => {
  const { notif_token } = req.body || {};
  res.send('OK');
  if (!notif_token) return;
  const o = allDocs('orders').find(x => x.payment?.method === 'orange' && x.payment.notifToken && safeEq(x.payment.notifToken, notif_token));
  if (o) await refreshPayment(o, o.id, true);
}));

app.use(express.json({ limit: '3mb' }));

/* Protection CSRF : les requêtes d'écriture doivent venir de la boutique elle-même */
app.use('/api', (req, res, next) => {
  if (req.method === 'GET') return next();
  const origin = req.headers.origin;
  if (origin && origin !== BASE_ORIGIN) return res.status(403).json({ error: 'Origine refusée.' });
  next();
});

/* --- Public --- */
const publicProduct = p => ({ id: p.id, name: p.name, sku: p.sku, category: p.category, price: p.price, comparePrice: p.comparePrice, stock: p.stock, lowStock: p.lowStock, emoji: p.emoji, image: p.image, description: p.description, active: true, createdAt: p.createdAt, bulkMin: p.bulkMin || 0, bulkPrice: p.bulkPrice || 0, newUntil: p.newUntil || 0 });
app.get('/api/public/catalog', (req, res) => {
  res.json({ products: allDocs('products').filter(p => p.active !== false).map(publicProduct), bundles: allDocs('bundles').filter(b => b.active !== false), settings: publicSettings(), providers: providers() });
});
app.post('/api/promo/check', h((req, res) => {
  if (limited('promo:' + req.ip, 20, 60e3)) throw httpErr(429, 'Trop d’essais. Patientez une minute.');
  const p = checkPromo(req.body?.code, Number(req.body?.subtotal) || 0);
  res.json({ promo: p });
}));

const publicOrder = (o, id) => {
  const { token, createdBy, ...rest } = o;
  const { sessionId, payToken, notifToken, ...pay } = rest.payment || {};
  return { ...rest, id, payment: pay };
};
app.post('/api/orders', h(async (req, res) => {
  if (limited('order:' + req.ip, 15, 600e3)) throw httpErr(429, 'Trop de commandes en peu de temps. Réessayez plus tard.');
  const b = req.body || {};
  const method = String(b.method || '');
  if (!providers().includes(method)) throw httpErr(400, 'Ce moyen de paiement n’est pas disponible.');
  const delivery = b.delivery === 'retrait' ? 'retrait' : 'livraison';
  const c = b.customer || {};
  const customer = { name: String(c.name || '').trim().slice(0, 80), phone: String(c.phone || '').trim().slice(0, 30),
    address: String(c.address || '').trim().slice(0, 200), city: String(c.city || '').trim().slice(0, 60), note: String(c.note || '').trim().slice(0, 300) };
  if (!customer.name || customer.phone.replace(/\D/g, '').length < 8) throw httpErr(400, 'Nom et numéro de téléphone valides requis.');
  if (delivery === 'livraison' && !customer.address) throw httpErr(400, 'Adresse de livraison requise.');
  const t = computeOrder(b.items, b.promoCode, delivery);
  if (method !== 'cod' && t.total < 100) throw httpErr(400, 'Montant trop faible pour un paiement mobile.');

  const id = newOrderId();
  const order = {
    number: 'FM-' + new Date().toISOString().slice(2, 10).replace(/-/g, '') + '-' + rnd(4),
    items: t.lines, subtotal: t.subtotal, discount: t.discount, shipping: t.shipping, total: t.total, promoCode: t.promoCode,
    customer, delivery, payment: { method, status: method === 'cod' ? 'à encaisser' : 'en attente', ref: '' },
    status: 'en_attente', channel: 'en ligne', stockApplied: false, createdAt: Date.now(), createdBy: 'web', token: randomToken()
  };
  putDoc('orders', id, order);

  let redirect = null;
  try {
    if (method === 'wave') {
      const s = await waveCreate(order, id);
      patchDoc('orders', id, { payment: { ...order.payment, sessionId: s.id } });
      redirect = s.wave_launch_url;
    } else if (method === 'orange') {
      const r = await omCreate(order, id);
      patchDoc('orders', id, { payment: { ...order.payment, payToken: r.pay_token, notifToken: r.notif_token } });
      redirect = r.payment_url;
    }
  } catch (e) {
    markFailed(id, 'échec d’initialisation');
    console.error('Initialisation paiement', method, e.message);
    throw httpErr(502, 'Le service de paiement ne répond pas. Réessayez ou choisissez un autre moyen de paiement.');
  }
  res.json({ id, token: order.token, redirect, order: publicOrder(getDoc('orders', id), id) });
}));
app.get('/api/orders/:id', h(async (req, res) => {
  const id = req.params.id; let o = validId(id) && getDoc('orders', id);
  if (!o || !req.query.t || !safeEq(o.token, req.query.t)) throw httpErr(404, 'Commande introuvable.');
  await refreshPayment(o, id, false);
  o = getDoc('orders', id);
  res.json(publicOrder(o, id));
}));

/* --- Équipe : connexion --- */
app.post('/api/auth/login', h((req, res) => {
  if (limited('login:' + req.ip, 8, 15 * 60e3)) throw httpErr(429, 'Trop de tentatives. Réessayez dans 15 minutes.');
  const u = store.users.byEmail(String(req.body?.email || '').toLowerCase().trim());
  if (!u || !checkPw(req.body?.password || '', u.hash)) throw httpErr(401, 'E-mail ou mot de passe incorrect.');
  res.set('Set-Cookie', `${COOKIE}=${signSession(u.id)}; ${cookieOpts(7 * 86400)}`).json({ ok: true });
}));
app.post('/api/auth/logout', (req, res) => res.set('Set-Cookie', `${COOKIE}=; ${cookieOpts(0)}`).json({ ok: true }));
app.get('/api/me', (req, res) => res.json({ user: currentUser(req) }));

/* --- Gestion (équipe connectée) --- */
app.get('/api/admin/state', requireStaff, (req, res) => {
  const s = settings();
  res.json({
    products: allDocs('products').sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
    bundles: allDocs('bundles').sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
    promos: allDocs('promos').sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
    orders: allDocs('orders').sort((a, b) => b.createdAt - a.createdAt).slice(0, 2000).map(o => publicOrder(o, o.id)),
    clients: allDocs('clients'), suppliers: allDocs('suppliers'),
    moves: allDocs('fin-moves').sort((a, b) => b.createdAt - a.createdAt), ledger: allDocs('fin-ledger').sort((a, b) => b.createdAt - a.createdAt),
    finConfig: getDoc('fin-config', 'main') || {},
    settings: s, users: store.users.list(), providers: providers(), configured: CONFIGURED, me: req.user
  });
});
const ADMIN_COLS = new Set(['products', 'bundles', 'promos', 'orders', 'settings', 'clients', 'suppliers', 'fin-moves', 'fin-ledger', 'fin-config']);
function adminTarget(req) {
  const { col, id } = req.params;
  if (!ADMIN_COLS.has(col) || !validId(id)) throw httpErr(400, 'Requête invalide.');
  if (col === 'settings' && req.user.role !== 'Gérant') throw httpErr(403, 'Réservé au gérant.');
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw httpErr(400, 'Données invalides.');
  return { col, id };
}
app.put('/api/admin/:col/:id', requireStaff, h((req, res) => {
  const { col, id } = adminTarget(req); const body = { ...req.body };
  if (col === 'orders') { const prev = getDoc('orders', id); body.token = prev ? prev.token : randomToken(); body.createdBy = prev ? prev.createdBy : req.user.id; if (prev?.payment) body.payment = { ...prev.payment, ...body.payment }; }
  if (col === 'promos') body.code = id;
  putDoc(col, id, body); res.json({ ok: true });
}));
app.patch('/api/admin/:col/:id', requireStaff, h((req, res) => {
  const { col, id } = adminTarget(req); const body = { ...req.body }; delete body.token; delete body.createdBy;
  if (col === 'orders' && body.payment) body.payment = { ...(getDoc('orders', id)?.payment || {}), ...body.payment };
  if (!patchDoc(col, id, body)) throw httpErr(404, 'Introuvable.');
  res.json({ ok: true });
}));
app.delete('/api/admin/:col/:id', requireStaff, h((req, res) => {
  const { col, id } = req.params;
  if (!ADMIN_COLS.has(col) || !validId(id)) throw httpErr(400, 'Requête invalide.');
  if ((col === 'orders' || col === 'settings') && req.user.role !== 'Gérant') throw httpErr(403, 'Réservé au gérant.');
  store.del(col, id); res.json({ ok: true });
}));
/* Remboursement Wave (gérant) */
app.post('/api/admin/orders/:id/refund', requireStaff, requireManager, h(async (req, res) => {
  const o = getDoc('orders', req.params.id);
  if (!o || o.payment?.method !== 'wave' || !o.payment.sessionId) throw httpErr(400, 'Remboursement automatique disponible uniquement pour Wave.');
  await waveRequest('POST', `/v1/checkout/sessions/${encodeURIComponent(o.payment.sessionId)}/refund`);
  patchDoc('orders', req.params.id, { status: 'annulee', payment: { ...o.payment, status: 'remboursé' } });
  res.json({ ok: true });
}));

/* --- Membres de l'équipe (gérant) --- */
const ROLES = ['Gérant', 'Vendeur', 'Caissier', 'Livreur', 'Gestionnaire de stock'];
app.post('/api/admin/users', requireStaff, requireManager, h((req, res) => {
  const { name, email, password, role } = req.body || {};
  const e = String(email || '').toLowerCase().trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw httpErr(400, 'Adresse e-mail invalide.');
  if (String(password || '').length < 10) throw httpErr(400, 'Mot de passe : 10 caractères minimum.');
  if (!ROLES.includes(role)) throw httpErr(400, 'Rôle invalide.');
  if (store.users.byEmail(e)) throw httpErr(409, 'Cette adresse est déjà utilisée.');
  store.users.add({ id: 'u' + rnd(10).toLowerCase(), email: e, name: String(name || '').trim().slice(0, 60) || e, role, hash: hashPw(password), created: Date.now() });
  res.json({ ok: true });
}));
app.patch('/api/admin/users/:id', requireStaff, requireManager, h((req, res) => {
  const role = req.body?.role;
  if (!ROLES.includes(role)) throw httpErr(400, 'Rôle invalide.');
  if (req.params.id === req.user.id && role !== 'Gérant') throw httpErr(400, 'Vous ne pouvez pas retirer votre propre rôle de gérant.');
  store.users.setRole(req.params.id, role); res.json({ ok: true });
}));
app.delete('/api/admin/users/:id', requireStaff, requireManager, h((req, res) => {
  if (req.params.id === req.user.id) throw httpErr(400, 'Vous ne pouvez pas supprimer votre propre compte.');
  store.users.remove(req.params.id); res.json({ ok: true });
}));

app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', maxAge: '1h' }));
app.use((req, res) => res.status(404).json({ error: 'Introuvable.' }));

store.init().then(ensureManager).then(() => app.listen(PORT, () => {
  console.log(`foûfoûni-Market sur ${BASE_URL} (port ${PORT})`);
  console.log(`Paiements : Wave ${CONFIGURED.wave ? 'configuré' : 'non configuré'} · Orange Money ${CONFIGURED.orange ? 'configuré' : 'non configuré'}`);
  if (!SECURE) console.warn('Attention : BASE_URL n’est pas en HTTPS. Les webhooks Wave et Orange l’exigent en production.');
})).catch(e => {
  console.error('Impossible de se connecter à Supabase :', e.message);
  console.error('Vérifiez DATABASE_URL : chaîne « Session pooler », mot de passe remplacé dans [YOUR-PASSWORD].');
  process.exit(1);
});
