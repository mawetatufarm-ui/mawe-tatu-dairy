/* =====================================================================
 * Mawe Tatu Dairy — health.js (Herd tab → Health, v5.7)
 * ---------------------------------------------------------------------
 * Animal health, recorded offline: treatments, vaccinations, deworming,
 * spraying / dipping, mastitis checks (CMT), vet visits.
 *
 *   • MILK WITHDRAWAL: a treatment with a milk withdrawal period makes
 *     the cow's milk "do not sell" until the end of the last course day
 *     + the withdrawal days. A red banner on the Milk tab (and when that
 *     cow is chosen) and on the Sales tab says whose milk must not be
 *     sold and until when.
 *   • Routines: the next deworming / spraying / vaccination date (the form
 *     suggests 90 days for deworming, 7 for spraying) and follow-ups come
 *     back in "Due in the next 3 weeks".
 *   • Drugs used before are remembered with their withdrawal days, so the
 *     label is read once. Whole-herd routines: "All animals" saves one
 *     record per animal.
 *   • A cost is saved as an expense (Animal health: vet services, drugs &
 *     dewormers, vaccines or acaricides & spraying) for that animal.
 *   • Edit or cancel: before upload the record is changed or deleted on
 *     the phone; after upload a correction is queued (Corrections.gs,
 *     audit in Record_Changes).
 * The calculations (hlthModel) are the same code as Health.gs —
 * generated from src/health_model.js by build_breeding.py.
 *
 * Store (Dexie v9 in app.js): `health_events` → Health_Events, append
 * only, never pruned. kv 'healthList' caches the server's listHealth.
 * IDs: HE + YYMMDD + -NNN.
 * Loaded by index.html after herd.js and expenses.js, before app.js;
 * defines window.MaweHealth.
 * ===================================================================== */

