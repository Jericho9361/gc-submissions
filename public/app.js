/* GC Redemption Portal — app logic (vanilla JS, no build step) */
(function () {
  'use strict';
  const C = window.GC_CONFIG || {};
  const DEMO = !C.API_URL;
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full / blocked */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} }
  };

  /* ------------------------------------------------------------------ state */
  const S = {
    stores: [], area: 'All', q: '',
    store: null, tab: 'new', amt: {}, curAmt: LS.get('gc_cur_amt', 0),
    gcType: null, series: [], images: [], submittedBy: LS.get('gc_by', ''), notes: '',
    showRange: false, busy: false,
    subs: [], subsLoading: false, subsError: '', listQ: '', listType: 'all',
    outbox: [], archive: []
  };

  /* ------------------------------------------------------------- IndexedDB outbox
     Submissions made while offline are kept here (images included) and sent
     automatically once the device is back online. */
  const IDB = {
    _db: null,
    open() {
      if (this._db) return Promise.resolve(this._db);
      return new Promise((res, rej) => {
        if (!('indexedDB' in window)) return rej(new Error('IndexedDB unavailable'));
        const r = indexedDB.open('gc-portal', 2);
        r.onupgradeneeded = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'clientId' });
          if (!db.objectStoreNames.contains('archive')) db.createObjectStore('archive', { keyPath: 'clientId' });
        };
        r.onsuccess = () => { this._db = r.result; res(this._db); };
        r.onerror = () => rej(r.error);
      });
    }
  };
  function idbStore(name) {
    const tx = async (mode, fn) => {
      const db = await IDB.open();
      return new Promise((res, rej) => {
        const t = db.transaction(name, mode); const out = fn(t.objectStore(name));
        t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
        t.onerror = () => rej(t.error);
      });
    };
    return {
      all() { return tx('readonly', (s) => s.getAll()).then((r) => r || []).catch(() => []); },
      put(item) { return tx('readwrite', (s) => s.put(item)); },
      del(id) { return tx('readwrite', (s) => s.delete(id)); },
      clear() { return tx('readwrite', (s) => s.clear()); }
    };
  }
  const DB = idbStore('outbox');   // waiting to be sent
  const ARC = idbStore('archive'); // device copy of every sent submission (with photos)

  /* -------------------------------------------------------------------- API */
  function apiError(msg, code, extra) { const e = new Error(msg); e.api = true; e.code = code; Object.assign(e, extra || {}); return e; }

  async function apiGet(params) {
    if (DEMO) return Demo.get(params);
    const r = await fetch(C.API_URL + '?' + new URLSearchParams(params), { method: 'GET', redirect: 'follow' });
    let j; try { j = await r.json(); } catch (e) { throw apiError('Unexpected server response. Check the Web App deployment (access must be "Anyone").', 'BAD_RESPONSE'); }
    if (!j.ok) throw apiError(j.error || 'Request failed', j.code, j);
    return j;
  }
  async function apiPost(body) {
    if (DEMO) return Demo.post(body);
    // No Content-Type header → "simple" request, so Apps Script doesn't need a CORS preflight.
    const r = await fetch(C.API_URL, { method: 'POST', body: JSON.stringify(body), redirect: 'follow' });
    let j; try { j = await r.json(); } catch (e) { throw apiError('Unexpected server response. Check the Web App deployment (access must be "Anyone").', 'BAD_RESPONSE'); }
    if (!j.ok) throw apiError(j.error || 'Request failed', j.code, j);
    return j;
  }

  /* ------------------------------------------------- Demo backend (no API_URL) */
  const Demo = {
    db() { return LS.get('gc_demo_db', { subs: [], seq: {} }); },
    save(d) { LS.set('gc_demo_db', d); },
    async get(p) {
      await sleep(250);
      if (p.action === 'stores') return { ok: true, stores: C.FALLBACK_STORES || [] };
      if (p.action === 'verify') return { ok: true };
      if (p.action === 'list') return { ok: true, submissions: this.db().subs.filter((s) => s.storeCode === p.store).sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)) };
      return { ok: true };
    },
    async post(b) {
      await sleep(700);
      const d = this.db();
      if (b.action === 'delete') {
        if ((await sha256(String(b.password || '').trim().toUpperCase())) !== String(C.MONITORING_PASS_SHA256).toLowerCase()) throw apiError('Incorrect password.', 'BADPASS');
        d.subs = d.subs.filter((x) => !(x.ticketId === b.ticketId && x.storeCode === b.store)); this.save(d);
        return { ok: true, deleted: b.ticketId };
      }
      const exist = d.subs.find((s) => s.clientId === b.clientId);
      if (exist) return { ok: true, submission: exist };
      const used = new Map();
      d.subs.filter((s) => s.gcType === b.gcType).forEach((s) => s.series.forEach((x) => used.set(x, s.ticketId + ' (' + s.storeName + ')')));
      const dups = b.series.filter((x) => used.has(x));
      if (dups.length) throw apiError('These series numbers were already submitted: ' + dups.map((x) => x + ' → ' + used.get(x)).join('; '), 'DUPLICATE', { duplicates: dups.map((x) => ({ series: x, ticket: used.get(x) })) });
      const st = S.stores.find((s) => s.code === b.store) || {};
      const now = new Date(); const day = ymd(now);
      d.seq[day] = (d.seq[day] || 0) + 1;
      const sub = {
        ticketId: 'GC-' + day.slice(2) + '-' + String(d.seq[day]).padStart(4, '0'),
        submittedAt: now.toISOString(), storeCode: b.store, storeName: st.name || b.store, area: st.area || '',
        gcType: b.gcType, series: b.series, amounts: b.amounts || [], totalAmount: b.totalAmount || 0, count: b.series.length, submittedBy: b.submittedBy, notes: b.notes,
        images: b.images.map((im) => im.dataUrl.length < 180000 ? im.dataUrl : ''), imageCount: b.images.length,
        remarks: 'Submitted', emailStatus: 'Demo — not sent', clientId: b.clientId
      };
      d.subs.push(sub);
      try { this.save(d); } catch (e) { sub.images = []; this.save(d); }
      return { ok: true, submission: sub };
    }
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ymd = (d) => d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');

  /* ---------------------------------------------------------------- helpers */
  function fmtDate(iso) {
    const d = new Date(iso); if (isNaN(d)) return esc(iso);
    return d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) + ' · ' + d.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });
  }
  function initials(name) { return String(name || '?').replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase(); }
  function typePill(t) { return '<span class="pill ' + (/pluxee|sodexo/i.test(t) ? 'pluxee' : 'tobys') + '">' + esc(t) + '</span>'; }
  function remarksPill(r) {
    const v = String(r || 'Submitted');
    let cls = 'info';
    if (/^submitted$/i.test(v)) cls = 'ok';
    else if (/pending|sync|queue/i.test(v)) cls = 'pend';
    else if (/fail|reject|invalid|error/i.test(v)) cls = 'err';
    else if (/verified|received|approved|done|complete/i.test(v)) cls = 'ok';
    return '<span class="pill ' + cls + '">' + esc(v) + '</span>';
  }
  function toast(msg, ms = 2600) {
    const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }
  const DENOMS = () => (C.GC_AMOUNTS || [100, 200, 300, 500, 1000]);
  const peso = (n) => '₱' + Number(n || 0).toLocaleString('en-PH');
  const amountsOf = (s) => (s.amounts || []).map(Number);
  const totalOf = (s) => (+s.totalAmount) || amountsOf(s).reduce((a, b) => a + (b || 0), 0);
  function formTotal() { return S.series.reduce((t, x) => t + (+S.amt[x] || 0), 0); }
  function normSeries(s) { return String(s || '').trim().toUpperCase().replace(/\s+/g, ''); }
  function pinFor(code) { return LS.get('gc_pin_' + code, ''); }

  /* ----------------------------------------------------------------- modals */
  function modal(html, { onMount, dismiss = true } = {}) {
    const root = $('#modalRoot');
    root.innerHTML = '<div class="scrim"><div class="sheet" role="dialog" aria-modal="true">' + html + '</div></div>';
    const scrim = root.firstChild;
    if (dismiss) scrim.addEventListener('click', (e) => { if (e.target === scrim) closeModal(); });
    if (onMount) onMount(scrim.firstChild);
    return scrim.firstChild;
  }
  function closeModal() { $('#modalRoot').innerHTML = ''; }

  /* -------------------------------------------------------------- top chrome */
  function setNet() {
    const p = $('#netPill');
    if (DEMO) { p.textContent = 'Demo'; p.title = 'Demo mode'; p.className = 'net demo'; }
    else if (!navigator.onLine) { p.textContent = 'Offline'; p.className = 'net off'; }
    else { p.textContent = 'Online'; p.className = 'net'; }
  }
  function setHeader() {
    $('#banner').innerHTML = DEMO
      ? '<div class="banner"><b>Demo mode.</b> Not connected yet — submissions stay on this device and no email is sent. Add the Web App URL in <code>config.js</code> to go live.</div>'
      : '';
    renderSidebar();
  }

  /* --------------------------------------------------------------- sidebar */
  // "Central" → "Central Area"; "Franchise" → "Franchise Store"
  function areaLabel(a) {
    a = String(a || '').trim();
    if (/franchise/i.test(a)) return 'Franchise Store';
    if (/\b(area|stores?)$/i.test(a)) return a;
    return a + ' Area';
  }
  function areaGroups(list) {
    const order = ['CENTRAL', 'NORTH', 'SOUTH', 'FRANCHISE'];
    const groups = {};
    list.forEach((s) => { const k = (s.area || 'Other').trim(); (groups[k] = groups[k] || []).push(s); });
    return Object.keys(groups).sort((x, y) => {
      const ix = order.indexOf(x.toUpperCase()), iy = order.indexOf(y.toUpperCase());
      return (ix < 0 ? 99 : ix) - (iy < 0 ? 99 : iy) || x.localeCompare(y);
    }).map((k) => ({ area: k, stores: groups[k].sort((p, q) => p.name.localeCompare(q.name)) }));
  }
  function renderSidebar() {
    const side = $('#side'); if (!side) return;
    const q = S.q.trim().toLowerCase();
    const list = S.stores.filter((s) => !q || (s.name + ' ' + s.code + ' ' + (s.area || '')).toLowerCase().includes(q));
    const closed = LS.get('gc_closed_areas', {});
    const groups = areaGroups(list);
    const keep = document.activeElement && document.activeElement.id === 'storeQ' ? document.activeElement.selectionStart : null;
    const scroll = $('.side-scroll', side) ? $('.side-scroll', side).scrollTop : 0;
    side.innerHTML =
      '<div class="side-head"><div class="side-label">STORE TABS</div><div class="side-search">' +
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>' +
      '<input id="storeQ" type="search" placeholder="Search store…" value="' + esc(S.q) + '" autocomplete="off"></div></div>' +
      '<button class="side-home ' + (S.store ? '' : 'on') + '" id="sideHome"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>Home</button>' +
      '<div class="side-scroll">' +
      (groups.length ? groups.map((g) => {
        const isClosed = !q && closed[g.area];
        return '<div class="area ' + (isClosed ? 'closed' : '') + '"><button class="area-h" data-area-t="' + esc(g.area) + '"><b>— ' + esc(areaLabel(g.area).toUpperCase()) + ' —</b>' +
          '<span class="cnt">' + g.stores.length + '</span>' +
          '<svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><path d="M6 9l6 6 6-6"/></svg></button>' +
          '<div class="area-list">' + g.stores.map((s) =>
            '<button class="st ' + (S.store && S.store.code === s.code ? 'on' : '') + '" data-code="' + esc(s.code) + '"><span class="dot"></span><span class="nm">' + esc(s.name) + '</span><small>' + esc(s.code) + (s.hasPin ? ' 🔒' : '') + '</small></button>').join('') +
          '</div></div>';
      }).join('') : '<div class="side-empty">' + (S.stores.length ? 'No store matches “' + esc(S.q) + '”.' : 'No stores yet. Add them in the “Stores” tab of the Google Sheet.') + '</div>') +
      '</div>' +
      '<div class="side-foot">' + (C.MONITORING_SHEET_URL ? '<button class="fd-btn" id="fdSheet"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/></svg><span><b>Open Monitoring Sheet</b><small>🔒 Franchise Dev only</small></span></button>' : '') +
      'Submissions are emailed to<br><b>' + esc(C.EMAIL_TO || '') + '</b></div>';
    $('.side-scroll', side).scrollTop = scroll;
    side.querySelectorAll('[data-code]').forEach((b) => b.onclick = () => { closeSide(); go('#/store/' + encodeURIComponent(b.dataset.code) + '/new'); });
    side.querySelectorAll('[data-area-t]').forEach((b) => b.onclick = () => {
      const c = LS.get('gc_closed_areas', {}); c[b.dataset.areaT] = !c[b.dataset.areaT]; LS.set('gc_closed_areas', c); renderSidebar();
    });
    $('#sideHome', side).onclick = () => { closeSide(); go('#/'); };
    const fd = $('#fdSheet', side); if (fd) fd.onclick = () => { closeSide(); openMonitoring(); };
    const qi = $('#storeQ', side);
    qi.oninput = () => { S.q = qi.value; renderSidebar(); };
    if (keep !== null) { qi.focus(); qi.setSelectionRange(keep, keep); }
  }
  /* -------------------------------------------- Franchise Dev monitoring sheet */
  async function sha256(t) {
    if (window.crypto && crypto.subtle) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
      return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    return null;
  }
  function openMonitoring() {
    modal(
      '<div class="center"><div class="big-ok" style="font-size:26px">🔒</div><h3>Open Monitoring Sheet</h3><p class="sub">For Franchise Development only. Enter the password to continue.</p></div>' +
      '<input class="pin-input" id="fdPass" type="password" autocomplete="off" autocapitalize="characters" placeholder="Password" style="letter-spacing:3px;font-size:20px">' +
      '<p class="helper" id="fdErr" style="color:var(--err);min-height:18px;text-align:center"></p>' +
      '<div class="sheet-actions"><button class="btn ghost" id="fdCancel">Cancel</button><button class="btn" id="fdGo">Open sheet</button></div>',
      {
        onMount(el) {
          const inp = $('#fdPass', el); setTimeout(() => inp.focus(), 50);
          const go2 = async () => {
            const v = inp.value.trim().toUpperCase(); if (!v) return;
            const h = await sha256(v);
            if (h === null) { $('#fdErr', el).textContent = 'This browser can’t check the password. Use Chrome, Edge or Safari over https.'; return; }
            if (h !== String(C.MONITORING_PASS_SHA256).toLowerCase()) { $('#fdErr', el).textContent = 'Incorrect password.'; inp.select(); return; }
            closeModal();
            const w = window.open(C.MONITORING_SHEET_URL, '_blank');
            if (w) { try { w.opener = null; } catch (e) {} }
            else location.href = C.MONITORING_SHEET_URL; // popup blocked → open in the same window
          };
          $('#fdGo', el).onclick = go2;
          inp.onkeydown = (e) => { if (e.key === 'Enter') go2(); };
          $('#fdCancel', el).onclick = closeModal;
        }
      }
    );
  }
  function openSide() { document.body.classList.add('side-open'); }
  function closeSide() { document.body.classList.remove('side-open'); }

  /* ---------------------------------------------------------------- routing */
  function route() {
    const m = location.hash.match(/^#\/store\/([^/]+)(?:\/(new|list))?/);
    if (m) {
      const code = decodeURIComponent(m[1]);
      const st = S.stores.find((s) => s.code === code);
      if (!st) { location.hash = '#/'; return; }
      const changed = !S.store || S.store.code !== st.code;
      if (changed) {
        if (st.hasPin && !pinFor(st.code)) { askPin(st); return; }
        S.store = st; resetForm(); S.subs = []; S.subsError = '';
        LS.set('gc_last_store', st.code);
        loadSubs();
      }
      S.tab = m[2] === 'list' ? 'list' : 'new';
    } else {
      S.store = null;
    }
    render();
    window.scrollTo(0, 0);
  }
  function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }

  /* ------------------------------------------------------------------- PIN */
  function askPin(st) {
    modal(
      '<h3>' + esc(st.name) + '</h3><p class="sub">Enter the store PIN to open this tab.</p>' +
      '<input class="pin-input" id="pinIn" inputmode="numeric" autocomplete="off" maxlength="8" placeholder="••••">' +
      '<p class="helper" id="pinErr" style="color:var(--err);min-height:18px"></p>' +
      '<div class="sheet-actions"><button class="btn ghost" id="pinCancel">Cancel</button><button class="btn" id="pinOk">Open</button></div>',
      {
        dismiss: false,
        onMount(el) {
          const inp = $('#pinIn', el); setTimeout(() => inp.focus(), 50);
          const submit = async () => {
            const pin = inp.value.trim(); if (!pin) return;
            const b = $('#pinOk', el); b.disabled = true; b.innerHTML = '<span class="spinner"></span>Checking';
            try {
              await apiGet({ action: 'verify', store: st.code, pin });
              LS.set('gc_pin_' + st.code, pin); closeModal(); route();
            } catch (e) {
              b.disabled = false; b.textContent = 'Open';
              $('#pinErr', el).textContent = e.api ? e.message : 'Can’t verify while offline. Connect and try again.';
            }
          };
          $('#pinOk', el).onclick = submit;
          inp.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
          $('#pinCancel', el).onclick = () => { closeModal(); location.hash = '#/'; };
        }
      }
    );
  }

  /* ---------------------------------------------------------------- render */
  function render() {
    setHeader(); setNet();
    if (!S.store) { renderHome(); $('#submitbar').innerHTML = ''; return; }
    const app = $('#app');
    const pending = S.outbox.filter((o) => o.store === S.store.code).length;
    const n = S.subs.length + pending;
    app.innerHTML =
      '<div class="page-h"><div class="ttl"><h1>' + esc(S.store.name) + '</h1><p>Branch: ' + esc([S.store.code, S.store.area ? areaLabel(S.store.area) : ''].filter(Boolean).join(' — ')) + ' · Redeemed GC submissions</p></div></div>' +
      '<div class="seg" role="tablist">' +
      '<button role="tab" class="' + (S.tab === 'new' ? 'on' : '') + '" data-tab="new">New Submission</button>' +
      '<button role="tab" class="' + (S.tab === 'list' ? 'on' : '') + '" data-tab="list">My Submissions' + (n ? '<span class="count">' + n + '</span>' : '') + '</button>' +
      '</div><div id="pane"></div>';
    app.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => go('#/store/' + encodeURIComponent(S.store.code) + '/' + b.dataset.tab));
    if (S.tab === 'new') renderForm(); else renderList();
  }

  function renderHome() {
    const app = $('#app');
    const last = S.stores.find((s) => s.code === LS.get('gc_last_store', ''));
    const areas = areaGroups(S.stores);
    app.innerHTML =
      '<div class="page-h"><div class="ttl"><h1>GC Management Portal</h1><p>' + esc(C.COMPANY || "Toby's Sports") + ' · Franchise Development</p></div></div>' +
      '<div class="welcome"><h1>Welcome! Select your store tab.</h1><p>Choose your store from the store tabs on the left to submit redeemed TOBYS GC and Sodexo Pluxee gift certificates and to view your store’s submission records.</p>' +
      '<button class="btn" id="openStores" style="display:none">Choose my store</button></div>' +
      (last ? '<button class="continue" data-code="' + esc(last.code) + '"><div class="store-ava">' + esc(initials(last.name)) + '</div><div style="flex:1"><small>Continue as</small><b>' + esc(last.name) + '</b></div><span aria-hidden="true" style="color:var(--blue-700);font-size:20px">›</span></button>' : '') +
      '<div class="steps3">' +
      '<div class="step3"><i>1</i><b>Select GC type</b><small>TOBYS GC or Sodexo Pluxee</small></div>' +
      '<div class="step3"><i>2</i><b>Enter series numbers</b><small>Type, scan, paste a list or add a range</small></div>' +
      '<div class="step3"><i>3</i><b>Attach GC images</b><small>Submit — Franchise Dev is emailed automatically</small></div></div>' +
      (areas.length ? '<div class="stats" style="margin-top:14px">' + areas.slice(0, 4).map((g) => '<div class="stat"><b>' + g.stores.length + '</b><small>' + esc(/franchise/i.test(g.area) ? 'Franchise Stores' : areaLabel(g.area) + ' stores') + '</small></div>').join('') + '</div>' : '');
    const ob = $('#openStores');
    if (window.matchMedia('(max-width:900px)').matches) { ob.style.display = 'inline-block'; ob.onclick = openSide; }
    app.querySelectorAll('[data-code]').forEach((b) => b.onclick = () => go('#/store/' + encodeURIComponent(b.dataset.code) + '/new'));
  }

  /* ------------------------------------------------------------------ form */
  function resetForm() { S.gcType = null; S.series = []; S.amt = {}; S.images = []; S.notes = ''; S.showRange = false; }

  function renderForm() {
    const pane = $('#pane');
    const types = C.GC_TYPES || [];
    pane.innerHTML = '<div class="form-grid">' +
      // Step 1
      '<section class="card span2"><div class="step-h"><span class="step-n ' + (S.gcType ? 'done' : '') + '">' + (S.gcType ? '✓' : '1') + '</span><h2>GC type</h2></div>' +
      '<div class="types">' + types.map((t) => '<button class="type ' + (S.gcType === t.id ? 'on' : '') + '" data-type="' + esc(t.id) + '"><b><span class="dot" style="background:' + (/pluxee|sodexo/i.test(t.id) ? 'var(--silver-500)' : 'var(--blue-600)') + '"></span>' + esc(t.label) + '</b><small>' + esc(t.hint || '') + '</small></button>').join('') + '</div></section>' +
      // Step 2
      '<section class="card"><div class="step-h"><span class="step-n ' + (S.series.length ? 'done' : '') + '">' + (S.series.length ? '✓' : '2') + '</span><h2>Series numbers & amount</h2><span class="meta">' + S.series.length + ' GC' + (S.series.length === 1 ? '' : 's') + (formTotal() ? ' · <b style="color:var(--blue-800)">' + peso(formTotal()) + '</b>' : '') + '</span></div>' +
      '<div class="amt-row"><span class="amt-lbl">GC amount</span>' + DENOMS().map((d) => '<button class="amt ' + (S.curAmt === d ? 'on' : '') + '" data-amt="' + d + '">' + peso(d) + '</button>').join('') + '</div>' +
      '<p class="helper" style="margin:-4px 0 10px">' + (S.curAmt ? 'Series you add now will be tagged <b>' + peso(S.curAmt) + '</b>. Change the amount anytime before adding more.' : '<b style="color:var(--err)">Select the GC amount first</b>, then enter the series numbers.') + '</p>' +
      '<div class="series-entry"><input id="serIn" placeholder="Type or scan series no." autocomplete="off" autocapitalize="characters" enterkeyhint="done"><button class="btn" id="serAdd">Add</button></div>' +
      '<p class="helper">Press Enter after each one. You can also paste a list (one per line or comma-separated). <button class="linkish" id="rangeToggle">' + (S.showRange ? 'Hide range' : 'Add a consecutive range') + '</button></p>' +
      (S.showRange ? '<div class="range"><input id="rFrom" placeholder="From e.g. TG000101"><input id="rTo" placeholder="To e.g. TG000110"><button class="btn sm" id="rAdd">Add range</button></div>' : '') +
      '<div class="series-list" id="serList">' + S.series.map((s, i) => '<span class="sc">' + esc(s) +
        '<select class="sc-amt" data-setamt="' + i + '" aria-label="Amount for ' + esc(s) + '">' + DENOMS().map((d) => '<option value="' + d + '"' + (+S.amt[s] === d ? ' selected' : '') + '>' + peso(d) + '</option>').join('') + '</select>' +
        '<button aria-label="Remove ' + esc(s) + '" data-rm="' + i + '">×</button></span>').join('') + '</div>' +
      (S.series.length ? '<div class="amt-sum">' + amountSummary(S.series.map((x) => +S.amt[x])) + '</div>' : '') +
      (S.series.length > 1 ? '<div class="series-tools"><span class="helper" style="margin:0">Tap the amount to change it, × to remove.</span><button class="linkish" id="serClear">Clear all</button></div>' : '') +
      '</section>' +
      // Step 3
      '<section class="card"><div class="step-h"><span class="step-n ' + (S.images.length ? 'done' : '') + '">' + (S.images.length ? '✓' : '3') + '</span><h2>GC images</h2><span class="meta">' + S.images.length + ' / ' + (C.MAX_IMAGES || 10) + '</span></div>' +
      '<div class="drop"><button class="pick" id="pickCam"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>Take photo<small>Use camera</small></button>' +
      '<button class="pick" id="pickGal"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/></svg>Attach images<small>From gallery / files</small></button></div>' +
      '<div class="thumbs">' + S.images.map((im, i) => '<div class="thumb"><img src="' + im.dataUrl + '" alt="GC image ' + (i + 1) + '"><button aria-label="Remove image" data-rmimg="' + i + '">×</button><span>' + Math.round(im.size / 1024) + ' KB</span></div>').join('') + '</div>' +
      '<p class="helper">Photograph the front of each redeemed GC so the series number is readable. Several GCs can be in one photo.</p></section>' +
      // Details
      '<section class="card span2"><div class="field"><label for="byIn">Submitted by <em>(optional)</em></label><input id="byIn" placeholder="Name of cashier / staff" value="' + esc(S.submittedBy) + '"></div>' +
      '<div class="field" style="margin:0"><label for="noteIn">Notes <em>(optional)</em></label><textarea id="noteIn" placeholder="e.g. OR / transaction no., customer name">' + esc(S.notes) + '</textarea></div></section></div>';

    pane.querySelectorAll('[data-type]').forEach((b) => b.onclick = () => { S.gcType = b.dataset.type; renderForm(); });
    const inp = $('#serIn');
    const addFromInput = () => { if (!S.curAmt) { addSeries(inp.value); inp.focus(); return; } addSeries(inp.value); inp.value = ''; renderForm(); $('#serIn').focus(); };
    $('#serAdd').onclick = addFromInput;
    inp.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addFromInput(); } };
    inp.onpaste = (e) => {
      const t = (e.clipboardData || window.clipboardData).getData('text');
      if (/[\n,;\t]/.test(t)) { e.preventDefault(); addSeries(t); renderForm(); $('#serIn').focus(); }
    };
    $('#rangeToggle').onclick = () => { S.showRange = !S.showRange; renderForm(); };
    if (S.showRange) $('#rAdd').onclick = () => { if (addRange($('#rFrom').value, $('#rTo').value)) { S.showRange = false; renderForm(); } };
    pane.querySelectorAll('[data-rm]').forEach((b) => b.onclick = () => { const x = S.series.splice(+b.dataset.rm, 1)[0]; delete S.amt[x]; renderForm(); });
    pane.querySelectorAll('[data-amt]').forEach((b) => b.onclick = () => { S.curAmt = +b.dataset.amt; LS.set('gc_cur_amt', S.curAmt); renderForm(); const i = $('#serIn'); if (i) i.focus(); });
    pane.querySelectorAll('[data-setamt]').forEach((sel) => sel.onchange = () => { S.amt[S.series[+sel.dataset.setamt]] = +sel.value; renderForm(); });
    const clr = $('#serClear'); if (clr) clr.onclick = () => { if (confirm('Remove all ' + S.series.length + ' series numbers?')) { S.series = []; S.amt = {}; renderForm(); } };
    $('#pickCam').onclick = () => $('#fileCamera').click();
    $('#pickGal').onclick = () => $('#fileGallery').click();
    pane.querySelectorAll('[data-rmimg]').forEach((b) => b.onclick = () => { S.images.splice(+b.dataset.rmimg, 1); renderForm(); });
    $('#byIn').oninput = (e) => { S.submittedBy = e.target.value; LS.set('gc_by', S.submittedBy); };
    $('#noteIn').oninput = (e) => { S.notes = e.target.value; };
    renderSubmitBar();
  }

  function addSeries(text) {
    if (!S.curAmt) { if (String(text || '').trim()) toast('Select the GC amount (₱100–₱1,000) first.'); return 0; }
    const parts = String(text || '').split(/[\n,;\t]+|\s{2,}/).map(normSeries).filter(Boolean);
    let added = 0, dup = 0;
    const max = C.MAX_SERIES || 500;
    for (const p of parts) {
      if (S.series.includes(p)) { dup++; continue; }
      if (S.series.length >= max) { toast('Maximum of ' + max + ' series per submission.'); break; }
      S.series.push(p); S.amt[p] = S.curAmt; added++;
    }
    if (dup) toast(dup + ' duplicate' + (dup > 1 ? 's' : '') + ' skipped — already in the list.');
    else if (added > 1) toast(added + ' series numbers added.');
    return added;
  }

  function addRange(a, b) {
    a = normSeries(a); b = normSeries(b);
    const ma = a.match(/^(.*?)(\d+)$/), mb = b.match(/^(.*?)(\d+)$/);
    if (!ma || !mb) { toast('Both ends must end in digits, e.g. TG000101 to TG000110.'); return false; }
    if (ma[1] !== mb[1]) { toast('The prefix must be the same on both ends.'); return false; }
    const from = parseInt(ma[2], 10), to = parseInt(mb[2], 10);
    if (to < from) { toast('“To” must be greater than “From”.'); return false; }
    const n = to - from + 1;
    if (n > 200) { toast('A range can have at most 200 numbers.'); return false; }
    const width = ma[2].length; const list = [];
    for (let i = from; i <= to; i++) list.push(ma[1] + String(i).padStart(width, '0'));
    if (!S.curAmt) { toast('Select the GC amount (₱100–₱1,000) first.'); return false; }
    addSeries(list.join('\n'));
    return true;
  }

  async function handleFiles(files) {
    const max = C.MAX_IMAGES || 10;
    const arr = Array.from(files || []).filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|heic|heif|webp)$/i.test(f.name));
    if (!arr.length) return;
    let room = max - S.images.length;
    if (room <= 0) { toast('Maximum of ' + max + ' images.'); return; }
    if (arr.length > room) toast('Only ' + room + ' more image' + (room > 1 ? 's' : '') + ' allowed — extra files skipped.');
    toast('Preparing image' + (arr.length > 1 ? 's' : '') + '…', 1200);
    for (const f of arr.slice(0, room)) {
      try {
        const dataUrl = await compress(f);
        S.images.push({ id: uid(), name: f.name, dataUrl, size: Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75) });
      } catch (e) { toast('Couldn’t read ' + f.name + '. Try a JPG or PNG.'); }
    }
    if (S.store && S.tab === 'new') renderForm();
  }

  function compress(file) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const maxPx = C.IMAGE_MAX_PX || 1600;
        let w = img.naturalWidth, h = img.naturalHeight;
        const k = Math.min(1, maxPx / Math.max(w, h)); w = Math.round(w * k); h = Math.round(h * k);
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        res(c.toDataURL('image/jpeg', C.IMAGE_QUALITY || 0.78));
      };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('decode')); };
      img.src = url;
    });
  }

  function amountSummary(arr) {
    const by = {}; arr.forEach((a) => { if (a) by[a] = (by[a] || 0) + 1; });
    const parts = Object.keys(by).map(Number).sort((a, b) => a - b).map((d) => by[d] + ' × ' + peso(d));
    return parts.join(' · ') + (parts.length ? ' = <b>' + peso(arr.reduce((t, a) => t + (a || 0), 0)) + '</b>' : '');
  }
  function renderSubmitBar() {
    const bar = $('#submitbar');
    if (!S.store || S.tab !== 'new') { bar.innerHTML = ''; return; }
    const missing = [];
    if (!S.gcType) missing.push('GC type');
    if (!S.series.length) missing.push('series no.');
    else if (S.series.some((x) => !S.amt[x])) missing.push('GC amount');
    if (!S.images.length) missing.push('images');
    bar.innerHTML = '<div class="submitbar"><div class="submitbar-inner"><div class="sum">' +
      (missing.length ? '<b>Still needed</b>' + esc(missing.join(', ')) : '<b>Ready to submit · ' + peso(formTotal()) + '</b>' + esc(S.gcType) + ' · ' + S.series.length + ' GC' + (S.series.length > 1 ? 's' : '') + ' · ' + S.images.length + ' image' + (S.images.length > 1 ? 's' : '')) +
      '</div><button class="btn accent" id="submitBtn" ' + (missing.length || S.busy ? 'disabled' : '') + '>' + (S.busy ? '<span class="spinner"></span>Sending…' : 'Submit') + '</button></div></div>';
    $('#submitBtn').onclick = confirmSubmit;
  }

  function confirmSubmit() {
    modal(
      '<h3>Submit to Franchise Dev?</h3><p class="sub">This will be emailed to <b>' + esc(C.EMAIL_TO) + '</b> with the attached images.</p>' +
      '<dl class="kv"><dt>Store</dt><dd>' + esc(S.store.name) + '</dd><dt>GC type</dt><dd>' + typePill(S.gcType) + '</dd><dt>Series</dt><dd>' + S.series.length + ' GC' + (S.series.length > 1 ? 's' : '') + '</dd><dt>Total amount</dt><dd style="color:var(--blue-800);font-size:16px">' + peso(formTotal()) + '</dd><dt>Images</dt><dd>' + S.images.length + '</dd>' +
      (S.submittedBy ? '<dt>By</dt><dd>' + esc(S.submittedBy) + '</dd>' : '') + '</dl>' +
      '<div class="mono-box">' + S.series.map((x) => esc(x) + '  —  ' + peso(S.amt[x])).join('\n') + '</div>' +
      '<div class="sheet-actions"><button class="btn ghost" id="cBack">Edit</button><button class="btn accent" id="cGo">Confirm & submit</button></div>',
      { onMount(el) { $('#cBack', el).onclick = closeModal; $('#cGo', el).onclick = () => { closeModal(); doSubmit(); }; } }
    );
  }

  async function doSubmit() {
    if (S.busy) return;
    const payload = {
      action: 'submit', clientId: uid(), store: S.store.code, pin: pinFor(S.store.code),
      gcType: S.gcType, series: S.series.slice(), amounts: S.series.map((x) => +S.amt[x]), totalAmount: formTotal(), submittedBy: S.submittedBy.trim(), notes: S.notes.trim(),
      images: S.images.map((im, i) => ({ name: 'GC_' + (i + 1) + '.jpg', dataUrl: im.dataUrl })),
      createdAt: new Date().toISOString(), storeName: S.store.name
    };
    S.busy = true; renderSubmitBar();
    try {
      if (!DEMO && !navigator.onLine) throw new TypeError('offline');
      const r = await apiPost(payload);
      S.busy = false; resetForm();
      await archiveSave(payload, r.submission);
      S.subs.unshift(r.submission); dedupeSubs(); mergeArchive(payload.store);
      renderForm(); showSuccess(r.submission);
      loadSubs(true);
    } catch (e) {
      S.busy = false;
      if (e.api) { renderSubmitBar(); showError(e); return; }
      // network problem → keep it in the outbox and send automatically later
      try {
        await DB.put(Object.assign({}, payload, { status: 'Pending sync', error: '' }));
        await refreshOutbox(); requestPersist(); updateStorage();
        resetForm(); renderForm(); showQueued();
      } catch (e2) { renderSubmitBar(); showError(apiError('No connection, and this device couldn’t save the submission for later. Please try again when online.')); }
    }
  }

  function showSuccess(sub) {
    modal(
      '<div class="center"><div class="big-ok">✓</div><h3>Submitted</h3><p class="sub">Sent to ' + esc(C.EMAIL_TO) + (DEMO ? ' (demo — no email sent)' : '') + '</p></div>' +
      '<dl class="kv"><dt>Ticket no.</dt><dd style="font-family:ui-monospace,Menlo,monospace">' + esc(sub.ticketId) + '</dd><dt>GC type</dt><dd>' + typePill(sub.gcType) + '</dd><dt>Series</dt><dd>' + esc(sub.count || (sub.series || []).length) + ' GC(s)</dd>' + (totalOf(sub) ? '<dt>Total amount</dt><dd>' + peso(totalOf(sub)) + '</dd>' : '') + '<dt>Remarks</dt><dd>' + remarksPill(sub.remarks) + '</dd></dl>' +
      '<div class="sheet-actions"><button class="btn ghost" id="sNew">New submission</button><button class="btn" id="sList">View my submissions</button></div>',
      { onMount(el) { $('#sNew', el).onclick = closeModal; $('#sList', el).onclick = () => { closeModal(); go('#/store/' + encodeURIComponent(S.store.code) + '/list'); }; } }
    );
  }
  function showQueued() {
    modal(
      '<div class="center"><div class="big-warn">⟳</div><h3>Saved — will send automatically</h3><p class="sub">No internet right now. This submission is saved on this device and will be emailed to Franchise Dev as soon as you’re back online. Keep the app installed and don’t clear browser data.</p></div>' +
      '<div class="sheet-actions"><button class="btn" id="qOk">OK</button></div>',
      { onMount(el) { $('#qOk', el).onclick = closeModal; } }
    );
  }
  function showError(e) {
    let body = '<p class="sub">' + esc(e.message) + '</p>';
    if (e.code === 'DUPLICATE' && e.duplicates) {
      body = '<p class="sub">These series numbers were already submitted before, so nothing was sent. Remove them and submit again.</p><div class="mono-box">' +
        e.duplicates.map((d) => esc(d.series) + '  →  ' + esc(d.ticket)).join('\n') + '</div>';
    }
    modal(
      '<h3>' + (e.code === 'DUPLICATE' ? 'Already submitted' : 'Couldn’t submit') + '</h3>' + body +
      '<div class="sheet-actions">' + (e.code === 'DUPLICATE' ? '<button class="btn ghost" id="eRm">Remove duplicates</button>' : '') + '<button class="btn" id="eOk">OK</button></div>',
      {
        onMount(el) {
          $('#eOk', el).onclick = closeModal;
          const rm = $('#eRm', el);
          if (rm) rm.onclick = () => { const set = new Set(e.duplicates.map((d) => d.series)); S.series = S.series.filter((s) => !set.has(s)); closeModal(); renderForm(); };
          if (e.code === 'PIN') { LS.del('gc_pin_' + S.store.code); }
        }
      }
    );
  }

  /* ------------------------------------------------------------- submissions */
  function dedupeSubs() {
    const seen = new Set();
    S.subs = S.subs.filter((s) => { const k = s.ticketId; if (seen.has(k)) return false; seen.add(k); return true; });
  }
  function cacheKey() { return 'gc_cache_' + (S.store ? S.store.code : ''); }

  async function loadSubs(silent) {
    if (!S.store) return;
    const code = S.store.code;
    if (!S.subs.length) { S.subs = LS.get(cacheKey(), []); mergeArchive(code); }
    S.subsLoading = !silent && !S.subs.length; S.subsError = '';
    if (S.tab === 'list') renderList();
    try {
      const r = await apiGet({ action: 'list', store: code, pin: pinFor(code) });
      if (!S.store || S.store.code !== code) return;
      S.subs = r.submissions || [];
      LS.set(cacheKey(), S.subs.map((s) => Object.assign({}, s, { images: (s.images || []).filter((u) => !/^data:/.test(u)) })));
      mergeArchive(code);
    } catch (e) {
      if (e.code === 'PIN') { LS.del('gc_pin_' + code); S.store = null; askPin(S.stores.find((s) => s.code === code)); return; }
      S.subsError = e.api ? e.message : (navigator.onLine ? 'Couldn’t reach the server — showing records saved on this device.' : 'Offline — showing records saved on this device.');
      mergeArchive(code);
    }
    S.subsLoading = false;
    if (S.store && S.store.code === code) refreshView();
  }

  // Re-render without wiping what the cashier is typing on the form tab
  function refreshView() {
    if (!S.store) return;
    if (S.tab === 'list') { render(); return; }
    const btn = document.querySelector('[data-tab="list"]'); if (!btn) return;
    const n = S.subs.length + S.outbox.filter((o) => o.store === S.store.code).length;
    btn.innerHTML = 'My Submissions' + (n ? '<span class="count">' + n + '</span>' : '');
  }

  function renderList() {
    const pane = $('#pane'); if (!pane) return;
    renderSubmitBar();
    const code = S.store.code;
    const pend = S.outbox.filter((o) => o.store === code).map((o) => ({
      ticketId: 'Pending', submittedAt: o.createdAt, gcType: o.gcType, series: o.series, amounts: o.amounts || [], totalAmount: o.totalAmount || 0, count: o.series.length,
      remarks: o.error ? 'Failed — tap to see' : 'Pending sync', submittedBy: o.submittedBy, notes: o.notes,
      images: o.images.map((i) => i.dataUrl), _outbox: o
    }));
    const all = pend.concat(S.subs);
    const q = S.listQ.trim().toUpperCase();
    const rows = all.filter((s) => (S.listType === 'all' || s.gcType === S.listType) &&
      (!q || (s.ticketId || '').toUpperCase().includes(q) || (s.series || []).some((x) => String(x).toUpperCase().includes(q))));
    const totalAmt = S.subs.reduce((a, s) => a + totalOf(s), 0);
    const totalGC = S.subs.reduce((a, s) => a + (+s.count || (s.series || []).length), 0);
    const now = new Date();
    const monthGC = S.subs.filter((s) => { const d = new Date(s.submittedAt); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); })
      .reduce((a, s) => a + (+s.count || (s.series || []).length), 0);

    pane.innerHTML =
      '<div class="stats"><div class="stat"><b>' + S.subs.length + '</b><small>Tickets submitted</small></div>' +
      '<div class="stat"><b>' + totalGC + '</b><small>GCs submitted</small></div>' +
      '<div class="stat"><b>' + monthGC + '</b><small>GCs this month</small></div>' +
      '<div class="stat"><b>' + peso(totalAmt) + '</b><small>Total amount</small></div></div>' +
      (pend.length ? '<div class="banner" style="margin:0 0 10px">' + pend.length + ' submission' + (pend.length > 1 ? 's are' : ' is') + ' waiting to send. ' + (navigator.onLine ? '<button class="linkish" id="syncNow">Send now</button>' : 'Will send when online.') + '</div>' : '') +
      (S.subsError ? '<div class="banner" style="margin:0 0 10px;background:var(--err-bg);color:var(--err);border-color:#f5c2bd">' + esc(S.subsError) + ' <button class="linkish" id="retry">Retry</button></div>' : '') +
      '<div class="list-tools"><div class="search"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>' +
      '<input id="listQ" type="search" placeholder="Search ticket or series no." value="' + esc(S.listQ) + '"></div>' +
      '<select id="listType"><option value="all">All types</option>' + (C.GC_TYPES || []).map((t) => '<option ' + (S.listType === t.id ? 'selected' : '') + ' value="' + esc(t.id) + '">' + esc(t.label) + '</option>').join('') + '</select>' +
      '<button class="btn ghost sm" id="refresh" title="Refresh">↻</button></div>' +
      (S.subsLoading ? '<div class="loading"><span class="spinner"></span>Loading submissions…</div>'
        : rows.length ? '<div class="tix">' + rows.map((s, i) =>
          '<div class="tk" role="button" tabindex="0" data-i="' + i + '"><span class="id">' + esc(s.ticketId) + '</span><span class="tk-r">' + remarksPill(s.remarks) + '<button class="tk-del" data-del="' + i + '" title="Delete submission" aria-label="Delete submission"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/></svg></button></span>' +
          '<span class="row">' + typePill(s.gcType) + '<span class="pill n">' + esc(s.count || (s.series || []).length) + ' GC' + ((s.count || (s.series || []).length) > 1 ? 's' : '') + '</span>' + (totalOf(s) ? '<span class="pill amt-pill">' + peso(totalOf(s)) + '</span>' : '') + (s.onDevice ? '<span class="pill dev" title="Saved on this device">📱 On device</span>' : '') + '<span class="when">' + fmtDate(s.submittedAt) + '</span></span>' +
          '<span class="ser">' + esc((s.series || []).slice(0, 6).join(', ') + ((s.series || []).length > 6 ? ' …' : '')) + '</span></div>').join('') + '</div>'
          : '<div class="empty">' + (all.length ? 'No submission matches your search.' : 'No submissions yet.<br><br><button class="btn" id="startNew">Submit redeemed GCs</button>') + '</div>');

    const lq = $('#listQ');
    lq.oninput = () => { S.listQ = lq.value; const p = lq.selectionStart; renderList(); const n = $('#listQ'); n.focus(); n.setSelectionRange(p, p); };
    $('#listType').onchange = (e) => { S.listType = e.target.value; renderList(); };
    $('#refresh').onclick = () => { flushOutbox(); loadSubs(); toast('Refreshing…', 1000); };
    const r = $('#retry'); if (r) r.onclick = () => loadSubs();
    const sn = $('#syncNow'); if (sn) sn.onclick = () => flushOutbox(true);
    const st = $('#startNew'); if (st) st.onclick = () => go('#/store/' + encodeURIComponent(code) + '/new');
    pane.querySelectorAll('[data-i]').forEach((b) => {
      b.onclick = () => showDetail(rows[+b.dataset.i]);
      b.onkeydown = (e) => { if (e.key === 'Enter') showDetail(rows[+b.dataset.i]); };
    });
    pane.querySelectorAll('[data-del]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); askDelete(rows[+b.dataset.del]); });
  }

  function showDetail(s) {
    const dev = (s.deviceImages || []).filter(Boolean);
    const imgs = dev.length ? dev : (s.images || []).filter(Boolean);
    const links = dev.length ? (s.images || []).filter((u) => u && !/^data:/.test(u)) : [];
    const ob = s._outbox;
    modal(
      '<h3 style="font-family:ui-monospace,Menlo,monospace">' + esc(s.ticketId) + '</h3><p class="sub">' + fmtDate(s.submittedAt) + '</p>' +
      '<dl class="kv"><dt>Remarks</dt><dd>' + remarksPill(ob && !ob.error ? 'Pending sync' : (ob ? 'Failed' : s.remarks)) + '</dd>' +
      '<dt>GC type</dt><dd>' + typePill(s.gcType) + '</dd>' +
      (totalOf(s) ? '<dt>Total amount</dt><dd style="color:var(--blue-800);font-size:16px">' + peso(totalOf(s)) + '</dd>' : '') +
      '<dt>Store</dt><dd>' + esc(S.store.name) + '</dd>' +
      (s.submittedBy ? '<dt>Submitted by</dt><dd>' + esc(s.submittedBy) + '</dd>' : '') +
      (s.notes ? '<dt>Notes</dt><dd style="font-weight:400">' + esc(s.notes) + '</dd>' : '') +
      (s.emailStatus && !/^sent$/i.test(s.emailStatus) ? '<dt>Email</dt><dd>' + esc(s.emailStatus) + '</dd>' : '') +
      '</dl>' +
      (ob && ob.error ? '<div class="banner" style="margin:0 0 12px;background:var(--err-bg);color:var(--err);border-color:#f5c2bd">' + esc(ob.error) + '</div>' : '') +
      '<p style="margin:0 0 6px;font-weight:600;font-size:13px">Series numbers (' + (s.series || []).length + ')</p><div class="mono-box">' + (s.series || []).map((x, i) => esc(x) + (amountsOf(s)[i] ? '  —  ' + peso(amountsOf(s)[i]) : '')).join('\n') + '</div>' +
      (amountsOf(s).some(Boolean) ? '<p class="helper" style="margin:-6px 0 12px">' + amountSummary(amountsOf(s)) + '</p>' : '') +
      (imgs.length ? '<p style="margin:0 0 6px;font-weight:600;font-size:13px">Images (' + imgs.length + ')</p><div class="img-links">' +
        imgs.map((u, i) => /^data:/.test(u) ? '<a href="#" data-full="' + i + '"><img src="' + u + '" alt="GC image ' + (i + 1) + '"></a>' : '<a href="' + esc(u) + '" target="_blank" rel="noopener">Image ' + (i + 1) + ' ↗</a>').join('') + '</div>' +
        (dev.length ? '<p class="helper" style="margin:-4px 0 12px">📱 Photos saved on this device' + (links.length ? ' · <a href="' + esc(links[0]) + '" target="_blank" rel="noopener">open online copy ↗</a>' : '') + '</p>' : '')
        : (s.imageCount ? '<p class="helper">' + s.imageCount + ' image(s) attached to the email.</p>' : '')) +
      '<div class="sheet-actions"><button class="btn danger" id="dDel">Delete</button>' + (ob && !ob.error ? '<button class="btn ghost" id="dSend">Send now</button>' : '') + '<button class="btn" id="dOk">Close</button></div>',
      {
        onMount(el) {
          $('#dOk', el).onclick = closeModal;
          el.querySelectorAll('[data-full]').forEach((a) => a.onclick = (ev) => {
            ev.preventDefault(); const w = window.open(); if (w) w.document.write('<title>GC image</title><body style="margin:0;background:#111"><img src="' + imgs[+a.dataset.full] + '" style="max-width:100%;display:block;margin:auto">');
          });
          const del = $('#dDel', el);
          if (del) del.onclick = () => askDelete(s);
          const snd = $('#dSend', el); if (snd) snd.onclick = () => { closeModal(); flushOutbox(true); };
        }
      }
    );
  }

  /* ------------------------------------------------- device storage (archive) */
  async function refreshArchive() { S.archive = await ARC.all(); }
  async function archiveSave(p, sub) {
    try {
      await ARC.put({
        clientId: p.clientId, ticketId: sub.ticketId, storeCode: p.store, storeName: p.storeName || '',
        gcType: p.gcType, series: p.series, amounts: p.amounts || [], totalAmount: p.totalAmount || 0, count: p.series.length, submittedBy: p.submittedBy, notes: p.notes,
        submittedAt: sub.submittedAt || p.createdAt, remarks: sub.remarks || 'Submitted', emailStatus: sub.emailStatus || '',
        images: (p.images || []).map((i) => i.dataUrl), imageLinks: (sub.images || []).filter((u) => !/^data:/.test(u)),
        savedAt: new Date().toISOString()
      });
      await refreshArchive();
      requestPersist();
    } catch (e) { toast('Couldn’t save a copy on this device (storage full?).'); }
    updateStorage();
  }
  // Attach the device copy (photos) to server rows, add device-only rows, keep remarks in sync
  function mergeArchive(code) {
    const loc = S.archive.filter((a) => a.storeCode === code);
    const byT = new Map(loc.map((a) => [a.ticketId, a]));
    const seen = new Set();
    S.subs = S.subs.map((s) => {
      seen.add(s.ticketId);
      const a = byT.get(s.ticketId); if (!a) return s;
      if (s.remarks && a.remarks !== s.remarks) { a.remarks = s.remarks; ARC.put(a).catch(() => {}); }
      return Object.assign({}, s, { deviceImages: a.images, onDevice: true });
    });
    loc.forEach((a) => { if (!seen.has(a.ticketId)) S.subs.push(Object.assign({}, a, { images: a.imageLinks || [], deviceImages: a.images, onDevice: true })); });
    S.subs.sort((x, y) => String(y.submittedAt).localeCompare(String(x.submittedAt)));
  }
  let persistAsked = false;
  function requestPersist() {
    if (persistAsked || !(navigator.storage && navigator.storage.persist)) return;
    persistAsked = true; navigator.storage.persist().catch(() => {});
  }
  const fmtMB = (b) => (b / 1048576).toFixed(1) + ' MB';
  async function storageInfo() {
    let usage = 0, quota = 0, persisted = false;
    try { if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); usage = e.usage || 0; quota = e.quota || 0; } } catch (e) {}
    try { if (navigator.storage && navigator.storage.persisted) persisted = await navigator.storage.persisted(); } catch (e) {}
    const bytes = (arr) => arr.reduce((t, a) => t + (a.images || []).reduce((x, u) => x + Math.round((typeof u === 'string' ? u : (u.dataUrl || '')).length * 0.75), 0), 0);
    return { usage, quota, persisted, saved: S.archive.length, photos: S.archive.reduce((t, a) => t + (a.images || []).length, 0),
      gcBytes: bytes(S.archive) + bytes(S.outbox.map((o) => ({ images: o.images }))), pending: S.outbox.length };
  }
  async function updateStorage() {
    const el = $('#storeMeter'); if (!el) return;
    const i = await storageInfo();
    if (!i.quota) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M17 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7l-4-4zm-5 16a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm3-10H5V5h10v4z"/></svg>' +
      '<b>' + fmtMB(i.usage) + '</b><span class="q"> / ' + Math.round(i.quota / 1048576) + ' MB used</span>';
    el.title = 'Device storage used by this app';
  }
  async function showStorage() {
    const i = await storageInfo();
    const pct = i.quota ? Math.min(100, i.usage / i.quota * 100) : 0;
    modal(
      '<h3>Device storage</h3><p class="sub">Every submission — details and GC photos — is saved on this device, so the records and photos open even without internet. A copy is also emailed to ' + esc(C.EMAIL_TO) + '.</p>' +
      '<div class="meter-bar"><span style="width:' + Math.max(pct, 0.6).toFixed(2) + '%"></span></div>' +
      '<p class="helper" style="margin:6px 0 14px"><b>' + fmtMB(i.usage) + '</b> used of ' + Math.round(i.quota / 1048576) + ' MB available to this app (' + pct.toFixed(pct < 1 ? 2 : 1) + '%)</p>' +
      '<dl class="kv"><dt>Saved on device</dt><dd>' + i.saved + ' submission' + (i.saved === 1 ? '' : 's') + ' · ' + i.photos + ' photo' + (i.photos === 1 ? '' : 's') + '</dd>' +
      '<dt>GC data size</dt><dd>' + (i.gcBytes < 1048576 ? Math.max(1, Math.round(i.gcBytes / 1024)) + ' KB' : fmtMB(i.gcBytes)) + '</dd>' +
      '<dt>Waiting to send</dt><dd>' + i.pending + '</dd>' +
      '<dt>Protection</dt><dd>' + (i.persisted ? '✓ Kept permanently' : 'May be cleared by the browser if the device runs low on space') + '</dd></dl>' +
      '<div class="sheet-actions">' + (i.saved ? '<button class="btn danger" id="stClear">Delete device copies</button>' : '') +
      (i.persisted ? '' : '<button class="btn ghost" id="stKeep">Keep permanently</button>') + '<button class="btn" id="stOk">Close</button></div>',
      {
        onMount(el) {
          $('#stOk', el).onclick = closeModal;
          const k = $('#stKeep', el);
          if (k) k.onclick = async () => {
            let ok = false; try { ok = await navigator.storage.persist(); } catch (e) {}
            toast(ok ? 'Data on this device will be kept permanently.' : 'The browser didn’t allow it yet — install the app to the home screen, then try again.', 3600);
            closeModal(); updateStorage();
          };
          const c = $('#stClear', el);
          if (c) c.onclick = async () => {
            if (!confirm('Delete the copies (records and photos) saved on this device?\n\nEmails already sent and the Franchise Dev records are NOT affected. Unsent submissions are kept.')) return;
            await ARC.clear(); await refreshArchive(); closeModal(); toast('Device copies deleted.'); updateStorage();
            if (S.store) loadSubs(true);
          };
        }
      }
    );
  }

  /* ------------------------------------------------- delete (password-protected) */
  function askDelete(s) {
    const ob = s._outbox;
    const label = ob ? 'this unsent submission' : 'ticket ' + s.ticketId;
    modal(
      '<div class="center"><div class="big-warn" style="background:var(--err-bg);color:var(--err)">🗑</div><h3>Delete ' + esc(ob ? 'unsent submission' : s.ticketId) + '?</h3>' +
      '<p class="sub">' + esc(s.gcType) + ' · ' + (s.series || []).length + ' GC(s): ' + esc((s.series || []).slice(0, 4).join(', ') + ((s.series || []).length > 4 ? ' …' : '')) + '<br>' +
      (ob ? 'It will be removed from this device and will not be sent.' : 'It will be removed from this store’s list and from the Franchise Dev records. Its series numbers can then be submitted again.') + '</p></div>' +
      '<input class="pin-input" id="delPass" type="password" autocomplete="off" autocapitalize="characters" placeholder="Enter password" style="letter-spacing:3px;font-size:20px">' +
      '<p class="helper" id="delErr" style="color:var(--err);min-height:18px;text-align:center"></p>' +
      '<div class="sheet-actions"><button class="btn ghost" id="delCancel">Cancel</button><button class="btn danger" id="delGo" style="background:var(--err);color:#fff">Delete</button></div>',
      {
        dismiss: false,
        onMount(el) {
          const inp = $('#delPass', el); setTimeout(() => inp.focus(), 50);
          const err = (m) => { $('#delErr', el).textContent = m; };
          const run = async () => {
            const pw = inp.value.trim().toUpperCase(); if (!pw) return;
            const h = await sha256(pw);
            if (h === null) return err('This browser can’t check the password. Use Chrome, Edge or Safari over https.');
            if (h !== String(C.MONITORING_PASS_SHA256).toLowerCase()) { err('Incorrect password.'); inp.select(); return; }
            const b = $('#delGo', el); b.disabled = true; b.innerHTML = '<span class="spinner"></span>Deleting';
            try {
              if (ob) { await DB.del(ob.clientId); await refreshOutbox(); }
              else {
                if (!DEMO && !navigator.onLine) throw apiError('You’re offline. Connect to the internet to delete a submitted ticket.');
                await apiPost({ action: 'delete', ticketId: s.ticketId, store: S.store.code, pin: pinFor(S.store.code), password: pw });
                const a = S.archive.find((x) => x.ticketId === s.ticketId && x.storeCode === S.store.code);
                if (a) { await ARC.del(a.clientId); await refreshArchive(); }
                S.subs = S.subs.filter((x) => x.ticketId !== s.ticketId);
                LS.set(cacheKey(), S.subs.map((x) => Object.assign({}, x, { deviceImages: undefined, images: (x.images || []).filter((u) => !/^data:/.test(u)) })));
              }
              closeModal(); toast((ob ? 'Unsent submission' : 'Ticket ' + s.ticketId) + ' deleted.'); updateStorage(); render();
            } catch (e) {
              b.disabled = false; b.textContent = 'Delete';
              err(e.api ? e.message : 'Couldn’t reach the server. Check the connection and try again.');
            }
          };
          $('#delGo', el).onclick = run;
          inp.onkeydown = (e) => { if (e.key === 'Enter') run(); };
          $('#delCancel', el).onclick = closeModal;
        }
      }
    );
  }

  /* ----------------------------------------------------------- outbox sync */
  let flushing = false;
  async function refreshOutbox() { S.outbox = await DB.all(); }
  async function flushOutbox(manual) {
    if (flushing || DEMO) return;
    await refreshOutbox();
    const items = S.outbox.filter((o) => !o.error);
    if (!items.length || !navigator.onLine) { if (manual && items.length) toast('Still offline.'); return; }
    flushing = true; let sent = 0;
    for (const it of items) {
      try {
        const body = Object.assign({}, it); delete body.status; delete body.error;
        const r = await apiPost(body);
        await archiveSave(body, r.submission || {});
        await DB.del(it.clientId); sent++;
      } catch (e) {
        if (e.api) { it.error = e.message; it.status = 'Failed'; await DB.put(it); }
        else break; // still no connection
      }
    }
    flushing = false;
    await refreshOutbox(); updateStorage();
    if (sent) { toast(sent + ' pending submission' + (sent > 1 ? 's' : '') + ' sent.'); if (S.store) loadSubs(true); }
    refreshView();
  }

  /* ---------------------------------------------------------------- stores */
  async function loadStores() {
    S.stores = LS.get('gc_stores', []);
    if (!S.stores.length && DEMO) S.stores = C.FALLBACK_STORES || [];
    if (S.stores.length) route();
    try {
      const r = await apiGet({ action: 'stores' });
      S.stores = (r.stores || []).map((s) => ({ code: String(s.code), name: s.name, area: s.area || '', hasPin: !!s.hasPin }));
      LS.set('gc_stores', S.stores);
    } catch (e) {
      if (!S.stores.length) S.stores = C.FALLBACK_STORES || [];
      if (!DEMO) toast(navigator.onLine ? 'Couldn’t load the store list — using saved list.' : 'Offline — using saved store list.');
    }
    route();
  }

  /* ------------------------------------------------------------------ boot */
  $('#menuBtn').onclick = () => document.body.classList.contains('side-open') ? closeSide() : openSide();
  $('#sideScrim').onclick = closeSide;
  $('#fileGallery').onchange = (e) => { handleFiles(e.target.files); e.target.value = ''; };
  $('#fileCamera').onchange = (e) => { handleFiles(e.target.files); e.target.value = ''; };
  window.addEventListener('hashchange', route);
  window.addEventListener('online', () => { setNet(); flushOutbox(); if (S.store) loadSubs(true); });
  window.addEventListener('offline', setNet);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { flushOutbox(); updateStorage(); } });

  // Install prompt (Android / desktop Chrome & Edge)
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; $('#installBtn').classList.remove('hidden'); });
  $('#installBtn').onclick = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; $('#installBtn').classList.add('hidden');
  };
  window.addEventListener('appinstalled', () => $('#installBtn').classList.add('hidden'));

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  $('#storeMeter').onclick = showStorage;
  Promise.all([refreshOutbox(), refreshArchive()]).then(() => { loadStores(); flushOutbox(); updateStorage(); });
  setInterval(updateStorage, 30000);
})();
