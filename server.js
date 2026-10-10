'use strict';
/* foûfoûni-Market — serveur de la boutique avec paiements réels Wave et Orange Money. */
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { createStore } = require('./store');
const WP = require('./webpush');

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
/* Prépare la chaîne de connexion : nettoie les copier-coller et accepte le mot de passe à part (DB_PASSWORD) */
function buildDatabaseUrl() {
  const clean = v => String(v || '').trim().replace(/^DATABASE_URL\s*=\s*/i, '').replace(/^["'«\s]+|["'»\s]+$/g, '');
  let raw = clean(env.DATABASE_URL);
  let u;
  try { u = new URL(raw); } catch {
    console.error('DATABASE_URL illisible : collez l’adresse « Session pooler » complète, qui commence par postgresql://');
    process.exit(1);
  }
  if (env.DB_PASSWORD) u.password = encodeURIComponent(clean(env.DB_PASSWORD));
  const pw = decodeURIComponent(u.password || '');
  const problems = [];
  if (!pw || /YOUR-PASSWORD|\[|\]/i.test(pw)) problems.push('le mot de passe [YOUR-PASSWORD] n’a pas été remplacé');
  if (!/pooler\.supabase\.com$/i.test(u.hostname)) problems.push('ce n’est pas l’adresse « Session pooler » (l’hôte doit finir par pooler.supabase.com)');
  if (u.port && u.port !== '5432') problems.push(`le port est ${u.port} au lieu de 5432 (prenez « Session pooler », pas « Transaction pooler »)`);
  if (!/^postgres\.[a-z0-9]+$/i.test(decodeURIComponent(u.username))) problems.push(`l’utilisateur « ${decodeURIComponent(u.username)} » devrait ressembler à postgres.xxxxxxxx`);
  console.log(`Base : ${u.hostname}:${u.port || 5432} · utilisateur ${decodeURIComponent(u.username)} · mot de passe de ${pw.length} caractères (${pw.slice(0, 1)}…${pw.slice(-1)})${env.DB_PASSWORD ? ' pris dans DB_PASSWORD' : ''}`);
  problems.forEach(m => console.error('À corriger : ' + m));
  return u.toString();
}
const store = createStore({ connectionString: buildDatabaseUrl() });
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
  affDefaultPct: 5, affDiscountPct: 5, affDays: 30,
  tagline: 'Le marché, sans les embouteillages.', intro: 'Commandez en ligne, payez par mobile money ou à la livraison, et recevez vos articles chez vous.',
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
    affDays: s.affDays || 30, siteUrl: s.siteUrl || '',
    featuredPromo: s.featuredPromo && s.featuredPromo.code ? { code: s.featuredPromo.code, type: s.featuredPromo.type, value: s.featuredPromo.value, minOrder: s.featuredPromo.minOrder || 0, expiresAt: s.featuredPromo.expiresAt || '' } : null };
}

/* ================= Notifications (ntfy) ================= */
const NTFY = { server: (env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, ''), topic: (env.NTFY_TOPIC || '').trim(), token: (env.NTFY_TOKEN || '').trim() };
const ABANDON_MIN = Math.max(5, Number(env.ABANDON_MINUTES) || 10);
const money = n => new Intl.NumberFormat('fr-FR').format(Math.round(n || 0)).replace(/[\u202f\u00a0]/g, ' ') + ' ' + (settings().currency || 'FCFA');
const METHOD_NAMES = { wave: 'Wave', orange: 'Orange Money', moov: 'Moov Money', cod: 'À la livraison', cash: 'Espèces', credit: 'À crédit', card: 'Carte', paypal: 'PayPal' };
const waLink = (phone, text) => { let d = String(phone || '').replace(/\D/g, ''); if (d.length === 8) d = '223' + d; return d ? `https://wa.me/${d}?text=${encodeURIComponent(text)}` : ''; };
async function notify({ title, message, tags = [], priority = 3, click }) {
  if (!NTFY.topic) return;
  try {
    const r = await fetch(NTFY.server + '/', {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json', ...(NTFY.token ? { Authorization: `Bearer ${NTFY.token}` } : {}) },
      body: JSON.stringify({ topic: NTFY.topic, title, message, tags, priority, ...(click ? { click } : {}) })
    });
    if (!r.ok) console.warn('Notification ntfy refusée :', r.status);
  } catch (e) { console.warn('Notification ntfy non envoyée :', e.message); }
}

