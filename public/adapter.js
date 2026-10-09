/* foûfoûni-Market — relie l'interface au serveur (paiements réels, comptes équipe). */
(function () {
  const api = async (method, url, body) => {
    const r = await fetch(url, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || 'Le serveur ne répond pas.'); e.status = r.status; throw e; }
    return j;
  };
  let me = null, providers = [], configured = {}, pollT = null, loadT = null;
  S.users = [];

  const KEY = 'ffm-my-orders';
  const myOrders = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { return []; } };
  const addMine = (id, t) => { const l = myOrders().filter(x => x.id !== id); l.unshift({ id, t }); try { localStorage.setItem(KEY, JSON.stringify(l.slice(0, 50))); } catch (e) {} };

  async function load() {
    try {
      if (me) {
        const s = await api('GET', '/api/admin/state');
        S.products = s.products; S.bundles = s.bundles || []; S.promos = s.promos;
        S.clients = (s.clients||[]).sort((a,b)=>a.name.localeCompare(b.name)); S.suppliers = (s.suppliers||[]).sort((a,b)=>a.name.localeCompare(b.name));
        S.moves = s.moves || []; S.ledger = s.ledger || []; S.finConfig = s.finConfig || {}; S.orders = s.orders; S.users = s.users;
        S.settings = mergeSettings(s.settings); providers = s.providers; configured = s.configured || {};
      } else {
        const s = await api('GET', '/api/public/catalog');
        S.products = s.products; S.bundles = s.bundles || []; S.settings = mergeSettings(s.settings); providers = s.providers;
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

  /* ---------- démarrage ---------- */
  window.boot = async function () {
    try { me = (await api('GET', '/api/me')).user; } catch (e) { me = null; }
    S.isAdmin = !!me; S.myName = me ? me.name : ''; S.uid = me ? me.id : null; S.live = false;
    try { S.cart = JSON.parse(localStorage.getItem('ffm-cart') || '[]'); } catch (e) {}
    await load(); S.ready = true; schedule();
    clearInterval(pollT); pollT = setInterval(load, me ? 15000 : 60000);
    handleReturn();
  };

  /* ---------- écritures (équipe connectée) ---------- */
  const skip = (col, id) => col === 'promo-lookup' || (col === 'settings' && id === 'team');
  window.put = async (col, id, data) => { if (skip(col, id)) return; await api('PUT', `/api/admin/${col}/${encodeURIComponent(id)}`, data); reload(); };
  window.patch = async (col, id, data) => { if (skip(col, id)) return; await api('PATCH', `/api/admin/${col}/${encodeURIComponent(id)}`, data); reload(); };
  window.del = async (col, id) => { if (skip(col, id)) return; await api('DELETE', `/api/admin/${col}/${encodeURIComponent(id)}`); reload(); };
  window.validatePromo = async (code, subtotal) => { try { return await api('POST', '/api/promo/check', { code, subtotal }); } catch (e) { return { err: e.message }; } };
  window.enabledProcs = () => Object.entries(S.settings.processors).filter(([k, v]) => v.enabled && PROCESSORS[k] && providers.includes(k));

  /* ---------- commande client avec paiement réel ---------- */
  window.coNext = async function () {
    readCO(); const err = $('#co-err');
    if (CO.step === 1 && (!CO.name || CO.phone.replace(/\D/g, '').length < 8)) { err.textContent = 'Indiquez votre nom et un numéro de téléphone valide.'; return; }
    if (CO.step === 2 && CO.delivery === 'livraison' && !CO.address) { err.textContent = 'Indiquez votre adresse ou votre quartier.'; return; }
    if (CO.step < 3) { CO.step++; drawCheckout(); return; }
    if (!CO.method) { err.textContent = 'Choisissez un moyen de paiement.'; return; }
    const btn = document.querySelector('[data-a="coNext"]'); btn.disabled = true; btn.textContent = 'Préparation du paiement…';
    try {
      const r = await api('POST', '/api/orders', {
        items: S.cart.map(l => l.b ? { bundle: l.b, qty: l.qty } : { id: l.id, qty: l.qty }), promoCode: S.appliedPromo ? S.appliedPromo.code : '',
        customer: { name: CO.name, phone: CO.phone, address: CO.address, city: CO.city, note: CO.note },
        delivery: CO.delivery, method: CO.method
      });
      addMine(r.id, r.token);
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
    addMine(id, t); history.replaceState(null, '', location.pathname);
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
    const id = e.target.dataset.srvRole; if (!id) return;
    try { await api('PATCH', `/api/admin/users/${encodeURIComponent(id)}`, { role: e.target.value }); toast('Rôle mis à jour'); load(); } catch (err) { toast(err.message); load(); }
  });
  document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'lg-pw') document.querySelector('[data-srv="doLogin"]')?.click(); });

  boot();
})();