(() => {
  'use strict';

  /* ---- HEALTH MODEL (shared: copied into Health.gs and health.js by build_breeding.py — edit here only) ----
   * hlthModel(events, animals, today) → { animals: [...], due: [...], withheld: [...], drugs: [...], people: [...] }
   *   events:  [{ eventId, date, animalId, eventType, condition, drug, dose, courseDays, milkWithdrawalDays, meatWithdrawalDays,
   *               quarters, cmt, treatedBy, nextDue, expenseId, notes }]  (cancelled ones already removed)
   *   animals: active farm animals [{ animalId, name, category, sex, milkingStatus }]
   * Rules (agreed 23 Nov 2026):
   *   • Withdrawal counts from the LAST day of the course: last = date + courseDays − 1; milk is withheld
   *     to the end of last + milk withdrawal days (whole days, a safety margin of up to a day).
   *   • Routines (deworming, spraying / dipping, vaccination) are due on the "next due" date entered
   *     (the form suggests 90 days for deworming, 7 for spraying); due until a newer one of that kind.
   *   • 2+ mastitis cases (treatment for mastitis or a positive CMT) in 12 months = repeat mastitis.
   */
  var HLTH_TYPES = ['Treatment', 'Vaccination', 'Deworming', 'Spraying / dipping', 'Mastitis check (CMT)', 'Vet visit', 'Other'];
  var HLTH_ROUTINE = ['Vaccination', 'Deworming', 'Spraying / dipping'];
  var HLTH_SUGGEST_NEXT = { 'Deworming': 90, 'Spraying / dipping': 7 };
  var HLTH_DUE_DAYS = 21;

  function hlthDay(k) { var p = String(k).split('-'); return Math.round(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])) / 86400000); }
  function hlthKey(n) { return new Date(n * 86400000).toISOString().slice(0, 10); }
  function hlthAdd(k, d) { return hlthKey(hlthDay(k) + d); }
  function hlthNum(v) { var n = Number(v); return v === '' || v === null || v === undefined || !isFinite(n) ? 0 : n; }

  /** Last day withheld for milk / meat, or '' — the same sum the sheet stores. */
  function hlthUntil(e, which) {
    var days = hlthNum(which === 'meat' ? e.meatWithdrawalDays : e.milkWithdrawalDays);
    if (!(days > 0) || !e.date) return '';
    var course = Math.max(1, hlthNum(e.courseDays) || 1);
    return hlthAdd(e.date, course - 1 + days);
  }
  function hlthIsMastitis(e) {
    if (/mastitis/i.test(String(e.condition || ''))) return true;
    // CMT stored as "FL:Neg FR:1 RL:Neg RR:T": any quarter T (trace), 1, 2 or 3 counts.
    return e.eventType === 'Mastitis check (CMT)' && String(e.cmt || '').split(/\s+/).some(function (p) { return /:(T|1|2|3)$/i.test(p); });
  }

  function hlthModel(events, animals, today) {
    var byAnimal = {};
    var drugs = {};
    var people = {};
    (events || []).forEach(function (e) {
      if (!e || !e.animalId || !e.date) return;
      (byAnimal[e.animalId] = byAnimal[e.animalId] || []).push(e);
      if (e.drug) {
        var k = String(e.drug).trim().toLowerCase();
        if (!drugs[k] || e.date >= drugs[k].date) drugs[k] = { drug: String(e.drug).trim(), date: e.date, milkWithdrawalDays: e.milkWithdrawalDays, meatWithdrawalDays: e.meatWithdrawalDays, dose: e.dose || '', eventType: e.eventType };
      }
      if (e.treatedBy) people[String(e.treatedBy).trim()] = true;
    });
    var yearAgo = hlthAdd(today, -365);
    var out = [];
    var due = [];
    var withheld = [];
    (animals || []).forEach(function (a) {
      var evs = (byAnimal[a.animalId] || []).slice().sort(function (x, y) { return x.date < y.date ? -1 : x.date > y.date ? 1 : 0; });
      var milkUntil = '', milkDrug = '', meatUntil = '';
      evs.forEach(function (e) {
        var m = hlthUntil(e, 'milk'), t = hlthUntil(e, 'meat');
        if (m && m > milkUntil) { milkUntil = m; milkDrug = e.drug || e.condition || e.eventType; }
        if (t && t > meatUntil) meatUntil = t;
      });
      var last = {};
      evs.forEach(function (e) { if (HLTH_ROUTINE.indexOf(e.eventType) !== -1) last[e.eventType] = e; });
      var items = [];
      Object.keys(last).forEach(function (t) { if (last[t].nextDue) items.push({ date: last[t].nextDue, action: t, kind: 'routine', type: t }); });
      // Follow-ups on treatments / visits (a next-due date after the latest event of that animal).
      evs.forEach(function (e) {
        if (HLTH_ROUTINE.indexOf(e.eventType) === -1 && e.nextDue && !evs.some(function (x) { return x !== e && x.date > e.date && x.date <= e.nextDue && x.eventType === e.eventType; })) {
          items.push({ date: e.nextDue, action: 'Follow-up: ' + (e.condition || e.eventType), kind: 'follow', type: e.eventType });
        }
      });
      items.forEach(function (it) {
        var away = hlthDay(it.date) - hlthDay(today);
        if (away <= HLTH_DUE_DAYS && away >= -120) due.push({ date: it.date, animalId: a.animalId, name: a.name, action: it.action, type: it.type, daysAway: away, overdue: away < 0 });
      });
      var mast = evs.filter(function (e) { return e.date >= yearAgo && hlthIsMastitis(e); });
      var flags = [];
      if (mast.length >= 2) flags.push('Repeat mastitis: ' + mast.length + ' cases in 12 months');
      var isWithheld = milkUntil && today <= milkUntil;
      if (isWithheld && (a.milkingStatus === 'Lactating' || a.category === 'Cow')) withheld.push({ animalId: a.animalId, name: a.name, until: milkUntil, drug: milkDrug, sellFrom: hlthAdd(milkUntil, 1) });
      out.push({
        animalId: a.animalId, name: a.name, category: a.category, milkingStatus: a.milkingStatus,
        milkWithheldUntil: isWithheld ? milkUntil : '', milkDrug: isWithheld ? milkDrug : '', meatWithheldUntil: meatUntil && today <= meatUntil ? meatUntil : '',
        lastDeworming: last['Deworming'] ? last['Deworming'].date : '', lastSpraying: last['Spraying / dipping'] ? last['Spraying / dipping'].date : '',
        lastVaccination: last['Vaccination'] ? last['Vaccination'].date + (last['Vaccination'].drug ? ' (' + last['Vaccination'].drug + ')' : '') : '',
        treatments12m: evs.filter(function (e) { return e.date >= yearAgo && (e.eventType === 'Treatment' || e.eventType === 'Vet visit'); }).length,
        mastitis12m: mast.length, flags: flags, events: evs.length, lastEvent: evs.length ? evs[evs.length - 1].date : '',
      });
    });
    due.sort(function (x, y) { return x.date < y.date ? -1 : x.date > y.date ? 1 : 0; });
    withheld.sort(function (x, y) { return x.name < y.name ? -1 : 1; });
    return {
      animals: out, due: due, withheld: withheld,
      drugs: Object.keys(drugs).map(function (k) { return drugs[k]; }).sort(function (x, y) { return x.drug.localeCompare(y.drug); }),
      people: Object.keys(people).sort(),
    };
  }
  /* ---- END HEALTH MODEL ---- */

  const STORE = 'health_events';
  const SHEET = 'Health_Events';
  const PAYLOAD = Object.freeze({
    [STORE]: ['clientId', 'deviceId', 'eventId', 'date', 'animalId', 'eventType', 'condition', 'drug', 'dose', 'courseDays', 'milkWithdrawalDays', 'meatWithdrawalDays',
      'milkUntil', 'meatUntil', 'quarters', 'cmt', 'treatedBy', 'nextDue', 'expenseId', 'notes', 'recordedBy', 'createdAt'],
  });
  const EDITABLE = ['date', 'condition', 'drug', 'dose', 'courseDays', 'milkWithdrawalDays', 'meatWithdrawalDays', 'quarters', 'cmt', 'treatedBy', 'nextDue', 'notes'];
  const CONDITIONS = ['Mastitis', 'Milk fever', 'East Coast Fever (ECF)', 'Anaplasmosis', 'Babesiosis (redwater)', 'Pneumonia', 'Diarrhoea / scours', 'Foot rot / lameness',
    'Bloat', 'Retained placenta', 'Metritis', 'Wound', 'Eye infection', 'Worms', 'Ticks', 'Lumpy skin disease', 'Other'];
  const COST_CATEGORY = { 'Treatment': 'Drugs & dewormers', 'Vet visit': 'Vet services', 'Vaccination': 'Vaccines', 'Deworming': 'Drugs & dewormers',
    'Spraying / dipping': 'Acaricides & spraying', 'Mastitis check (CMT)': 'Drugs & dewormers', 'Other': 'Vet services' };
  const ALL = '__all__';

  function create(deps) {
    const { db, SYNC_STATUS, getSession, getDeviceId, makeUUID, todayLocal, esc, toast, requestSync, saveDebounceMs, callServer, expenses, queueCorrection } = deps;
    const $ = (s) => document.querySelector(s);
    const $$ = (s) => [...document.querySelectorAll(s)];
    const show = (el, v) => el && el.classList.toggle('hidden', !v);
    const num = (v) => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
    const fmt = (k) => { if (!k) return ''; const [y, m, d] = String(k).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }); };
    const money = (x) => 'KES ' + Number(x || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    let server = null;  // { events }
    let local = [];     // health_events on this phone
    let animals = [];
    let editing = null; // the event being corrected

    /* ================= data ================= */

    function allEvents() {
      const srv = ((server && server.events) || []).map((e) => { const l = local.find((x) => x.clientId === e.clientId); return l && l.syncStatus !== SYNC_STATUS.SYNCED ? { ...e, ...l } : e; }); // once uploaded, the sheet's copy wins (it has corrections from any phone)
      const ids = new Set(srv.map((e) => e.clientId));
      return srv.concat(local.filter((e) => !ids.has(e.clientId))).filter((e) => !e.voided && e.status !== 'Void');
    }
    function farmAnimals() {
      return animals.filter((a) => a.herd === 'farm' && a.status === 'Active')
        .sort((a, b) => (a.category === 'Cow' ? 0 : 1) - (b.category === 'Cow' ? 0 : 1) || a.animalId.localeCompare(b.animalId));
    }
    const nameOf = (id) => { const a = animals.find((x) => x.animalId === id); return a ? a.name : id; };
    function model() { return hlthModel(allEvents(), farmAnimals(), todayLocal()); }

    async function refresh(loud) {
      if (!navigator.onLine || !getSession()) { if (loud) toast('Updates when online and signed in', 'info'); return false; }
      try {
        const r = await callServer({ action: 'listHealth' });
        if (!Array.isArray(r.events)) throw new Error('reply has no event list');
        server = { events: r.events, serverTime: r.serverTime };
        await db.kv.put({ key: 'healthList', value: server });
        render();
        if (loud) toast('Health records updated', 'info');
        return true;
      } catch (err) {
        if (loud) toast('Could not update: ' + (err.message || err), 'error');
        return false;
      }
    }

    function nextEventId(date, extra = []) {
      const stem = 'HE' + date.slice(2, 4) + date.slice(5, 7) + date.slice(8, 10) + '-';
      let max = 0;
      allEvents().concat(extra).forEach((e) => { if (e.eventId && e.eventId.startsWith(stem)) max = Math.max(max, parseInt(e.eventId.slice(stem.length), 10) || 0); });
      return stem + String(max + 1).padStart(3, '0');
    }

    /** For other screens: is this cow's milk withheld today? → { until, sellFrom, drug } or null. */
    function withdrawalFor(animalId) {
      const w = model().withheld.find((x) => x.animalId === animalId);
      return w || null;
    }

    /* ================= banners (Milk and Sales tabs) ================= */

    function renderBanners(m) {
      const list = m.withheld;
      const text = list.map((w) => `<b>${esc(w.name)}</b> until ${esc(fmt(w.until))} (${esc(w.drug)})`).join(' · ');
      ['#hl-sales-banner', '#hl-milk-banner'].forEach((sel) => {
        const el = $(sel);
        if (!el) return;
        el.innerHTML = list.length ? `⚠️ Milk NOT to be sold: ${text}. Keep it apart, record it as usual.` : '';
        show(el, list.length > 0);
      });
      milkCowWarning();
    }
    function milkCowWarning() {
      const el = $('#hl-milk-cow');
      const sel = $('#milk-cowId');
      if (!el || !sel) return;
      const w = withdrawalFor(sel.value);
      el.innerHTML = w ? `Do not sell ${esc(w.name)}'s milk: withdrawal until ${esc(fmt(w.until))} (${esc(w.drug)}). Can be sold from ${esc(fmt(w.sellFrom))}.` : '';
      show(el, !!w);
    }

    /* ================= view ================= */

    function render() {
      if (!$('#health-view')) return;
      const m = model();
      renderBanners(m);
      const today = todayLocal();
      $('#hl-withheld').innerHTML = m.withheld.length ? m.withheld.map((w) => `
        <li class="bg-red-50 text-red-800 rounded-xl px-4 py-2 text-sm"><b>${esc(w.name)}</b>: milk not to be sold until <b>${esc(fmt(w.until))}</b> · ${esc(w.drug)} · sell again from ${esc(fmt(w.sellFrom))}</li>`).join('')
        : '<li class="text-sm text-slate-400 px-1">No milk withheld today.</li>';
      const flags = m.animals.filter((a) => a.flags.length);
      $('#hl-due').innerHTML = m.due.length || flags.length ? m.due.map((d) => `
        <li class="flex items-center justify-between gap-3 bg-white rounded-xl px-4 py-3 shadow-sm ${d.overdue ? 'ring-2 ring-red-200' : ''}">
          <div class="min-w-0"><p class="font-semibold text-sm">${esc(d.name)} · ${esc(d.action)}</p>
            <p class="text-xs ${d.overdue ? 'text-red-700 font-semibold' : 'text-slate-500'}">${esc(fmt(d.date))} · ${d.daysAway === 0 ? 'today' : d.daysAway > 0 ? `in ${d.daysAway} day${d.daysAway === 1 ? '' : 's'}` : `${-d.daysAway} days ago`}${d.overdue ? ' · overdue' : ''}</p></div>
          <button type="button" class="hl-do shrink-0 rounded-lg bg-teal-700 text-white text-xs font-semibold px-3 py-1.5" data-animal="${esc(d.animalId)}" data-type="${esc(d.type)}">Record</button>
        </li>`).join('') + flags.map((a) => `<li class="bg-amber-50 text-amber-900 rounded-xl px-4 py-2 text-xs"><b>${esc(a.name)}:</b> ${a.flags.map(esc).join(' · ')}</li>`).join('')
        : '<li class="text-sm text-slate-400 px-1">Nothing due in the next 3 weeks.</li>';
      $('#hl-animals').innerHTML = m.animals.length ? m.animals.map((a) => {
        const lines = [];
        if (a.milkWithheldUntil) lines.push(`<span class="text-red-700 font-semibold">Milk withheld until ${esc(fmt(a.milkWithheldUntil))}</span>`);
        const r = [a.lastDeworming && `dewormed ${fmt(a.lastDeworming)}`, a.lastSpraying && `sprayed ${fmt(a.lastSpraying)}`, a.lastVaccination && `vaccinated ${fmt(a.lastVaccination.slice(0, 10))}${a.lastVaccination.length > 10 ? a.lastVaccination.slice(10) : ''}`].filter(Boolean);
        if (r.length) lines.push(esc(r.join(' · ')));
        if (a.treatments12m || a.mastitis12m) lines.push(`${a.treatments12m} treatment${a.treatments12m === 1 ? '' : 's'} in 12 months${a.mastitis12m ? ` · ${a.mastitis12m} mastitis` : ''}`);
        if (!lines.length) lines.push('No health records yet.');
        return `<li class="bg-white rounded-xl shadow-sm" data-animal="${esc(a.animalId)}">
          <button type="button" class="hl-animal w-full text-left px-4 py-3 space-y-1">
            <span class="flex items-center justify-between gap-2"><span class="font-semibold text-sm">${esc(a.name)} <span class="text-xs text-slate-400">${esc(a.animalId)} · ${esc(a.category)}</span></span>
              ${a.milkWithheldUntil ? '<span class="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-red-100 text-red-700">Withheld</span>' : ''}</span>
            ${lines.map((l) => `<span class="block text-xs text-slate-600">${l}</span>`).join('')}
            ${a.flags.length ? `<span class="block text-xs text-amber-800">${a.flags.map(esc).join(' · ')}</span>` : ''}
          </button>
          <div class="hl-hist hidden px-4 pb-3 text-xs text-slate-600"></div>
        </li>`;
      }).join('') : '<li class="text-sm text-slate-400 px-1">No animals in the herd register yet.</li>';
      fillLists(m);
    }

    function historyHtml(id) {
      const evs = allEvents().filter((e) => e.animalId === id).sort((a, b) => (a.date < b.date ? 1 : -1));
      const pending = new Set(local.filter((e) => e.syncStatus !== SYNC_STATUS.SYNCED).map((e) => e.clientId));
      return (evs.length ? `<ul class="space-y-2">${evs.map((e) => `<li class="border-t border-slate-100 pt-1">
          ${esc(fmt(e.date))} · <b>${esc(e.eventType)}</b>${e.condition ? ' · ' + esc(e.condition) : ''}${e.drug ? ' · ' + esc(e.drug) : ''}${e.dose ? ' (' + esc(e.dose) + ')' : ''}
          ${e.milkWithdrawalDays ? ` · milk withdrawal ${e.milkWithdrawalDays} d → ${esc(fmt(hlthUntil(e, 'milk')))}` : ''}${e.quarters ? ' · ' + esc(e.quarters) : ''}${e.cmt ? ' · CMT ' + esc(e.cmt) : ''}
          ${e.treatedBy ? ' · by ' + esc(e.treatedBy) : ''}${e.nextDue ? ' · next ' + esc(fmt(e.nextDue)) : ''}${e.notes ? ' · ' + esc(e.notes) : ''}
          ${pending.has(e.clientId) ? ' <span class="text-amber-700">(not uploaded)</span>' : ''}
          <span class="flex gap-3 mt-1"><button type="button" class="hl-edit text-teal-700 font-semibold" data-id="${esc(e.clientId)}">Edit</button>
          <button type="button" class="hl-cancel text-slate-500" data-id="${esc(e.clientId)}">${pending.has(e.clientId) ? 'Delete' : 'Cancel'}</button></span></li>`).join('')}</ul>`
        : '<p>No health records yet.</p>') +
        `<button type="button" class="hl-do mt-2 rounded-lg bg-teal-700 text-white font-semibold px-3 py-1.5" data-animal="${esc(id)}" data-type="Treatment">Record for ${esc(nameOf(id))}</button>`;
    }

    /* ================= form ================= */

    function fillLists(m) {
      const sel = $('#hl-animal');
      const keep = sel.value;
      sel.innerHTML = `<option value="${ALL}">All animals (whole herd)</option>` + farmAnimals().map((a) => `<option value="${esc(a.animalId)}">${esc(a.name)} (${esc(a.animalId)}) · ${esc(a.category)}</option>`).join('');
      sel.value = keep || (farmAnimals()[0] ? farmAnimals()[0].animalId : ALL);
      $('#hl-drug-list').innerHTML = m.drugs.map((d) => `<option value="${esc(d.drug)}"></option>`).join('');
      $('#hl-by-list').innerHTML = m.people.map((p) => `<option value="${esc(p)}"></option>`).join('');
      $('#hl-condition-list').innerHTML = CONDITIONS.map((c) => `<option value="${esc(c)}"></option>`).join('');
    }

    function openForm(type, animalId, ev) {
      editing = ev || null;
      show($('#hl-form'), true);
      show($('#hl-main'), false);
      $('#hl-type').value = ev ? ev.eventType : (type || 'Treatment');
      $('#hl-type').disabled = !!ev;
      if (animalId) $('#hl-animal').value = animalId;
      $('#hl-animal').disabled = !!ev;
      const v = ev || {};
      $('#hl-date').value = v.date || todayLocal();
      $('#hl-condition').value = v.condition || '';
      $('#hl-drug').value = v.drug || '';
      $('#hl-dose').value = v.dose || '';
      $('#hl-course').value = v.courseDays || (ev ? '' : 1);
      $('#hl-milkdays').value = v.milkWithdrawalDays === 0 || v.milkWithdrawalDays ? v.milkWithdrawalDays : '';
      $('#hl-meatdays').value = v.meatWithdrawalDays === 0 || v.meatWithdrawalDays ? v.meatWithdrawalDays : '';
      $('#hl-by').value = v.treatedBy || '';
      $('#hl-next').value = v.nextDue || '';
      $('#hl-notes').value = v.notes || '';
      $('#hl-cost').value = '';
      $$('.hl-q').forEach((c) => { c.checked = String(v.quarters || '').split(/\s+/).includes(c.value); });
      const cmt = {};
      String(v.cmt || '').split(/\s+/).forEach((p) => { const [q, r] = p.split(':'); if (q && r) cmt[q] = r; });
      $$('.hl-cmt').forEach((s) => { s.value = cmt[s.dataset.q] || 'Neg'; });
      $('#hl-reason').value = '';
      $('#hl-title').textContent = ev ? `Correct ${ev.eventType.toLowerCase()} · ${nameOf(ev.animalId)}` : 'Record animal health';
      $('#hl-next').dataset.touched = ev ? '1' : '';
      setError('');
      onType();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    function closeForm() { editing = null; $('#hl-type').disabled = false; $('#hl-animal').disabled = false; show($('#hl-form'), false); show($('#hl-main'), true); render(); }
    function setError(msg) { const el = $('#hl-error'); el.textContent = msg || ''; show(el, !!msg); }

    function onType() {
      const t = $('#hl-type').value;
      const routine = HLTH_ROUTINE.includes(t);
      show($('#hl-condition-wrap'), t === 'Treatment' || t === 'Vet visit' || t === 'Other');
      show($('#hl-drug-wrap'), t !== 'Mastitis check (CMT)');
      show($('#hl-withdrawal'), t !== 'Mastitis check (CMT)');
      show($('#hl-quarters-wrap'), t === 'Treatment');
      show($('#hl-cmt-wrap'), t === 'Mastitis check (CMT)');
      show($('#hl-cost-wrap'), !editing);
      show($('#hl-reason-wrap'), !!editing);
      $('#hl-drug-label').textContent = t === 'Vaccination' ? 'Vaccine' : t === 'Spraying / dipping' ? 'Acaricide' : 'Drug';
      $('#hl-next-label').textContent = routine ? `Next ${t.toLowerCase()} due` : 'Follow-up date (optional)';
      if (!$('#hl-next').dataset.touched && HLTH_SUGGEST_NEXT[t]) $('#hl-next').value = hlthAdd($('#hl-date').value || todayLocal(), HLTH_SUGGEST_NEXT[t]);
      else if (!$('#hl-next').dataset.touched) $('#hl-next').value = '';
      $('#hl-next-hint').textContent = t === 'Vaccination' ? 'Ask your vet: e.g. FMD is often every 6 months, others yearly.' : routine ? 'Suggested; change it to your routine.' : '';
      // The "All animals" choice is only for routines.
      const allOpt = $('#hl-animal').querySelector(`option[value="${ALL}"]`);
      if (allOpt) allOpt.disabled = !routine;
      if (!routine && $('#hl-animal').value === ALL && farmAnimals()[0]) $('#hl-animal').value = farmAnimals()[0].animalId;
      updateEffect();
    }

    /** Drug chosen: fill its withdrawal days and dose from the last time it was used. */
    function onDrug() {
      const d = model().drugs.find((x) => x.drug.toLowerCase() === $('#hl-drug').value.trim().toLowerCase());
      if (!d) { updateEffect(); return; }
      if ($('#hl-milkdays').value === '' && d.milkWithdrawalDays !== '' && d.milkWithdrawalDays !== undefined) $('#hl-milkdays').value = d.milkWithdrawalDays;
      if ($('#hl-meatdays').value === '' && d.meatWithdrawalDays !== '' && d.meatWithdrawalDays !== undefined) $('#hl-meatdays').value = d.meatWithdrawalDays;
      if (!$('#hl-dose').value && d.dose) $('#hl-dose').value = d.dose;
      $('#hl-drug-hint').textContent = `Last used ${fmt(d.date)}: milk withdrawal ${d.milkWithdrawalDays || 0} days. Check the label if unsure.`;
      updateEffect();
    }

    function readForm() {
      const t = $('#hl-type').value;
      const quarters = $$('.hl-q').filter((c) => c.checked).map((c) => c.value).join(' ');
      const cmt = t === 'Mastitis check (CMT)' ? $$('.hl-cmt').map((s) => `${s.dataset.q}:${s.value}`).join(' ') : '';
      const n = (sel) => { const v = $(sel).value.trim(); return v === '' ? '' : num(v); };
      return { eventType: t, date: $('#hl-date').value, condition: $('#hl-condition').value.trim().slice(0, 80), drug: t === 'Mastitis check (CMT)' ? '' : $('#hl-drug').value.trim().slice(0, 80),
        dose: $('#hl-dose').value.trim().slice(0, 80), courseDays: t === 'Mastitis check (CMT)' ? '' : n('#hl-course'), milkWithdrawalDays: t === 'Mastitis check (CMT)' ? '' : n('#hl-milkdays'),
        meatWithdrawalDays: t === 'Mastitis check (CMT)' ? '' : n('#hl-meatdays'), quarters: t === 'Treatment' ? quarters : '', cmt, treatedBy: $('#hl-by').value.trim().slice(0, 80),
        nextDue: $('#hl-next').value, notes: $('#hl-notes').value.trim().slice(0, 300) };
    }

    function updateEffect() {
      const f = readForm();
      const until = hlthUntil(f, 'milk');
      const who = $('#hl-animal').value === ALL ? 'every milking cow' : nameOf($('#hl-animal').value);
      $('#hl-effect').textContent = until ? `Milk from ${who} must not be sold until the end of ${fmt(until)} (the last course day + ${f.milkWithdrawalDays} days). It can be sold again from ${fmt(hlthAdd(until, 1))}.`
        : f.milkWithdrawalDays === 0 ? 'No milk withdrawal.' : ($('#hl-withdrawal').classList.contains('hidden') ? '' : 'Enter the milk withdrawal days from the label (0 if none).');
    }

    function validate(f, animalId) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date) || f.date > todayLocal()) return 'Pick the date (not in the future).';
      if (!animalId) return 'Choose the animal.';
      for (const k of ['courseDays', 'milkWithdrawalDays', 'meatWithdrawalDays']) {
        if (f[k] !== '' && (f[k] === null || f[k] < 0 || Math.round(f[k]) !== f[k] || f[k] > (k === 'courseDays' ? 30 : 120))) return 'Days must be whole numbers (course 1–30, withdrawal 0–120).';
      }
      if (f.courseDays === 0) return 'The course is at least 1 day.';
      if (f.nextDue && f.nextDue < f.date) return 'The next date cannot be before this one.';
      if (f.eventType === 'Treatment' && !f.drug && !f.condition) return 'Say what was treated or which drug was used.';
      return '';
    }

    async function handleSubmit(e) {
      e.preventDefault();
      setError('');
      if (!getSession()) { toast('Sign in first', 'error'); return; }
      const f = readForm();
      const target = editing ? editing.animalId : $('#hl-animal').value;
      const err = validate(f, target);
      if (err) { setError(err); return; }
      if (['Treatment', 'Deworming', 'Spraying / dipping'].includes(f.eventType) && f.drug && f.milkWithdrawalDays === '' &&
        !confirm('No milk withdrawal entered. If the label gives one, enter it so the milk is held back. Save without it?')) return;
      const btn = $('#hl-form button[type="submit"]');
      btn.disabled = true;
      try {
        if (editing) await saveEdit(f);
        else await saveNew(f, target);
        closeForm();
      } catch (er) {
        setError('Could not save on this phone: ' + (er.message || er));
      } finally {
        btn.disabled = false;
      }
    }

    async function saveNew(f, target) {
      const list = target === ALL ? farmAnimals().map((a) => a.animalId) : [target];
      const recs = [];
      list.forEach((id) => {
        const rec = { ...baseRecord(), ...f, animalId: id, expenseId: '', milkUntil: '', meatUntil: '' };
        rec.eventId = nextEventId(f.date, recs);
        rec.milkUntil = hlthUntil(rec, 'milk'); rec.meatUntil = hlthUntil(rec, 'meat');
        recs.push(rec);
      });
      const cost = num($('#hl-cost').value) || 0;
      if (cost > 0 && expenses) {
        const now = new Date().toISOString();
        const s = getSession();
        const exp = { clientId: makeUUID(), deviceId: getDeviceId(), recordedBy: s ? s.email : '', createdAt: now, updatedAt: now, syncStatus: SYNC_STATUS.PENDING, syncAttempts: 0, lastError: null, syncedAt: null,
          expenseId: expenses.nextId(f.date), date: f.date, group: 'Animal health', category: COST_CATEGORY[f.eventType] || 'Vet services',
          item: [f.drug, f.condition].filter(Boolean).join(' · ').slice(0, 80) || f.eventType, quantity: '', unit: '', unitPrice: '', amount: Math.round(cost * 100) / 100,
          paymentMethod: $('#hl-costmethod').value, paymentStatus: 'Paid', amountPaid: Math.round(cost * 100) / 100, dueDate: '', receiptRef: '',
          payee: f.treatedBy, animalId: list.length === 1 ? list[0] : '', notes: `Health ${recs[0].eventId}${list.length > 1 ? ` (${list.length} animals)` : ''}` };
        await db.expenses.add(exp);
        recs.forEach((r) => { r.expenseId = exp.expenseId; });
      }
      await db[STORE].bulkAdd(recs);
      const until = hlthUntil(recs[0], 'milk');
      toast(`Saved: ${f.eventType}${list.length > 1 ? ` for ${list.length} animals` : ' · ' + nameOf(list[0])}${until ? ` · milk withheld until ${fmt(until)}` : ''}${cost > 0 ? ' · cost in Expenses' : ''}`);
      requestSync('new-record', saveDebounceMs);
    }

    async function saveEdit(f) {
      const ev = editing;
      const changes = {};
      EDITABLE.forEach((k) => { if (String(f[k] ?? '') !== String(ev[k] ?? '')) changes[k] = f[k]; });
      if (!Object.keys(changes).length) throw new Error('Nothing was changed.');
      const mine = local.find((x) => x.clientId === ev.clientId);
      if (mine && mine.syncStatus !== SYNC_STATUS.SYNCED) {
        const upd = { ...changes, updatedAt: new Date().toISOString() };
        const merged = { ...mine, ...upd };
        upd.milkUntil = hlthUntil(merged, 'milk'); upd.meatUntil = hlthUntil(merged, 'meat');
        await db[STORE].update(mine.id, upd);
        toast('Changed on this phone (not uploaded yet)');
      } else {
        const reason = $('#hl-reason').value.trim();
        if (!reason) throw new Error('Give a short reason for the correction.');
        await queueCorrection({ sheet: SHEET, id: ev.eventId, changes, reason });
        await mirror(ev, changes);
        toast('Correction saved: uploads with the next sync');
      }
    }

    /** Show a correction straight away: change the phone's copy (or the cached server copy). */
    async function mirror(ev, changes) {
      const mine = local.find((x) => x.clientId === ev.clientId);
      if (mine) await db[STORE].update(mine.id, changes);
      if (server && server.events) {
        server.events = server.events.map((x) => (x.clientId === ev.clientId ? { ...x, ...changes } : x));
        await db.kv.put({ key: 'healthList', value: server });
      }
      render();
    }

    async function cancelEvent(clientId) {
      const ev = allEvents().find((x) => x.clientId === clientId);
      if (!ev) return;
      const mine = local.find((x) => x.clientId === clientId);
      if (mine && mine.syncStatus !== SYNC_STATUS.SYNCED) {
        if (!confirm(`Delete this ${ev.eventType.toLowerCase()} for ${nameOf(ev.animalId)}? It has not been uploaded yet.`)) return;
        await db[STORE].delete(mine.id);
        toast('Deleted', 'info');
        return;
      }
      const reason = prompt(`Cancel this ${ev.eventType.toLowerCase()} for ${nameOf(ev.animalId)} (${fmt(ev.date)})? It stays in the sheet marked Void.\n\nReason:`);
      if (reason === null) return;
      if (!reason.trim()) { toast('A reason is needed to cancel', 'error'); return; }
      await queueCorrection({ sheet: SHEET, id: ev.eventId, changes: {}, void: true, reason: reason.trim().slice(0, 300) });
      await mirror(ev, { voided: true });
      toast('Cancelled: uploads with the next sync', 'info');
    }

    function baseRecord() {
      const now = new Date().toISOString();
      const s = getSession();
      return { clientId: makeUUID(), deviceId: getDeviceId(), recordedBy: s ? s.email : '', createdAt: now, updatedAt: now, syncStatus: SYNC_STATUS.PENDING, syncAttempts: 0, lastError: null, syncedAt: null };
    }

    async function applyRename(storeName, rec, renamed) {
      if (storeName !== STORE || !renamed || !renamed.value) return;
      await db[STORE].update(rec.id, { eventId: renamed.value });
    }

    /* ================= init ================= */

    function init() {
      $$('.herd-view-btn[data-view="health"]').forEach((b) => b.addEventListener('click', () => { render(); refresh(false); }));
      $('#hl-add').addEventListener('click', () => openForm('Treatment'));
      $('#hl-refresh').addEventListener('click', () => refresh(true));
      $('#hl-cancel-form').addEventListener('click', closeForm);
      $('#hl-form').addEventListener('submit', handleSubmit);
      $('#hl-type').addEventListener('change', onType);
      $('#hl-animal').addEventListener('change', updateEffect);
      $('#hl-drug').addEventListener('change', onDrug);
      $('#hl-drug').addEventListener('input', () => { $('#hl-drug-hint').textContent = ''; updateEffect(); });
      ['#hl-course', '#hl-milkdays', '#hl-date'].forEach((s) => $(s).addEventListener('input', () => { if (s === '#hl-date') onType(); else updateEffect(); }));
      $('#hl-next').addEventListener('input', () => { $('#hl-next').dataset.touched = '1'; });
      $('#health-view').addEventListener('click', (e) => {
        const d = e.target.closest('.hl-do');
        if (d) { openForm(d.dataset.type, d.dataset.animal); return; }
        const ed = e.target.closest('.hl-edit');
        if (ed) { const ev = allEvents().find((x) => x.clientId === ed.dataset.id); if (ev) openForm(ev.eventType, ev.animalId, ev); return; }
        const c = e.target.closest('.hl-cancel');
        if (c) { cancelEvent(c.dataset.id); return; }
        const a = e.target.closest('.hl-animal');
        if (a) {
          const li = a.closest('li');
          const h = li.querySelector('.hl-hist');
          const open = h.classList.contains('hidden');
          if (open) h.innerHTML = historyHtml(li.dataset.animal);
          show(h, open);
        }
      });
      const milkSel = $('#milk-cowId');
      if (milkSel) milkSel.addEventListener('change', milkCowWarning);
      // After a milking is saved the app moves to the next cow by itself (no change event): check again.
      const milkForm = milkSel && milkSel.form;
      if (milkForm) milkForm.addEventListener('submit', () => setTimeout(milkCowWarning, 300));
      Dexie.liveQuery(() => db[STORE].toArray()).subscribe({ next: (r) => { local = r; render(); } });
      Dexie.liveQuery(() => db.animals.toArray()).subscribe({ next: (a) => { animals = a; render(); } });
      db.kv.get('healthList').then((x) => { if (x && x.value) { server = x.value; render(); } }).catch(() => {});
    }

    return Object.freeze({ init, refresh, applyRename, withdrawalFor, model });
  }

  window.MaweHealth = Object.freeze({ create, STORE, PAYLOAD });
})();
