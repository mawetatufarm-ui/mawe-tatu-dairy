/* =====================================================================
 * Mawe Tatu Dairy — fodder.js (Fodder tab, v5.5)
 * ---------------------------------------------------------------------
 * Silage, hay and fodder batches: how much was made, what it cost per
 * tonne, how fast it is fed and how many days are left — and, when a batch
 * is finished, how much was really fed, the losses and (for piles) the
 * farm's own packing density.
 *
 * Three views (buttons at the top):
 *   FEED-OUT  — daily: which batch, how many sacks / wheelbarrows / bags,
 *               the weight of one (weighed once, remembered per batch and
 *               unit), kg thrown away, "this finishes the batch".
 *   BATCHES   — every batch with estimate, fed so far, left, kg per day,
 *               days left, cost per kg; finished ones show actual figures.
 *   NEW BATCH — type (maize ground pile, Napier bags, hay bales…), plot,
 *               acres, and the estimate:
 *                 pile:  rounded top ⅔ × W × H × L, flat top (W+T)/2 × H × L,
 *                        × density (own density when known, else 450 kg/m³)
 *                 bags:  count × average of the bags weighed
 *               Costs: pick the expenses that belong to the batch (Fodder
 *               production by default) with a share %, plus other costs.
 *
 * Stores (Dexie v7 in app.js): `fodder_batches` → Fodder_Batches,
 * `fodder_feedout` → Fodder_Feedout (append only). kv 'fodderList' caches
 * the server's listFodder reply; kv 'fodderUnitKg' remembers sack weights.
 * The server recomputes volume and estimate (Fodder.gs) — the phone's
 * numbers are only for showing while typing.
 *
 * Loaded by index.html before app.js; defines window.MaweFodder.
 * ===================================================================== */

