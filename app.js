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
    store: null, tab: 'new',
    gcType: null, series: [], images: [], submittedBy: LS.get('gc_by', ''), notes: '',
    showRange: false, busy: false,
    subs: [], subsLoading: false, subsError: '', listQ: '', listType: 'all',
    outbox: []
  };

  /* ------------------------------------------------------------- IndexedDB outbox
     Submissions made while offline are kept here (images included) and sent
     automatically once the device is back online. */
  const DB = {
    _db: null,
    open() {
      if (this._db) return Promise.resolve(this._db);
      return new Promise((res, rej) => {
        if (!('indexedDB' in window)) return rej(new Error('IndexedDB unavailable'));
        const r = indexedDB.open('gc-portal', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('outbox', { keyPath: 'clientId' });
        r.onsuccess = () => { this._db = r.result; res(this._db); };
        r.onerror = () => rej(r.error);
      });
    },
    async tx(mode, fn) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const t = db.transaction('outbox', mode); const st = t.objectStore('outbox');
        const out = fn(st);
        t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
        t.onerror = () => rej(t.error);
      });
    },
    all() { return this.tx('readonly', (s) => s.getAll()).then((r) => r || []).catch(() => []); },
    put(item) { return this.tx('readwrite', (s) => s.put(item)); },
    del(id) { return this.tx('readwrite', (s) => s.delete(id)); }
  };

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
        gcType: b.gcType, series: b.series, count: b.series.length, submittedBy: b.submittedBy, notes: b.notes,
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
    if (DEMO) { p.textContent = 'Demo'; p.className = 'net demo'; }
    else if (!navigator.onLine) { p.textContent = 'Offline'; p.className = 'net off'; }
    else { p.textContent = 'Online'; p.className = 'net'; }
  }
  function setHeader() {
    const back = $('#backBtn');
    if (S.store) {
      back.classList.remove('hidden');
      $('#brandMark').textContent = initials(S.store.name);
      $('#topTitle').textContent = S.store.name;
      $('#topSub').textContent = [S.store.code, S.store.area].filter(Boolean).join(' · ') + ' — GC Submissions';
    } else {
      back.classList.add('hidden');
      $('#brandMark').textContent = 'GC';
      $('#topTitle').textContent = (C.APP_NAME || 'GC Submissions');
      $('#topSub').textContent = (C.COMPANY ? C.COMPANY + ' · ' : '') + 'Redeemed gift certificates';
    }
    $('#banner').innerHTML = DEMO
      ? '<div class="banner"><b>Demo mode.</b> Not connected yet — submissions stay on this device and no email is sent. Add the Web App URL in <code>config.js</code> to go live.</div>'
      : '';
  }

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
      '<div class="seg" role="tablist">' +
      '<button role="tab" class="' + (S.tab === 'new' ? 'on' : '') + '" data-tab="new">New Submission</button>' +
      '<button role="tab" class="' + (S.tab === 'list' ? 'on' : '') + '" data-tab="list">My Submissions' + (n ? '<span class="count">' + n + '</span>' : '') + '</button>' +
      '</div><div id="pane"></div>';
    app.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => go('#/store/' + encodeURIComponent(S.store.code) + '/' + b.dataset.tab));
    if (S.tab === 'new') renderForm(); else renderList();
  }

  function renderHome() {
    const app = $('#app');
    const areas = ['All'].concat([...new Set(S.stores.map((s) => s.area).filter(Boolean))]);
    const q = S.q.toLowerCase();
    const list = S.stores.filter((s) => (S.area === 'All' || s.area === S.area) &&
      (!q || (s.name + ' ' + s.code + ' ' + (s.area || '')).toLowerCase().includes(q)));
    const last = S.stores.find((s) => s.code === LS.get('gc_last_store', ''));
    app.innerHTML =
      '<div class="hero"><h1>Select your store</h1><p>Open your store tab to submit redeemed GCs and see your submission records.</p></div>' +
      (last ? '<button class="continue" data-code="' + esc(last.code) + '"><div class="store-ava">' + esc(initials(last.name)) + '</div><div style="flex:1"><small>Continue as</small><b>' + esc(last.name) + '</b></div><span aria-hidden="true">›</span></button>' : '') +
      '<div class="search"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>' +
      '<input id="storeQ" type="search" placeholder="Search store name or code" value="' + esc(S.q) + '" autocomplete="off"></div>' +
      (areas.length > 2 ? '<div class="chips">' + areas.map((a) => '<button class="chip ' + (a === S.area ? 'on' : '') + '" data-area="' + esc(a) + '">' + esc(a) + '</button>').join('') + '</div>' : '') +
      (list.length
        ? '<div class="store-grid">' + list.map((s) =>
          '<button class="store-tab" data-code="' + esc(s.code) + '"><div class="store-ava">' + esc(initials(s.name)) + '</div><div style="min-width:0"><b>' + esc(s.name) + '</b><small>' +
          esc([s.code, s.area].filter(Boolean).join(' · ')) + (s.hasPin ? ' · 🔒' : '') + '</small></div></button>').join('') + '</div>'
        : '<div class="empty">' + (S.stores.length ? 'No store matches “' + esc(S.q) + '”.' : 'No stores set up yet. Add stores in the “Stores” tab of the Google Sheet.') + '</div>');
    app.querySelectorAll('[data-code]').forEach((b) => b.onclick = () => go('#/store/' + encodeURIComponent(b.dataset.code) + '/new'));
    app.querySelectorAll('[data-area]').forEach((b) => b.onclick = () => { S.area = b.dataset.area; renderHome(); });
    const qi = $('#storeQ');
    qi.oninput = () => { S.q = qi.value; const pos = qi.selectionStart; renderHome(); const n = $('#storeQ'); n.focus(); n.setSelectionRange(pos, pos); };
  }

  /* ------------------------------------------------------------------ form */
  function resetForm() { S.gcType = null; S.series = []; S.images = []; S.notes = ''; S.showRange = false; }

  function renderForm() {
    const pane = $('#pane');
    const types = C.GC_TYPES || [];
    pane.innerHTML =
      // Step 1
      '<section class="card"><div class="step-h"><span class="step-n ' + (S.gcType ? 'done' : '') + '">' + (S.gcType ? '✓' : '1') + '</span><h2>GC type</h2></div>' +
      '<div class="types">' + types.map((t) => '<button class="type ' + (S.gcType === t.id ? 'on' : '') + '" data-type="' + esc(t.id) + '"><b><span class="dot" style="background:' + (/pluxee|sodexo/i.test(t.id) ? 'var(--pluxee)' : 'var(--tobys)') + '"></span>' + esc(t.label) + '</b><small>' + esc(t.hint || '') + '</small></button>').join('') + '</div></section>' +
      // Step 2
      '<section class="card"><div class="step-h"><span class="step-n ' + (S.series.length ? 'done' : '') + '">' + (S.series.length ? '✓' : '2') + '</span><h2>Series numbers</h2><span class="meta">' + S.series.length + ' GC' + (S.series.length === 1 ? '' : 's') + '</span></div>' +
      '<div class="series-entry"><input id="serIn" placeholder="Type or scan series no." autocomplete="off" autocapitalize="characters" enterkeyhint="done"><button class="btn" id="serAdd">Add</button></div>' +
      '<p class="helper">Press Enter after each one. You can also paste a list (one per line or comma-separated). <button class="linkish" id="rangeToggle">' + (S.showRange ? 'Hide range' : 'Add a consecutive range') + '</button></p>' +
      (S.showRange ? '<div class="range"><input id="rFrom" placeholder="From e.g. TG000101"><input id="rTo" placeholder="To e.g. TG000110"><button class="btn sm" id="rAdd">Add range</button></div>' : '') +
      '<div class="series-list" id="serList">' + S.series.map((s, i) => '<span class="sc">' + esc(s) + '<button aria-label="Remove ' + esc(s) + '" data-rm="' + i + '">×</button></span>').join('') + '</div>' +
      (S.series.length > 1 ? '<div class="series-tools"><span class="helper" style="margin:0">Tap × to remove a wrong entry.</span><button class="linkish" id="serClear">Clear all</button></div>' : '') +
      '</section>' +
      // Step 3
      '<section class="card"><div class="step-h"><span class="step-n ' + (S.images.length ? 'done' : '') + '">' + (S.images.length ? '✓' : '3') + '</span><h2>GC images</h2><span class="meta">' + S.images.length + ' / ' + (C.MAX_IMAGES || 10) + '</span></div>' +
      '<div class="drop"><button class="pick" id="pickCam"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>Take photo<small>Use camera</small></button>' +
      '<button class="pick" id="pickGal"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/></svg>Attach images<small>From gallery / files</small></button></div>' +
      '<div class="thumbs">' + S.images.map((im, i) => '<div class="thumb"><img src="' + im.dataUrl + '" alt="GC image ' + (i + 1) + '"><button aria-label="Remove image" data-rmimg="' + i + '">×</button><span>' + Math.round(im.size / 1024) + ' KB</span></div>').join('') + '</div>' +
      '<p class="helper">Photograph the front of each redeemed GC so the series number is readable. Several GCs can be in one photo.</p></section>' +
      // Details
      '<section class="card"><div class="field"><label for="byIn">Submitted by <em>(optional)</em></label><input id="byIn" placeholder="Name of cashier / staff" value="' + esc(S.submittedBy) + '"></div>' +
      '<div class="field" style="margin:0"><label for="noteIn">Notes <em>(optional)</em></label><textarea id="noteIn" placeholder="e.g. OR / transaction no., customer name">' + esc(S.notes) + '</textarea></div></section>';

    pane.querySelectorAll('[data-type]').forEach((b) => b.onclick = () => { S.gcType = b.dataset.type; renderForm(); });
    const inp = $('#serIn');
    const addFromInput = () => { addSeries(inp.value); inp.value = ''; renderForm(); $('#serIn').focus(); };
    $('#serAdd').onclick = addFromInput;
    inp.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addFromInput(); } };
    inp.onpaste = (e) => {
      const t = (e.clipboardData || window.clipboardData).getData('text');
      if (/[\n,;\t]/.test(t)) { e.preventDefault(); addSeries(t); renderForm(); $('#serIn').focus(); }
    };
    $('#rangeToggle').onclick = () => { S.showRange = !S.showRange; renderForm(); };
    if (S.showRange) $('#rAdd').onclick = () => { if (addRange($('#rFrom').value, $('#rTo').value)) { S.showRange = false; renderForm(); } };
    pane.querySelectorAll('[data-rm]').forEach((b) => b.onclick = () => { S.series.splice(+b.dataset.rm, 1); renderForm(); });
    const clr = $('#serClear'); if (clr) clr.onclick = () => { if (confirm('Remove all ' + S.series.length + ' series numbers?')) { S.series = []; renderForm(); } };
    $('#pickCam').onclick = () => $('#fileCamera').click();
    $('#pickGal').onclick = () => $('#fileGallery').click();
    pane.querySelectorAll('[data-rmimg]').forEach((b) => b.onclick = () => { S.images.splice(+b.dataset.rmimg, 1); renderForm(); });
    $('#byIn').oninput = (e) => { S.submittedBy = e.target.value; LS.set('gc_by', S.submittedBy); };
    $('#noteIn').oninput = (e) => { S.notes = e.target.value; };
    renderSubmitBar();
  }

  function addSeries(text) {
    const parts = String(text || '').split(/[\n,;\t]+|\s{2,}/).map(normSeries).filter(Boolean);
    let added = 0, dup = 0;
    const max = C.MAX_SERIES || 500;
    for (const p of parts) {
      if (S.series.includes(p)) { dup++; continue; }
      if (S.series.length >= max) { toast('Maximum of ' + max + ' series per submission.'); break; }
      S.series.push(p); added++;
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

  function renderSubmitBar() {
    const bar = $('#submitbar');
    if (!S.store || S.tab !== 'new') { bar.innerHTML = ''; return; }
    const missing = [];
    if (!S.gcType) missing.push('GC type');
    if (!S.series.length) missing.push('series no.');
    if (!S.images.length) missing.push('images');
    bar.innerHTML = '<div class="submitbar"><div class="submitbar-inner"><div class="sum">' +
      (missing.length ? '<b>Still needed</b>' + esc(missing.join(', ')) : '<b>Ready to submit</b>' + esc(S.gcType) + ' · ' + S.series.length + ' GC' + (S.series.length > 1 ? 's' : '') + ' · ' + S.images.length + ' image' + (S.images.length > 1 ? 's' : '')) +
      '</div><button class="btn accent" id="submitBtn" ' + (missing.length || S.busy ? 'disabled' : '') + '>' + (S.busy ? '<span class="spinner"></span>Sending…' : 'Submit') + '</button></div></div>';
    $('#submitBtn').onclick = confirmSubmit;
  }

  function confirmSubmit() {
    modal(
      '<h3>Submit to Franchise Dev?</h3><p class="sub">This will be emailed to <b>' + esc(C.EMAIL_TO) + '</b> with the attached images.</p>' +
      '<dl class="kv"><dt>Store</dt><dd>' + esc(S.store.name) + '</dd><dt>GC type</dt><dd>' + typePill(S.gcType) + '</dd><dt>Series</dt><dd>' + S.series.length + ' GC' + (S.series.length > 1 ? 's' : '') + '</dd><dt>Images</dt><dd>' + S.images.length + '</dd>' +
      (S.submittedBy ? '<dt>By</dt><dd>' + esc(S.submittedBy) + '</dd>' : '') + '</dl>' +
      '<div class="mono-box">' + S.series.map(esc).join('\n') + '</div>' +
      '<div class="sheet-actions"><button class="btn ghost" id="cBack">Edit</button><button class="btn accent" id="cGo">Confirm & submit</button></div>',
      { onMount(el) { $('#cBack', el).onclick = closeModal; $('#cGo', el).onclick = () => { closeModal(); doSubmit(); }; } }
    );
  }

  async function doSubmit() {
    if (S.busy) return;
    const payload = {
      action: 'submit', clientId: uid(), store: S.store.code, pin: pinFor(S.store.code),
      gcType: S.gcType, series: S.series.slice(), submittedBy: S.submittedBy.trim(), notes: S.notes.trim(),
      images: S.images.map((im, i) => ({ name: 'GC_' + (i + 1) + '.jpg', dataUrl: im.dataUrl })),
      createdAt: new Date().toISOString(), storeName: S.store.name
    };
    S.busy = true; renderSubmitBar();
    try {
      if (!DEMO && !navigator.onLine) throw new TypeError('offline');
      const r = await apiPost(payload);
      S.busy = false; resetForm();
      S.subs.unshift(r.submission); dedupeSubs();
      renderForm(); showSuccess(r.submission);
      loadSubs(true);
    } catch (e) {
      S.busy = false;
      if (e.api) { renderSubmitBar(); showError(e); return; }
      // network problem → keep it in the outbox and send automatically later
      try {
        await DB.put(Object.assign({}, payload, { status: 'Pending sync', error: '' }));
        await refreshOutbox();
        resetForm(); renderForm(); showQueued();
      } catch (e2) { renderSubmitBar(); showError(apiError('No connection, and this device couldn’t save the submission for later. Please try again when online.')); }
    }
  }

  function showSuccess(sub) {
    modal(
      '<div class="center"><div class="big-ok">✓</div><h3>Submitted</h3><p class="sub">Sent to ' + esc(C.EMAIL_TO) + (DEMO ? ' (demo — no email sent)' : '') + '</p></div>' +
      '<dl class="kv"><dt>Ticket no.</dt><dd style="font-family:ui-monospace,Menlo,monospace">' + esc(sub.ticketId) + '</dd><dt>GC type</dt><dd>' + typePill(sub.gcType) + '</dd><dt>Series</dt><dd>' + esc(sub.count || (sub.series || []).length) + ' GC(s)</dd><dt>Remarks</dt><dd>' + remarksPill(sub.remarks) + '</dd></dl>' +
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
    if (!S.subs.length) S.subs = LS.get(cacheKey(), []);
    S.subsLoading = !silent && !S.subs.length; S.subsError = '';
    if (S.tab === 'list') renderList();
    try {
      const r = await apiGet({ action: 'list', store: code, pin: pinFor(code) });
      if (!S.store || S.store.code !== code) return;
      S.subs = r.submissions || [];
      LS.set(cacheKey(), S.subs.map((s) => Object.assign({}, s, { images: (s.images || []).filter((u) => !/^data:/.test(u)) })));
    } catch (e) {
      if (e.code === 'PIN') { LS.del('gc_pin_' + code); S.store = null; askPin(S.stores.find((s) => s.code === code)); return; }
      S.subsError = e.api ? e.message : (navigator.onLine ? 'Couldn’t reach the server.' : 'Offline — showing the last saved list.');
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
      ticketId: 'Pending', submittedAt: o.createdAt, gcType: o.gcType, series: o.series, count: o.series.length,
      remarks: o.error ? 'Failed — tap to see' : 'Pending sync', submittedBy: o.submittedBy, notes: o.notes,
      images: o.images.map((i) => i.dataUrl), _outbox: o
    }));
    const all = pend.concat(S.subs);
    const q = S.listQ.trim().toUpperCase();
    const rows = all.filter((s) => (S.listType === 'all' || s.gcType === S.listType) &&
      (!q || (s.ticketId || '').toUpperCase().includes(q) || (s.series || []).some((x) => String(x).toUpperCase().includes(q))));
    const totalGC = S.subs.reduce((a, s) => a + (+s.count || (s.series || []).length), 0);
    const now = new Date();
    const monthGC = S.subs.filter((s) => { const d = new Date(s.submittedAt); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); })
      .reduce((a, s) => a + (+s.count || (s.series || []).length), 0);

    pane.innerHTML =
      '<div class="stats"><div class="stat"><b>' + S.subs.length + '</b><small>Tickets submitted</small></div>' +
      '<div class="stat"><b>' + totalGC + '</b><small>GCs submitted</small></div>' +
      '<div class="stat"><b>' + monthGC + '</b><small>GCs this month</small></div></div>' +
      (pend.length ? '<div class="banner" style="margin:0 0 10px">' + pend.length + ' submission' + (pend.length > 1 ? 's are' : ' is') + ' waiting to send. ' + (navigator.onLine ? '<button class="linkish" id="syncNow">Send now</button>' : 'Will send when online.') + '</div>' : '') +
      (S.subsError ? '<div class="banner" style="margin:0 0 10px;background:var(--err-bg);color:var(--err);border-color:#f5c2bd">' + esc(S.subsError) + ' <button class="linkish" id="retry">Retry</button></div>' : '') +
      '<div class="list-tools"><div class="search"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>' +
      '<input id="listQ" type="search" placeholder="Search ticket or series no." value="' + esc(S.listQ) + '"></div>' +
      '<select id="listType"><option value="all">All types</option>' + (C.GC_TYPES || []).map((t) => '<option ' + (S.listType === t.id ? 'selected' : '') + ' value="' + esc(t.id) + '">' + esc(t.label) + '</option>').join('') + '</select>' +
      '<button class="btn ghost sm" id="refresh" title="Refresh">↻</button></div>' +
      (S.subsLoading ? '<div class="loading"><span class="spinner"></span>Loading submissions…</div>'
        : rows.length ? '<div class="tix">' + rows.map((s, i) =>
          '<button class="tk" data-i="' + i + '"><span class="id">' + esc(s.ticketId) + '</span><span>' + remarksPill(s.remarks) + '</span>' +
          '<span class="row">' + typePill(s.gcType) + '<span class="pill n">' + esc(s.count || (s.series || []).length) + ' GC' + ((s.count || (s.series || []).length) > 1 ? 's' : '') + '</span><span class="when">' + fmtDate(s.submittedAt) + '</span></span>' +
          '<span class="ser">' + esc((s.series || []).slice(0, 6).join(', ') + ((s.series || []).length > 6 ? ' …' : '')) + '</span></button>').join('') + '</div>'
          : '<div class="empty">' + (all.length ? 'No submission matches your search.' : 'No submissions yet.<br><br><button class="btn" id="startNew">Submit redeemed GCs</button>') + '</div>');

    const lq = $('#listQ');
    lq.oninput = () => { S.listQ = lq.value; const p = lq.selectionStart; renderList(); const n = $('#listQ'); n.focus(); n.setSelectionRange(p, p); };
    $('#listType').onchange = (e) => { S.listType = e.target.value; renderList(); };
    $('#refresh').onclick = () => { flushOutbox(); loadSubs(); toast('Refreshing…', 1000); };
    const r = $('#retry'); if (r) r.onclick = () => loadSubs();
    const sn = $('#syncNow'); if (sn) sn.onclick = () => flushOutbox(true);
    const st = $('#startNew'); if (st) st.onclick = () => go('#/store/' + encodeURIComponent(code) + '/new');
    pane.querySelectorAll('[data-i]').forEach((b) => b.onclick = () => showDetail(rows[+b.dataset.i]));
  }

  function showDetail(s) {
    const imgs = (s.images || []).filter(Boolean);
    const ob = s._outbox;
    modal(
      '<h3 style="font-family:ui-monospace,Menlo,monospace">' + esc(s.ticketId) + '</h3><p class="sub">' + fmtDate(s.submittedAt) + '</p>' +
      '<dl class="kv"><dt>Remarks</dt><dd>' + remarksPill(ob && !ob.error ? 'Pending sync' : (ob ? 'Failed' : s.remarks)) + '</dd>' +
      '<dt>GC type</dt><dd>' + typePill(s.gcType) + '</dd>' +
      '<dt>Store</dt><dd>' + esc(S.store.name) + '</dd>' +
      (s.submittedBy ? '<dt>Submitted by</dt><dd>' + esc(s.submittedBy) + '</dd>' : '') +
      (s.notes ? '<dt>Notes</dt><dd style="font-weight:400">' + esc(s.notes) + '</dd>' : '') +
      (s.emailStatus && !/^sent$/i.test(s.emailStatus) ? '<dt>Email</dt><dd>' + esc(s.emailStatus) + '</dd>' : '') +
      '</dl>' +
      (ob && ob.error ? '<div class="banner" style="margin:0 0 12px;background:var(--err-bg);color:var(--err);border-color:#f5c2bd">' + esc(ob.error) + '</div>' : '') +
      '<p style="margin:0 0 6px;font-weight:600;font-size:13px">Series numbers (' + (s.series || []).length + ')</p><div class="mono-box">' + (s.series || []).map(esc).join('\n') + '</div>' +
      (imgs.length ? '<p style="margin:0 0 6px;font-weight:600;font-size:13px">Images (' + imgs.length + ')</p><div class="img-links">' +
        imgs.map((u, i) => /^data:/.test(u) ? '<div><img src="' + u + '" alt="GC image ' + (i + 1) + '"></div>' : '<a href="' + esc(u) + '" target="_blank" rel="noopener">Image ' + (i + 1) + ' ↗</a>').join('') + '</div>'
        : (s.imageCount ? '<p class="helper">' + s.imageCount + ' image(s) attached to the email.</p>' : '')) +
      '<div class="sheet-actions">' + (ob ? '<button class="btn danger" id="dDel">Delete</button>' + (ob.error ? '' : '<button class="btn ghost" id="dSend">Send now</button>') : '') + '<button class="btn" id="dOk">Close</button></div>',
      {
        onMount(el) {
          $('#dOk', el).onclick = closeModal;
          const del = $('#dDel', el);
          if (del) del.onclick = async () => { if (confirm('Delete this unsent submission from this device?')) { await DB.del(ob.clientId); await refreshOutbox(); closeModal(); render(); } };
          const snd = $('#dSend', el); if (snd) snd.onclick = () => { closeModal(); flushOutbox(true); };
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
        await apiPost(body);
        await DB.del(it.clientId); sent++;
      } catch (e) {
        if (e.api) { it.error = e.message; it.status = 'Failed'; await DB.put(it); }
        else break; // still no connection
      }
    }
    flushing = false;
    await refreshOutbox();
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
  $('#backBtn').onclick = () => go('#/');
  $('#fileGallery').onchange = (e) => { handleFiles(e.target.files); e.target.value = ''; };
  $('#fileCamera').onchange = (e) => { handleFiles(e.target.files); e.target.value = ''; };
  window.addEventListener('hashchange', route);
  window.addEventListener('online', () => { setNet(); flushOutbox(); if (S.store) loadSubs(true); });
  window.addEventListener('offline', setNet);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) flushOutbox(); });

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

  refreshOutbox().then(() => { loadStores(); flushOutbox(); });
})();
