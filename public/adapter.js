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
        S.products = s.products; S.bundles = s.bundles || []; S.promos = s.promos; S.affiliates = s.affiliates || []; S.affPayouts = s.affPayouts || []; S.reviews = s.reviews || []; S.costs = Object.fromEntries((s.costs || []).map(c => [c.id, Number(c.cost) || 0])); S.stockMoves = s.stockMoves || [];
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
      S._push = sub && Notification.permission === 'granted' ? 'on' : 'off';
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
      S._push = 'on'; schedule(); toast('🔔 Alertes activées : vous serez prévenu de chaque étape et de nos promos');
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
      const items = S.cart.map(l => l.b ? { bundle: l.b, qty: l.qty } : { id: l.id, qty: l.qty });
      api('POST', '/api/carts', { id: cartId, items, contact }).catch(() => {});
    }, now ? 0 : 2500);
  }
  const baseSaveCart = window.saveCart;
  window.saveCart = function () { baseSaveCart(); syncCart(false); };

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
    affSpace();
  };

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
  window.validatePromo = async (code, subtotal) => { try { return await api('POST', '/api/promo/check', { code, subtotal }); } catch (e) { return { err: e.message }; } };
  window.enabledProcs = () => Object.entries(S.settings.processors).filter(([k, v]) => v.enabled && PROCESSORS[k] && providers.includes(k));

  /* ---------- commande client avec paiement réel ---------- */
  window.coNext = async function () {
    readCO(); const err = $('#co-err');
    if (CO.step === 1 && (!CO.name || CO.phone.replace(/\D/g, '').length < 8)) { err.textContent = 'Indiquez votre nom et un numéro de téléphone valide.'; return; }
    if (CO.step === 2 && CO.delivery === 'livraison' && !CO.address) { err.textContent = 'Indiquez votre adresse ou votre quartier.'; return; }
    if (CO.step === 1) { contact = { name: CO.name, phone: CO.phone }; syncCart(true); }
    if (CO.step < 3) { CO.step++; drawCheckout(); return; }
    if (!CO.method) { err.textContent = 'Choisissez un moyen de paiement.'; return; }
    const btn = document.querySelector('[data-a="coNext"]'); btn.disabled = true; btn.textContent = 'Préparation du paiement…';
    try {
      const r = await api('POST', '/api/orders', {
        items: S.cart.map(l => l.b ? { bundle: l.b, qty: l.qty } : { id: l.id, qty: l.qty }), promoCode: S.appliedPromo ? S.appliedPromo.code : '',
        customer: { name: CO.name, phone: CO.phone, address: CO.address, city: CO.city, note: CO.note },
        delivery: CO.delivery, method: CO.method, cartId, ref: refCode()
      });
      addMine(r.id, r.token); syncAlerts();
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
    if (e.target.dataset.srvProd) { S.pushPre = e.target.value || null; schedule(); return; }
    const id = e.target.dataset.srvRole; if (!id) return;
    try { await api('PATCH', `/api/admin/users/${encodeURIComponent(id)}`, { role: e.target.value }); toast('Rôle mis à jour'); load(); } catch (err) { toast(err.message); load(); }
  });
  document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'lg-pw') document.querySelector('[data-srv="doLogin"]')?.click(); });

  boot();
})();
