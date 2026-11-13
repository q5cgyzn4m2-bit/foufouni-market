/* foûfoûni-Market — relie l'interface au serveur (paiements réels, comptes équipe). */
(function () {
  window.FFM_SERVER = true;
  const api = async (method, url, body) => {
    const r = await fetch(url, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || 'Le serveur ne répond pas.'); e.status = r.status; throw e; }
    return j;
  };
  let me = null, providers = [], configured = {}, notif = {}, pollT = null, loadT = null;
  S.users = [];

  const KEY = 'ffm-my-orders';
  const myOrders = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { return []; } };
  const addMine = (id, t) => { const l = myOrders().filter(x => x.id !== id); l.unshift({ id, t }); try { localStorage.setItem(KEY, JSON.stringify(l.slice(0, 50))); } catch (e) {} };

  async function load() {
    try {
      if (me) {
        const s = await api('GET', '/api/admin/state');
        S.products = s.products; S.bundles = s.bundles || []; S.promos = s.promos; S.affiliates = s.affiliates || []; S.affPayouts = s.affPayouts || []; S.visits = s.visits || []; S.reviews = s.reviews || []; S.campaigns = s.campaigns || []; S.drivers = s.drivers || []; S.purchases = s.purchases || []; S.lpStats = s.lpStats || []; S.contactFlags = Object.fromEntries((s.contactFlags || []).map(f => [f.id, f])); S.costs = Object.fromEntries((s.costs || []).map(c => [c.id, Number(c.cost) || 0])); S.stockMoves = s.stockMoves || [];
        S.clients = (s.clients||[]).sort((a,b)=>a.name.localeCompare(b.name)); S.suppliers = (s.suppliers||[]).sort((a,b)=>a.name.localeCompare(b.name));
        S.moves = s.moves || []; S.ledger = s.ledger || []; S.finConfig = s.finConfig || {}; S.orders = s.orders; S.users = s.users;
        S.settings = mergeSettings(s.settings); providers = s.providers; configured = s.configured || {}; notif = s.notifications || {};
      } else {
        const s = await api('GET', '/api/public/catalog');
        S.products = s.products; S.bundles = s.bundles || []; S.reviews = s.reviews || []; S.settings = mergeSettings(s.settings); providers = s.providers;
        const got = await Promise.all(myOrders().slice(0, 20).map(m => api('GET', `/api/orders/${encodeURIComponent(m.id)}?t=${encodeURIComponent(m.t)}`).catch(() => null)));
        S.orders = got.filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
      }
      S.settings.testMode = false;
    } catch (e) {
      if (e.status === 401 && me) { location.reload(); return; }
      toast('Connexion au serveur impossible. Nouvel essai dans un instant.');
    }
    schedule();
  }
  const reload = () => { clearTimeout(loadT); loadT = setTimeout(load, 250); };

  /* ---------- notifications push pour les clients ---------- */
  const PUSH_OK = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const STANDALONE = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  S._push = 'off';
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  const u8 = b64 => { const s2 = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64.length + 3) % 4)); return Uint8Array.from(s2, c => c.charCodeAt(0)); };
  async function pushState() {
    try {
      if (!PUSH_OK) { S._push = IS_IOS && !STANDALONE ? 'ios' : 'no'; return; }
      if (Notification.permission === 'denied') { S._push = 'denied'; return; }
      const reg = await navigator.serviceWorker.ready, sub = await reg.pushManager.getSubscription();
      S._push = sub && Notification.permission === 'granted' ? 'on' : 'off'; S._pushEndpoint = sub ? sub.endpoint : '';
    } catch (e) { S._push = 'no'; }
  }
  function iosHelp() {
    $('#overlay').innerHTML = `<div class="scrim" data-a="closeAll"><div class="modal" role="dialog" aria-modal="true" aria-label="Alertes sur iPhone"><div class="m-h"><h2>Alertes sur iPhone</h2><button class="x" data-a="closeAll" aria-label="Fermer">×</button></div>
      <div class="m-b"><p style="margin-top:0">Sur iPhone, les alertes fonctionnent une fois la boutique installée :</p><ol style="padding-left:20px;line-height:1.7"><li>Touchez le bouton <b>Partager</b> de Safari (carré avec une flèche).</li><li>Choisissez <b>« Sur l’écran d’accueil »</b>, puis <b>Ajouter</b>.</li><li>Ouvrez <b>foûfoûni</b> depuis la nouvelle icône et touchez <b>« Activer les alertes »</b>.</li></ol><p class="muted small" style="margin-bottom:0">iOS 16.4 ou plus récent est nécessaire.</p></div></div></div>`;
  }
  async function enableAlerts() {
    if (IS_IOS && !STANDALONE) return iosHelp();
    if (!PUSH_OK) return toast('Ce navigateur ne permet pas les alertes. Essayez Chrome.');
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { await pushState(); schedule(); return toast('Alertes refusées. Vous pourrez les autoriser dans les réglages du navigateur.'); }
      const { key } = await api('GET', '/api/push/key'), reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: u8(key) });
      await api('POST', '/api/push/subscribe', { subscription: sub.toJSON(), orders: myOrders(), promo: true });
      S._push = 'on'; S._pushEndpoint = sub.endpoint; syncCart(true); schedule(); toast('🔔 Alertes activées : vous serez prévenu de chaque étape et de nos promos');
    } catch (e) { toast('Activation impossible : ' + (e.message || 'réessayez plus tard')); }
  }
  async function syncAlerts() {
    try { if (!PUSH_OK || Notification.permission !== 'granted') return; const reg = await navigator.serviceWorker.ready, sub = await reg.pushManager.getSubscription();
      if (sub) await api('POST', '/api/push/subscribe', { subscription: sub.toJSON(), orders: myOrders() }); } catch (e) {}
  }
  const alertBox = ctx => (me || S._push === 'on' || S._push === 'no') ? '' : `<div class="panel" style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin:${ctx === 'shop' ? '40px 0 0' : '0 0 18px'}"><span style="font-size:30px">🔔</span><div style="flex:1 1 220px"><b>${ctx === 'orders' ? 'Suivez vos commandes en direct' : 'Ne manquez aucune promo'}</b><div class="muted small">${ctx === 'orders' ? 'Recevez une alerte à chaque étape : paiement, préparation, expédition, livraison.' : 'Soldes, nouveautés et offres réservées : recevez une alerte avec notre logo.'}${S._push === 'denied' ? ' Les alertes sont bloquées : autorisez-les dans les réglages du navigateur.' : ''}</div></div><button class="btn primary" style="border-radius:999px" data-srv="alerts" ${S._push === 'denied' ? 'disabled' : ''}>Activer les alertes</button></div>`;
  const baseShop = window.viewShop;
  window.viewShop = function () { const h = baseShop(); const box = alertBox('shop'); return box ? h.replace('<footer class="shop-foot">', box + '<footer class="shop-foot">') : h; };
  const baseOrders = window.viewMyOrders;
  window.viewMyOrders = function () { const h = baseOrders(); return h.replace('<div class="sec-h"><h2>Mes commandes</h2></div>', '<div class="sec-h"><h2>Mes commandes</h2></div>' + alertBox('orders')); };
  const baseReceipt = window.showReceipt;
  window.showReceipt = function (o, fresh) {
    baseReceipt(o, fresh);
    if (fresh && !me && S._push !== 'on' && S._push !== 'no') { const f = document.querySelector('#overlay .m-f'); if (f) { const b = document.createElement('button'); b.className = 'btn ghost'; b.dataset.srv = 'alerts'; b.textContent = '🔔 Me prévenir de chaque étape'; b.style.marginRight = 'auto'; f.prepend(b); } }
  };

  /* ---------- Gestion : alertes clients (promos et nouveautés) ---------- */
  let pushStats = null;
  async function loadPushStats() { try { pushStats = await api('GET', '/api/admin/push/stats'); } catch (e) { pushStats = { error: e.message }; } schedule(); }
  window.paneAlerts = function () {
    if (!pushStats) { loadPushStats(); return '<div class="empty"><div class="spinner"></div>Chargement…</div>'; }
    if (pushStats.error) return `<div class="empty"><h3>Indisponible</h3><p>${esc(pushStats.error)}</p></div>`;
    const pre = S.products.find(p => p.id === S.pushPre);
    const tpl = pre ? { t: pre.comparePrice > pre.price ? `Promo : ${pre.name}` : `Nouveau : ${pre.name}`, b: `${fmt(pre.price)}${pre.comparePrice > pre.price ? ' au lieu de ' + fmt(pre.comparePrice) : ''} chez ${S.settings.shopName}. Touchez pour voir le produit.` } : { t: '', b: '' };
    return `<div class="toolbar"><h2 style="font-size:24px;flex:1">Alertes clients</h2></div>
    <div class="kpis" style="grid-template-columns:repeat(3,1fr)"><div class="kpi"><span>Appareils abonnés</span><b>${pushStats.total}</b></div><div class="kpi"><span>Acceptent les promos</span><b>${pushStats.promo}</b></div><div class="kpi"><span>Suivent une commande</span><b>${pushStats.withOrders}</b></div></div>
    <div class="panel"><h3>Envoyer une alerte promo ou nouveauté</h3>
      <div class="field"><label for="pu-prod">Produit à mettre en avant (facultatif)</label><select class="input" id="pu-prod" data-srv-prod="1"><option value="">— Toute la boutique —</option>${S.products.filter(p => p.active !== false).map(p => `<option value="${p.id}" ${pre && pre.id === p.id ? 'selected' : ''}>${esc(p.name)} · ${fmt(p.price)}</option>`).join('')}</select></div>
      <div class="field"><label for="pu-title">Titre (70 caractères max.)</label><input class="input" id="pu-title" maxlength="70" value="${esc(tpl.t)}" placeholder="ex. Soldes du week-end : −20 % sur l’épicerie"></div>
      <div class="field"><label for="pu-body">Message (200 caractères max.)</label><textarea class="input" id="pu-body" maxlength="200" placeholder="ex. Profitez-en jusqu’à dimanche, livraison offerte dès 50 000 FCFA.">${esc(tpl.b)}</textarea></div>
      <p class="muted small">L’alerte s’affiche avec le logo foûfoûni, et la photo du produit sur Android. Un toucher ouvre ${pre ? 'la fiche du produit' : 'la boutique'}. Conseil : 1 à 2 alertes par semaine au maximum, sinon les clients les désactivent.</p>
      <button class="btn primary" data-srv="pushSend" ${pushStats.promo ? '' : 'disabled'}>📣 Envoyer à ${pushStats.promo} appareil${pushStats.promo > 1 ? 's' : ''}</button></div>
    <div class="panel"><h3>Alertes automatiques</h3><p class="muted" style="margin:0">Chaque client abonné est prévenu automatiquement quand sa commande passe en <b>Payée</b>, <b>En préparation</b>, <b>Expédiée</b>, <b>Livrée</b> ou <b>Annulée</b>.</p></div>
    ${pushStats.log.length ? `<div class="panel tbl-wrap"><h3>Derniers envois</h3><table><tbody>${pushStats.log.map(l => `<tr><td class="small">${dateFr(l.at)}</td><td><b>${esc(l.title)}</b><div class="muted small">${esc(l.body)}</div></td><td class="small">${l.sent} reçus${l.failed ? ' · ' + l.failed + ' échecs' : ''}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
  };

  /* ---------- suivi du panier (paniers abandonnés) ---------- */
  const newCartId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), b => (b % 36).toString(36)).join('');
  let cartId = (() => { try { return localStorage.getItem('ffm-cart-id') || ''; } catch (e) { return ''; } })();
  if (!/^[a-z0-9]{8,40}$/.test(cartId)) { cartId = newCartId(); try { localStorage.setItem('ffm-cart-id', cartId); } catch (e) {} }
  let contact = null, syncT = null;
  function syncCart(now) {
    if (me) return; // l'équipe connectée n'est pas suivie
    clearTimeout(syncT);
    syncT = setTimeout(() => {
      const items = S.cart.map(l => l.b ? { bundle: l.b, qty: l.qty } : (l.v ? { id: l.id, qty: l.qty, v: l.v } : { id: l.id, qty: l.qty }));
      api('POST', '/api/carts', { id: cartId, items, contact, push: S._pushEndpoint || '' }).catch(() => {});
    }, now ? 0 : 2500);
  }
  const baseSaveCart = window.saveCart;
  window.saveCart = function () { baseSaveCart(); syncCart(false); try { localStorage.setItem('ffm-cart-at', String(Date.now())); } catch (e) {} };

  /* ---------- démarrage ---------- */
  window.boot = async function () {
    try { me = (await api('GET', '/api/me')).user; } catch (e) { me = null; }
    await pushState();
    try { if (new URLSearchParams(location.search).get('vue') === 'commandes') S.view = 'orders'; } catch (e) {}
    S.isAdmin = !!me; S.myName = me ? me.name : ''; S.uid = me ? me.id : null; S.live = false;
    try { S.cart = JSON.parse(localStorage.getItem('ffm-cart') || '[]'); } catch (e) {}
    await load(); S.ready = true; schedule();
    clearInterval(pollT); pollT = setInterval(load, me ? 15000 : 60000);
    handleReturn();
    if (window.__ffmNewRef && !me) api('POST', '/api/aff/click', { code: window.__ffmNewRef }).catch(() => {});
    if (window.__ffmNewSrc && !me) api('POST', '/api/visit', { src: window.__ffmNewSrc }).catch(() => {});
    affSpace(); driverSpace();
    try { if (new URLSearchParams(location.search).get('panier') && !me) { history.replaceState(null, '', location.pathname); setTimeout(openCart, 400); } } catch (e) {}
    setupAssistant();
  };

  /* ---------- assistant IA pour les clients ---------- */
  const AI = { open: false, msgs: [], busy: false };
  try { AI.msgs = JSON.parse(sessionStorage.getItem('ffm-ai') || '[]'); } catch (e) {}
  const aiSave = () => { try { sessionStorage.setItem('ffm-ai', JSON.stringify(AI.msgs.slice(-30))); } catch (e) {} };
  function aiFormat(t) {
    let h = esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    h = h.replace(/\[\[([A-Za-z0-9._~:@+-]{1,64})\]\]/g, (m, id) => { const p = S.products.find(x => x.id === id && x.active !== false); if (!p) return '';
      return `<button class="ai-prod" data-ai-p="${esc(id)}"><span class="ai-pi">${pImg(p)}</span><span><b>${esc(p.name)}</b><br><span class="price" style="font-size:16px">${fmt(hasVar(p) ? minPrice(p) : p.price)}</span>${p.stock <= 0 ? ' <span class="pill bad">Rupture</span>' : ''}</span><span class="ai-go">Voir ›</span></button>`; });
    return h.replace(/\n/g, '<br>');
  }
  /* Avatar de l'assistante : illustration originale, ou image choisie par la boutique (Gestion › Assistant & paniers) */
  const AV_DEFAULT = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20120%20120%22%3E%20%3Cdefs%3E%3CradialGradient%20id%3D%22bg%22%20cx%3D%2250%25%22%20cy%3D%2238%25%22%20r%3D%2270%25%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%23F6E3B8%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23D9AE62%22%2F%3E%3C%2FradialGradient%3E%20%3CclipPath%20id%3D%22c%22%3E%3Ccircle%20cx%3D%2260%22%20cy%3D%2260%22%20r%3D%2260%22%2F%3E%3C%2FclipPath%3E%3C%2Fdefs%3E%20%3Cg%20clip-path%3D%22url%28%23c%29%22%3E%20%3Crect%20width%3D%22120%22%20height%3D%22120%22%20fill%3D%22url%28%23bg%29%22%2F%3E%20%3Cpath%20d%3D%22M14%20124%20C16%2096%2036%2086%2060%2086%20C84%2086%20104%2096%20106%20124%20Z%22%20fill%3D%22%23B23A26%22%2F%3E%20%3Cg%20fill%3D%22%23F2C14E%22%3E%3Ccircle%20cx%3D%2234%22%20cy%3D%22104%22%20r%3D%223%22%2F%3E%3Ccircle%20cx%3D%2248%22%20cy%3D%2298%22%20r%3D%223%22%2F%3E%3Ccircle%20cx%3D%2272%22%20cy%3D%2298%22%20r%3D%223%22%2F%3E%3Ccircle%20cx%3D%2286%22%20cy%3D%22104%22%20r%3D%223%22%2F%3E%3Ccircle%20cx%3D%2260%22%20cy%3D%22110%22%20r%3D%223%22%2F%3E%3Ccircle%20cx%3D%2242%22%20cy%3D%22116%22%20r%3D%223%22%2F%3E%3Ccircle%20cx%3D%2278%22%20cy%3D%22116%22%20r%3D%223%22%2F%3E%3C%2Fg%3E%20%3Cpath%20d%3D%22M46%2092%20Q60%20102%2074%2092%20L72%2086%20L48%2086%20Z%22%20fill%3D%22%233B2216%22%20opacity%3D%22.35%22%2F%3E%20%3Crect%20x%3D%2251%22%20y%3D%2274%22%20width%3D%2218%22%20height%3D%2216%22%20rx%3D%226%22%20fill%3D%22%235B341F%22%2F%3E%20%3Cellipse%20cx%3D%2238.5%22%20cy%3D%2262%22%20rx%3D%224%22%20ry%3D%226%22%20fill%3D%22%236B3E26%22%2F%3E%3Cellipse%20cx%3D%2281.5%22%20cy%3D%2262%22%20rx%3D%224%22%20ry%3D%226%22%20fill%3D%22%236B3E26%22%2F%3E%20%3Ccircle%20cx%3D%2238%22%20cy%3D%2271%22%20r%3D%222.6%22%20fill%3D%22%23F2C14E%22%2F%3E%3Ccircle%20cx%3D%2282%22%20cy%3D%2271%22%20r%3D%222.6%22%20fill%3D%22%23F2C14E%22%2F%3E%20%3Cellipse%20cx%3D%2260%22%20cy%3D%2260%22%20rx%3D%2221%22%20ry%3D%2224%22%20fill%3D%22%236F4029%22%2F%3E%20%3Cpath%20d%3D%22M36%2052%20C34%2028%2050%2014%2066%2016%20C84%2018%2092%2034%2086%2052%20C80%2044%2072%2041%2060%2041%20C48%2041%2041%2045%2036%2052%20Z%22%20fill%3D%22%23E09A2E%22%2F%3E%20%3Cpath%20d%3D%22M38%2046%20C46%2038%2074%2036%2085%2045%22%20fill%3D%22none%22%20stroke%3D%22%237A2E1C%22%20stroke-width%3D%223%22%2F%3E%20%3Cpath%20d%3D%22M40%2040%20L45%2035%20L50%2040%20L55%2035%20L60%2040%20L65%2035%20L70%2040%20L75%2035%20L80%2040%22%20fill%3D%22none%22%20stroke%3D%22%237A2E1C%22%20stroke-width%3D%222.2%22%20stroke-linejoin%3D%22round%22%2F%3E%20%3Cpath%20d%3D%22M62%2016%20C70%204%2086%206%2088%2016%20C82%2012%2074%2014%2070%2022%20Z%22%20fill%3D%22%23C9781F%22%2F%3E%20%3Cpath%20d%3D%22M66%2018%20C76%2010%2090%2014%2092%2026%20C86%2020%2078%2020%2072%2026%20Z%22%20fill%3D%22%23E7AE45%22%2F%3E%20%3Cpath%20d%3D%22M50.5%2056%20Q54%2054%2057.5%2056%22%20fill%3D%22none%22%20stroke%3D%22%232A160D%22%20stroke-width%3D%221.6%22%20stroke-linecap%3D%22round%22%2F%3E%3Cpath%20d%3D%22M62.5%2056%20Q66%2054%2069.5%2056%22%20fill%3D%22none%22%20stroke%3D%22%232A160D%22%20stroke-width%3D%221.6%22%20stroke-linecap%3D%22round%22%2F%3E%20%3Cellipse%20cx%3D%2254%22%20cy%3D%2261%22%20rx%3D%222.4%22%20ry%3D%222.9%22%20fill%3D%22%231E0F08%22%2F%3E%3Cellipse%20cx%3D%2266%22%20cy%3D%2261%22%20rx%3D%222.4%22%20ry%3D%222.9%22%20fill%3D%22%231E0F08%22%2F%3E%20%3Ccircle%20cx%3D%2254.8%22%20cy%3D%2260%22%20r%3D%22.8%22%20fill%3D%22%23fff%22%2F%3E%3Ccircle%20cx%3D%2266.8%22%20cy%3D%2260%22%20r%3D%22.8%22%20fill%3D%22%23fff%22%2F%3E%20%3Cpath%20d%3D%22M58.5%2066%20Q60%2069%2061.5%2066%22%20fill%3D%22none%22%20stroke%3D%22%234A2817%22%20stroke-width%3D%221.3%22%20stroke-linecap%3D%22round%22%2F%3E%20%3Cpath%20d%3D%22M53%2072%20Q60%2078%2067%2072%20Q60%2075%2053%2072%20Z%22%20fill%3D%22%238E3B2E%22%2F%3E%3Cpath%20d%3D%22M54.5%2072.6%20Q60%2075.6%2065.5%2072.6%22%20fill%3D%22none%22%20stroke%3D%22%23fff%22%20stroke-width%3D%221%22%20opacity%3D%22.75%22%2F%3E%20%3Cellipse%20cx%3D%2248%22%20cy%3D%2268%22%20rx%3D%223.4%22%20ry%3D%222%22%20fill%3D%22%23B5553B%22%20opacity%3D%22.35%22%2F%3E%3Cellipse%20cx%3D%2272%22%20cy%3D%2268%22%20rx%3D%223.4%22%20ry%3D%222%22%20fill%3D%22%23B5553B%22%20opacity%3D%22.35%22%2F%3E%20%3C%2Fg%3E%3C%2Fsvg%3E';
  const avSrc = () => (/^data:image\/(png|jpeg|webp);base64,/.test(S.settings.assistantPhoto || '') ? S.settings.assistantPhoto : AV_DEFAULT);
  const avHTML = (size, dot) => `<span class="ai-av" style="width:${size}px;height:${size}px"><img src="${avSrc()}" alt="">${dot ? '<i class="ai-dot" aria-hidden="true"></i>' : ''}</span>`;
  function aiDraw() {
    let box = $('#ai-box'); if (!box) return;
    const name = S.settings.assistantName || 'Fanta';
    box.innerHTML = !AI.open ? '' : `<div class="ai-panel" role="dialog" aria-label="Assistant ${esc(name)}"><div class="ai-h">${avHTML(42, true)}<div style="flex:1"><b>${esc(name)}</b><div class="small" style="color:var(--muted)"><span style="color:#22C55E;font-weight:700">● En ligne</span> · Assistante ${esc(S.settings.shopName)}</div></div><button class="x" data-ai="close" aria-label="Fermer">×</button></div>
      <div class="ai-msgs" id="ai-msgs">${AI.msgs.length ? '' : `<div class="ai-row">${avHTML(28)}<div class="ai-m bot">Bonjour 👋 Je suis ${esc(name)}. Je peux vous aider à trouver un produit, comparer, ou vous expliquer la livraison et le paiement.</div></div>`}${AI.msgs.map(m => m.role === 'user' ? `<div class="ai-m me">${esc(m.content)}</div>` : `<div class="ai-row">${avHTML(28)}<div class="ai-m bot">${aiFormat(m.content)}${m.actions ? `<div class="ai-act">${m.actions}</div>` : ''}</div></div>`).join('')}${AI.busy ? '<div class="ai-m bot"><span class="ai-dots"><i></i><i></i><i></i></span></div>' : ''}</div>
      ${AI.msgs.length ? '' : `<div class="ai-sug">${['Quels produits sont en promo ?', 'Comment se passe la livraison ?', 'Comment payer ?', 'Aidez-moi à choisir un cadeau'].map(q => `<button data-ai-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>`}
      <form class="ai-in" id="ai-form"><label class="sr" for="ai-t">Votre message</label><input id="ai-t" autocomplete="off" maxlength="600" placeholder="Posez votre question…" ${AI.busy ? 'disabled' : ''}><button class="btn primary" ${AI.busy ? 'disabled' : ''} aria-label="Envoyer">➤</button></form></div>`;
    $('#ai-fab').hidden = AI.open;
    const ms = $('#ai-msgs'); if (ms) ms.scrollTop = ms.scrollHeight;
    const f = $('#ai-form'); if (f) { f.onsubmit = e => { e.preventDefault(); aiSend($('#ai-t').value); }; if (!AI.busy) setTimeout(() => $('#ai-t') && $('#ai-t').focus(), 50); }
  }
  async function aiSend(text) {
    text = String(text || '').trim(); if (!text || AI.busy) return;
    AI.msgs.push({ role: 'user', content: text }); AI.busy = true; aiDraw();
    try {
      const r = await api('POST', '/api/assistant', { messages: AI.msgs.filter(m => !m.local).map(m => ({ role: m.role, content: m.content })), cart: S.cart.filter(l => !l.b).map(l => ({ id: l.id, qty: l.qty, v: l.v || '' })), productId: S.view === 'product' ? S.pid : '' });
      AI.msgs.push({ role: 'assistant', content: r.reply });
    } catch (e) { AI.msgs.push({ role: 'assistant', content: e.message + (S.settings.phone ? ' Vous pouvez aussi nous appeler au ' + S.settings.phone + '.' : ''), local: true }); }
    AI.busy = false; aiSave(); aiDraw();
  }
  function setupAssistant() {
    if (me || !S.settings.assistant || $('#ai-fab')) return;
    const css = document.createElement('style');
    css.textContent = `#ai-fab{position:fixed;right:18px;bottom:calc(22px + env(safe-area-inset-bottom,0px));z-index:45;border:0;border-radius:999px;background:var(--indigo);color:var(--on-indigo);font:700 15px var(--f-b);padding:13px 18px;box-shadow:var(--shadow);display:flex;gap:8px;align-items:center}
      .ai-panel{position:fixed;right:18px;bottom:calc(18px + env(safe-area-inset-bottom,0px));z-index:60;width:min(390px,calc(100vw - 24px));height:min(600px,calc(100vh - 110px));background:var(--surface);border:1px solid var(--line);border-radius:20px;box-shadow:var(--shadow);display:flex;flex-direction:column;overflow:hidden}
      .ai-h{display:flex;gap:10px;align-items:center;padding:12px 14px;border-bottom:1px solid var(--line)}
      .ai-msgs{flex:1;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:10px}
      .ai-m{max-width:88%;padding:10px 13px;border-radius:14px;font-size:14.5px;line-height:1.5}
      .ai-m.bot{background:var(--surface-2);align-self:flex-start;border-bottom-left-radius:4px}.ai-m.me{background:var(--indigo);color:var(--on-indigo);align-self:flex-end;border-bottom-right-radius:4px}
      .ai-prod{display:flex;gap:10px;align-items:center;width:100%;margin:8px 0 2px;padding:8px;border:1px solid var(--line);border-radius:12px;background:var(--surface);color:var(--ink);text-align:left}
      .ai-pi{width:48px;height:48px;flex:none;border-radius:8px;overflow:hidden;background:#fff;display:grid;place-items:center;font-size:26px}.ai-pi img{width:100%;height:100%;object-fit:cover}
      .ai-go{margin-left:auto;color:var(--indigo);font-weight:700;font-size:13px}
      .ai-act{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.ai-act button{border:1px solid var(--indigo);background:transparent;color:var(--indigo);border-radius:999px;padding:6px 12px;font-weight:700;font-size:13px}
      .ai-sug{display:flex;gap:6px;flex-wrap:wrap;padding:0 14px 10px}.ai-sug button{border:1px solid var(--line);background:transparent;color:var(--ink);border-radius:999px;padding:6px 11px;font-size:13px}
      .ai-in{display:flex;gap:8px;padding:10px;border-top:1px solid var(--line)}.ai-in input{flex:1;padding:10px 12px;border-radius:999px;border:1px solid var(--line);background:var(--bg)}.ai-in .btn{border-radius:50%;width:42px;height:42px;padding:0}
      .ai-dots i{display:inline-block;width:7px;height:7px;margin:0 2px;border-radius:50%;background:var(--muted);animation:aib 1s infinite}.ai-dots i:nth-child(2){animation-delay:.15s}.ai-dots i:nth-child(3){animation-delay:.3s}
      @keyframes aib{50%{opacity:.25;transform:translateY(-3px)}}
      @media (max-width:760px){#ai-fab{bottom:calc(140px + env(safe-area-inset-bottom,0px));right:12px;width:52px;height:52px;padding:0;justify-content:center;font-size:22px}#ai-fab>span:not(.ai-av){display:none}.ai-panel{right:6px;left:6px;width:auto;bottom:calc(6px + env(safe-area-inset-bottom,0px));height:calc(100vh - 80px)}}
      .ai-av{position:relative;display:inline-block;flex:none}.ai-av img{width:100%;height:100%;border-radius:50%;object-fit:cover;display:block;box-shadow:0 0 0 2px rgba(255,255,255,.85)}
      .ai-dot{position:absolute;right:0;bottom:0;width:28%;height:28%;min-width:10px;min-height:10px;border-radius:50%;background:#22C55E;border:2px solid var(--surface,#fff);box-shadow:0 0 0 0 rgba(34,197,94,.6);animation:aion 2s infinite}
      @keyframes aion{0%{box-shadow:0 0 0 0 rgba(34,197,94,.55)}70%{box-shadow:0 0 0 7px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}
      .ai-row{display:flex;gap:8px;align-items:flex-end}.ai-row .ai-m{margin:0}
      #ai-fab{padding:7px 18px 7px 7px}#ai-fab .ai-av{width:38px;height:38px}
      @media (max-width:760px){#ai-fab{padding:0;width:60px;height:60px;background:transparent;box-shadow:none}#ai-fab .ai-av{width:60px;height:60px}#ai-fab .ai-av img{box-shadow:0 6px 18px rgba(0,0,0,.35),0 0 0 3px #fff}}
      @media (prefers-reduced-motion:reduce){.ai-dots i,.ai-dot{animation:none}}`;
    document.head.appendChild(css);
    const fab = document.createElement('button'); fab.id = 'ai-fab'; fab.innerHTML = avHTML(38, true) + '<span>Besoin d’aide ?</span>'; fab.setAttribute('aria-label', 'Discuter avec l’assistante');
    fab.onclick = () => { AI.open = true; aiDraw(); }; document.body.appendChild(fab);
    const box = document.createElement('div'); box.id = 'ai-box'; document.body.appendChild(box);
    box.addEventListener('click', e => {
      const t = e.target.closest('[data-ai],[data-ai-q],[data-ai-p],[data-ai-do]'); if (!t) return;
      if (t.dataset.ai === 'close') { AI.open = false; aiDraw(); }
      if (t.dataset.aiQ) aiSend(t.dataset.aiQ);
      if (t.dataset.aiP) { openProduct(t.dataset.aiP); if (window.innerWidth < 760) { AI.open = false; aiDraw(); } }
      if (t.dataset.aiDo === 'cart') { AI.open = false; aiDraw(); openCart(); }
      if (t.dataset.aiDo === 'checkout') { AI.open = false; aiDraw(); if (enabledProcs().length) openCheckout(); else openCart(); }
    });
    /* Bon retour : un panier attend depuis plus de 30 minutes */
    let at = 0; try { at = Number(localStorage.getItem('ffm-cart-at')) || 0; } catch (e) {}
    const lines = cartLines(S.cart);
    if (lines.length && at && Date.now() - at > 30 * 60e3 && !sessionStorage.getItem('ffm-ai-welcome')) {
      try { sessionStorage.setItem('ffm-ai-welcome', '1'); } catch (e) {}
      const off = S.settings.featuredPromo;
      setTimeout(() => { AI.msgs.push({ role: 'assistant', local: true, content: `Bon retour 👋 Votre panier vous attend : **${lines.slice(0, 2).map(l => l.name).join(', ')}${lines.length > 2 ? '…' : ''}**. Avez-vous une question avant de commander ?${off && off.code ? ` Pensez au code **${off.code}**.` : ''}`, actions: '<button data-ai-do="cart">Voir mon panier</button><button data-ai-do="checkout">Finaliser ma commande</button>' }); AI.open = true; aiSave(); aiDraw(); }, 3500);
    }
    if (AI.msgs.length && sessionStorage.getItem('ffm-ai-open') === '1') { AI.open = true; aiDraw(); }
  }

  /* ---------- Gestion : assistant et paniers abandonnés ---------- */
  let cartsData = null;
  async function loadCarts() { try { cartsData = await api('GET', '/api/admin/carts'); } catch (e) { cartsData = { error: e.message }; } schedule(); }
  window.paneCarts = function () {
    if (!cartsData) { loadCarts(); return '<div class="empty"><div class="spinner"></div>Chargement…</div>'; }
    if (cartsData.error) return `<div class="empty"><h3>Indisponible</h3><p>${esc(cartsData.error)}</p></div>`;
    const st = S.settings, carts = cartsData.carts, val = carts.reduce((t, c) => t + c.value, 0), withPhone = carts.filter(c => c.contact && c.contact.phone).length;
    return `<div class="toolbar"><h2 style="font-size:24px;flex:1">Assistant IA et paniers abandonnés</h2><button class="btn ghost" data-srv="cartsReload">Actualiser</button></div>
    <div class="panel"><h3>Assistante IA pour vos clients</h3>
      <p style="margin:0 0 12px">${cartsData.ai ? '<span class="pill ok">Connectée</span> Une bulle « Besoin d’aide ? » s’affiche dans la boutique : elle répond aux questions et recommande vos produits, à partir de votre catalogue réel.' : '<span class="pill bad">Clé API manquante</span> Ajoutez la variable <b>ANTHROPIC_API_KEY</b> sur Render pour activer l’assistante.'}</p>
      <div class="row" style="align-items:center;gap:14px;margin-bottom:12px">${avHTML(64, true)}<div style="flex:1"><b>Image de l’assistante</b><div class="muted small">Par défaut, une illustration. Vous pouvez la remplacer par votre propre image (photo d’une personne de l’équipe avec son accord, ou illustration).</div>
        <div class="row" style="gap:8px;margin-top:8px"><label class="btn ghost sm" style="flex:0;white-space:nowrap">Changer l’image<input type="file" accept="image/*" class="sr" id="as-photo"></label>${st.assistantPhoto ? '<button class="btn ghost sm" data-srv="aiPhotoDel" style="flex:0;white-space:nowrap">Remettre l’illustration</button>' : ''}</div></div></div>
      <div class="row"><div class="field"><label for="as-name">Prénom de l’assistante</label><input class="input" id="as-name" value="${esc(st.assistantName || 'Fanta')}" maxlength="30"></div>
      <div class="field"><label for="as-code">Code promo proposé lors des relances</label><select class="input" id="as-code"><option value="">— Aucun —</option>${S.promos.filter(p => p.active).map(p => `<option ${p.code === st.relaunchCode ? 'selected' : ''}>${esc(p.code)}</option>`).join('')}</select></div></div>
      <div class="field"><label for="as-info">Informations utiles pour l’assistante</label><textarea class="input" id="as-info" maxlength="1500" placeholder="ex. Ouvert du lundi au samedi, 8 h – 19 h. Boutique à Hamdallaye ACI, près de la pharmacie. Livraison en 24 h à Bamako. Échange possible sous 7 jours.">${esc(st.assistantInfo || '')}</textarea></div>
      <label class="row" style="align-items:center;gap:10px;margin-bottom:8px"><span class="switch" style="flex:0 0 42px"><input type="checkbox" id="as-on" ${st.assistantOn !== false ? 'checked' : ''}><span></span></span><span>Afficher l’assistante dans la boutique</span></label>
      <label class="row" style="align-items:center;gap:10px;margin-bottom:14px"><span class="switch" style="flex:0 0 42px"><input type="checkbox" id="as-push" ${st.relaunchPush !== false ? 'checked' : ''}><span></span></span><span>Relancer automatiquement par notification les clients qui ont activé les alertes</span></label>
      <button class="btn primary" data-srv="aiSave">Enregistrer</button></div>
    <div class="kpis" style="grid-template-columns:repeat(3,1fr)"><div class="kpi"><span>Paniers abandonnés (7 j)</span><b>${carts.length}</b></div><div class="kpi"><span>Valeur à récupérer</span><b>${fmt(val)}</b></div><div class="kpi"><span>Avec numéro de téléphone</span><b>${withPhone}</b></div></div>
    <div class="panel tbl-wrap"><h3>Paniers à relancer</h3>${carts.length ? `<table><thead><tr><th>Quand</th><th>Contenu</th><th>Valeur</th><th>Client</th><th></th></tr></thead><tbody>${carts.map(c => `<tr><td class="small" style="white-space:nowrap">${dateFr(c.updatedAt)}</td><td class="small">${c.lines.map(l => `${l.qty} × ${esc(l.name)}`).join('<br>')}</td><td><b>${fmt(c.value)}</b></td>
      <td class="small">${c.contact && (c.contact.name || c.contact.phone) ? `${esc(c.contact.name || '')}<br>${esc(c.contact.phone || '')}` : '<span class="muted">Anonyme</span>'}${c.pushed ? '<br><span class="pill info">Relancé par notification</span>' : ''}${c.relaunchedAt ? `<br><span class="pill ok">WhatsApp ${dateFr(c.relaunchedAt)}</span>` : ''}</td>
      <td>${c.contact && c.contact.phone ? `<button class="btn primary sm" data-srv="relance" data-id="${c.id}" style="white-space:nowrap">💬 Relancer</button>` : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Aucun panier abandonné pour le moment.</p>'}
      <p class="muted small" style="margin:10px 0 0">« Relancer » prépare un message WhatsApp personnalisé${cartsData.ai ? ', rédigé par l’assistante' : ''}, que vous relisez avant l’envoi. Le numéro est connu quand le client a commencé à remplir le formulaire de commande.</p></div>`;
  };


  /* ---------- espace livreur (?livreur=…) ---------- */
  async function driverSpace() {
    const t = new URLSearchParams(location.search).get('livreur'); if (!t) return;
    let d; try { d = await api('GET', '/api/driver/me?t=' + encodeURIComponent(t)); } catch (e) { $('#overlay').innerHTML = `<div class="scrim"><div class="modal"><div class="m-b"><h2>Espace livreur</h2><p>${esc(e.message)}</p></div></div></div>`; return; }
    const todo = d.orders.filter(o => o.status !== 'livree'), done = d.orders.filter(o => o.status === 'livree');
    const card = o => `<div class="panel" style="margin-bottom:12px"><div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline"><b style="font-size:17px">${esc(o.number)}</b>${o.status === 'livree' ? '<span class="pill ok">Livrée ✓</span>' : o.toCollect ? `<span class="pill warn">À encaisser ${fmt(o.toCollect)}</span>` : '<span class="pill ok">Déjà payée</span>'}</div>
      <p style="margin:8px 0 4px"><b>${esc(o.customer.name)}</b> · ${esc(o.customer.phone)}</p><p class="muted small" style="margin:0">📍 ${esc([o.customer.address, o.customer.city].filter(Boolean).join(', '))}${o.customer.note ? '<br>Repère : ' + esc(o.customer.note) : ''}</p>
      <p class="small" style="margin:8px 0 0">${o.items.map(i => i.qty + ' × ' + esc(i.name)).join('<br>')}</p>
      ${o.status !== 'livree' ? `<div class="fin-actions" style="margin:12px 0 0"><a class="btn ghost sm" href="tel:${esc(o.customer.phone.replace(/\s/g, ''))}">📞 Appeler</a><a class="btn ghost sm" target="_blank" rel="noopener" href="https://wa.me/${waNumber(o.customer.phone)}">💬 WhatsApp</a><a class="btn ${o.customer.geo ? 'primary' : 'ghost'} sm" target="_blank" rel="noopener" href="${esc(mapsLink(o.customer))}">🗺 ${o.customer.geo ? 'Position exacte' : 'Itinéraire'}</a></div>
        <label class="btn primary block" style="margin-top:12px">📷 Colis livré : prendre la photo<input type="file" accept="image/*" capture="environment" class="sr" data-drv-photo="${esc(o.id)}"></label>` : `<p class="muted small" style="margin:10px 0 0">Livrée le ${dateFr(o.proof ? o.proof.at : o.createdAt)}</p>`}</div>`;
    $('#overlay').innerHTML = `<div class="scrim"><div class="modal wide" role="dialog" aria-modal="true" aria-label="Espace livreur"><div class="m-h"><h2>🛵 Bonjour ${esc(d.driver.name)}</h2></div>
      <div class="m-b"><p class="muted" style="margin-top:0">${todo.length} livraison${todo.length > 1 ? 's' : ''} à faire pour ${esc(d.shop)}. Une fois le colis remis, prenez la photo : la commande passe en « Livrée ».</p>
      ${todo.map(card).join('') || '<p class="muted">Aucune livraison en attente 👍</p>'}${done.length ? `<h3 style="margin:18px 0 10px">Livrées récemment</h3>${done.slice(0, 10).map(card).join('')}` : ''}</div></div></div>`;
    document.querySelectorAll('[data-drv-photo]').forEach(inp => inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return; const id = inp.dataset.drvPhoto, o = d.orders.find(x => x.id === id);
      const photo = await compress(f).catch(() => null); if (!photo) return toast('Photo illisible.');
      const lab = inp.closest('label'); lab.firstChild.nodeValue = 'Envoi…';
      const collected = o.toCollect ? confirm(`Avez-vous encaissé ${fmt(o.toCollect).replace(/[\u202f\u00a0]/g, ' ')} auprès du client ?`) : false;
      try { await api('POST', '/api/driver/deliver', { t, orderId: id, photo, collected }); toast('✓ Livraison enregistrée, merci !'); driverSpace(); }
      catch (e) { toast(e.message || 'Envoi impossible, réessayez.'); lab.firstChild.nodeValue = '📷 Colis livré : prendre la photo'; }
    });
  }

  /* ---------- espace personnel de l'ambassadeur (?espace=…) ---------- */
  async function affSpace() {
    const t = new URLSearchParams(location.search).get('espace'); if (!t) return;
    let d; try { d = await api('GET', '/api/aff/me?t=' + encodeURIComponent(t)); } catch (e) { $('#overlay').innerHTML = `<div class="scrim"><div class="modal"><div class="m-b"><h2>Espace ambassadeur</h2><p>${esc(e.message)}</p></div></div></div>`; return; }
    const ST = { validee: ['Validée', 'ok'], en_attente: ['En attente', 'warn'], annulee: ['Annulée', 'bad'] };
    const wa = encodeURIComponent(`Découvrez ${d.shop} : ${d.link}\nAvec mon code ${d.code}, vous avez −${d.discountPct} % sur votre commande.`);
    $('#overlay').innerHTML = `<div class="scrim"><div class="modal wide" role="dialog" aria-modal="true" aria-label="Espace ambassadeur">
      <div class="m-h"><h2>Bonjour ${esc(d.name)} 👋</h2><button class="x" data-a="closeAll" aria-label="Fermer">×</button></div>
      <div class="m-b">${d.active ? '' : '<div class="alert">Votre code est actuellement désactivé. Contactez la boutique.</div>'}
      <div class="kpis"><div class="kpi"><span>Clics sur votre lien</span><b>${d.clicks}</b></div><div class="kpi"><span>Ventes validées</span><b>${d.n}</b></div><div class="kpi"><span>Gains validés</span><b>${fmt(d.validated)}</b></div><div class="kpi"><span>À recevoir</span><b style="color:var(--indigo)">${fmt(d.due)}</b></div></div>
      <div class="panel"><h3>Votre lien et votre code</h3><p style="margin:0;word-break:break-all"><b>${esc(d.link)}</b></p><p class="muted small">Code : <b>${esc(d.code)}</b> · vos clients ont −${d.discountPct} % · une vente vous est attribuée si le client achète dans les ${d.days} jours après avoir cliqué.</p>
        <div class="fin-actions" style="margin:10px 0 0"><button class="btn primary sm" id="as-copy">Copier le lien</button><a class="btn ghost sm" href="https://wa.me/?text=${wa}" target="_blank" rel="noopener">Partager sur WhatsApp</a><a class="btn ghost sm" href="https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(d.link)}" target="_blank" rel="noopener">Partager sur Facebook</a></div></div>
      <div class="panel tbl-wrap"><h3>Vos ventes</h3>${d.sales.length ? `<table><thead><tr><th>Commande</th><th>Date</th><th>Montant</th><th>Votre commission</th><th>État</th></tr></thead><tbody>${d.sales.map(x => `<tr><td>${esc(x.number)}</td><td class="small">${dateFr(x.date)}</td><td>${fmt(x.total)}</td><td><b>${fmt(x.commission)}</b></td><td><span class="pill ${ST[x.state][1]}">${ST[x.state][0]}</span></td></tr>`).join('')}</tbody></table>` : '<p class="muted">Pas encore de vente : partagez votre lien !</p>'}
        <p class="muted small" style="margin-bottom:0">Une commission est validée quand la commande est payée ou livrée. Déjà reçu : ${fmt(d.paid)}${d.pending ? ' · en attente : ' + fmt(d.pending) : ''}.</p></div>
      <div class="panel tbl-wrap"><h3>Commissions par produit</h3><table><tbody>${d.products.map(p => `<tr><td>${esc(p.emoji)} ${esc(p.name)}</td><td>${fmt(p.price)}</td><td><b>${p.pct} %</b></td></tr>`).join('')}</tbody></table></div></div></div></div>`;
    $('#as-copy').onclick = async () => { try { await navigator.clipboard.writeText(d.link); toast('Lien copié'); } catch (e) { toast(d.link); } };
  }

  /* ---------- écritures (équipe connectée) ---------- */
  const skip = (col, id) => col === 'promo-lookup' || col === 'aff-lookup' || (col === 'settings' && id === 'team');
  window.put = async (col, id, data) => { if (skip(col, id)) return; await api('PUT', `/api/admin/${col}/${encodeURIComponent(id)}`, data); reload(); };
  window.patch = async (col, id, data) => { if (skip(col, id)) return; await api('PATCH', `/api/admin/${col}/${encodeURIComponent(id)}`, data); reload(); };
  window.del = async (col, id) => { if (skip(col, id)) return; await api('DELETE', `/api/admin/${col}/${encodeURIComponent(id)}`); reload(); };
  /* Avis : envoyés au serveur avec le jeton secret de la commande (achat vérifié) */
  window.postReview = async (o, item, r) => {
    const m = myOrders().find(x => x.id === o.id);
    if (!m) throw new Error('Commande introuvable sur cet appareil.');
    await api('POST', '/api/reviews', { orderId: o.id, token: m.t, productId: item.id, rating: r.rating, comment: r.comment, name: r.name, photos: r.photos });
    reload();
  };
  window.lpAI = productId => api('POST', '/api/admin/ai/landing', { productId });
  let audLoading = false;
  window.loadAudienceCarts = () => { if (audLoading) return; audLoading = true; api('GET', '/api/admin/audience-carts').then(r => { S.audCarts = r.carts || []; schedule(); }).catch(() => { S.audCarts = []; schedule(); }).finally(() => { audLoading = false; }); };
  window.pushToContacts = d => api('POST', '/api/admin/push/contacts', { keys: d.recips.map(r => r.c.key), productId: d.p ? d.p.id : '', url: d.p ? landingLink(d.p, 'notification') + '&cmp=' + d.cid : shopUrl() + '?src=notification&cmp=' + d.cid });
  window.importFromUrl = url => api('POST', '/api/admin/import-url', { url });
  window.readCnProduct = (shots, photos) => api('POST', '/api/admin/ai/cn-product', { shots, photos: photos || [] });
  window.lpView = pid => api('POST', '/api/lp-view', { pid }).catch(() => {});
  window.readInvoice = file => api('POST', '/api/admin/ai/invoice', { file });
  window.markWaCart = () => { clearTimeout(syncT); api('POST', `/api/carts/${encodeURIComponent(cartId)}/whatsapp`, {}).catch(() => {}); };
  window.deleteVideo = file => api('DELETE', '/api/admin/video/' + encodeURIComponent(file)).catch(() => {});
  window.seoAI = pid => api('POST', '/api/admin/ai/seo', { productId: pid });
  window.findOrder = (number, phone) => api('POST', '/api/orders/find', { number, phone });
  window.attachOrder = async (id, t) => { if (!id || !t) return; addMine(id, t); if (!me) await load(); };
  window.orderToken = id => { const m = myOrders().find(x => x.id === id); return m ? m.t : ''; };
  window.lookupBarcode = code => api('GET', '/api/admin/lookup-barcode?code=' + encodeURIComponent(code));
  window.posQrOrder = (items, promo) => api('POST', '/api/admin/pos/qr-order', { items: items.map(l => l.b ? { bundle: l.b, qty: l.qty } : (l.v ? { id: l.id, qty: l.qty, v: l.v } : { id: l.id, qty: l.qty })), promoCode: promo ? promo.code : '' });
  window.orderStatus = (id, t) => api('GET', `/api/orders/${encodeURIComponent(id)}?t=${encodeURIComponent(t)}`);
  window.payExistingOrder = (id, t, method) => api('POST', `/api/orders/${encodeURIComponent(id)}/pay`, { t, method });
  window.cancelQrOrder = id => api('PATCH', `/api/admin/orders/${encodeURIComponent(id)}`, { status: 'annulee' }).then(() => reload());
  window.resolveLink = async url => (await api('POST', '/api/admin/resolve-link', { url })).url;
  window.validatePromo = async (code, subtotal) => { try { return await api('POST', '/api/promo/check', { code, subtotal }); } catch (e) { return { err: e.message }; } };
  window.enabledProcs = () => Object.entries(S.settings.processors).filter(([k, v]) => v.enabled && PROCESSORS[k] && providers.includes(k));

  /* ---------- commande client avec paiement réel ---------- */
  window.coNext = async function () {
    readCO(); const err = $('#co-err');
    if (CO.step === 1 && (!CO.name || CO.phone.replace(/\D/g, '').length < 8)) { err.textContent = 'Indiquez votre nom et un numéro de téléphone valide.'; return; }
    if (CO.step === 2 && CO.delivery === 'livraison' && (!CO.city || !CO.address)) { err.textContent = !CO.city ? 'Indiquez votre ville.' : 'Indiquez votre quartier.'; return; }
    if (CO.step === 1) { contact = { name: CO.name, phone: CO.phone }; syncCart(true); }
    if (CO.step < 3) { CO.step++; drawCheckout(); return; }
    if (!payCheck()) return;
    const btn = document.querySelector('[data-a="coNext"]'); btn.disabled = true; btn.textContent = 'Préparation du paiement…';
    try {
      const r = await api('POST', '/api/orders', {
        items: S.cart.map(l => l.b ? { bundle: l.b, qty: l.qty } : (l.v ? { id: l.id, qty: l.qty, v: l.v } : { id: l.id, qty: l.qty })), promoCode: S.appliedPromo ? S.appliedPromo.code : '',
        customer: { name: CO.name, phone: CO.phone, address: CO.address, city: CO.city, note: CO.note, country: CO.country || 'ML', ...(CO.geo ? { geo: CO.geo } : {}) }, payRef: CO.payRef || '',
        delivery: CO.delivery, method: CO.method, cartId, ref: refCode(), source: srcCode(), campaign: cmpCode(), lpPids: lpSeen().filter(id => S.cart.some(l => l.id === id))
      });
      addMine(r.id, r.token); syncAlerts();
      { const tt = computeTotals(S.cart, S.appliedPromo, CO.delivery); ttTrack('PlaceAnOrder', { transaction_id: (r.order && r.order.number) || r.id, value: Math.round(tt.total), contents: tt.lines.filter(l => l.kind === 'product').map(l => ttItem(l.p, l.qty, l.unit)) }); ttIdentify(CO.phone); }
      clearTimeout(syncT); cartId = newCartId(); contact = null; try { localStorage.setItem('ffm-cart-id', cartId); } catch (e) {}
      S.cart = []; S.appliedPromo = null; saveCart(); schedule();
      if (r.redirect) {
        const name = PROCESSORS[CO.method].name;
        $('#overlay').innerHTML = `<div class="scrim"><div class="modal"><div class="m-b" style="text-align:center"><div class="spinner"></div><b>Ouverture de ${name}…</b><p class="muted small">Si rien ne se passe, <a href="${esc(r.redirect)}">touchez ici pour payer</a>.</p></div></div></div>`;
        location.href = r.redirect;
      } else { load(); showReceipt(r.order, true); }
    } catch (e) { err.textContent = e.message; btn.disabled = false; btn.textContent = 'Réessayer'; }
  };

  /* Retour depuis Wave ou Orange Money : on attend la confirmation du serveur */
  async function handleReturn() {
    const q = new URLSearchParams(location.search), id = q.get('order'), t = q.get('t');
    if (!id || !t) return;
    addMine(id, t); syncAlerts(); history.replaceState(null, '', location.pathname);
    $('#overlay').innerHTML = `<div class="scrim"><div class="modal"><div class="m-b" style="text-align:center"><div class="spinner"></div><b>Vérification de votre paiement…</b><p class="muted small">Cela prend quelques secondes.</p></div></div></div>`;
    const end = Date.now() + 120000;
    while (Date.now() < end) {
      let o; try { o = await api('GET', `/api/orders/${encodeURIComponent(id)}?t=${encodeURIComponent(t)}`); } catch (e) { break; }
      if (o.status !== 'en_attente') {
        load();
        if (o.status === 'annulee') return payFail(`Le paiement n’a pas abouti (${o.payment.status}). Votre panier n’a pas été débité ; vous pouvez repasser commande.`);
        ttTrack('CompletePayment', { value: Math.round(o.total || 0), contents: (o.items || []).filter(i => !i.bundle).map(i => ({ content_id: String(i.id), content_type: 'product', content_name: i.name, quantity: i.qty, price: i.price })) });
        return showReceipt(o, true);
      }
      if (q.get('err') && Date.now() > end - 110000) return payFail('Le paiement a été annulé. Vous pouvez repasser commande quand vous voulez.');
      await new Promise(r => setTimeout(r, 3000));
    }
    load();
    payFail('Nous n’avons pas encore reçu la confirmation. Si vous avez payé, la commande sera validée automatiquement : retrouvez-la dans « Mes commandes ».');
  }

  /* ---------- téléchargements dans le navigateur ---------- */
  dl = { save: async ({ filename, data }) => {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data])); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } };

  /* ---------- barre du haut : accès équipe ---------- */
  const baseTop = window.renderTop;
  window.renderTop = function () {
    baseTop();
    const sm = document.querySelector('#topbar .brand small'); if (sm) sm.textContent = me ? `Connecté : ${me.role}` : 'Boutique en ligne';
    const cart = document.querySelector('#topbar [data-a="cart"]');
    const b = document.createElement('button'); b.className = 'btn ghost sm'; b.dataset.srv = me ? 'logout' : 'login';
    b.textContent = me ? 'Déconnexion' : 'Espace équipe'; cart.before(b);
  };
  function loginModal() {
    $('#overlay').innerHTML = `<div class="scrim" data-a="closeAll"><div class="modal" role="dialog" aria-modal="true" aria-label="Connexion équipe">
      <div class="m-h"><h2>Espace équipe</h2><button class="x" data-a="closeAll" aria-label="Fermer">×</button></div>
      <div class="m-b"><div class="field"><label for="lg-email">E-mail</label><input class="input" id="lg-email" type="email" autocomplete="username"></div>
      <div class="field"><label for="lg-pw">Mot de passe</label><input class="input" id="lg-pw" type="password" autocomplete="current-password"></div>
      <div class="small" id="lg-err" style="color:var(--danger)"></div></div>
      <div class="m-f"><button class="btn primary" data-srv="doLogin">Se connecter</button></div></div></div>`;
    $('#lg-email').focus();
  }

  /* ---------- paiements : état réel des connexions ---------- */
  const basePay = window.panePayments;
  window.panePayments = function () {
    const row = (k, n) => `<div class="row" style="justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--line)"><b style="flex:1">${n}</b><span class="pill ${configured[k] ? 'ok' : 'bad'}" style="flex:0 0 auto;white-space:nowrap">${configured[k] ? 'Connecté' : 'Clés manquantes'}</span></div>`;
    return `<div class="panel" style="margin-bottom:18px"><h3>Connexions de paiement réelles</h3>${row('wave', 'Wave')}${row('orange', 'Orange Money')}
      <div class="row" style="justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--line)"><b style="flex:1">Notifications ntfy</b><span class="pill ${notif.active ? 'ok' : 'bad'}" style="flex:0 0 auto;white-space:nowrap">${notif.active ? 'Actives' : 'NTFY_TOPIC manquant'}</span></div>
      ${notif.active ? `<p class="muted small">Vous êtes prévenu de chaque paiement, commande, vente en caisse, règlement client, et des paniers sans commande depuis ${notif.abandonMinutes} min.</p><button class="btn ghost sm" data-srv="notifyTest" style="margin-bottom:10px">Envoyer une notification de test</button>` : ''}
      <p class="muted small" style="margin-bottom:0">Les clés secrètes se règlent uniquement dans le fichier .env du serveur. Moov Money, la carte bancaire et PayPal restent masqués côté client tant qu’ils ne sont pas branchés.</p></div>` + basePay();
  };

  /* ---------- équipe : vrais comptes ---------- */
  window.paneTeam = function () {
    const isMgr = me && me.role === 'Gérant';
    const sales = {}; S.orders.filter(o => o.channel === 'caisse').forEach(o => { sales[o.cashier] = (sales[o.cashier] || 0) + o.total; });
    return `<h2 style="font-size:24px;margin-bottom:16px">Équipe</h2>
    <div class="panel"><h3>Comptes</h3><div class="tbl-wrap"><table><thead><tr><th>Nom</th><th>E-mail</th><th>Rôle</th><th>Ventes en caisse</th><th></th></tr></thead><tbody>
    ${S.users.map(u => `<tr><td>${esc(u.name)}${u.id === me.id ? ' <span class="pill info">vous</span>' : ''}</td><td class="small">${esc(u.email)}</td>
      <td>${isMgr ? `<select class="input" data-srv-role="${esc(u.id)}" aria-label="Rôle">${ROLES.map(r => `<option ${r === u.role ? 'selected' : ''}>${r}</option>`).join('')}</select>` : esc(u.role)}</td>
      <td>${fmt(sales[u.id] || 0)}</td><td>${isMgr && u.id !== me.id ? `<button class="btn sm ghost" data-srv="rmUser" data-id="${esc(u.id)}">Supprimer</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div></div>
    ${isMgr ? `<div class="panel"><h3>Ajouter un membre</h3><div class="row"><div class="field"><label for="nu-name">Nom</label><input class="input" id="nu-name"></div><div class="field"><label for="nu-email">E-mail</label><input class="input" id="nu-email" type="email"></div></div>
      <div class="row"><div class="field"><label for="nu-pw">Mot de passe provisoire</label><input class="input" id="nu-pw" type="text" placeholder="10 caractères minimum"></div><div class="field"><label for="nu-role">Rôle</label><select class="input" id="nu-role">${ROLES.map(r => `<option ${r === 'Vendeur' ? 'selected' : ''}>${r}</option>`).join('')}</select></div></div>
      <div class="small" id="nu-err" style="color:var(--danger)"></div><button class="btn primary" data-srv="addUser">Créer le compte</button></div>` : ''}
    <div class="panel"><h3>Qui peut faire quoi</h3><p class="muted" style="margin:0">Le <b>Gérant</b> gère tout, y compris les réglages, les comptes et les remboursements Wave. Les autres rôles accèdent à la caisse, aux produits, aux commandes et aux codes promo. Les clients n’ont pas besoin de compte.</p></div>`;
  };

  /* ---------- remboursement Wave dans le détail de commande ---------- */
  const baseDetail = window.orderDetail;
  window.orderDetail = function (o) {
    baseDetail(o);
    if (me && me.role === 'Gérant' && o.payment?.method === 'wave' && ['payee', 'preparation'].includes(o.status)) {
      const f = document.querySelector('#overlay .m-f'); const b = document.createElement('button');
      b.className = 'btn danger'; b.style.marginRight = 'auto'; b.textContent = 'Rembourser via Wave'; b.dataset.srv = 'refund'; b.dataset.id = o.id; f.prepend(b);
    }
  };

  /* ---------- événements propres au serveur ---------- */
  document.addEventListener('click', async e => {
    const el = e.target.closest('[data-srv]'); if (!el) return;
    const a = el.dataset.srv;
    try {
      if (a === 'login') loginModal();
      if (a === 'cartsReload') { cartsData = null; schedule(); }
      if (a === 'aiPhotoDel') { const s2 = structuredClone(S.settings); delete s2.assistantPhoto; await api('PUT', '/api/admin/settings/main', s2); toast('Illustration remise'); reload(); }
      if (a === 'aiSave') { const s2 = structuredClone(S.settings); s2.assistantName = $('#as-name').value.trim() || 'Fanta'; s2.relaunchCode = $('#as-code').value; s2.assistantInfo = $('#as-info').value.trim(); s2.assistantOn = $('#as-on').checked; s2.relaunchPush = $('#as-push').checked;
        await api('PUT', '/api/admin/settings/main', s2); toast('Réglages de l’assistante enregistrés'); reload(); }
      if (a === 'relance') { el.disabled = true; const r = await api('POST', `/api/admin/carts/${encodeURIComponent(el.dataset.id)}/relance`); window.open(r.wa, '_blank'); cartsData = null; schedule(); }
      if (a === 'alerts') { closeAll(); await enableAlerts(); }
      if (a === 'pushSend') {
        const title = $('#pu-title').value.trim(), body = $('#pu-body').value.trim(), productId = $('#pu-prod').value;
        if (!title || !body) return toast('Remplissez le titre et le message.');
        if (!el.dataset.armed) { el.dataset.armed = '1'; el.textContent = 'Confirmer l’envoi ?'; return; } el.disabled = true;
        const r = await api('POST', '/api/admin/push/broadcast', { title, body, productId });
        toast(`Alerte envoyée : ${r.sent} reçue${r.sent > 1 ? 's' : ''}${r.failed ? ', ' + r.failed + ' appareil(s) désabonné(s)' : ''}`); S.pushPre = null; pushStats = null; schedule();
      }
      if (a === 'notifyTest') { el.disabled = true; await api('POST', '/api/admin/notify-test'); toast('Notification envoyée : regardez votre téléphone'); el.disabled = false; }
      if (a === 'logout') { await api('POST', '/api/auth/logout'); location.reload(); }
      if (a === 'doLogin') {
        el.disabled = true;
        try { await api('POST', '/api/auth/login', { email: $('#lg-email').value, password: $('#lg-pw').value }); location.reload(); }
        catch (err) { $('#lg-err').textContent = err.message; el.disabled = false; }
      }
      if (a === 'addUser') {
        try { await api('POST', '/api/admin/users', { name: $('#nu-name').value, email: $('#nu-email').value, password: $('#nu-pw').value, role: $('#nu-role').value }); toast('Compte créé'); load(); }
        catch (err) { $('#nu-err').textContent = err.message; }
      }
      if (a === 'rmUser') { if (!confirmTwice(el)) return; await api('DELETE', `/api/admin/users/${encodeURIComponent(el.dataset.id)}`); toast('Compte supprimé'); load(); }
      if (a === 'refund') {
        if (!confirmTwice(el)) return; el.disabled = true;
        await api('POST', `/api/admin/orders/${encodeURIComponent(el.dataset.id)}/refund`); closeAll(); toast('Remboursement Wave effectué'); load();
      }
    } catch (err) { toast(err.message); el.disabled = false; }
  });
  document.addEventListener('change', async e => {
    if (e.target.id === 'as-photo' && e.target.files[0]) { try {
        const big = await compress(e.target.files[0]); const im = new Image(); await new Promise((ok, ko) => { im.onload = ok; im.onerror = ko; im.src = big; });
        const c = document.createElement('canvas'); c.width = c.height = 256; c.getContext('2d').drawImage(im, 0, 0, 256, 256);
        const s2 = structuredClone(S.settings); s2.assistantPhoto = c.toDataURL('image/jpeg', .85); await api('PUT', '/api/admin/settings/main', s2); toast('Image de l’assistante enregistrée'); reload();
      } catch (err) { toast(err.message || 'Image illisible'); } return; }
    if (e.target.dataset.srvProd) { S.pushPre = e.target.value || null; schedule(); return; }
    const id = e.target.dataset.srvRole; if (!id) return;
    try { await api('PATCH', `/api/admin/users/${encodeURIComponent(id)}`, { role: e.target.value }); toast('Rôle mis à jour'); load(); } catch (err) { toast(err.message); load(); }
  });
  document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'lg-pw') document.querySelector('[data-srv="doLogin"]')?.click(); });

  boot();
})();
