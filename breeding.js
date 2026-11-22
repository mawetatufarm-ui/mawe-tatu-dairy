/* =====================================================================
 * Mawe Tatu Dairy — breeding.js (Herd tab → Breeding, v5.6)
 * ---------------------------------------------------------------------
 * Breeding and calving for every cow and heifer, recorded offline:
 *   heat seen · service (AI or bull: sire, semen type, inseminator, and
 *   the AI cost as an expense) · pregnancy check · dry-off · calving
 *   (adds the live calf to the herd register) · abortion / loss.
 *
 * Each event also updates the cow in the herd register through herd.js:
 *   pregnancy check Pregnant → In-calf (with the sire); Not pregnant or a
 *   loss → Open; dry-off → Dry; calving → Cow, Lactating, Open.
 *
 * The view shows what is due (repeat-heat watch, pregnancy checks, dry
 * off, calvings, cows ready to serve), AI costs recorded in Expenses that
 * are not yet a service, and a card per cow with her status and history.
 * The calculations (brdModel, below) are the same code as Breeding.gs —
 * generated from src/breeding_model.js by build_breeding.py.
 *
 * Store (Dexie v8 in app.js): `breeding_events` → Breeding_Events tab,
 * append only, never pruned (a few dozen a year). kv 'breedingList' keeps
 * the server's listBreeding reply (events from other phones, AI costs).
 * IDs: BR + YYMMDD + -NNN; if taken the server adds a letter (applyRename).
 *
 * Loaded by index.html after herd.js and expenses.js, before app.js;
 * defines window.MaweBreeding.
 * ===================================================================== */

