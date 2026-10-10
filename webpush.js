'use strict';
if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = require('crypto').webcrypto;
/* Envoi de notifications Web Push (RFC 8291 aes128gcm + VAPID RFC 8292), sans dépendance.
   Fonctionne avec WebCrypto : Node 18+ et Supabase Edge Functions (Deno). */
const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();
const b64u = buf => { let s = ''; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64u = str => { const s = atob(String(str).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(str).length + 3) % 4)); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
const concat = (...a) => { const n = a.reduce((t, x) => t + x.length, 0), o = new Uint8Array(n); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
async function hkdf(salt, ikm, info, len) {
  const k = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
}

/* Crée une paire de clés VAPID : publicKey (à donner aux navigateurs) et privateJwk (à garder secrète) */
async function generateVapidKeys() {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { publicKey: b64u(await subtle.exportKey('raw', kp.publicKey)), privateJwk: await subtle.exportKey('jwk', kp.privateKey) };
}

async function vapidHeader(endpoint, vapid, subject) {
  const aud = new URL(endpoint).origin;
  const head = b64u(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(te.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject || 'mailto:contact@example.com' })));
  const key = await subtle.importKey('jwk', vapid.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(head + '.' + body));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${vapid.publicKey}`;
}

/* Chiffre le message pour un abonnement (endpoint + keys.p256dh + keys.auth) */
async function encrypt(sub, payload) {
  const uaPublic = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const local = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await subtle.exportKey('raw', local.publicKey));
  const uaKey = await subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));
  const ikm = await hkdf(auth, shared, concat(te.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const key = await subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const data = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(te.encode(payload), new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]); // taille d'enregistrement 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, data);
}

/* Envoie une notification. Renvoie { ok, status, gone } — gone = abonnement à supprimer */
async function sendPush(sub, message, vapid, subject, ttl = 86400) {
  try {
    const body = await encrypt(sub, typeof message === 'string' ? message : JSON.stringify(message));
    const r = await fetch(sub.endpoint, {
      method: 'POST', body,
      headers: { Authorization: await vapidHeader(sub.endpoint, vapid, subject), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(ttl), Urgency: 'normal' }
    });
    return { ok: r.status >= 200 && r.status < 300, status: r.status, gone: r.status === 404 || r.status === 410 };
  } catch (e) { return { ok: false, status: 0, gone: false, error: String(e && e.message || e) }; }
}

/* Petit identifiant stable pour un abonnement */
async function subId(endpoint) { return 'h' + b64u(await subtle.digest('SHA-256', te.encode(endpoint))).slice(0, 32).replace(/[-_]/g, 'x'); }

module.exports = { generateVapidKeys, sendPush, subId };
