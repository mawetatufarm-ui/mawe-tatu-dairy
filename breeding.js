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
 * v5.7: Edit / Cancel in each cow's history. Before upload the phone's
 * record is changed or deleted; after upload a correction is queued
 * (app.js → Corrections.gs, audit in Record_Changes). Afterwards the cow's
 * herd record is brought in line with her events (reconcileHerd).
 *
 * v5.9.1 (28 Nov 2026):
 *   • "She is already in calf from this service" (e.g. bought in calf): the
 *     service (date, or worked out from the expected calving date) is saved
 *     with a Pregnant check, so calving and dry-off dates follow at once.
 *   • Relative check before every service: the bull is compared with the
 *     cow's father, grandfathers and great-grandfathers (from the herd list's
 *     sires and from the services her dam and granddams came from, matching
 *     semen codes too), and with her own descendants and half-siblings.
 *     Each card lists "Do not serve with: …".
 *   • Calving passes the sire to the calf: the service's bull, a typed semen
 *     code that matches an AI bull in the herd list, or the "In calf to" bull
 *     in her herd record; an old calving linked to an existing calf fills in
 *     that calf's sire when it is blank.
 * NOTE: from v5.9.1 this generated file was edited directly (the src
 * templates were not available); the shared model block is unchanged, so
 * Breeding.gs needs no change.
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
  const SHEET = 'Breeding_Events';
  const EDITABLE = ['date', 'method', 'sireId', 'sireCode', 'semenType', 'technician', 'result', 'calvingEase', 'calfWeightKg', 'notes'];
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
    const { db, SYNC_STATUS, getSession, getDeviceId, makeUUID, todayLocal, esc, toast, requestSync, saveDebounceMs, callServer, herd, expenses, queueCorrection } = deps;
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
    let editing = null;        // the event being corrected

    /* ================= data ================= */

    function allEvents() {
      const srv = ((server && server.events) || []).map((e) => { const l = local.find((x) => x.clientId === e.clientId); return l && l.syncStatus !== SYNC_STATUS.SYNCED ? { ...e, ...l } : e; }); // once uploaded, the sheet's copy wins (it has corrections from any phone)
      const ids = new Set(srv.map((e) => e.clientId));
      return srv.concat(local.filter((e) => !ids.has(e.clientId))).filter((e) => !e.voided && e.status !== 'Void');
    }
    function farmFemales() {
      return animals.filter((a) => a.herd === 'farm' && a.sex === 'Female' && (a.category === 'Cow' || a.category === 'Heifer') && a.status === 'Active')
        .sort((a, b) => a.animalId.localeCompare(b.animalId));
    }
    const nameOf = (id) => { const a = animals.find((x) => x.animalId === id); return a ? a.name : id; };
    const sireLabel = (s) => (s && /^(MT|X)-/.test(s) ? `${nameOf(s)}${animals.find((x) => x.animalId === s && x.aiCode) ? ' · ' + animals.find((x) => x.animalId === s).aiCode : ''}` : s);
    function model() { return brdModel(allEvents(), farmFemales(), todayLocal()); }

    /* ================= pedigree (v5.9.1) ================= */

    const byAnimal = (id) => animals.find((a) => a.animalId === id);
    /** Semen codes compared without spaces, dashes or case: "7HO 12345" = "7ho-12345". */
    const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    /** A registered AI bull whose AI code matches a typed code, or null. */
    const bullByCode = (code) => { const n = normCode(code); return n ? animals.find((a) => a.category === 'AI bull' && normCode(a.aiCode) === n) || null : null; };

    /** The service an animal came from: the last service of her dam 240–300 days before her birth. */
    function birthService(id, evs) {
      const a = byAnimal(id);
      const calving = evs.find((e) => e.eventType === 'Calving' && e.calfId === id);
      const damId = calving ? calving.animalId : a && a.damId;
      const born = calving ? calving.date : a && a.dateOfBirth;
      if (!damId || !born) return null;
      return evs.filter((e) => e.animalId === damId && e.eventType === 'Service' && brdDiff(born, e.date) >= 240 && brdDiff(born, e.date) <= 300)
        .sort((x, y) => (x.date < y.date ? 1 : -1))[0] || null;
    }
    /** The dam of an animal: herd list, else the calving that produced her. */
    function damOf(id, evs) {
      const a = byAnimal(id);
      if (a && a.damId) return a.damId;
      const c = evs.find((e) => e.eventType === 'Calving' && e.calfId === id);
      return c ? c.animalId : '';
    }
    /** The sire of an animal as { id, code, name }: the herd list's sire, else the service she came from. */
    function sireOf(id, evs) {
      const a = byAnimal(id);
      const ref = (sid, code) => {
        const b = sid ? byAnimal(sid) : bullByCode(code);
        const bid = sid || (b ? b.animalId : '');
        return { id: bid, code: normCode(b ? b.aiCode : code) || normCode(code), name: b ? `${b.name}${b.aiCode ? ' · ' + b.aiCode : ''}` : (sid || code) };
      };
      if (a && a.sireId) return ref(a.sireId, '');
      const sv = birthService(id, evs);
      if (sv && (sv.sireId || sv.sireCode)) return ref(sv.sireId || '', sv.sireCode || '');
      return null;
    }
    const REL = ['', 'father', 'grandfather', 'great-grandfather'];
    /** Bulls not to use on this female: her sires up to 3 generations back, each with the relationship. */
    function avoidList(femaleId) {
      const evs = allEvents();
      const out = [];
      const seen = new Set();
      const walk = (id, gen, via) => {
        if (!id || gen > 3) return;
        const s = sireOf(id, evs);
        if (s && (s.id || s.code)) {
          const k = s.id || s.code;
          if (!seen.has(k)) { seen.add(k); out.push({ ...s, gen, rel: REL[gen] + (gen > 1 && via ? ` (${via} side)` : '') }); }
          if (s.id) walk(s.id, gen + 1, gen === 1 ? "sire's" : via);
        }
        walk(damOf(id, evs), gen + 1, gen === 1 ? "dam's" : via);
      };
      walk(femaleId, 1, '');
      return out;
    }
    /** All ancestor IDs (herd list + calving records) up to `depth` generations. */
    function ancestorIds(id, evs, depth = 3, out = new Set()) {
      if (!id || depth === 0) return out;
      const s = sireOf(id, evs);
      [damOf(id, evs), s && s.id].forEach((p) => { if (p && !out.has(p)) { out.add(p); ancestorIds(p, evs, depth - 1, out); } });
      return out;
    }
    /**
     * Warning text when serving femaleId with bull sireId (herd list) or a typed semen code would mate
     * close relatives, else ''.
     */
    function kinWarning(femaleId, sireId, code) {
      if (!femaleId || (!sireId && !code)) return '';
      const evs = allEvents();
      const her = byAnimal(femaleId);
      const herName = her ? her.name : femaleId;
      const bull = sireId ? byAnimal(sireId) : bullByCode(code);
      const bId = sireId || (bull ? bull.animalId : '');
      const bCode = normCode(bull ? bull.aiCode : code) || normCode(code);
      const bName = bull ? `${bull.name}${bull.aiCode ? ' (' + bull.aiCode + ')' : ''}` : code;
      const hit = avoidList(femaleId).find((x) => (bId && x.id === bId) || (bCode && x.code && x.code === bCode));
      if (hit) return `${bName} is ${herName}'s ${hit.rel}.`;
      if (bId) {
        if (ancestorIds(bId, evs).has(femaleId)) return `${bName} is ${herName}'s son or grandson.`;
        const mine = ancestorIds(femaleId, evs);
        const shared = [...ancestorIds(bId, evs)].filter((x) => mine.has(x));
        if (shared.length) return `${bName} and ${herName} are related: both descend from ${shared.map(nameOf).join(', ')}.`;
      }
      return '';
    }

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
        const c = b.dataset.view === 'health' ? 'bg-teal-700' : 'bg-sky-700';
        b.classList.remove('bg-sky-700', 'bg-teal-700');
        if (on) b.classList.add(c);
        b.classList.toggle('text-white', on);
        b.classList.toggle('bg-white', !on); b.classList.toggle('text-sky-800', !on);
      });
      show($('#herd-animals'), view === 'animals');
      show($('#breed-view'), view === 'breeding');
      show($('#health-view'), view === 'health');
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
        if (c.status === 'In calf (date unknown)') lines.push('In calf in the herd list, but no service recorded. Use <b>Record the service she is in calf from</b> below (an estimated date, or the expected calving date, is fine).');
        const avoid = avoidList(c.animalId);
        if (avoid.length) lines.push(`<span class="text-red-800">Do not serve with: ${avoid.map((x) => `<b>${esc(x.name)}</b> (${esc(x.rel)})`).join(' · ')}</span>`);
        return `<li class="bg-white rounded-xl shadow-sm" data-cow="${esc(c.animalId)}">
          <button type="button" class="brd-cow w-full text-left px-4 py-3 space-y-1">
            <span class="flex items-center justify-between gap-2"><span class="font-semibold text-sm">${esc(c.name)} <span class="text-xs text-slate-400">${esc(c.animalId)} · ${esc(c.category)}</span></span>
              <span class="text-[11px] font-semibold px-2 py-0.5 rounded-full ${STATUS_CHIP[c.status] || 'bg-slate-100 text-slate-700'}">${esc(c.status)}</span></span>
            ${lines.map((l) => `<span class="block text-xs text-slate-600">${l}</span>`).join('')}
            ${c.flags.length ? `<span class="block text-xs text-red-700">${c.flags.map(esc).join(' · ')}</span>` : ''}
          </button>
          ${c.status === 'In calf (date unknown)' ? `<div class="px-4 pb-3"><button type="button" class="brd-already-btn rounded-lg bg-calf-100 text-calf-700 text-xs font-semibold px-3 py-1.5" data-cow="${esc(c.animalId)}">Record the service she is in calf from</button></div>` : ''}
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
      return (evs.length ? `<ul class="space-y-2">${evs.map((e) => `<li class="border-t border-slate-100 pt-1">${esc(fmt(e.date))} · <b>${esc(e.eventType)}</b>${detail(e)}${pending.has(e.clientId) ? ' <span class="text-amber-700">(not uploaded)</span>' : ''}
          <span class="flex gap-3 mt-1"><button type="button" class="brd-edit text-sky-700 font-semibold" data-id="${esc(e.clientId)}">Edit</button>
          <button type="button" class="brd-cancel-ev text-slate-500" data-id="${esc(e.clientId)}">${pending.has(e.clientId) ? 'Delete' : 'Cancel'}</button></span></li>`).join('')}</ul>`
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

    function openForm(type, cowId, preset = {}, ev = null) {
      editing = ev;
      show($('#brd-form'), true);
      show($('#brd-main'), false);
      $('#brd-type').value = type || 'Service';
      if (cowId) $('#brd-cow').value = cowId;
      $('#brd-type').disabled = !!ev;
      $('#brd-cow').disabled = !!ev;
      $('#brd-date').value = preset.date || todayLocal();
      ['#brd-sirecode', '#brd-tech', '#brd-cost', '#brd-calfweight', '#brd-calfname', '#brd-notes', '#brd-reason', '#brd-duedate'].forEach((s) => { $(s).value = ''; });
      $('#brd-already').checked = !!preset.already;
      $('#brd-sire').value = '';
      delete $('#brd-calfname').dataset.touched;
      if (ev) {
        $('#brd-method').value = ev.method || 'AI';
        $('#brd-sire').value = ev.sireId || '';
        $('#brd-sirecode').value = ev.sireCode || '';
        $('#brd-semen').value = ev.semenType || '';
        $('#brd-tech').value = ev.technician || '';
        if (ev.result) $('#brd-result').value = ev.result;
        if (ev.calvingEase) $('#brd-ease').value = ev.calvingEase;
        $('#brd-calfweight').value = ev.calfWeightKg || '';
        $('#brd-notes').value = ev.notes || '';
      }
      $('#brd-title').textContent = ev ? `Correct ${ev.eventType.toLowerCase()} · ${nameOf(ev.animalId)}` : '';
      if (preset.sireCode) $('#brd-sirecode').value = preset.sireCode;
      if (preset.technician) $('#brd-tech').value = preset.technician;
      pendingExpenseId = preset.expenseId || '';
      setError('');
      updateForm();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    function closeForm() { editing = null; $('#brd-type').disabled = false; $('#brd-cow').disabled = false; show($('#brd-form'), false); show($('#brd-main'), true); pendingExpenseId = ''; render(); }
    function setError(m) { const el = $('#brd-error'); el.textContent = m || ''; show(el, !!m); }

    function updateForm() {
      const t = $('#brd-type').value;
      const ai = $('#brd-method').value === 'AI';
      show($('#brd-service'), t === 'Service');
      show($('#brd-semen-wrap'), t === 'Service' && ai);
      const already = t === 'Service' && !editing && $('#brd-already').checked;
      show($('#brd-already-row'), t === 'Service' && !editing && !pendingExpenseId);
      show($('#brd-already-wrap'), already);
      show($('#brd-cost-wrap'), t === 'Service' && !pendingExpenseId && !editing && !already);
      show($('#brd-reason-wrap'), !!editing);
      show($('#brd-calf-wrap'), t === 'Calving' && $('#brd-outcome').value === 'Alive' && !editing);
      $('#brd-outcome').disabled = !!editing; $('#brd-calfsex').disabled = !!editing;
      show($('#brd-linked'), t === 'Service' && !!pendingExpenseId);
      show($('#brd-sirecode-wrap'), t === 'Service' && !$('#brd-sire').value);
      show($('#brd-tech-wrap'), t === 'Service' || t === 'Pregnancy check');
      $('#brd-tech-label').textContent = t === 'Pregnancy check' ? 'Checked by (vet)' : ai ? 'Inseminator' : 'Bull owner (optional)';
      show($('#brd-pd'), t === 'Pregnancy check');
      show($('#brd-calving'), t === 'Calving');

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
        'Service': already ? 'Saved with a Pregnant check: she is marked In-calf, and her calving and dry-off dates are worked out from this service date.'
          : 'She stays Open until a pregnancy check confirms it. You will be reminded when to watch for a repeat heat and when to check.',
        'Heat': 'Her next heat is expected 21 days later.',
      }[t] || '';
      $('#brd-effect').textContent = what;
      updateKin();
    }

    /** Live relative check in the service form, and the cow's "do not serve with" list. */
    function updateKin() {
      const t = $('#brd-type').value;
      const cow = $('#brd-cow').value;
      const box = $('#brd-kin');
      const avoidEl = $('#brd-avoid');
      if (t !== 'Service' || !cow) { show(box, false); show(avoidEl, false); return; }
      const sireId = $('#brd-sire').value;
      const code = sireId ? '' : $('#brd-sirecode').value.trim();
      const w = kinWarning(cow, sireId, code);
      box.textContent = w ? `⚠ ${w} Serving close relatives (inbreeding) lowers fertility, calf survival, growth and milk. Choose another bull.` : '';
      show(box, !!w);
      const avoid = avoidList(cow);
      avoidEl.innerHTML = avoid.length ? `Do not use for ${esc(nameOf(cow))}: ${avoid.map((x) => `<b>${esc(x.name)}</b> (${esc(x.rel)})`).join(' · ')}` : '';
      show(avoidEl, avoid.length > 0);
      const m = code ? bullByCode(code) : null;
      $('#brd-codehint').textContent = code && !m ? 'Tip: add this bull in Herd → Animals → Outside (category AI bull, with this code) so his calves are linked to him.'
        : m ? `Matches ${m.name} (${m.animalId}) in the herd list.` : '';
    }

    /** Correct an event: on the phone if not uploaded, else a queued correction. */
    async function saveEdit() {
      const ev = editing;
      const t = ev.eventType;
      const f = { date: $('#brd-date').value, notes: $('#brd-notes').value.trim().slice(0, 300) };
      if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date) || f.date > todayLocal()) throw new Error('Pick the date (not in the future).');
      if (t === 'Service') {
        f.method = $('#brd-method').value; f.sireId = $('#brd-sire').value; f.sireCode = f.sireId ? '' : $('#brd-sirecode').value.trim().slice(0, 60);
        f.semenType = f.method === 'AI' ? $('#brd-semen').value : ''; f.technician = $('#brd-tech').value.trim().slice(0, 60);
      } else if (t === 'Pregnancy check') { f.result = $('#brd-result').value; f.technician = $('#brd-tech').value.trim().slice(0, 60); }
      else if (t === 'Calving') {
        f.calvingEase = $('#brd-ease').value;
        const w = $('#brd-calfweight').value.trim();
        f.calfWeightKg = w === '' ? '' : num(w);
        if (f.calfWeightKg !== '' && !(f.calfWeightKg >= 5 && f.calfWeightKg <= 80)) throw new Error('Calf weight should be 5–80 kg (or blank).');
      }
      const changes = {};
      Object.keys(f).forEach((k) => { if (EDITABLE.includes(k) && String(f[k] ?? '') !== String(ev[k] ?? '')) changes[k] = f[k]; });
      if (!Object.keys(changes).length) throw new Error('Nothing was changed.');
      const mine = local.find((x) => x.clientId === ev.clientId);
      if (mine && mine.syncStatus !== SYNC_STATUS.SYNCED) {
        await db[STORE].update(mine.id, { ...changes, updatedAt: new Date().toISOString() });
        toast('Changed on this phone (not uploaded yet)');
      } else {
        const reason = $('#brd-reason').value.trim();
        if (!reason) throw new Error('Give a short reason for the correction.');
        await queueCorrection({ sheet: SHEET, id: ev.eventId, changes, reason });
        await mirror(ev, changes);
        toast('Correction saved: uploads with the next sync');
      }
      await reconcileHerd(ev.animalId);
    }

    /** Show a correction straight away: change the phone's copy (or the cached server copy). */
    async function mirror(ev, changes) {
      const mine = local.find((x) => x.clientId === ev.clientId);
      if (mine) await db[STORE].update(mine.id, changes);
      if (server && server.events) {
        server.events = server.events.map((x) => (x.clientId === ev.clientId ? { ...x, ...changes } : x));
        await db.kv.put({ key: 'breedingList', value: server });
      }
      local = await db[STORE].toArray();
      render();
    }

    async function cancelEvent(clientId) {
      const ev = allEvents().find((x) => x.clientId === clientId);
      if (!ev) return;
      const mine = local.find((x) => x.clientId === clientId);
      const calfNote = ev.calfId ? `\n\nThe calf ${nameOf(ev.calfId)} (${ev.calfId}) stays in the herd list: remove it in Animals if it was a mistake.` : '';
      if (mine && mine.syncStatus !== SYNC_STATUS.SYNCED) {
        if (!confirm(`Delete this ${ev.eventType.toLowerCase()} for ${nameOf(ev.animalId)}? It has not been uploaded yet.${calfNote}`)) return;
        await db[STORE].delete(mine.id);
        local = await db[STORE].toArray();
        toast('Deleted', 'info');
      } else {
        const reason = prompt(`Cancel this ${ev.eventType.toLowerCase()} for ${nameOf(ev.animalId)} (${fmt(ev.date)})? It stays in the sheet marked Void.${calfNote}\n\nReason:`);
        if (reason === null) return;
        if (!reason.trim()) { toast('A reason is needed to cancel', 'error'); return; }
        await queueCorrection({ sheet: SHEET, id: ev.eventId, changes: {}, void: true, reason: reason.trim().slice(0, 300) });
        await mirror(ev, { voided: true });
        toast('Cancelled: uploads with the next sync', 'info');
      }
      await reconcileHerd(ev.animalId);
    }

    /**
     * After a correction, bring the cow's herd record in line with her events:
     * confirmed in calf → In-calf (with the sire); served / open / fresh → Open;
     * dried off and still in calf → Dry; calved since the last dry-off → Lactating.
     * A cow In-calf in the register with no events is left alone.
     */
    async function reconcileHerd(cowId) {
      const cow = animals.find((a) => a.animalId === cowId);
      if (!cow) return;
      const c = model().cows.find((x) => x.animalId === cowId);
      if (!c || c.status === 'In calf (date unknown)') return;
      const patch = {};
      const inCalf = c.expectedIsConfirmed;
      if (inCalf && cow.pregnancyStatus !== 'In-calf') { patch.pregnancyStatus = 'In-calf'; patch.pregnancySireId = /^(MT|X)-/.test(c.conceptionSireId) ? c.conceptionSireId : ''; }
      if (!inCalf && cow.pregnancyStatus === 'In-calf') { patch.pregnancyStatus = 'Open'; patch.pregnancySireId = ''; }
      if (inCalf && c.dryOffDone && cow.milkingStatus !== 'Dry') patch.milkingStatus = 'Dry';
      if (!c.dryOffDone && c.lastCalving && cow.milkingStatus === 'Dry' && allEvents().some((e) => e.animalId === cowId && e.eventType === 'Calving')) patch.milkingStatus = 'Lactating';
      if (!Object.keys(patch).length) return;
      try { await herd.updateAnimal(cowId, patch); toast(`${cow.name}: herd list updated`, 'info'); } catch (err) { toast('Herd list not updated: ' + (err.message || err), 'error'); }
    }

    async function handleSubmit(e) {
      e.preventDefault();
      setError('');
      if (!getSession()) { toast('Sign in first', 'error'); return; }
      if (editing) {
        const b = $('#brd-form button[type="submit"]');
        b.disabled = true;
        try { await saveEdit(); closeForm(); } catch (err) { setError(err.message || String(err)); } finally { b.disabled = false; }
        return;
      }
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
      let already = false; // v5.9.1: service she is already in calf from
      if (t === 'Service') {
        rec.method = $('#brd-method').value;
        rec.sireId = $('#brd-sire').value;
        rec.sireCode = rec.sireId ? '' : $('#brd-sirecode').value.trim().slice(0, 60);
        // A typed code that belongs to an AI bull in the herd list is saved as that bull, so his calves are linked to him.
        const known = !rec.sireId && rec.sireCode ? bullByCode(rec.sireCode) : null;
        if (known) { rec.sireId = known.animalId; rec.sireCode = ''; }
        if (!rec.sireId && !rec.sireCode && !confirm('No bull or semen code entered. Save anyway?')) return;
        rec.semenType = rec.method === 'AI' ? $('#brd-semen').value : '';
        rec.technician = $('#brd-tech').value.trim().slice(0, 60);
        rec.expenseId = pendingExpenseId;
        already = $('#brd-already').checked && !pendingExpenseId;
        cost = pendingExpenseId || already ? 0 : (num($('#brd-cost').value) || 0);
        if (cost < 0 || cost > 200000) { setError('Cost should be between 0 and 200,000.'); return; }
        const kin = kinWarning(cowId, rec.sireId, rec.sireCode);
        if (kin && !confirm(`${kin}\n\nServing close relatives (inbreeding) lowers fertility, calf survival, growth and milk.\n\n${already ? 'Save the record anyway?' : 'Serve her with this bull anyway?'}`)) return;
        const m = model().cows.find((c) => c.animalId === cowId);
        if (already) {
          if (m && m.expectedIsConfirmed) { setError(`${cow.name} already has a confirmed pregnancy recorded. Edit that service in her history instead.`); return; }
          if (brdDiff(todayLocal(), date) > 300) { setError('That service date is more than 300 days ago: she would already have calved. Check the date.'); return; }
          if (!rec.notes) rec.notes = 'In calf when recorded (e.g. bought in calf)';
        } else if (brdDiff(todayLocal(), date) <= 300 && ((m && m.expectedIsConfirmed) || cow.pregnancyStatus === 'In-calf') && !confirm(`${cow.name} is recorded as in calf. Serve her anyway?`)) return;
        // (A service more than 300 days ago is an old record, e.g. the one an existing calf came from: no question.)
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
          const cs = calfSire(cowId, date);
          const sire = cs.id;
          try {
            const calf = await herd.addAnimal({ name: ($('#brd-calfname').value.trim() || `${cow.name} calf ${date.slice(5, 7)}/${date.slice(2, 4)}`).slice(0, 40),
              sex: rec.calfSex, category: 'Calf', breed: herd.suggestBreed ? (herd.suggestBreed(cowId, sire) || 'Unknown') : 'Unknown',
              dateOfBirth: date, damId: cowId, sireId: sire, milkingStatus: 'N/A', pregnancyStatus: 'N/A',
              ...(cs.code && !sire ? { notes: `Sire: ${cs.code} (semen code; bull not in the herd list)` } : {}) });
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
        // 1b. An old calving linked to a calf already in the herd list: fill in the calf's sire if blank.
        if (t === 'Calving' && rec.calfId && $('#brd-calfexisting').value) {
          const k = animals.find((a) => a.animalId === rec.calfId);
          const cs = calfSire(cowId, date);
          if (k && !k.sireId && cs.id) {
            try { await herd.updateAnimal(k.animalId, { sireId: cs.id }); notes.push(`${k.name}'s sire set to ${nameOf(cs.id)}`); } catch (err) { notes.push('calf\'s sire not set: ' + (err.message || err)); }
          }
        }
        // 3. The event.
        await db[STORE].add(rec);
        // 3b. Already in calf from this service: a Pregnant check (dated up to 60 days after the service, not later than today).
        if (already) {
          const pdDate = brdDiff(todayLocal(), date) > 60 ? brdAdd(date, 60) : todayLocal();
          let pdId = nextEventId(pdDate);
          if (pdId === rec.eventId) pdId = pdId.replace(/(\d+)$/, (n) => String(Number(n) + 1).padStart(n.length, '0'));
          await db[STORE].add({ ...baseRecord(), eventId: pdId, date: pdDate, animalId: cowId, eventType: 'Pregnancy check', method: '', sireId: '', sireCode: '', semenType: '', technician: '',
            result: 'Pregnant', calvingEase: '', calfSex: '', calfWeightKg: '', calfOutcome: '', calfId: '', expenseId: '', notes: 'Recorded with the service she was already in calf from' });
          notes.push('pregnancy confirmed');
        }
        // 4. The cow in the herd register.
        const after = brdModel(allEvents().concat(local.some((x) => x.clientId === rec.clientId) ? [] : [rec]), farmFemales(), todayLocal()).cows.find((c) => c.animalId === cowId);
        let patch = null;
        if (t === 'Pregnancy check' && rec.result === 'Pregnant') patch = { pregnancyStatus: 'In-calf', pregnancySireId: after && /^(MT|X)-/.test(after.conceptionSireId) ? after.conceptionSireId : '' };
        else if (already) patch = { pregnancyStatus: 'In-calf', pregnancySireId: /^(MT|X)-/.test(rec.sireId) ? rec.sireId : (cow.pregnancySireId || '') };
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

    /**
     * The calf's sire at calving: the bull of the service she conceived it from (the last service 240–300 days
     * before this calving, else her last service within 300 days), a typed semen code matched to an AI bull in
     * the herd list, else — for a recent calving only — the "In calf to" bull in her herd record (bought in calf).
     * Returns { id: 'MT-…|X-…' | '', code: typed code when no bull matched }.
     */
    function calfSire(cowId, date) {
      const svcs = allEvents().filter((e) => e.animalId === cowId && e.eventType === 'Service' && e.date < date && brdDiff(date, e.date) <= 300)
        .sort((x, y) => (x.date < y.date ? 1 : -1));
      const svc = svcs.find((e) => brdDiff(date, e.date) >= 240) || svcs[0];
      let id = (svc && svc.sireId) || '';
      let code = '';
      if (!id && svc && svc.sireCode) { const b = bullByCode(svc.sireCode); if (b) id = b.animalId; else code = svc.sireCode; }
      if (!id && !code && brdDiff(todayLocal(), date) <= 30) { const cow = byAnimal(cowId); if (cow && cow.pregnancySireId) id = cow.pregnancySireId; }
      return { id: /^(MT|X)-/.test(id) ? id : '', code };
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
      ['#brd-type', '#brd-method', '#brd-sire', '#brd-result', '#brd-outcome', '#brd-cow', '#brd-calfexisting', '#brd-already'].forEach((s) => $(s).addEventListener('change', updateForm));
      $('#brd-sirecode').addEventListener('input', updateKin);
      // Expected calving date → service date (283 days before).
      $('#brd-duedate').addEventListener('change', () => { const d = $('#brd-duedate').value; if (/^\d{4}-\d{2}-\d{2}$/.test(d)) { $('#brd-date').value = brdAdd(d, -BRD_RULES.gestation); updateForm(); } });
      $('#brd-calfname').addEventListener('input', () => { $('#brd-calfname').dataset.touched = '1'; });
      $('#breed-view').addEventListener('click', (e) => {
        const d = e.target.closest('.brd-do');
        if (d) { openForm(d.dataset.type, d.dataset.cow); return; }
        const al = e.target.closest('.brd-already-btn');
        if (al) { openForm('Service', al.dataset.cow, { already: true }); return; }
        const ed = e.target.closest('.brd-edit');
        if (ed) { const ev = allEvents().find((x) => x.clientId === ed.dataset.id); if (ev) { openForm(ev.eventType, ev.animalId, { date: ev.date }, ev); } return; }
        const cx = e.target.closest('.brd-cancel-ev');
        if (cx) { cancelEvent(cx.dataset.id); return; }
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