(() => {
  'use strict';

  const BATCH_STORE = 'fodder_batches';
  const FEED_STORE = 'fodder_feedout';
  const TYPES = ['Maize silage (ground pile)', 'Napier silage (bags)', 'Hay (bales)', 'Other silage (pile)', 'Other silage (bags)'];
  const PILE_TYPES = ['Maize silage (ground pile)', 'Other silage (pile)'];
  const UNITS = ['sacks', 'wheelbarrows', 'bags', 'bales', 'loads', 'kg'];
  const DEFAULT_DENSITY = 450;
  const PAYLOAD = Object.freeze({
    [BATCH_STORE]: ['clientId', 'deviceId', 'batchId', 'date', 'type', 'name', 'plot', 'acres', 'method', 'shape', 'lengthM', 'baseWidthM', 'topWidthM', 'heightM',
      'volumeM3', 'density', 'units', 'unitName', 'sampleWeights', 'avgUnitKg', 'estimatedKg', 'costLines', 'otherCost', 'notes', 'recordedBy', 'createdAt'],
    [FEED_STORE]: ['clientId', 'deviceId', 'date', 'batchId', 'units', 'unitName', 'kgPerUnit', 'kg', 'spoiledKg', 'finished', 'notes', 'recordedBy', 'createdAt'],
  });

  /** Pile volume (m³) — same formulas as Fodder.gs. */
  function volume(shape, L, W, T, H) {
    if (!(L > 0 && W > 0 && H > 0)) return null;
    if (shape === 'Flat top') return T >= 0 && T <= W ? (W + T) / 2 * H * L : null;
    return 2 / 3 * W * H * L;
  }
  const samples = (text) => String(text || '').split(/[,;\s]+/).map(Number).filter((n) => Number.isFinite(n) && n > 0);

  function create(deps) {
    const { db, SYNC_STATUS, getSession, getDeviceId, makeUUID, todayLocal, esc, toast, requestSync, saveDebounceMs, callServer, CATEGORIES } = deps;
    const $ = (s) => document.querySelector(s);
    const $$ = (s) => [...document.querySelectorAll(s)];
    const show = (el, v) => el && el.classList.toggle('hidden', !v);
    const num = (v) => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
    const r1 = (x) => Math.round(x * 10) / 10;
    const r2 = (x) => Math.round(x * 100) / 100;
    const money = (x) => 'KES ' + Number(x || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const tonnes = (kg) => (Number(kg || 0) / 1000).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' t';
    const kgs = (kg) => Math.round(kg || 0).toLocaleString('en-KE') + ' kg';
    const fmtDate = (k) => { if (!k) return ''; const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString([], { day: 'numeric', month: 'short', year: '2-digit' }); };
    const isPile = (type) => PILE_TYPES.includes(type);

    let server = null;      // last listFodder reply
    let localBatches = [];  // fodder_batches on this phone
    let localFeeds = [];    // fodder_feedout on this phone
    let unitKg = {};        // 'BATCHID|unit' → kg
    let costRows = [];      // expenses offered in the batch form
    let localExpenses = []; // this phone's expenses (offline fallback for costs)

    function baseRecord() {
      const now = new Date().toISOString();
      const s = getSession();
      return { clientId: makeUUID(), deviceId: getDeviceId(), createdAt: now, updatedAt: now, syncStatus: SYNC_STATUS.PENDING, syncAttempts: 0, lastError: null, syncedAt: null, recordedBy: s ? s.email : '' };
    }
    function setError(sel, msg) { const el = $(sel); el.textContent = msg || ''; show(el, !!msg); }

    /* ================= batches: server + phone ================= */

    /** One list: server batches with this phone's unsent feed-outs added, plus batches not uploaded yet. */
    function allBatches() {
      const unsentFeeds = localFeeds.filter((f) => f.syncStatus !== SYNC_STATUS.SYNCED);
      const srv = (server && server.batches) || [];
      const ids = new Set(srv.map((b) => b.batchId));
      const fromPhone = localBatches.filter((b) => !ids.has(b.batchId)).map((b) => ({
        ...b, cost: null, fedKg: 0, spoiledKg: 0, finished: false, remainingKg: b.estimatedKg || 0, kgPerDay: 0, daysLeft: '', notUploaded: true,
        costPerKg: b.estimatedKg > 0 && b.localCost !== undefined ? r2(b.localCost / b.estimatedKg) : '',
      }));
      return srv.map((b) => ({ ...b })).concat(fromPhone).map((b) => {
        const mine = unsentFeeds.filter((f) => f.batchId === b.batchId && !(b.fedSynced || []).includes(f.clientId));
        if (!mine.length) return b;
        const fed = mine.reduce((t, f) => t + (f.kg || 0), 0);
        const sp = mine.reduce((t, f) => t + (f.spoiledKg || 0), 0);
        const fin = mine.find((f) => f.finished === 'Yes');
        return { ...b, fedKg: r1(b.fedKg + fed), spoiledKg: r1(b.spoiledKg + sp), finished: b.finished || !!fin, finishedOn: b.finishedOn || (fin ? fin.date : ''),
          remainingKg: b.finished || fin ? 0 : Math.max(0, r1(b.remainingKg - fed - sp)), pendingFeeds: mine.length };
      }).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    }

    async function refresh(loud) {
      if (!navigator.onLine || !getSession()) { if (loud) toast('Batches update when online and signed in', 'info'); return false; }
      try {
        const data = await callServer({ action: 'listFodder' });
        if (!Array.isArray(data.batches)) throw new Error('reply has no batch list');
        server = { batches: data.batches, densities: data.densities || {}, allocations: data.allocations || {}, defaultDensity: data.defaultDensity || DEFAULT_DENSITY, serverTime: data.serverTime };
        await db.kv.put({ key: 'fodderList', value: server });
        renderAll();
        if (loud) toast('Batches updated', 'info');
        return true;
      } catch (err) {
        if (loud) toast('Could not update: ' + (err.message || err), 'error');
        return false;
      }
    }

    function nextBatchId(date) {
      const stem = 'F' + date.slice(2, 4) + date.slice(5, 7) + date.slice(8, 10) + '-';
      let max = 0;
      allBatches().forEach((b) => { if (b.batchId && b.batchId.startsWith(stem)) max = Math.max(max, parseInt(b.batchId.slice(stem.length), 10) || 0); });
      return stem + String(max + 1).padStart(3, '0');
    }

    /* ================= views ================= */

    function setView(view) {
      $$('.fod-view-btn').forEach((b) => {
        const on = b.dataset.view === view;
        b.setAttribute('aria-pressed', String(on));
        b.classList.toggle('bg-lime-700', on); b.classList.toggle('text-white', on);
        b.classList.toggle('bg-white', !on); b.classList.toggle('text-lime-800', !on);
      });
      show($('#fod-view-feed'), view === 'feed');
      show($('#fod-view-list'), view === 'list');
      show($('#fod-view-new'), view === 'new');
      if (view === 'new') updateBatchForm();
    }

    function renderAll() { fillFeedBatches(); renderList(); renderFeedRecent(); updateFeed(); updateBatchForm(); }

    /* ================= feed-out ================= */

    function label(b) { return `${b.name || b.type} · ${fmtDate(b.date)}`; }

    function fillFeedBatches() {
      const sel = $('#fo-batch');
      const keep = sel.value;
      const open = allBatches().filter((b) => !b.finished);
      sel.innerHTML = open.length ? open.map((b) => `<option value="${esc(b.batchId)}">${esc(label(b))} · ~${esc(tonnes(b.remainingKg))} left</option>`).join('')
        : '<option value="">No open batches — add one under New batch</option>';
      if (keep && open.some((b) => b.batchId === keep)) sel.value = keep;
      prefillUnit();
    }

    /** Weight of one sack / bag for this batch: remembered, or the batch's average bag weight. */
    function prefillUnit() {
      const b = allBatches().find((x) => x.batchId === $('#fo-batch').value);
      if (b && !$('#fo-unit').dataset.touched) $('#fo-unit').value = /bags/.test(b.type) ? 'bags' : /bales/.test(b.type) ? 'bales' : 'sacks';
      const unit = $('#fo-unit').value;
      const key = (b ? b.batchId : '') + '|' + unit;
      const el = $('#fo-kgper');
      if (unit === 'kg') { el.value = 1; }
      else if (unitKg[key]) el.value = unitKg[key];
      else if (b && b.avgUnitKg && unit === (b.unitName || 'bags')) el.value = b.avgUnitKg;
      else if (el.dataset.auto !== '0') el.value = '';
      show($('#fo-kgper-wrap'), unit !== 'kg');
      updateFeed();
    }

    function updateFeed() {
      const units = num($('#fo-units').value);
      const per = $('#fo-unit').value === 'kg' ? 1 : num($('#fo-kgper').value);
      const b = allBatches().find((x) => x.batchId === $('#fo-batch').value);
      let t = units > 0 && per > 0 ? `= ${kgs(units * per)}` : '';
      if (b) {
        t += `${t ? ' · ' : ''}batch: ${tonnes(b.fedKg)} fed of ~${tonnes(b.estimatedKg)}${b.kgPerDay ? `, ${kgs(b.kgPerDay)}/day, ~${b.daysLeft} days left` : ''}`;
      }
      $('#fo-kg').textContent = t;
      $('#fo-kgper-hint').textContent = per > 0 ? '' : 'Weigh one full sack / barrow once on the hanging scale; it is remembered.';
    }

    async function handleFeed(e) {
      e.preventDefault();
      setError('#fo-error', '');
      if (!getSession()) { toast('Sign in first', 'error'); return; }
      const date = $('#fo-date').value;
      const b = allBatches().find((x) => x.batchId === $('#fo-batch').value);
      const unit = $('#fo-unit').value;
      const units = $('#fo-units').value.trim() === '' ? 0 : num($('#fo-units').value);
      const per = unit === 'kg' ? 1 : num($('#fo-kgper').value);
      const spoiled = $('#fo-spoiled').value.trim() === '' ? 0 : num($('#fo-spoiled').value);
      const finished = $('#fo-finished').checked;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > todayLocal()) { setError('#fo-error', 'Pick the date (not in the future).'); return; }
      if (!b) { setError('#fo-error', 'Choose the batch (add it under New batch first).'); return; }
      if (date < b.date) { setError('#fo-error', 'The date is before this batch was made.'); return; }
      if (units === null || units < 0) { setError('#fo-error', 'How many were taken out?'); return; }
      if (units > 0 && !(per > 0)) { setError('#fo-error', `Enter the weight of one ${unit.replace(/s$/, '')} (weigh one once).`); return; }
      if (spoiled === null || spoiled < 0) { setError('#fo-error', 'Thrown away must be kg, or blank.'); return; }
      if (!(units > 0) && !(spoiled > 0) && !finished) { setError('#fo-error', 'Enter what was taken out.'); return; }
      const kg = r1(units * (per || 0));
      if (kg > b.remainingKg * 1.5 + 50 && !confirm(`${kgs(kg)} is much more than the ~${kgs(b.remainingKg)} estimated left. Save anyway?`)) return;
      if (finished && !confirm(`Mark ${label(b)} as finished? No more feed-outs can be recorded for it, and the actual figures are worked out.`)) return;
      const rec = { ...baseRecord(), date, batchId: b.batchId, units, unitName: unit, kgPerUnit: unit === 'kg' ? 1 : per || '', kg, spoiledKg: spoiled || '',
        finished: finished ? 'Yes' : '', notes: $('#fo-notes').value.trim().slice(0, 300) };
      try {
        await db[FEED_STORE].add(rec);
        if (unit !== 'kg' && per > 0) { unitKg[b.batchId + '|' + unit] = per; await db.kv.put({ key: 'fodderUnitKg', value: unitKg }); }
        toast(`Saved: ${kgs(kg)} from ${b.name || b.type}${finished ? ' · batch finished' : ''}`);
        ['#fo-units', '#fo-spoiled', '#fo-notes'].forEach((s) => { $(s).value = ''; });
        $('#fo-finished').checked = false;
        requestSync('new-record', saveDebounceMs);
      } catch (err) { setError('#fo-error', 'Could not save on this phone: ' + (err.message || err)); }
    }

    function renderFeedRecent() {
      const names = Object.fromEntries(allBatches().map((b) => [b.batchId, b.name || b.type]));
      const list = localFeeds.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 8);
      const chip = (st) => st === SYNC_STATUS.SYNCED ? '<span class="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-farm-100 text-farm-800">Synced</span>'
        : st === SYNC_STATUS.FAILED ? '<span class="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-red-100 text-red-700">Retrying</span>'
          : '<span class="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-calf-100 text-calf-700">Pending</span>';
      $('#fo-recent').innerHTML = list.length ? list.map((f) => `
        <li class="flex items-center justify-between gap-3 bg-white rounded-xl px-4 py-3 shadow-sm">
          <div class="min-w-0"><p class="font-semibold text-sm truncate">${esc(names[f.batchId] || f.batchId)} · ${esc(kgs(f.kg))}</p>
            <p class="text-xs text-slate-500 truncate">${esc(fmtDate(f.date))} · ${f.units} ${esc(f.unitName)}${f.spoiledKg ? ` · ${f.spoiledKg} kg thrown away` : ''}${f.finished ? ' · <b>finished</b>' : ''}</p>
            ${f.syncStatus === SYNC_STATUS.FAILED && f.lastError ? `<p class="text-xs text-red-600">${esc(f.lastError)}</p>` : ''}</div>
          <div class="flex items-center gap-2 shrink-0">${chip(f.syncStatus)}
            ${f.syncStatus !== SYNC_STATUS.SYNCED ? `<button type="button" class="fo-del text-slate-400 hover:text-red-600 text-lg leading-none px-1" data-id="${f.id}" aria-label="Delete">&times;</button>` : ''}</div>
        </li>`).join('') : '<li class="text-sm text-slate-400 px-1">Nothing fed out on this phone yet.</li>';
    }

    /* ================= batch list ================= */

    function renderList() {
      const list = allBatches();
      const dens = (server && server.densities) || {};
      $('#fod-dens').textContent = Object.keys(dens).length ? 'Your packing density so far: ' + Object.keys(dens).map((t) => `${t.replace(/ \(.*\)/, '')} ${dens[t]} kg/m³`).join(' · ') : '';
      $('#fod-list').innerHTML = list.length ? list.map((b) => {
        const est = b.estimatedKg || 0;
        const used = est > 0 ? Math.min(100, Math.round((b.fedKg + b.spoiledKg) / est * 100)) : 0;
        const status = b.finished ? `<span class="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">Finished ${esc(fmtDate(b.finishedOn))}</span>`
          : b.notUploaded ? '<span class="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-calf-100 text-calf-700">Not uploaded</span>'
            : b.daysLeft !== '' && b.daysLeft < 14 ? `<span class="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-red-100 text-red-700">${b.daysLeft} days left</span>`
              : b.daysLeft !== '' ? `<span class="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-lime-100 text-lime-800">~${b.daysLeft} days left</span>` : '';
        const actual = b.finished && b.actualCostPerKgFed !== undefined ? `
            <p>Actually fed <b>${tonnes(b.fedKg)}</b> of ~${tonnes(est)} estimated · loss ${b.lossPct !== '' ? Math.round(b.lossPct * 100) + '%' : '—'}${b.actualDensity ? ` · your density <b>${b.actualDensity} kg/m³</b>` : ''}</p>
            ${b.actualCostPerKgFed !== '' ? `<p>Actual cost per kg fed: <b>${money(b.actualCostPerKgFed)}</b></p>` : ''}` : '';
        return `<li class="bg-white rounded-xl shadow-sm px-4 py-3 space-y-1 text-xs text-slate-600">
          <div class="flex items-start justify-between gap-2"><p class="font-semibold text-sm text-slate-900">${esc(b.name || b.type)}</p>${status}</div>
          <p>${esc(b.batchId)} · ${esc(b.type)} · ${esc(fmtDate(b.date))}${b.plot ? ' · ' + esc(b.plot) : ''}${b.acres ? ` · ${b.acres} acre${b.acres === 1 ? '' : 's'}` : ''}</p>
          <p>Estimated <b>${tonnes(est)}</b>${b.method === 'Measure pile' ? ` (${b.volumeM3 ?? r2(volume(b.shape, b.lengthM, b.baseWidthM, b.topWidthM, b.heightM) || 0)} m³ × ${b.density} kg/m³)` : b.units ? ` (${b.units} ${esc(b.unitName)} × ${b.avgUnitKg} kg)` : ''}${b.tonnesPerAcre ? ` · ${b.tonnesPerAcre} t/acre` : ''}</p>
          ${b.cost !== null && b.cost !== undefined ? `<p>Cost ${money(b.cost)}${b.costPerTonne ? ` · <b>${money(b.costPerTonne)}</b> per tonne · ${money(b.costPerKg)} per kg` : ''}</p>` : ''}
          <div class="h-2 bg-slate-100 rounded-full overflow-hidden" aria-label="${used}% used"><div class="h-2 bg-lime-600" style="width:${used}%"></div></div>
          <p>Fed ${tonnes(b.fedKg)}${b.spoiledKg ? ` · thrown away ${kgs(b.spoiledKg)}` : ''}${!b.finished ? ` · ~${tonnes(b.remainingKg)} left` : ''}${b.kgPerDay ? ` · ${kgs(b.kgPerDay)} a day` : ''}${b.pendingFeeds ? ` · ${b.pendingFeeds} feed-out(s) not uploaded` : ''}</p>
          ${actual}
        </li>`;
      }).join('') : '<li class="text-sm text-slate-400 px-1">No batches yet. Add your current silage under New batch.</li>';
    }

    /* ================= new batch ================= */

    function fillStatic() {
      $('#fb-type').innerHTML = TYPES.map((t) => `<option>${esc(t)}</option>`).join('');
      $('#fo-unit').innerHTML = UNITS.map((u) => `<option>${esc(u)}</option>`).join('');
    }

    function suggestedDensity(type) {
      const d = server && server.densities && server.densities[type];
      return d || (server && server.defaultDensity) || DEFAULT_DENSITY;
    }

    function onType() {
      const type = $('#fb-type').value;
      $('#fb-method').value = isPile(type) ? 'Measure pile' : 'Count x sample weight';
      $('#fb-unitname').value = /bales/.test(type) ? 'bales' : 'bags';
      if ($('#fb-density').dataset.touched !== '1') $('#fb-density').value = suggestedDensity(type);
      updateBatchForm();
    }

    function readBatch() {
      const method = $('#fb-method').value;
      const type = $('#fb-type').value;
      const shape = $('#fb-shape').value;
      const L = num($('#fb-length').value), W = num($('#fb-width').value), T = num($('#fb-top').value), H = num($('#fb-height').value);
      const density = num($('#fb-density').value);
      const units = num($('#fb-units').value);
      const s = samples($('#fb-samples').value);
      const avg = s.length ? r1(s.reduce((t, x) => t + x, 0) / s.length) : null;
      const vol = method === 'Measure pile' ? volume(shape, L, W, shape === 'Flat top' ? T : 0, H) : null;
      const est = method === 'Measure pile' ? (vol && density ? Math.round(vol * density) : null) : (units > 0 && avg ? Math.round(units * avg) : null);
      const lines = costRows.filter((c) => c.checked && c.share > 0);
      const other = num($('#fb-other').value) || 0;
      const cost = r2(lines.reduce((t, c) => t + c.amount * c.share / 100, 0) + other);
      return { method, type, shape, L, W, T, H, density, units, s, avg, vol, est, lines, other, cost, acres: num($('#fb-acres').value) };
    }

    function updateBatchForm() {
      if (!$('#fb-form')) return;
      const x = readBatch();
      const pile = x.method === 'Measure pile';
      show($('#fb-pile'), pile);
      show($('#fb-count'), !pile);
      show($('#fb-top-wrap'), pile && x.shape === 'Flat top');
      const d = server && server.densities && server.densities[x.type];
      $('#fb-density-hint').textContent = d ? `Your own density from finished piles: ${d} kg/m³.` : 'No finished pile yet: 450 kg/m³ is a fair start for hand / trampled packing.';
      $('#fb-calc').textContent = pile
        ? (x.vol ? `Volume ${r2(x.vol)} m³ × ${x.density || '?'} kg/m³` : 'Enter length, base width and height (metres).')
        : (x.avg ? `Average of ${x.s.length} weighed: ${x.avg} kg × ${x.units || '?'} = ` : 'Type the weights of the bags you weighed, e.g. 52, 48, 55.');
      const el = $('#fb-summary');
      if (!x.est) { el.innerHTML = '<p class="text-slate-500">The estimate and cost per tonne appear here.</p>'; return; }
      el.innerHTML = `<div class="grid grid-cols-2 gap-x-3 gap-y-1">
          <span class="text-slate-500">Estimated</span><span class="text-right font-semibold">${tonnes(x.est)}</span>
          ${x.acres > 0 ? `<span class="text-slate-500">Per acre</span><span class="text-right">${r2(x.est / 1000 / x.acres)} t</span>` : ''}
          <span class="text-slate-500">Cost (${x.lines.length} expense${x.lines.length === 1 ? '' : 's'}${x.other ? ' + other' : ''})</span><span class="text-right">${money(x.cost)}</span>
        </div>${x.cost > 0 ? `<p class="mt-2 text-lg font-bold text-lime-900">${money(r2(x.cost / x.est * 1000))} per tonne · ${money(r2(x.cost / x.est))} per kg</p>` : ''}`;
    }

    /** Expenses that can be charged to the batch (Fodder production by default). */
    async function findCosts() {
      const from = $('#fb-cost-from').value;
      const to = $('#fb-date').value || todayLocal();
      const all = $('#fb-cost-all').checked;
      if (!from || from > to) { toast('Choose a "costs from" date before the batch date', 'error'); return; }
      const btn = $('#fb-cost-find');
      btn.disabled = true; btn.textContent = 'Finding…';
      let lines = null;
      if (navigator.onLine && getSession()) {
        try {
          const r = await callServer({ action: 'listExpenses', from, to, group: all ? 'ALL' : 'Fodder production' });
          lines = r.lines;
        } catch (err) { toast('Could not reach the sheet: showing this phone\'s expenses', 'info'); }
      }
      if (!lines) {
        lines = localExpenses.filter((x) => x.date >= from && x.date <= to && (all || x.group === 'Fodder production'));
      }
      const alloc = (server && server.allocations) || {};
      const pendingAlloc = {};
      localBatches.filter((b) => b.syncStatus !== SYNC_STATUS.SYNCED).forEach((b) => String(b.costLines || '').split(';').forEach((p) => { const [id, sh] = p.split(':'); if (id) pendingAlloc[id] = (pendingAlloc[id] || 0) + Number(sh); }));
      costRows = lines.filter((x) => !(all && /^(Animal purchases)$/.test(x.group))).map((x) => {
        const used = (alloc[x.expenseId] || 0) + (pendingAlloc[x.expenseId] || 0);
        const left = Math.max(0, 100 - used);
        return { expenseId: x.expenseId, date: x.date, category: x.category, item: x.item, amount: x.amount, used, share: left, checked: left > 0 && (all ? x.group === 'Fodder production' : true) };
      }).sort((a, b) => (a.date < b.date ? -1 : 1));
      renderCosts();
      btn.disabled = false; btn.textContent = 'Find costs';
    }

    function renderCosts() {
      $('#fb-costs').innerHTML = costRows.length ? costRows.map((c, i) => `
        <li class="flex items-center gap-2 text-xs ${c.used >= 100 ? 'opacity-50' : ''}">
          <input type="checkbox" class="fb-cost-chk" data-i="${i}" ${c.checked ? 'checked' : ''} ${c.used >= 100 ? 'disabled' : ''} aria-label="Include ${esc(c.expenseId)}" />
          <span class="flex-1 min-w-0"><span class="block truncate font-semibold">${esc(c.item || c.category)} · ${money(c.amount)}</span>
            <span class="block truncate text-slate-500">${esc(fmtDate(c.date))} · ${esc(c.category)}${c.used ? ` · ${c.used}% already in other batches` : ''}</span></span>
          <input type="number" class="fb-cost-share hf-input !w-20 !py-1 !px-2 text-right" data-i="${i}" min="1" max="${Math.max(1, 100 - c.used)}" value="${c.share}" aria-label="Share %" /><span>%</span>
        </li>`).join('') : '<li class="text-xs text-slate-500">No expenses found for these dates. Tick "all groups" or add costs below.</li>';
      updateBatchForm();
    }

    function validateBatch() {
      const x = readBatch();
      const date = $('#fb-date').value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > todayLocal()) return { error: 'Pick the date it was made (not in the future).' };
      if (x.acres !== null && !(x.acres > 0)) return { error: 'Acres must be above 0, or blank.' };
      if (x.method === 'Measure pile') {
        if (!(x.L > 0 && x.W > 0 && x.H > 0)) return { error: 'Enter the pile\'s length, base width and height in metres.' };
        if (x.L > 200 || x.W > 50 || x.H > 10) return { error: 'Those measurements look too big: use metres.' };
        if (x.shape === 'Flat top' && !(x.T >= 0 && x.T <= x.W)) return { error: 'Top width must be between 0 and the base width.' };
        if (!(x.density >= 150 && x.density <= 1200)) return { error: 'Density should be 150–1,200 kg per m³ (450 if unsure).' };
      } else {
        if (!(x.units > 0) || Math.round(x.units) !== x.units) return { error: 'How many bags / bales? (a whole number)' };
        if (!x.s.length) return { error: 'Weigh a few bags / bales and type their weights, e.g. 52, 48, 55.' };
      }
      for (const c of x.lines) if (!(c.share >= 1 && c.share <= 100 - c.used + 0.001)) return { error: `${c.expenseId}: share must be 1–${100 - c.used}%.` };
      if (x.other < 0) return { error: 'Other costs cannot be negative.' };
      const warnings = [];
      if (!x.lines.length && !x.other) warnings.push('No costs chosen: the cost per tonne will be blank. You can still save.');
      if (x.method === 'Count x sample weight' && x.s.length < 3) warnings.push('Weighing at least 3 bags gives a better average.');
      return { x, date, warnings };
    }

    async function handleBatch(e) {
      e.preventDefault();
      setError('#fb-error', '');
      if (!getSession()) { toast('Sign in first', 'error'); return; }
      const v = validateBatch();
      if (v.error) { setError('#fb-error', v.error); return; }
      if (v.warnings.length && !confirm(v.warnings.join('\n') + '\n\nSave anyway?')) return;
      const { x, date } = v;
      const pile = x.method === 'Measure pile';
      const rec = { ...baseRecord(), batchId: nextBatchId(date), date, type: x.type, name: $('#fb-name').value.trim().slice(0, 80), plot: $('#fb-plot').value.trim().slice(0, 80),
        acres: x.acres || '', method: x.method, shape: pile ? x.shape : '', lengthM: pile ? x.L : '', baseWidthM: pile ? x.W : '', topWidthM: pile && x.shape === 'Flat top' ? x.T : '',
        heightM: pile ? x.H : '', volumeM3: pile ? r2(x.vol) : '', density: pile ? x.density : '', units: pile ? '' : x.units, unitName: pile ? '' : $('#fb-unitname').value,
        sampleWeights: pile ? '' : x.s.join(', '), avgUnitKg: pile ? '' : x.avg, estimatedKg: x.est,
        costLines: x.lines.map((c) => `${c.expenseId}:${r2(c.share)}`).join(';'), otherCost: x.other || '', notes: $('#fb-notes').value.trim().slice(0, 300), localCost: x.cost };
      try {
        await db[BATCH_STORE].add(rec);
        toast(`Batch ${rec.batchId} saved: ~${tonnes(rec.estimatedKg)}${x.cost > 0 ? ` at ${money(r2(x.cost / x.est * 1000))}/t` : ''}`);
        ['#fb-name', '#fb-length', '#fb-width', '#fb-top', '#fb-height', '#fb-units', '#fb-samples', '#fb-other', '#fb-notes'].forEach((s) => { $(s).value = ''; });
        costRows = []; renderCosts();
        requestSync('new-record', saveDebounceMs);
        setView('list');
      } catch (err) { setError('#fb-error', 'Could not save on this phone: ' + (err.message || err)); }
    }

    /** Server renamed a batch ID (taken): follow it in this phone's feed-outs. */
    async function applyRename(storeName, rec, renamed) {
      if (storeName !== BATCH_STORE || !renamed || !renamed.value) return;
      await db[BATCH_STORE].update(rec.id, { batchId: renamed.value });
      await db[FEED_STORE].where('batchId').equals(rec.batchId).modify({ batchId: renamed.value });
      toast(`${rec.batchId} was already used: saved as ${renamed.value}`, 'info');
    }

    /* ================= init ================= */

    function init() {
      fillStatic();
      const t = todayLocal();
      ['#fo-date', '#fb-date'].forEach((s) => { $(s).value = t; $(s).max = t; });
      const d = new Date(); d.setMonth(d.getMonth() - 9);
      $('#fb-cost-from').value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
      $('#fb-density').value = DEFAULT_DENSITY;
      $$('.fod-view-btn').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
      $('#tab-fodder').addEventListener('click', () => refresh(false));
      $('#fod-refresh').addEventListener('click', () => refresh(true));
      // feed-out
      $('#fo-form').addEventListener('submit', handleFeed);
      $('#fo-batch').addEventListener('change', () => { $('#fo-kgper').dataset.auto = '1'; prefillUnit(); });
      $('#fo-unit').addEventListener('change', () => { $('#fo-unit').dataset.touched = '1'; $('#fo-kgper').dataset.auto = '1'; prefillUnit(); });
      $('#fo-kgper').addEventListener('input', () => { $('#fo-kgper').dataset.auto = '0'; updateFeed(); });
      $('#fo-units').addEventListener('input', updateFeed);
      $('#fo-recent').addEventListener('click', async (e) => {
        const b = e.target.closest('.fo-del');
        if (!b || !confirm('Delete this feed-out from the phone? It has not been uploaded yet.')) return;
        const rec = await db[FEED_STORE].get(Number(b.dataset.id));
        if (rec && rec.syncStatus !== SYNC_STATUS.SYNCED) { await db[FEED_STORE].delete(rec.id); toast('Deleted', 'info'); }
      });
      // new batch
      $('#fb-form').addEventListener('submit', handleBatch);
      $('#fb-type').addEventListener('change', onType);
      $('#fb-density').addEventListener('input', () => { $('#fb-density').dataset.touched = '1'; updateBatchForm(); });
      ['#fb-method', '#fb-shape', '#fb-unitname'].forEach((s) => $(s).addEventListener('change', updateBatchForm));
      ['#fb-length', '#fb-width', '#fb-top', '#fb-height', '#fb-units', '#fb-samples', '#fb-other', '#fb-acres'].forEach((s) => $(s).addEventListener('input', updateBatchForm));
      $('#fb-cost-find').addEventListener('click', findCosts);
      $('#fb-costs').addEventListener('change', (e) => {
        const i = Number(e.target.dataset.i);
        if (!costRows[i]) return;
        if (e.target.classList.contains('fb-cost-chk')) costRows[i].checked = e.target.checked;
        updateBatchForm();
      });
      $('#fb-costs').addEventListener('input', (e) => {
        const i = Number(e.target.dataset.i);
        if (costRows[i] && e.target.classList.contains('fb-cost-share')) { costRows[i].share = num(e.target.value) || 0; updateBatchForm(); }
      });

      // When feed-outs or batches finish uploading, fetch the server's totals again (they now include them).
      let syncedSeen = -1;
      const watchSynced = () => {
        const n = localFeeds.concat(localBatches).filter((x) => x.syncStatus === SYNC_STATUS.SYNCED).length;
        if (syncedSeen >= 0 && n > syncedSeen) refresh(false);
        syncedSeen = n;
      };
      Dexie.liveQuery(() => db[BATCH_STORE].toArray()).subscribe({ next: (r) => { localBatches = r; renderAll(); watchSynced(); } });
      Dexie.liveQuery(() => db[FEED_STORE].toArray()).subscribe({ next: (r) => { localFeeds = r; renderAll(); watchSynced(); } });
      Dexie.liveQuery(() => db.expenses.toArray()).subscribe({ next: (r) => { localExpenses = r; } });
      db.kv.get('fodderList').then((x) => { if (x && x.value) { server = x.value; $('#fb-density').value = suggestedDensity($('#fb-type').value); renderAll(); } }).catch(() => {});
      db.kv.get('fodderUnitKg').then((x) => { if (x && x.value) unitKg = x.value; prefillUnit(); }).catch(() => {});
      setView('feed');
      onType();
    }

    return Object.freeze({ init, refresh, applyRename });
  }

  window.MaweFodder = Object.freeze({ create, BATCH_STORE, FEED_STORE, PAYLOAD, TYPES, volume });
})();