(() => {
  'use strict';

  /* ---- BREEDING MODEL (shared: copied into Breeding.gs and breeding.js by build_breeding.py — edit here only) ----
   * brdModel(events, cows, today) → { cows: [...], calendar: [...], herd: {...} }
   *   events: [{ eventId, date, animalId, eventType, method, sireId, sireCode, semenType, technician, result,
   *              calvingEase, calfSex, calfWeightKg, calfOutcome, calfId, expenseId, notes }]
   *   cows:   farm females (Cow / Heifer, Active): [{ animalId, name, category, milkingStatus, pregnancyStatus }]
   *   today:  'YYYY-MM-DD'
   * Rules (agreed 22 Nov 2026, standard for dairy cattle):
   *   gestation 283 days; dry off 60 days before calving; heat cycle 21 days (repeat heat 18–24 days after a
   *   service); pregnancy check from 45 days after service; first service from 45 days after calving; a cow not
   *   in calf 100 days after calving needs attention; 3+ services without conception = repeat breeder.
   */
  var BRD_RULES = { gestation: 283, dryBefore: 60, cycle: 21, heatFrom: 18, heatTo: 24, pdFrom: 45, waitAfterCalving: 45, openAlert: 100, repeatServices: 3,
    calendarDays: 120, calvingWarn: 14 };
  var BRD_TYPES = ['Heat', 'Service', 'Pregnancy check', 'Dry-off', 'Calving', 'Abortion / loss'];
  var BRD_ORDER = { 'Calving': 0, 'Abortion / loss': 1, 'Dry-off': 2, 'Heat': 3, 'Service': 4, 'Pregnancy check': 5 };

  function brdDay(k) { var p = String(k).split('-'); return Math.round(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])) / 86400000); }
  function brdKey(n) { return new Date(n * 86400000).toISOString().slice(0, 10); }
  function brdAdd(k, days) { return brdKey(brdDay(k) + days); }
  function brdDiff(a, b) { return brdDay(a) - brdDay(b); }
  var BRD_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function brdShort(k) { var p = String(k).split('-'); return Number(p[2]) + ' ' + BRD_MONTHS[Number(p[1]) - 1]; }
  function brdSire(s) { return s ? (s.sireId || s.sireCode || (s.method === 'Bull' ? 'farm bull' : '')) : ''; }

  function brdModel(events, cows, today) {
    var R = BRD_RULES;
    var byCow = {};
    (events || []).forEach(function (e) {
      if (!e || !e.animalId || !e.date || !BRD_ORDER.hasOwnProperty(e.eventType)) return;
      (byCow[e.animalId] = byCow[e.animalId] || []).push(e);
    });
    var outCows = [];
    var calendar = [];
    var allHistory = [];

    (cows || []).forEach(function (cow) {
      var evs = (byCow[cow.animalId] || []).slice().sort(function (a, b) {
        return a.date < b.date ? -1 : a.date > b.date ? 1 : BRD_ORDER[a.eventType] - BRD_ORDER[b.eventType];
      });
      var calvings = [];
      var history = [];
      var cycle = { start: '', services: [], pregnant: null, conception: null, pd: null, lastHeat: '', dryOff: '', losses: 0 };
      var lastHeat = '';
      evs.forEach(function (e) {
        if (e.eventType === 'Calving') {
          var conc = cycle.conception;
          if (!conc) { // the service 265–300 days before calving, else the last one
            for (var i = cycle.services.length - 1; i >= 0; i--) {
              var d = brdDiff(e.date, cycle.services[i].date);
              if (d >= 265 && d <= 300) { conc = cycle.services[i]; break; }
            }
            if (!conc && cycle.services.length) conc = cycle.services[cycle.services.length - 1];
          }
          if (cycle.start) {
            var concIdx = conc ? cycle.services.indexOf(conc) : -1;
            history.push({ animalId: cow.animalId, name: cow.name, from: cycle.start, conception: conc ? conc.date : '', sire: brdSire(conc),
              daysOpen: conc ? brdDiff(conc.date, cycle.start) : '', services: concIdx >= 0 ? concIdx + 1 : cycle.services.length,
              calving: e.date, interval: brdDiff(e.date, cycle.start) });
          }
          calvings.push(e);
          cycle = { start: e.date, services: [], pregnant: null, conception: null, pd: null, lastHeat: '', dryOff: '', losses: 0 };
        } else if (e.eventType === 'Abortion / loss') {
          cycle.services = []; cycle.pregnant = null; cycle.conception = null; cycle.pd = null; cycle.dryOff = ''; cycle.losses += 1; cycle.lossDate = e.date;
        } else if (e.eventType === 'Service') {
          cycle.services.push(e); cycle.pregnant = null; cycle.conception = null; cycle.pd = null;
        } else if (e.eventType === 'Pregnancy check') {
          cycle.pd = e;
          if (e.result === 'Pregnant') {
            cycle.pregnant = true;
            var before = cycle.services.filter(function (s) { return s.date <= e.date; });
            cycle.conception = before.length ? before[before.length - 1] : null;
          } else if (e.result === 'Not pregnant') { cycle.pregnant = false; cycle.conception = null; }
        } else if (e.eventType === 'Heat') {
          lastHeat = e.date; cycle.lastHeat = e.date;
          // A heat after a service (and no positive check since) means that service did not hold.
          if (cycle.services.length && cycle.pregnant !== true && e.date > cycle.services[cycle.services.length - 1].date) cycle.pregnant = false;
        } else if (e.eventType === 'Dry-off') {
          cycle.dryOff = e.date;
        }
      });

      var lastCalving = calvings.length ? calvings[calvings.length - 1].date : '';
      var lastService = cycle.services.length ? cycle.services[cycle.services.length - 1] : null;
      var notHeld = cycle.services.filter(function (s) { return s !== cycle.conception; }).length;
      var flags = [];
      var status, next = '', nextDate = '', expected = '', dryDue = '';
      var items = [];
      var add = function (date, action, kind) { items.push({ date: date, action: action, kind: kind }); };

      if (cycle.pregnant === true && cycle.conception) {
        expected = brdAdd(cycle.conception.date, R.gestation);
        dryDue = brdAdd(expected, -R.dryBefore);
        var toCalve = brdDiff(expected, today);
        if (toCalve < -7) status = 'Calving overdue';
        else if (toCalve <= R.calvingWarn) status = 'Calving due';
        else if (cycle.dryOff) status = 'Dry, in calf';
        else if (today >= dryDue) status = 'Due to dry off';
        else status = 'In calf';
        if (!cycle.dryOff && (cow.milkingStatus === 'Lactating' || cow.category === 'Cow')) add(dryDue, 'Dry off', 'dry');
        add(expected, 'Calving expected', 'calving');
      } else if (lastService && cycle.pregnant === null) {
        var since = brdDiff(today, lastService.date);
        expected = brdAdd(lastService.date, R.gestation);
        status = 'Served';
        if (since <= R.heatTo) add(brdAdd(lastService.date, R.cycle), 'Watch for repeat heat (' + brdShort(brdAdd(lastService.date, R.heatFrom)) + ' – ' + brdShort(brdAdd(lastService.date, R.heatTo)) + ')', 'heat');
        add(brdAdd(lastService.date, R.pdFrom), 'Pregnancy check', 'pd');
      } else if (!cycle.services.length && cycle.pregnant === null && cow.pregnancyStatus === 'In-calf' && !(lastCalving && brdDiff(today, lastCalving) < 200)) {
        // In calf in the herd register (e.g. bought in calf) but no service recorded: no dates can be worked out.
        status = 'In calf (date unknown)';
      } else {
        status = 'Open';
        if (lastCalving) {
          var dsc = brdDiff(today, lastCalving);
          if (dsc < R.waitAfterCalving) status = 'Fresh (calved)';
          if (!cycle.services.length) add(brdAdd(lastCalving, R.waitAfterCalving), 'Ready to serve', 'serve');
        }
        var ref = cycle.lastHeat || lastHeat;
        if (ref && brdDiff(today, ref) < 60) {
          var nh = brdAdd(ref, R.cycle);
          while (brdDiff(nh, today) < -3) nh = brdAdd(nh, R.cycle);
          add(nh, 'Next heat expected', 'heat');
        }
      }
      if (lastCalving && cycle.pregnant !== true && status !== 'In calf (date unknown)' && brdDiff(today, lastCalving) > R.openAlert) flags.push('Not in calf ' + brdDiff(today, lastCalving) + ' days after calving');
      if (notHeld >= R.repeatServices && cycle.pregnant !== true) flags.push('Repeat breeder: ' + notHeld + ' services without holding');
      if (cycle.pregnant === false && lastService && !cycle.lastHeat) flags.push('Not pregnant at check: watch for heat and serve again');
      if (cycle.losses) flags.push('Pregnancy lost ' + cycle.lossDate);

      items.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
      var upcoming = items.filter(function (it) { return brdDiff(it.date, today) >= -60; });
      if (upcoming.length) { next = upcoming[0].action; nextDate = upcoming[0].date; }
      upcoming.forEach(function (it) {
        if (brdDiff(it.date, today) <= R.calendarDays) calendar.push({ date: it.date, animalId: cow.animalId, name: cow.name, action: it.action, kind: it.kind,
          overdue: it.date < today && it.kind !== 'heat', daysAway: brdDiff(it.date, today) });
      });

      var intervals = history.filter(function (h) { return h.interval > 0; }).map(function (h) { return h.interval; });
      var opens = history.filter(function (h) { return h.daysOpen !== ''; }).map(function (h) { return h.daysOpen; });
      var avg = function (L) { return L.length ? Math.round(L.reduce(function (t, x) { return t + x; }, 0) / L.length) : ''; };
      history.forEach(function (h) { allHistory.push(h); });

      outCows.push({
        animalId: cow.animalId, name: cow.name, category: cow.category, milkingStatus: cow.milkingStatus, status: status, flags: flags,
        calvingsRecorded: calvings.length, lastCalving: lastCalving,
        dim: lastCalving && cow.milkingStatus !== 'Dry' && !cycle.dryOff ? brdDiff(today, lastCalving) : '',
        daysSinceCalving: lastCalving ? brdDiff(today, lastCalving) : '',
        lastHeat: cycle.lastHeat || lastHeat, servicesThisCycle: cycle.services.length,
        lastService: lastService ? { date: lastService.date, method: lastService.method, sire: brdSire(lastService), sireId: lastService.sireId || '', technician: lastService.technician || '' } : null,
        pregnancyCheck: cycle.pd ? { date: cycle.pd.date, result: cycle.pd.result } : null,
        conceptionDate: cycle.pregnant === true && cycle.conception ? cycle.conception.date : '',
        conceptionSireId: cycle.pregnant === true && cycle.conception ? (cycle.conception.sireId || '') : '',
        sire: cycle.pregnant === true && cycle.conception ? brdSire(cycle.conception) : (lastService ? brdSire(lastService) : ''),
        expectedCalving: expected, expectedIsConfirmed: cycle.pregnant === true, dryOffDue: dryDue, dryOffDone: cycle.dryOff,
        nextAction: next, nextDate: nextDate, avgCalvingInterval: avg(intervals), avgDaysOpen: avg(opens), history: history,
      });
    });

    calendar.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    var conceived = allHistory.filter(function (h) { return h.conception; });
    var svc = conceived.reduce(function (t, h) { return t + (h.services || 1); }, 0);
    var ints = allHistory.filter(function (h) { return h.interval > 0; });
    var opn = allHistory.filter(function (h) { return h.daysOpen !== ''; });
    return {
      cows: outCows, calendar: calendar, history: allHistory,
      herd: {
        cows: outCows.length,
        inCalf: outCows.filter(function (c) { return c.expectedIsConfirmed || c.status === 'In calf (date unknown)'; }).length,
        served: outCows.filter(function (c) { return c.status === 'Served'; }).length,
        open: outCows.filter(function (c) { return c.status === 'Open' || c.status === 'Fresh (calved)'; }).length,
        avgCalvingInterval: ints.length ? Math.round(ints.reduce(function (t, h) { return t + h.interval; }, 0) / ints.length) : '',
        avgDaysOpen: opn.length ? Math.round(opn.reduce(function (t, h) { return t + h.daysOpen; }, 0) / opn.length) : '',
        servicesPerConception: conceived.length ? Math.round(svc / conceived.length * 10) / 10 : '',
      },
    };
  }
  /* ---- END BREEDING MODEL ---- */

  const STORE = 'breeding_events';
  const PAYLOAD = Object.freeze({
    [STORE]: ['clientId', 'deviceId', 'eventId', 'date', 'animalId', 'eventType', 'method', 'sireId', 'sireCode', 'semenType', 'technician', 'result',
      'calvingEase', 'calfSex', 'calfWeightKg', 'calfOutcome', 'calfId', 'expenseId', 'notes', 'recordedBy', 'createdAt'],
  });
  const KIND_TO_TYPE = { heat: 'Heat', pd: 'Pregnancy check', dry: 'Dry-off', calving: 'Calving', serve: 'Service' };
  const STATUS_CHIP = {
    'In calf': 'bg-calf-100 text-calf-700', 'Dry, in calf': 'bg-calf-100 text-calf-700', 'Served': 'bg-sky-100 text-sky-800',
    'Due to dry off': 'bg-amber-100 text-amber-900', 'Calving due': 'bg-amber-100 text-amber-900', 'Calving overdue': 'bg-red-100 text-red-700',
    'Open': 'bg-slate-100 text-slate-700', 'Fresh (calved)': 'bg-farm-100 text-farm-800', 'In calf (date unknown)': 'bg-calf-100 text-calf-700',
  };

  function create(deps) {
    const { db, SYNC_STATUS, getSession, getDeviceId, makeUUID, todayLocal, esc, toast, requestSync, saveDebounceMs, callServer, herd, expenses } = deps;
    const $ = (s) => document.querySelector(s);
    const $$ = (s) => [...document.querySelectorAll(s)];
    const show = (el, v) => el && el.classList.toggle('hidden', !v);
    const num = (v) => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
    const fmt = (k) => { if (!k) return ''; const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }); };
    const money = (x) => 'KES ' + Number(x || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    let server = null;   // { events, unmatchedAi }
    let local = [];      // breeding_events on this phone
    let animals = [];
    let pendingExpenseId = ''; // when recording a service from an AI cost

    /* ================= data ================= */

    function allEvents() {
      const srv = (server && server.events) || [];
      const ids = new Set(srv.map((e) => e.clientId));
      return srv.concat(local.filter((e) => !ids.has(e.clientId)));
    }
    function farmFemales() {
      return animals.filter((a) => a.herd === 'farm' && a.sex === 'Female' && (a.category === 'Cow' || a.category === 'Heifer') && a.status === 'Active')
        .sort((a, b) => a.animalId.localeCompare(b.animalId));
    }
    const nameOf = (id) => { const a = animals.find((x) => x.animalId === id); return a ? a.name : id; };
    const sireLabel = (s) => (s && /^(MT|X)-/.test(s) ? `${nameOf(s)}${animals.find((x) => x.animalId === s && x.aiCode) ? ' · ' + animals.find((x) => x.animalId === s).aiCode : ''}` : s);
    function model() { return brdModel(allEvents(), farmFemales(), todayLocal()); }

    async function refresh(loud) {
      if (!navigator.onLine || !getSession()) { if (loud) toast('Updates when online and signed in', 'info'); return false; }
      try {
        const r = await callServer({ action: 'listBreeding' });
        if (!Array.isArray(r.events)) throw new Error('reply has no event list');
        server = { events: r.events, unmatchedAi: r.unmatchedAi || [], serverTime: r.serverTime };
        await db.kv.put({ key: 'breedingList', value: server });
        render();
        if (loud) toast('Breeding records updated', 'info');
        return true;
      } catch (err) {
        if (loud) toast('Could not update: ' + (err.message || err), 'error');
        return false;
      }
    }

    function nextEventId(date) {
      const stem = 'BR' + date.slice(2, 4) + date.slice(5, 7) + date.slice(8, 10) + '-';
      let max = 0;
      allEvents().forEach((e) => { if (e.eventId && e.eventId.startsWith(stem)) max = Math.max(max, parseInt(e.eventId.slice(stem.length), 10) || 0); });
      return stem + String(max + 1).padStart(3, '0');
    }

    /* ================= view switch (Animals / Breeding) ================= */

    function setView(view) {
      $$('.herd-view-btn').forEach((b) => {
        const on = b.dataset.view === view;
        b.setAttribute('aria-pressed', String(on));
        b.classList.toggle('bg-sky-700', on); b.classList.toggle('text-white', on);
        b.classList.toggle('bg-white', !on); b.classList.toggle('text-sky-800', !on);
      });
      show($('#herd-animals'), view === 'animals');
      show($('#breed-view'), view === 'breeding');
      if (view === 'breeding') { render(); refresh(false); }
    }

    /* ================= rendering ================= */

    function render() {
      if (!$('#breed-view')) return;
      const m = model();
      const today = todayLocal();
      const h = m.herd;
      $('#brd-summary').textContent = `${h.cows} cows and heifers · ${h.inCalf} in calf · ${h.served} served · ${h.open} open` +
        (h.avgCalvingInterval !== '' ? ` · calving interval ${h.avgCalvingInterval} days · ${h.servicesPerConception} services per conception` : '');

      // Due soon / overdue (next 21 days) + attention flags.
      const due = m.calendar.filter((c) => c.daysAway <= 21 && (c.daysAway >= -3 || c.overdue));
      const flags = m.cows.filter((c) => c.flags.length);
      $('#brd-due').innerHTML = due.length || flags.length ? due.map((c) => `
        <li class="flex items-center justify-between gap-3 bg-white rounded-xl px-4 py-3 shadow-sm ${c.overdue ? 'ring-2 ring-red-200' : ''}">
          <div class="min-w-0"><p class="font-semibold text-sm">${esc(c.name)} · ${esc(c.action)}</p>
            <p class="text-xs ${c.overdue ? 'text-red-700 font-semibold' : 'text-slate-500'}">${esc(fmt(c.date))} · ${c.daysAway === 0 ? 'today' : c.daysAway > 0 ? `in ${c.daysAway} day${c.daysAway === 1 ? '' : 's'}` : `${-c.daysAway} days ago`}${c.overdue ? ' · overdue' : ''}</p></div>
          <button type="button" class="brd-do shrink-0 rounded-lg bg-sky-700 text-white text-xs font-semibold px-3 py-1.5" data-cow="${esc(c.animalId)}" data-type="${esc(KIND_TO_TYPE[c.kind] || 'Heat')}">Record</button>
        </li>`).join('') + flags.map((c) => `
        <li class="bg-red-50 text-red-800 rounded-xl px-4 py-2 text-xs"><b>${esc(c.name)}:</b> ${c.flags.map(esc).join(' · ')}</li>`).join('')
        : '<li class="text-sm text-slate-400 px-1">Nothing due in the next 3 weeks.</li>';

      // AI costs recorded in Expenses without a service.
      const recordedIds = new Set(allEvents().map((e) => e.expenseId).filter(Boolean));
      const ai = ((server && server.unmatchedAi) || []).filter((x) => !recordedIds.has(x.expenseId) &&
        !allEvents().some((e) => e.eventType === 'Service' && e.animalId === x.animalId && Math.abs(brdDiff(e.date, x.date)) <= 3));
      show($('#brd-ai-wrap'), ai.length > 0);
      $('#brd-ai').innerHTML = ai.map((x) => `
        <li class="flex items-center justify-between gap-3 bg-sky-50 rounded-xl px-4 py-2">
          <span class="min-w-0 text-xs"><b>${esc(nameOf(x.animalId))}</b> · ${esc(fmt(x.date))} · ${esc(x.item || 'AI')} · ${esc(money(x.amount))}${x.payee ? ' · ' + esc(x.payee) : ''}</span>
          <button type="button" class="brd-ai-use shrink-0 rounded-lg bg-white border border-sky-300 text-sky-800 text-xs font-semibold px-2 py-1" data-id="${esc(x.expenseId)}">Add as service</button>
        </li>`).join('');

      // Cow cards.
      $('#brd-cows').innerHTML = m.cows.length ? m.cows.map((c) => {
        const lines = [];
        if (c.lastCalving) lines.push(`Calved ${fmt(c.lastCalving)}${c.dim !== '' ? ` · ${c.dim} days in milk` : ''}`);
        if (c.lastService) lines.push(`Served ${fmt(c.lastService.date)} · ${esc(c.lastService.method || '')} ${esc(sireLabel(c.lastService.sire))}${c.servicesThisCycle > 1 ? ` · service ${c.servicesThisCycle}` : ''}`);
        if (c.pregnancyCheck) lines.push(`Check ${fmt(c.pregnancyCheck.date)}: ${esc(c.pregnancyCheck.result)}`);
        if (c.expectedCalving) lines.push(`${c.expectedIsConfirmed ? 'Due to calve' : 'Would calve (if held)'} <b>${fmt(c.expectedCalving)}</b>${c.expectedIsConfirmed && c.dryOffDue && !c.dryOffDone ? ` · dry off by ${fmt(c.dryOffDue)}` : ''}`);
        if (c.nextAction && !c.expectedCalving) lines.push(`Next: ${esc(c.nextAction)} ${fmt(c.nextDate)}`);
        if (c.status === 'In calf (date unknown)') lines.push('In calf in the herd list, but no service date recorded. Record the service (even an estimated date) to get calving and dry-off dates.');
        return `<li class="bg-white rounded-xl shadow-sm" data-cow="${esc(c.animalId)}">
          <button type="button" class="brd-cow w-full text-left px-4 py-3 space-y-1">
            <span class="flex items-center justify-between gap-2"><span class="font-semibold text-sm">${esc(c.name)} <span class="text-xs text-slate-400">${esc(c.animalId)} · ${esc(c.category)}</span></span>
              <span class="text-[11px] font-semibold px-2 py-0.5 rounded-full ${STATUS_CHIP[c.status] || 'bg-slate-100 text-slate-700'}">${esc(c.status)}</span></span>
            ${lines.map((l) => `<span class="block text-xs text-slate-600">${l}</span>`).join('')}
            ${c.flags.length ? `<span class="block text-xs text-red-700">${c.flags.map(esc).join(' · ')}</span>` : ''}
          </button>
          <div class="brd-hist hidden px-4 pb-3 text-xs text-slate-600"></div>
        </li>`;
      }).join('') : '<li class="text-sm text-slate-400 px-1">No cows or heifers in the herd register yet.</li>';
      fillCowSelect();
    }

    function historyHtml(id) {
      const evs = allEvents().filter((e) => e.animalId === id).sort((a, b) => (a.date < b.date ? 1 : -1));
      const c = model().cows.find((x) => x.animalId === id);
      const pending = new Set(local.filter((e) => e.syncStatus !== SYNC_STATUS.SYNCED).map((e) => e.clientId));
      const past = c && c.history.length ? `<p class="font-semibold mt-1">Past calvings</p><ul class="list-disc pl-5">${c.history.map((h) =>
        `<li>Calved ${fmt(h.calving)} · ${h.services} service${h.services === 1 ? '' : 's'} · ${h.daysOpen !== '' ? h.daysOpen + ' days open · ' : ''}interval ${h.interval} days</li>`).join('')}</ul>` : '';
      return (evs.length ? `<ul class="space-y-1">${evs.map((e) => `<li>${esc(fmt(e.date))} · <b>${esc(e.eventType)}</b>${detail(e)}${pending.has(e.clientId) ? ' <span class="text-amber-700">(not uploaded)</span>' : ''}</li>`).join('')}</ul>`
        : '<p>No breeding events recorded yet.</p>') + past +
        `<button type="button" class="brd-do mt-2 rounded-lg bg-sky-700 text-white font-semibold px-3 py-1.5" data-cow="${esc(id)}" data-type="Service">Record an event</button>`;
    }
    function detail(e) {
      if (e.eventType === 'Service') return ` · ${esc(e.method)} ${esc(sireLabel(e.sireId) || e.sireCode)}${e.semenType ? ' · ' + esc(e.semenType) : ''}${e.technician ? ' · ' + esc(e.technician) : ''}`;
      if (e.eventType === 'Pregnancy check') return ` · ${esc(e.result)}${e.technician ? ' · ' + esc(e.technician) : ''}`;
      if (e.eventType === 'Calving') return ` · ${esc(e.calfOutcome)} ${esc((e.calfSex || '').toLowerCase())} calf${e.calfWeightKg ? ', ' + e.calfWeightKg + ' kg' : ''}${e.calfId ? ' → ' + esc(nameOf(e.calfId)) + ' (' + esc(e.calfId) + ')' : ''}`;
      return e.notes ? ' · ' + esc(e.notes) : '';
    }

    /* ================= form ================= */

    function fillCowSelect() {
      const sel = $('#brd-cow');
      const keep = sel.value;
      sel.innerHTML = farmFemales().map((a) => `<option value="${esc(a.animalId)}">${esc(a.name)} (${esc(a.animalId)}) · ${esc(a.category)}</option>`).join('');
      if (keep) sel.value = keep;
      const sire = $('#brd-sire');
      const keepS = sire.value;
      const bulls = animals.filter((a) => a.sex === 'Male' && (a.category === 'AI bull' || (a.herd === 'farm' && a.category === 'Bull' && a.status === 'Active')));
      sire.innerHTML = '<option value="">Not in the herd list (type the code)</option>' + bulls.map((a) => `<option value="${esc(a.animalId)}">${esc(a.name)}${a.aiCode ? ' · ' + esc(a.aiCode) : ''} (${esc(a.animalId)})</option>`).join('');
      if (keepS) sire.value = keepS;
    }

    function openForm(type, cowId, preset = {}) {
      show($('#brd-form'), true);
      show($('#brd-main'), false);
      $('#brd-type').value = type || 'Service';
      if (cowId) $('#brd-cow').value = cowId;
      $('#brd-date').value = preset.date || todayLocal();
      ['#brd-sirecode', '#brd-tech', '#brd-cost', '#brd-calfweight', '#brd-calfname', '#brd-notes'].forEach((s) => { $(s).value = ''; });
      $('#brd-sire').value = '';
      delete $('#brd-calfname').dataset.touched;
      if (preset.sireCode) $('#brd-sirecode').value = preset.sireCode;
      if (preset.technician) $('#brd-tech').value = preset.technician;
      pendingExpenseId = preset.expenseId || '';
      setError('');
      updateForm();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    function closeForm() { show($('#brd-form'), false); show($('#brd-main'), true); pendingExpenseId = ''; render(); }
    function setError(m) { const el = $('#brd-error'); el.textContent = m || ''; show(el, !!m); }

    function updateForm() {
      const t = $('#brd-type').value;
      const ai = $('#brd-method').value === 'AI';
      show($('#brd-service'), t === 'Service');
      show($('#brd-semen-wrap'), t === 'Service' && ai);
      show($('#brd-cost-wrap'), t === 'Service' && !pendingExpenseId);
      show($('#brd-linked'), t === 'Service' && !!pendingExpenseId);
      show($('#brd-sirecode-wrap'), t === 'Service' && !$('#brd-sire').value);
      show($('#brd-tech-wrap'), t === 'Service' || t === 'Pregnancy check');
      $('#brd-tech-label').textContent = t === 'Pregnancy check' ? 'Checked by (vet)' : ai ? 'Inseminator' : 'Bull owner (optional)';
      show($('#brd-pd'), t === 'Pregnancy check');
      show($('#brd-calving'), t === 'Calving');
      show($('#brd-calf-wrap'), t === 'Calving' && $('#brd-outcome').value === 'Alive');
      const cow = $('#brd-cow').value;
      if (t === 'Calving' && !$('#brd-calfname').dataset.touched) $('#brd-calfname').placeholder = `e.g. ${nameOf(cow)}'s calf`;
      // For calvings entered from the past: her calves already in the herd list can be chosen instead of adding a new one.
      const sel = $('#brd-calfexisting');
      const keep = sel.value;
      const linked = new Set(allEvents().map((e) => e.calfId).filter(Boolean));
      const kids = animals.filter((a) => a.damId === cow && !linked.has(a.animalId));
      sel.innerHTML = '<option value="">New calf: add it to the herd list</option>' + kids.map((a) => `<option value="${esc(a.animalId)}">Already in the herd list: ${esc(a.name)} (${esc(a.animalId)})${a.dateOfBirth ? ' · born ' + esc(fmt(a.dateOfBirth)) : ''}</option>`).join('');
      if (keep && kids.some((a) => a.animalId === keep)) sel.value = keep;
      show($('#brd-calfname-wrap'), !sel.value);
      // What will happen in the herd register.
      const what = {
        'Pregnancy check': { Pregnant: 'She will be marked In-calf in the herd list.', 'Not pregnant': 'She will be marked Open; watch for her next heat.', 'Not sure': 'No change in the herd list; check again later.' }[$('#brd-result').value],
        'Dry-off': 'She will be marked Dry (and leave the milking list).',
        'Calving': $('#brd-outcome').value !== 'Alive' ? 'She becomes Lactating and Open.' : $('#brd-calfexisting').value ? 'She becomes Lactating and Open; the calving is linked to the calf already in the herd list.'
          : 'She becomes Lactating and Open, and the calf is added to the herd with a new MT- number.',
        'Abortion / loss': 'She will be marked Open.',
        'Service': 'She stays Open until a pregnancy check confirms it. You will be reminded when to watch for a repeat heat and when to check.',
        'Heat': 'Her next heat is expected 21 days later.',
      }[t] || '';
      $('#brd-effect').textContent = what;
    }

    async function handleSubmit(e) {
      e.preventDefault();
      setError('');
      if (!getSession()) { toast('Sign in first', 'error'); return; }
      const t = $('#brd-type').value;
      const cowId = $('#brd-cow').value;
      const date = $('#brd-date').value;
      const cow = animals.find((a) => a.animalId === cowId);
      if (!cow) { setError('Choose the cow.'); return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > todayLocal()) { setError('Pick the date (not in the future).'); return; }
      if (cow.dateOfBirth && date < cow.dateOfBirth) { setError('The date is before she was born.'); return; }
      const rec = { ...baseRecord(), eventId: nextEventId(date), date, animalId: cowId, eventType: t, method: '', sireId: '', sireCode: '', semenType: '', technician: '', result: '',
        calvingEase: '', calfSex: '', calfWeightKg: '', calfOutcome: '', calfId: '', expenseId: '', notes: $('#brd-notes').value.trim().slice(0, 300) };
      let cost = 0;
      if (t === 'Service') {
        rec.method = $('#brd-method').value;
        rec.sireId = $('#brd-sire').value;
        rec.sireCode = rec.sireId ? '' : $('#brd-sirecode').value.trim().slice(0, 60);
        if (!rec.sireId && !rec.sireCode && !confirm('No bull or semen code entered. Save anyway?')) return;
        rec.semenType = rec.method === 'AI' ? $('#brd-semen').value : '';
        rec.technician = $('#brd-tech').value.trim().slice(0, 60);
        rec.expenseId = pendingExpenseId;
        cost = pendingExpenseId ? 0 : (num($('#brd-cost').value) || 0);
        if (cost < 0 || cost > 200000) { setError('Cost should be between 0 and 200,000.'); return; }
        const m = model().cows.find((c) => c.animalId === cowId);
        // In calf either from a recorded check, or in the herd register (status set before breeding records began).
        if (((m && m.expectedIsConfirmed) || cow.pregnancyStatus === 'In-calf') && !confirm(`${cow.name} is recorded as in calf. Serve her anyway?`)) return;
      } else if (t === 'Pregnancy check') {
        rec.result = $('#brd-result').value;
        rec.technician = $('#brd-tech').value.trim().slice(0, 60);
        if (!allEvents().some((x) => x.animalId === cowId && x.eventType === 'Service') && !confirm(`No service is recorded for ${cow.name}. Save the check anyway?`)) return;
      } else if (t === 'Calving') {
        rec.calvingEase = $('#brd-ease').value;
        rec.calfOutcome = $('#brd-outcome').value;
        rec.calfSex = $('#brd-calfsex').value;
        const w = $('#brd-calfweight').value.trim();
        rec.calfWeightKg = w === '' ? '' : num(w);
        if (rec.calfWeightKg !== '' && !(rec.calfWeightKg >= 5 && rec.calfWeightKg <= 80)) { setError('Calf weight should be 5–80 kg (or blank).'); return; }
        if (rec.calfOutcome === 'Alive' && $('#brd-calfexisting').value) {
          const k = animals.find((a) => a.animalId === $('#brd-calfexisting').value);
          rec.calfId = k.animalId; rec.calfSex = k.sex;
        } else if (rec.calfOutcome === 'Alive' && !rec.calfSex) { setError('Choose the calf\'s sex.'); return; }
      }
      const btn = $('#brd-form button[type="submit"]');
      btn.disabled = true;
      const notes = [];
      try {
        const before = model().cows.find((c) => c.animalId === cowId);
        // 1. A live calf joins the herd (gets its MT- number first, so the event can name it).
        if (t === 'Calving' && rec.calfOutcome === 'Alive' && !rec.calfId) {
          const sire = before && before.conceptionSireId ? before.conceptionSireId : (before && before.lastService && before.lastService.sireId) || '';
          try {
            const calf = await herd.addAnimal({ name: ($('#brd-calfname').value.trim() || `${cow.name} calf ${date.slice(5, 7)}/${date.slice(2, 4)}`).slice(0, 40),
              sex: rec.calfSex, category: 'Calf', breed: herd.suggestBreed ? (herd.suggestBreed(cowId, sire) || 'Unknown') : 'Unknown',
              dateOfBirth: date, damId: cowId, sireId: sire, milkingStatus: 'N/A', pregnancyStatus: 'N/A' });
            rec.calfId = calf.animalId;
            notes.push(`calf ${calf.name} added as ${calf.animalId}`);
          } catch (err) { notes.push('calf not added to the herd: ' + (err.message || err)); }
        }
        // 2. The AI / bull cost as an expense.
        if (t === 'Service' && cost > 0 && expenses) {
          const now = new Date().toISOString();
          const s = getSession();
          const exp = { clientId: makeUUID(), deviceId: getDeviceId(), recordedBy: s ? s.email : '', createdAt: now, updatedAt: now, syncStatus: SYNC_STATUS.PENDING, syncAttempts: 0, lastError: null, syncedAt: null,
            expenseId: expenses.nextId(date), date, group: 'Breeding', category: 'AI service & semen',
            item: (rec.sireId ? `${nameOf(rec.sireId)} ${rec.sireId}` : rec.sireCode || (rec.method === 'Bull' ? 'Bull service' : 'AI')).slice(0, 80),
            quantity: '', unit: '', unitPrice: '', amount: Math.round(cost * 100) / 100, paymentMethod: $('#brd-costmethod').value, paymentStatus: 'Paid', amountPaid: Math.round(cost * 100) / 100, dueDate: '',
            receiptRef: '', payee: rec.technician, animalId: cowId, notes: `Service ${rec.eventId}` };
          await db.expenses.add(exp);
          rec.expenseId = exp.expenseId;
          notes.push(`cost ${money(cost)} recorded in Expenses`);
        }
        // 3. The event.
        await db[STORE].add(rec);
        // 4. The cow in the herd register.
        const after = brdModel(allEvents().concat(local.some((x) => x.clientId === rec.clientId) ? [] : [rec]), farmFemales(), todayLocal()).cows.find((c) => c.animalId === cowId);
        let patch = null;
        if (t === 'Pregnancy check' && rec.result === 'Pregnant') patch = { pregnancyStatus: 'In-calf', pregnancySireId: after && /^(MT|X)-/.test(after.conceptionSireId) ? after.conceptionSireId : '' };
        else if ((t === 'Pregnancy check' && rec.result === 'Not pregnant') || t === 'Abortion / loss') patch = { pregnancyStatus: 'Open', pregnancySireId: '' };
        else if (t === 'Dry-off') patch = { milkingStatus: 'Dry' };
        else if (t === 'Calving') {
          // Only the latest calving changes her current status (an old calving entered for the record does not).
          const latest = !allEvents().some((x) => x.animalId === cowId && x.eventType === 'Calving' && x.date > date && x.clientId !== rec.clientId);
          const newer = allEvents().some((x) => x.animalId === cowId && x.date > date && x.clientId !== rec.clientId);
          patch = latest && !newer ? { category: 'Cow', milkingStatus: 'Lactating', pregnancyStatus: 'Open', pregnancySireId: '' } : { category: 'Cow' };
        }
        if (patch) {
          try { await herd.updateAnimal(cowId, patch); notes.push('herd list updated'); } catch (err) { notes.push('herd list not updated: ' + (err.message || err)); }
        }
        toast(`Saved: ${cow.name} · ${t}${notes.length ? ' · ' + notes.join(' · ') : ''}`);
        requestSync('new-record', saveDebounceMs);
        closeForm();
      } catch (err) {
        setError('Could not save on this phone: ' + (err.message || err));
      } finally {
        btn.disabled = false;
      }
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
      $$('.herd-view-btn').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
      $('#brd-add').addEventListener('click', () => openForm('Service'));
      $('#brd-refresh').addEventListener('click', () => refresh(true));
      $('#brd-cancel').addEventListener('click', closeForm);
      $('#brd-form').addEventListener('submit', handleSubmit);
      ['#brd-type', '#brd-method', '#brd-sire', '#brd-result', '#brd-outcome', '#brd-cow', '#brd-calfexisting'].forEach((s) => $(s).addEventListener('change', updateForm));
      $('#brd-calfname').addEventListener('input', () => { $('#brd-calfname').dataset.touched = '1'; });
      $('#breed-view').addEventListener('click', (e) => {
        const d = e.target.closest('.brd-do');
        if (d) { openForm(d.dataset.type, d.dataset.cow); return; }
        const a = e.target.closest('.brd-ai-use');
        if (a) {
          const x = ((server && server.unmatchedAi) || []).find((y) => y.expenseId === a.dataset.id);
          if (x) { openForm('Service', x.animalId, { date: x.date, sireCode: x.item, technician: x.payee, expenseId: x.expenseId }); $('#brd-method').value = 'AI'; updateForm(); }
          return;
        }
        const c = e.target.closest('.brd-cow');
        if (c) {
          const li = c.closest('li');
          const h = li.querySelector('.brd-hist');
          const open = h.classList.contains('hidden');
          if (open) h.innerHTML = historyHtml(li.dataset.cow);
          show(h, open);
        }
      });
      Dexie.liveQuery(() => db[STORE].toArray()).subscribe({ next: (r) => { local = r; render(); } });
      Dexie.liveQuery(() => db.animals.toArray()).subscribe({ next: (a) => { animals = a; render(); } });
      db.kv.get('breedingList').then((x) => { if (x && x.value) { server = x.value; render(); } }).catch(() => {});
      // If the Herd form opens (e.g. "Add a new animal" from the Milk tab), show the Animals view.
      new MutationObserver(() => { if (!$('#herd-form').classList.contains('hidden')) setView('animals'); })
        .observe($('#herd-form'), { attributes: true, attributeFilter: ['class'] });
      setView('animals');
    }

    return Object.freeze({ init, refresh, applyRename, model });
  }

  window.MaweBreeding = Object.freeze({ create, STORE, PAYLOAD });
})();