/* ================= Notifications push aux clients ================= */
let VAPID = null;
async function vapidKeys() {
  if (VAPID) return VAPID;
  let k = getDoc('push-config', 'vapid');
  if (!k) { k = await WP.generateVapidKeys(); putDoc('push-config', 'vapid', k); await store.flush(); }
  return (VAPID = k);
}
const PUSH_SUBJECT = 'mailto:' + (env.ADMIN_EMAIL || 'contact@foufouni.ml');
async function pushTo(subs, msg) {
  const v = await vapidKeys(); let sent = 0, failed = 0;
  for (let i = 0; i < subs.length; i += 20) {
    await Promise.all(subs.slice(i, i + 20).map(async x => {
      const r = await WP.sendPush(x.sub, msg, v, PUSH_SUBJECT);
      if (r.ok) sent++; else { failed++; if (r.gone) store.del('push-subs', x.id); }
    }));
  }
  return { sent, failed };
}
const ORDER_PUSH = {
  payee: ['Paiement reçu ✅', 'Merci ! Le paiement de votre commande {n} est confirmé.'],
  preparation: ['Commande en préparation 📦', 'Nous préparons votre commande {n}.'],
  expediee: ['Commande expédiée 🚚', 'Votre commande {n} est en route.'],
  livree: ['Commande livrée 🎉', 'Votre commande {n} a été livrée. Merci pour votre confiance !'],
  annulee: ['Commande annulée', 'Votre commande {n} a été annulée. Contactez-nous pour toute question.']
};
function pushOrder(id, o) {
  const m = ORDER_PUSH[o.status]; if (!m) return;
  const subs = allDocs('push-subs').filter(x => (x.orders || []).includes(id)); if (!subs.length) return;
  pushTo(subs, { title: m[0], body: m[1].replace('{n}', o.number), url: BASE_URL + '/?vue=commandes', tag: 'commande-' + id, icon: '/icon-192.png', badge: '/badge-96.png' })
    .catch(e => console.warn('Notification client :', e.message));
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
/* ================= Ambassadeurs ================= */
const PAID_ST = ['payee', 'preparation', 'expediee', 'livree'];
const findAffiliate = code => { const c = String(code || '').trim().toUpperCase(); return c ? allDocs('affiliates').find(a => a.code === c && a.active !== false) || null : null; };
const affPct = (doc) => { const v = doc && doc.affPct; return (v !== undefined && v !== null && v !== '' && !isNaN(v)) ? Number(v) : (Number(settings().affDefaultPct) || 0); };
const affState = o => !o.affiliate ? null : o.status === 'annulee' ? 'annulee' : PAID_ST.includes(o.status) ? 'validee' : 'en_attente';
function affCommission(lines, discPct) {
  const k = 1 - (Number(discPct) || 0) / 100;
  return Math.round(lines.reduce((t, l) => t + l.price * l.qty * k * affPct(l.bundle ? getDoc('bundles', l.id.slice(2)) : getDoc('products', l.id)) / 100, 0));
}

function computeOrder(items, promoCode, delivery, ref) {
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
  let discount = 0, code = '', affiliate = null;
  const aff = findAffiliate(promoCode);
  if (aff) {
    code = aff.code; const d = Math.min(90, Number(aff.discountPct) || 0);
    discount = Math.round(subtotal * d / 100);
    affiliate = { id: aff.id, code: aff.code, discountPct: d };
  } else if (promoCode) {
    const p = checkPromo(promoCode, subtotal); code = p.code;
    if (p.type === 'percent') discount = Math.round(subtotal * Math.min(p.value, 100) / 100);
    else if (p.type === 'fixed') discount = Math.min(p.value, subtotal);
    else if (p.type === 'shipping') discount = shipping;
  }
  if (!affiliate) { const r = findAffiliate(ref); if (r) affiliate = { id: r.id, code: r.code, discountPct: 0 }; }
  if (affiliate) affiliate.commission = affCommission(lines, affiliate.discountPct);
  return { lines, subtotal, shipping, discount, total: Math.max(0, subtotal + shipping - discount), promoCode: code, affiliate };
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
  pushOrder(orderId, { ...o, status: 'payee' });
  notify({ title: `Paiement reçu : ${money(o.total)}`, tags: ['moneybag'], priority: 4, click: BASE_URL,
    message: `Commande ${o.number} payée par ${METHOD_NAMES[o.payment.method] || o.payment.method}\n${o.customer?.name || ''} ${o.customer?.phone || ''}\n${o.items.map(i => `${i.qty} × ${i.name}`).join(', ')}${o.affiliate ? `\nVia l’ambassadeur ${o.affiliate.code} (commission ${money(o.affiliate.commission)})` : ''}` });
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
const publicProduct = p => ({ id: p.id, name: p.name, sku: p.sku, category: p.category, price: p.price, comparePrice: p.comparePrice, stock: p.stock, lowStock: p.lowStock, emoji: p.emoji, image: p.image, description: p.description, active: true, createdAt: p.createdAt, bulkMin: p.bulkMin || 0, bulkPrice: p.bulkPrice || 0, newUntil: p.newUntil || 0,
  gallery: Array.isArray(p.gallery) ? p.gallery : [], highlights: p.highlights || '', details: p.details || '', specs: p.specs || '', warranty: p.warranty || '' });
app.get('/api/public/catalog', (req, res) => {
  const reviews = allDocs('reviews').filter(r => r.status !== 'hidden').sort((a, b) => b.createdAt - a.createdAt).slice(0, 1500)
    .map(r => ({ id: r.id, productId: r.productId, rating: r.rating, comment: r.comment, name: r.name, photos: r.photos || [], reply: r.reply || '', createdAt: r.createdAt, status: 'published' }));
  res.json({ reviews, products: allDocs('products').filter(p => p.active !== false).map(publicProduct), bundles: allDocs('bundles').filter(b => b.active !== false), settings: publicSettings(), providers: providers() });
});
app.post('/api/promo/check', h((req, res) => {
  if (limited('promo:' + req.ip, 20, 60e3)) throw httpErr(429, 'Trop d’essais. Patientez une minute.');
  const a = findAffiliate(req.body?.code);
  if (a) return res.json({ promo: { code: a.code, type: 'percent', value: Number(a.discountPct) || 0, affiliate: { id: a.id } } });
  const p = checkPromo(req.body?.code, Number(req.body?.subtotal) || 0);
  res.json({ promo: p });
}));

/* Avis clients : uniquement pour un produit réellement acheté et expédié ou livré */
app.post('/api/reviews', h(async (req, res) => {
  if (limited('review:' + req.ip, 20, 3600e3)) throw httpErr(429, 'Trop d’avis envoyés. Réessayez plus tard.');
  const b = req.body || {}, oid = String(b.orderId || ''), pid = String(b.productId || '');
  const o = validId(oid) && getDoc('orders', oid);
  if (!o || !b.token || !safeEq(o.token, String(b.token))) throw httpErr(403, 'Commande introuvable.');
  if (!['livree', 'expediee'].includes(o.status)) throw httpErr(400, 'Vous pourrez donner votre avis dès que la commande sera expédiée ou livrée.');
  const inOrder = (o.items || []).some(i => i.id === pid || (i.bundle && (i.components || []).some(c => c.id === pid)));
  if (!validId(pid) || !inOrder || !getDoc('products', pid)) throw httpErr(400, 'Ce produit ne fait pas partie de la commande.');
  if (allDocs('reviews').some(r => r.orderId === oid && r.productId === pid)) throw httpErr(409, 'Vous avez déjà donné votre avis sur ce produit.');
  const rating = Math.round(Number(b.rating));
  if (!(rating >= 1 && rating <= 5)) throw httpErr(400, 'Choisissez une note de 1 à 5 étoiles.');
  const id = 'r' + Date.now().toString(36) + rnd(5).toLowerCase(), photos = [];
  for (const d of (Array.isArray(b.photos) ? b.photos : []).slice(0, 3)) {
    if (typeof d !== 'string' || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(d) || d.length > 300000) throw httpErr(400, 'Photo invalide ou trop lourde.');
    const iid = 'ri' + Date.now().toString(36) + rnd(5).toLowerCase(); putDoc('review-images', iid, { reviewId: id, data: d, createdAt: Date.now() }); photos.push(iid);
  }
  const doc = { productId: pid, orderId: oid, rating, comment: String(b.comment || '').trim().slice(0, 1000), name: String(b.name || 'Client').trim().slice(0, 40) || 'Client', photos, status: 'published', createdAt: Date.now() };
  putDoc('reviews', id, doc);
  res.json({ ok: true, id });
  const prod = getDoc('products', pid) || {};
  notify({ title: `Nouvel avis ${'★'.repeat(rating)}${'☆'.repeat(5 - rating)} : ${prod.name || ''}`, message: `${doc.name} : ${doc.comment || '(sans commentaire)'}${photos.length ? `\n${photos.length} photo(s) jointe(s)` : ''}`, tags: [rating >= 4 ? 'star' : 'warning'], priority: rating <= 2 ? 4 : 3, click: `${BASE_URL}/?p=${encodeURIComponent(pid)}` });
}));
app.get('/img/rv/:id', (req, res) => {
  const d = validId(req.params.id) && getDoc('review-images', req.params.id);
  const m = d && /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(d.data || '');
  if (!m) return res.status(404).end();
  res.set({ 'Content-Type': m[1], 'Cache-Control': 'public, max-age=86400' }).send(Buffer.from(m[2], 'base64'));
});

/* Notifications push : abonnement des clients */
app.get('/api/push/key', h(async (req, res) => res.json({ key: (await vapidKeys()).publicKey })));
app.post('/api/push/subscribe', h(async (req, res) => {
  if (limited('push:' + req.ip, 30, 600e3)) throw httpErr(429, 'Trop de requêtes.');
  const sub = req.body?.subscription || {}, k = sub.keys || {};
  if (!/^https:\/\//.test(String(sub.endpoint || '')) || String(sub.endpoint).length > 1000 || !k.p256dh || !k.auth) throw httpErr(400, 'Abonnement invalide.');
  const id = await WP.subId(sub.endpoint), prev = getDoc('push-subs', id), orders = new Set(prev?.orders || []);
  for (const x of (Array.isArray(req.body.orders) ? req.body.orders : []).slice(0, 50)) {
    const oid = String(x?.id || ''), o = validId(oid) && getDoc('orders', oid);
    if (o && x.t && safeEq(o.token, String(x.t))) orders.add(oid);
  }
  putDoc('push-subs', id, { sub: { endpoint: sub.endpoint, keys: { p256dh: String(k.p256dh), auth: String(k.auth) } }, orders: [...orders].slice(-50),
    promo: req.body.promo !== undefined ? req.body.promo !== false : (prev ? prev.promo !== false : true), createdAt: prev?.createdAt || Date.now(), updatedAt: Date.now() });
  res.json({ ok: true, orders: orders.size });
}));
app.post('/api/push/unsubscribe', h(async (req, res) => { const e = String(req.body?.endpoint || ''); if (e) store.del('push-subs', await WP.subId(e)); res.json({ ok: true }); }));
app.get('/api/admin/push/stats', requireStaff, (req, res) => {
  const subs = allDocs('push-subs');
  res.json({ total: subs.length, promo: subs.filter(x => x.promo !== false).length, withOrders: subs.filter(x => (x.orders || []).length).length,
    log: allDocs('push-log').sort((a, b) => b.at - a.at).slice(0, 10) });
});
app.post('/api/admin/push/broadcast', requireStaff, h(async (req, res) => {
  const b = req.body || {}, title = String(b.title || '').trim().slice(0, 70), body = String(b.body || '').trim().slice(0, 200);
  if (!title || !body) throw httpErr(400, 'Titre et message obligatoires.');
  if (limited('broadcast', 6, 3600e3)) throw httpErr(429, 'Trop d’envois en une heure : gardez vos clients, espacez les alertes.');
  const pid = String(b.productId || ''), p = validId(pid) ? getDoc('products', pid) : null;
  const url = p ? `${BASE_URL}/?p=${encodeURIComponent(pid)}` : BASE_URL + '/';
  const image = p ? productImage(pid, p) : (b.image ? `${BASE_URL}/og-image.jpg` : undefined);
  const subs = allDocs('push-subs').filter(x => x.promo !== false);
  const r = await pushTo(subs, { title, body, url, image, icon: '/icon-192.png', badge: '/badge-96.png', tag: 'promo-' + Date.now() });
  putDoc('push-log', 'l' + Date.now().toString(36), { at: Date.now(), title, body, product: p ? p.name : '', by: req.user.name, ...r });
  res.json({ ...r, total: subs.length });
}));

/* Ambassadeurs : comptage des clics et espace personnel (accès par lien secret) */
app.post('/api/aff/click', h((req, res) => {
  const a = findAffiliate(req.body?.code);
  if (a && !limited('affclick:' + req.ip + ':' + a.id, 1, 3600e3)) patchDoc('affiliates', a.id, { clicks: (a.clicks || 0) + 1 });
  res.json({ ok: true });
}));
app.get('/api/aff/me', h((req, res) => {
  if (limited('affme:' + req.ip, 60, 600e3)) throw httpErr(429, 'Trop de requêtes.');
  const t = String(req.query.t || '');
  const a = t.length >= 16 && allDocs('affiliates').find(x => x.token && safeEq(x.token, t));
  if (!a) throw httpErr(404, 'Espace introuvable. Demandez votre lien à la boutique.');
  const orders = allDocs('orders').filter(o => o.affiliate && o.affiliate.id === a.id).sort((x, y) => y.createdAt - x.createdAt);
  let validated = 0, pending = 0, n = 0;
  const sales = orders.map(o => { const st = affState(o), c = o.affiliate.commission || 0; if (st === 'validee') { validated += c; n++; } else if (st === 'en_attente') pending += c;
    return { number: o.number, date: o.createdAt, total: o.total, commission: c, state: st }; });
  const payouts = allDocs('aff-payouts').filter(p => p.affiliateId === a.id).sort((x, y) => y.createdAt - x.createdAt).map(p => ({ date: p.date, amount: p.amount }));
  const paid = payouts.reduce((t2, p) => t2 + p.amount, 0);
  const products = allDocs('products').filter(p => p.active !== false).sort((x, y) => affPct(y) * y.price - affPct(x) * x.price).slice(0, 40)
    .map(p => ({ name: p.name, price: p.price, pct: affPct(p), emoji: p.emoji || '📦' }));
  res.json({ name: a.name, code: a.code, active: a.active !== false, discountPct: a.discountPct || 0, clicks: a.clicks || 0, days: settings().affDays || 30,
    link: BASE_URL + '/?ref=' + encodeURIComponent(a.code), shop: settings().shopName, sales, n, validated, pending, paid, due: Math.max(0, validated - paid), payouts, products });
}));

/* Paniers : enregistrés pendant la visite pour signaler les paniers abandonnés */
app.post('/api/carts', h((req, res) => {
  if (limited('cart:' + req.ip, 60, 600e3)) throw httpErr(429, 'Trop de requêtes.');
  const b = req.body || {}, id = String(b.id || '');
  if (!/^[a-z0-9]{8,40}$/.test(id)) throw httpErr(400, 'Panier invalide.');
  const prev = getDoc('carts', id);
  if (prev && prev.converted) return res.json({ ok: true });
  const lines = [];
  for (const it of (Array.isArray(b.items) ? b.items : []).slice(0, 50)) {
    const q = Math.min(999, Math.max(1, parseInt(it?.qty) || 1));
    if (it?.bundle) { const x = validId(String(it.bundle)) && getDoc('bundles', String(it.bundle)); if (x) lines.push({ name: 'Lot · ' + x.name, qty: q, price: Number(x.price) || 0 }); }
    else { const x = validId(String(it?.id)) && getDoc('products', String(it.id)); if (x) lines.push({ name: x.name, qty: q, price: unitPrice(x, q) }); }
  }
  if (!lines.length) { if (prev) store.del('carts', id); return res.json({ ok: true }); }
  const c = b.contact || {};
  const contact = (c.name || c.phone) ? { name: String(c.name || '').trim().slice(0, 80), phone: String(c.phone || '').trim().slice(0, 30) } : (prev?.contact || null);
  const value = lines.reduce((t, l) => t + l.price * l.qty, 0), count = lines.reduce((t, l) => t + l.qty, 0);
  const changed = !prev || prev.value !== value || prev.count !== count;
  putDoc('carts', id, { lines, value, count, contact, createdAt: prev?.createdAt || Date.now(), updatedAt: changed ? Date.now() : prev.updatedAt, notified: changed ? false : !!prev.notified, converted: false });
  res.json({ ok: true });
}));
/* Toutes les minutes : signale les paniers sans commande depuis ABANDON_MINUTES, nettoie les anciens */
setInterval(() => {
  const t = Date.now();
  for (const c of allDocs('carts')) {
    if (t - c.updatedAt > 7 * 864e5) { store.del('carts', c.id); continue; }
    if (c.converted || c.notified || !c.value || t - c.updatedAt < ABANDON_MIN * 60e3 || t - c.updatedAt > 2 * 864e5) continue;
    patchDoc('carts', c.id, { notified: true, notifiedAt: t });
    const who = c.contact && (c.contact.name || c.contact.phone) ? `Client : ${c.contact.name || ''} ${c.contact.phone || ''}` : 'Visiteur anonyme (pas encore de coordonnées)';
    notify({ title: `Panier abandonné : ${money(c.value)}`, tags: ['shopping_cart'], priority: 3,
      click: (c.contact?.phone && waLink(c.contact.phone, `Bonjour ${c.contact.name || ''}, vous avez laissé des articles dans votre panier chez ${settings().shopName}. Pouvons-nous vous aider à finaliser votre commande ?`)) || BASE_URL,
      message: `${c.count} article${c.count > 1 ? 's' : ''} : ${c.lines.map(l => `${l.qty} × ${l.name}`).join(', ')}\n${who}` });
  }
}, 60e3).unref();

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
  const t = computeOrder(b.items, b.promoCode, delivery, b.ref);
  if (method !== 'cod' && t.total < 100) throw httpErr(400, 'Montant trop faible pour un paiement mobile.');

  const id = newOrderId();
  const order = {
    number: 'FM-' + new Date().toISOString().slice(2, 10).replace(/-/g, '') + '-' + rnd(4),
    items: t.lines, subtotal: t.subtotal, discount: t.discount, shipping: t.shipping, total: t.total, promoCode: t.promoCode, affiliate: t.affiliate,
    customer, delivery, payment: { method, status: method === 'cod' ? 'à encaisser' : 'en attente', ref: '' },
    status: 'en_attente', channel: 'en ligne', stockApplied: false, createdAt: Date.now(), createdBy: 'web', token: randomToken()
  };
  putDoc('orders', id, order);
  const cartId = String(b.cartId || '');
  if (/^[a-z0-9]{8,40}$/.test(cartId) && getDoc('carts', cartId)) patchDoc('carts', cartId, { converted: true, orderId: id });
  if (method === 'cod') notify({ title: `Nouvelle commande : ${money(order.total)}`, tags: ['shopping_bags'], priority: 4, click: waLink(customer.phone, `Bonjour ${customer.name}, merci pour votre commande ${order.number} chez ${settings().shopName}.`) || BASE_URL,
    message: `${order.number} · paiement à la livraison\n${customer.name} ${customer.phone}\n${delivery === 'livraison' ? 'Livraison : ' + customer.address + ', ' + customer.city : 'Retrait en boutique'}\n${order.items.map(i => `${i.qty} × ${i.name}`).join(', ')}${order.affiliate ? `\nVia l’ambassadeur ${order.affiliate.code} (commission ${money(order.affiliate.commission)})` : ''}` });

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
    affiliates: allDocs('affiliates').sort((a, b) => a.name.localeCompare(b.name)), affPayouts: allDocs('aff-payouts').sort((a, b) => b.createdAt - a.createdAt),
    costs: allDocs('costs'), stockMoves: allDocs('stock-moves').sort((a, b) => b.createdAt - a.createdAt).slice(0, 1000),
    reviews: allDocs('reviews').sort((a, b) => b.createdAt - a.createdAt),
    bundles: allDocs('bundles').sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
    promos: allDocs('promos').sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
    orders: allDocs('orders').sort((a, b) => b.createdAt - a.createdAt).slice(0, 2000).map(o => publicOrder(o, o.id)),
    clients: allDocs('clients'), suppliers: allDocs('suppliers'),
    moves: allDocs('fin-moves').sort((a, b) => b.createdAt - a.createdAt), ledger: allDocs('fin-ledger').sort((a, b) => b.createdAt - a.createdAt),
    finConfig: getDoc('fin-config', 'main') || {},
    notifications: { active: !!NTFY.topic, abandonMinutes: ABANDON_MIN },
    settings: s, users: store.users.list(), providers: providers(), configured: CONFIGURED, me: req.user
  });
});
const ADMIN_COLS = new Set(['products', 'product-images', 'costs', 'stock-moves', 'reviews', 'review-images', 'bundles', 'promos', 'orders', 'settings', 'affiliates', 'aff-payouts', 'aff-lookup', 'clients', 'suppliers', 'fin-moves', 'fin-ledger', 'fin-config']);
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
  if (col === 'affiliates') { const prev = getDoc('affiliates', id); body.token = (prev && prev.token) || body.token || randomToken(); body.code = String(body.code || '').toUpperCase(); }
  const prevDoc = getDoc(col, id), isNew = !prevDoc;
  putDoc(col, id, body); res.json({ ok: true });
  if (col === 'orders' && prevDoc && body.status && prevDoc.status !== body.status) pushOrder(id, body);
  if (isNew && col === 'orders' && body.channel === 'caisse') {
    const pay = body.payment || {};
    const paid = pay.rest > 0 ? (pay.paid || 0) : body.total;
    notify({ title: pay.rest > 0 ? `Vente en caisse : ${money(paid)} payés, ${money(pay.rest)} à crédit` : `Vente en caisse : ${money(body.total)}`, tags: ['receipt'], priority: 3, click: BASE_URL,
      message: `${body.number} · ${METHOD_NAMES[pay.method] || pay.method || ''} · par ${req.user.name}${body.customer?.name ? '\nClient : ' + body.customer.name + ' ' + (body.customer.phone || '') : ''}\n${(body.items || []).map(i => `${i.qty} × ${i.name}`).join(', ')}` });
  }
  if (isNew && col === 'fin-ledger' && body.kind === 'reglement' && body.partyType === 'client') {
    const c = getDoc('clients', body.partyId) || {};
    notify({ title: `Règlement client : ${money(body.amount)}`, tags: ['white_check_mark'], priority: 3, click: BASE_URL, message: `${c.name || 'Client'} ${c.phone || ''}\n${body.label || ''}` });
  }
}));
app.patch('/api/admin/:col/:id', requireStaff, h((req, res) => {
  const { col, id } = adminTarget(req); const body = { ...req.body }; delete body.token; delete body.createdBy;
  if (col === 'orders' && body.payment) body.payment = { ...(getDoc('orders', id)?.payment || {}), ...body.payment };
  const before = getDoc(col, id);
  const after = patchDoc(col, id, body); if (!after) throw httpErr(404, 'Introuvable.');
  res.json({ ok: true });
  if (col === 'orders' && body.status && before && before.status !== body.status) pushOrder(id, after);
}));
app.delete('/api/admin/:col/:id', requireStaff, h((req, res) => {
  const { col, id } = req.params;
  if (!ADMIN_COLS.has(col) || !validId(id)) throw httpErr(400, 'Requête invalide.');
  if ((col === 'orders' || col === 'settings') && req.user.role !== 'Gérant') throw httpErr(403, 'Réservé au gérant.');
  store.del(col, id); res.json({ ok: true });
}));
/* Test des notifications (équipe) */
app.post('/api/admin/notify-test', requireStaff, h(async (req, res) => {
  if (!NTFY.topic) throw httpErr(400, 'Ajoutez la variable NTFY_TOPIC sur Render pour activer les notifications.');
  await notify({ title: 'Test réussi', message: `Les notifications de ${settings().shopName} arrivent bien sur ce téléphone. Envoyé par ${req.user.name}.`, tags: ['bell'], priority: 3, click: BASE_URL });
  res.json({ ok: true, abandonMinutes: ABANDON_MIN });
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

/* ================= Partage : aperçu des liens, images produits, catalogue Facebook ================= */
const fs = require('fs');
let INDEX_HTML = '';
try { INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8'); } catch (e) { console.error('public/index.html introuvable : envoyez le dossier public sur GitHub.'); }
const escH = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plain = n => new Intl.NumberFormat('fr-FR').format(Math.round(n || 0)).replace(/[\u202f\u00a0]/g, ' ');
const productImage = (id, p) => (p && /^data:image\//.test(p.image || '')) ? `${BASE_URL}/img/p/${encodeURIComponent(id)}` : `${BASE_URL}/og-image.jpg`;
function sendPage(req, res) {
  if (!INDEX_HTML) return res.status(500).send('Page introuvable : le dossier public manque sur le serveur.');
  const s = settings(), pid = String(req.query.p || '');
  const found = validId(pid) ? getDoc('products', pid) : null, p = found && found.active !== false ? found : null;
  const title = p ? `${p.name} — ${plain(p.price)} FCFA | ${s.shopName}` : `${s.shopName} — ${s.tagline || 'Boutique en ligne'}`;
  const desc = p
    ? `${p.comparePrice > p.price ? `Promo : ${plain(p.price)} FCFA au lieu de ${plain(p.comparePrice)} FCFA. ` : ''}${p.description || p.category || ''} Commandez chez ${s.shopName} : mobile money ou paiement à la livraison.`.replace(/\s+/g, ' ').trim()
    : (s.intro || 'Commandez en ligne, payez par mobile money ou à la livraison.');
  const img = p ? productImage(pid, p) : `${BASE_URL}/og-image.jpg`, url = p ? `${BASE_URL}/?p=${encodeURIComponent(pid)}` : `${BASE_URL}/`;
  const meta = [
    ['name', 'description', desc], ['property', 'og:type', p ? 'product' : 'website'], ['property', 'og:site_name', s.shopName], ['property', 'og:locale', 'fr_FR'],
    ['property', 'og:title', title], ['property', 'og:description', desc], ['property', 'og:url', url], ['property', 'og:image', img],
    ...(img.endsWith('/og-image.jpg') ? [['property', 'og:image:width', '1200'], ['property', 'og:image:height', '630']] : []),
    ...(p ? [['property', 'product:price:amount', String(Math.round(p.price))], ['property', 'product:price:currency', 'XOF']] : []),
    ['name', 'twitter:card', 'summary_large_image'], ['name', 'twitter:title', title], ['name', 'twitter:description', desc], ['name', 'twitter:image', img]
  ].map(([k, n, v]) => `<meta ${k}="${n}" content="${escH(v)}">`).join('\n');
  res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' })
    .send(INDEX_HTML.replace(/<title>[^<]*<\/title>/, `<title>${escH(title)}</title>\n<link rel="canonical" href="${escH(url)}">\n${meta}`));
}
app.get(['/', '/index.html'], sendPage);
app.get('/img/p/:id', (req, res) => {
  const p = validId(req.params.id) && getDoc('products', req.params.id);
  const m = p && /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(p.image || '');
  if (!m) return res.redirect(302, '/og-image.jpg');
  res.set({ 'Content-Type': m[1], 'Cache-Control': 'public, max-age=3600' }).send(Buffer.from(m[2], 'base64'));
});
app.get('/img/pi/:id', (req, res) => {
  const d = validId(req.params.id) && getDoc('product-images', req.params.id);
  const m = d && /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(d.data || '');
  if (!m) return res.status(404).end();
  res.set({ 'Content-Type': m[1], 'Cache-Control': 'public, max-age=86400' }).send(Buffer.from(m[2], 'base64'));
});
/* Flux catalogue lu automatiquement par Facebook (Meta Commerce Manager) */
app.get('/catalogue.csv', (req, res) => {
  const s = settings();
  const q = v => { const x = String(v ?? '').replace(/\s+/g, ' ').trim(); return /[",]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x; };
  const rows = [['id', 'title', 'description', 'availability', 'condition', 'price', 'sale_price', 'link', 'image_link', 'additional_image_link', 'brand', 'product_type']];
  for (const p of allDocs('products').filter(x => x.active !== false && x.name && x.price > 0)) {
    const promo = p.comparePrice > p.price;
    rows.push([p.id, p.name.slice(0, 150), (p.description || `${p.name}${p.category ? ' — ' + p.category : ''}, disponible chez ${s.shopName}.`).slice(0, 5000),
      p.stock > 0 ? 'in stock' : 'out of stock', 'new', `${Math.round(promo ? p.comparePrice : p.price)} XOF`, promo ? `${Math.round(p.price)} XOF` : '',
      `${BASE_URL}/?p=${encodeURIComponent(p.id)}`, productImage(p.id, p), (Array.isArray(p.gallery) ? p.gallery : []).slice(0, 10).map(g => `${BASE_URL}/img/pi/${encodeURIComponent(g)}`).join(','), s.shopName, p.category || '']);
  }
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-cache' }).send(rows.map(r => r.map(q).join(',')).join('\n'));
});

app.use(express.static(path.join(__dirname, 'public'), { index: false, maxAge: '1h' }));
app.use((req, res) => res.status(404).json({ error: 'Introuvable.' }));

store.init().then(ensureManager).then(() => app.listen(PORT, () => {
  console.log(`foûfoûni-Market sur ${BASE_URL} (port ${PORT})`);
  console.log(`Paiements : Wave ${CONFIGURED.wave ? 'configuré' : 'non configuré'} · Orange Money ${CONFIGURED.orange ? 'configuré' : 'non configuré'}`);
  console.log(NTFY.topic ? `Notifications ntfy actives (sujet ${NTFY.topic.slice(0, 4)}…, panier abandonné après ${ABANDON_MIN} min)` : 'Notifications ntfy désactivées (variable NTFY_TOPIC absente)');
  if (!SECURE) console.warn('Attention : BASE_URL n’est pas en HTTPS. Les webhooks Wave et Orange l’exigent en production.');
})).catch(e => {
  console.error('Impossible de se connecter à Supabase :', e.message);
  if (/password authentication failed/i.test(e.message)) {
    console.error('→ Le mot de passe ne correspond pas à celui de la base Supabase.');
    console.error('→ Solution simple : réinitialisez-le dans Supabase (lettres et chiffres seulement), attendez 2 minutes,');
    console.error('  puis mettez-le dans la variable DB_PASSWORD sur Render (DATABASE_URL peut garder [YOUR-PASSWORD]).');
  } else if (/tenant|user not found/i.test(e.message)) {
    console.error('→ L’adresse ne correspond pas à votre projet : recopiez la chaîne « Session pooler » depuis le bouton Connect de Supabase.');
  } else {
    console.error('Vérifiez DATABASE_URL : chaîne « Session pooler » de Supabase.');
  }
  process.exit(1);
});
