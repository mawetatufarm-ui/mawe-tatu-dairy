/* =====================================================================
 * Mawe Tatu Dairy — milkuse.js (Milk tab: summary, Use & quality, v5.8)
 * ---------------------------------------------------------------------
 * 1. MILK SUMMARY at the top of the Milk tab, worked out on the phone from
 *    the milkings recorded here (works offline):
 *      • today so far by milking and by cow, against yesterday at the same
 *        point (the same milkings);
 *      • milk from cows under treatment withdrawal today (not for sale),
 *        using health.js;
 *      • the last 7 days as bars;
 *      • cows whose last 7 days fell 20% or more below the 7 days before —
 *        an early sign of mastitis, illness, heat or a feed problem.
 * 2. USE & QUALITY view:
 *      • where the rest of the milk went on a day: home, spoilt, rejected by
 *        a buyer (with the buyer and reason), other → Milk_Use. Sold, calves
 *        and withheld are counted automatically (MilkUse.gs), so they are not
 *        entered here. A guide shows the day's produced / sold / calves /
 *        withheld from this phone and what is still unaccounted.
 *      • quality checks: lactometer (28 = 1.028; pass 1.026–1.032), alcohol
 *        test, smell & colour, temperature → Milk_Quality.
 *      • the daily balance for the last 7 days from the sheet (listMilkUse).
 *      • recent entries: delete before upload; cancel after (a correction).
 * 3. EDIT A MILKING (v5.8.2): the Edit button on each entry under the milk
 *    form opens #mk-edit (cow, milking, litres, date).
 *      • not yet uploaded → the entry on the phone is simply changed;
 *        "Cancel this milking" deletes it;
 *      • already uploaded → the phone's copy is changed at once (so the
 *        summary is right) and a correction is queued for the sheet
 *        (Corrections.gs, sheet Milk_Production, id = the entry's clientId),
 *        with a reason logged in Record_Changes. Cancel = Status Void: the
 *        row stays in the sheet but no report counts it.
 *      • warns if the change makes a second entry for the same cow, day and
 *        milking (both would be added together).
 *
 * Stores (Dexie v10 in app.js): `milk_use`, `milk_quality` (append, pruned
 * 30 days after upload). kv 'milkUseList' caches listMilkUse.
 * IDs MU / MQ + YYMMDD + -NNN. Loaded before app.js; defines window.MaweMilkUse.
 * ===================================================================== */

(() => {
  'use strict';

  const USE = 'milk_use';
  const QUALITY = 'milk_quality';
  const PAYLOAD = Object.freeze({
    [USE]: ['clientId', 'deviceId', 'useId', 'date', 'homeL', 'spoiltL', 'rejectedL', 'otherL', 'buyer', 'reason', 'notes', 'recordedBy', 'createdAt'],
    [QUALITY]: ['clientId', 'deviceId', 'checkId', 'date', 'session', 'sample', 'test', 'reading', 'result', 'notes', 'recordedBy', 'createdAt'],
  });
  const SESSIONS = ['Morning', 'Afternoon', 'Evening'];
  const LACTO = [1.026, 1.032];  // same as MU_RULES.lactometer in MilkUse.gs
  const KG_PER_LITRE = 1.03;     // calf milk is logged in kg (as SalesReports.gs)
  const DROP = 0.2;              // flag a cow whose 7-day average fell by 20%+

  function create(deps) {
    const { db, SYNC_STATUS, getSession, getDeviceId, makeUUID, todayLocal, esc, toast, requestSync, saveDebounceMs, callServer, queueCorrection, getHealth, isMilkInFlight } = deps;
    const $ = (s) => document.querySelector(s);
    const $$ = (s) => [...document.querySelectorAll(s)];
    const show = (el, v) => el && el.classList.toggle('hidden', !v);
    const num = (v) => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
    const r1 = (x) => Math.round(x * 10) / 10;
    const L = (x) => `${r1(x || 0).toLocaleString('en-KE', { maximumFractionDigits: 1 })} L`;
    const addDays = (k, d) => { const [y, m, dd] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd + d)).toISOString().slice(0, 10); };
    const short = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'short' }).slice(0, 2) + ' ' + d; };
    const fmt = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }); };

    let milk = [], calves = [], sales = [], returns = [], uses = [], checks = [], animals = [], customers = [];
    let server = null;

    /* ================= summary (Milk tab) ================= */

    const nameOf = (id) => { const a = animals.find((x) => x.animalId === id); return a ? a.name : id; };
    function dayTotals() {
      const by = {};
      milk.forEach((m) => { if (m.date && m.litres > 0) by[m.date] = (by[m.date] || 0) + m.litres; });
      return by;
    }

    function renderSummary() {
      const el = $('#mk-summary');
      if (!el) return;
      const today = todayLocal();
      const yest = addDays(today, -1);
      const todayRecs = milk.filter((m) => m.date === today);
      const sessToday = SESSIONS.filter((s) => todayRecs.some((m) => m.session === s));
      const total = todayRecs.reduce((t, m) => t + (m.litres || 0), 0);
      const ySame = milk.filter((m) => m.date === yest && sessToday.includes(m.session)).reduce((t, m) => t + (m.litres || 0), 0);
      const bySess = SESSIONS.map((s) => [s, todayRecs.filter((m) => m.session === s).reduce((t, m) => t + m.litres, 0)]);
      const byCow = {};
      todayRecs.forEach((m) => { byCow[m.cowId] = (byCow[m.cowId] || 0) + m.litres; });
      // Withheld today (treatment).
      const health = getHealth && getHealth();
      const withheld = health ? Object.keys(byCow).filter((id) => health.withdrawalFor(id)).map((id) => [id, byCow[id]]) : [];
      const withheldL = withheld.reduce((t, x) => t + x[1], 0);
      // Last 7 days.
      const totals = dayTotals();
      const days = [...Array(7)].map((_, i) => addDays(today, i - 6));
      const max = Math.max(1, ...days.map((d) => totals[d] || 0));
      // Cows dropping: last 7 complete days vs the 7 before.
      const drops = [];
      const cowIds = [...new Set(milk.map((m) => m.cowId))];
      cowIds.forEach((id) => {
        const daily = {};
        milk.filter((m) => m.cowId === id).forEach((m) => { daily[m.date] = (daily[m.date] || 0) + m.litres; });
        const avg = (from, to) => { const ks = Object.keys(daily).filter((k) => k >= from && k <= to); return ks.length >= 3 ? ks.reduce((t, k) => t + daily[k], 0) / ks.length : null; };
        const now = avg(addDays(today, -7), yest), prev = avg(addDays(today, -14), addDays(today, -8));
        if (now !== null && prev !== null && prev >= 2 && now <= prev * (1 - DROP)) drops.push({ id, now, prev, pct: Math.round((1 - now / prev) * 100) });
      });
      const diff = total - ySame;
      el.innerHTML = `
        <div class="flex items-baseline justify-between gap-2">
          <h2 class="text-sm font-semibold text-slate-500 uppercase tracking-wide">Today so far</h2>
          ${sessToday.length && ySame > 0 ? `<span class="text-xs ${diff >= 0 ? 'text-farm-800' : 'text-red-700'}">${diff >= 0 ? '▲' : '▼'} ${L(Math.abs(diff))} vs yesterday (same milkings)</span>` : ''}
        </div>
        <p class="text-3xl font-bold text-farm-800 mt-1">${L(total)}</p>
        <div class="grid grid-cols-3 gap-2 mt-2 text-center text-xs">${bySess.map(([s, v]) => `<div class="rounded-lg ${v ? 'bg-farm-50 text-farm-900' : 'bg-slate-50 text-slate-400'} py-1">${s}<br><b>${v ? L(v) : '—'}</b></div>`).join('')}</div>
        ${Object.keys(byCow).length ? `<p class="text-xs text-slate-600 mt-2">${Object.keys(byCow).sort((a, b) => byCow[b] - byCow[a]).map((id) => `${esc(nameOf(id))} ${L(byCow[id])}`).join(' · ')}</p>` : ''}
        ${withheldL > 0 ? `<p class="text-xs font-semibold text-red-700 mt-1">${L(withheldL)} from ${withheld.map((x) => esc(nameOf(x[0]))).join(', ')} is withheld (treatment): ${L(total - withheldL)} can be sold.</p>` : ''}
        <div class="flex items-end gap-1 h-16 mt-3" aria-label="Last 7 days">${days.map((d) => {
          const v = totals[d] || 0;
          return `<div class="flex-1 flex flex-col items-center gap-0.5"><span class="text-[9px] text-slate-500">${v ? Math.round(v) : ''}</span>
            <div class="w-full rounded-t ${d === today ? 'bg-farm-500 opacity-50' : 'bg-farm-600'}" style="height:${Math.max(2, Math.round(v / max * 40))}px" title="${esc(fmt(d))}: ${L(v)}"></div>
            <span class="text-[9px] text-slate-400">${fmt(d).slice(0, 2)}</span></div>`;
        }).join('')}</div>
        ${drops.length ? `<p class="text-xs text-amber-900 bg-amber-50 rounded-lg px-3 py-2 mt-2">Dropping: ${drops.map((x) => `<b>${esc(nameOf(x.id))}</b> ${r1(x.now)} L/day, down ${x.pct}% from ${r1(x.prev)}`).join(' · ')}. Check for mastitis, illness, heat or feed.</p>` : ''}
        ${!milk.length ? '<p class="text-xs text-slate-400 mt-2">Shows milkings recorded on this phone (the last 30 days).</p>' : ''}`;
    }

    /* ================= view switch ================= */

    function setView(view) {
      $$('.mk-view-btn').forEach((b) => {
        const on = b.dataset.view === view;
        b.setAttribute('aria-pressed', String(on));
        b.classList.toggle('bg-farm-700', on); b.classList.toggle('text-white', on);
        b.classList.toggle('bg-white', !on); b.classList.toggle('text-farm-800', !on);
      });
      show($('#mk-view-milking'), view === 'milking');
      show($('#mk-view-use'), view === 'use');
      if (view === 'use') { renderUse(); refresh(false); }
    }

    /* ================= use & quality ================= */

    /** The phone's view of one day: produced, sold, calves, withheld (today only), uses entered. */
    function dayFromPhone(date) {
      const produced = milk.filter((m) => m.date === date).reduce((t, m) => t + (m.litres || 0), 0);
      const sold = sales.filter((s) => s.date === date && s.transactionType !== 'Balance B/F').reduce((t, s) => t + (Number(s.litres) || 0), 0)
        - returns.filter((x) => x.date === date).reduce((t, x) => t + (Number(x.litresReturned) || 0), 0);
      const calf = calves.filter((c) => c.date === date && c.feedType === 'Milk').reduce((t, c) => t + (Number(c.quantityKg) || 0), 0) / KG_PER_LITRE;
      const health = getHealth && getHealth();
      const withheld = date === todayLocal() && health ? milk.filter((m) => m.date === date && health.withdrawalFor(m.cowId)).reduce((t, m) => t + m.litres, 0) : 0;
      const u = uses.filter((x) => x.date === date && !x.voided);
      const sum = (f) => u.reduce((t, x) => t + (Number(x[f]) || 0), 0);
      const used = { home: sum('homeL'), spoilt: sum('spoiltL'), rejected: sum('rejectedL'), other: sum('otherL') };
      return { produced, sold, calf, withheld, ...used, unaccounted: produced - sold - calf - withheld - used.home - used.spoilt - used.rejected - used.other };
    }

    function renderGuide() {
      const date = $('#mu-date').value || todayLocal();
      const d = dayFromPhone(date);
      const typed = ['#mu-home', '#mu-spoilt', '#mu-rejected', '#mu-other'].reduce((t, s) => t + (num($(s).value) || 0), 0);
      const left = d.unaccounted - typed;
      $('#mu-guide').innerHTML = d.produced > 0 ? `On ${esc(fmt(date))} (this phone): produced <b>${L(d.produced)}</b> · sold ${L(d.sold)} · calves ${L(d.calf)}${d.withheld ? ` · withheld ${L(d.withheld)}` : ''}` +
        `${d.home + d.spoilt + d.rejected + d.other ? ` · already entered ${L(d.home + d.spoilt + d.rejected + d.other)}` : ''}. ` +
        `<span class="${Math.abs(left) > Math.max(1, d.produced * 0.05) ? 'text-amber-800 font-semibold' : 'text-farm-800'}">Still unaccounted: ${L(left)}</span>`
        : 'No milkings recorded on this phone for that day.';
    }

    function renderUse() {
      if (!$('#mk-view-use')) return;
      renderGuide();
      const sel = $('#mq-sample');
      const keep = sel.value;
      sel.innerHTML = '<option value="Bulk">Bulk (all the milk)</option>' + animals.filter((a) => a.herd === 'farm' && a.status === 'Active' && a.sex === 'Female' && a.category === 'Cow')
        .map((a) => `<option value="${esc(a.animalId)}">${esc(a.name)} (${esc(a.animalId)})</option>`).join('');
      if (keep) sel.value = keep;
      $('#mu-buyer-list').innerHTML = customers.filter((c) => c.status !== 'Inactive').map((c) => `<option value="${esc(c.name)}"></option>`).join('');
      // Daily balance from the sheet.
      const days = (server && server.days) || [];
      $('#mu-days').innerHTML = days.length ? `<table class="w-full text-[11px] whitespace-nowrap"><thead><tr class="text-slate-500 text-right"><th class="text-left font-semibold">Day</th><th>Made</th><th>Sold</th><th>Calf</th><th>Home</th><th>Held</th><th>Lost</th><th>Left</th></tr></thead>
        <tbody>${days.slice(0, 7).map((d) => `<tr class="text-right border-t border-slate-100 ${d.note ? 'bg-amber-50' : ''}"><td class="text-left py-1">${esc(short(d.date))}</td><td>${r1(d.produced)}</td><td>${r1(d.sold)}</td><td>${r1(d.calves)}</td>
          <td>${r1(d.home)}</td><td>${d.withheld ? r1(d.withheld) : ''}</td><td>${d.spoilt + d.rejected ? r1(d.spoilt + d.rejected) : ''}</td><td class="${d.note ? 'text-amber-800 font-semibold' : ''}">${r1(d.unaccounted)}</td></tr>`).join('')}</tbody></table>
        <p class="text-[10px] text-slate-400 mt-1">Litres. Calf = fed to calves · Held = withheld after treatment · Lost = spoilt or rejected · Left = unaccounted.</p>
        ${days.slice(0, 7).some((d) => d.note) ? `<p class="text-xs text-amber-800 mt-1">${esc(days.slice(0, 7).find((d) => d.note).note)}</p>` : ''}`
        : '<p class="text-xs text-slate-400">The balance from the sheet appears here when online.</p>';
      // Recent entries on this phone.
      const recent = uses.map((u) => ({ ...u, kind: 'use' })).concat(checks.map((c) => ({ ...c, kind: 'check' })))
        .filter((x) => !x.voided).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 8);
      $('#mu-recent').innerHTML = recent.length ? recent.map((x) => {
        const what = x.kind === 'use' ? [['home', x.homeL], ['spoilt', x.spoiltL], ['rejected', x.rejectedL], ['other', x.otherL]].filter((p) => Number(p[1]) > 0).map((p) => `${p[0]} ${L(p[1])}`).join(' · ') +
          (x.buyer ? ` (${esc(x.buyer)})` : '') : `${esc(x.test)}${x.reading !== '' && x.reading !== undefined ? ' ' + esc(x.reading) : ''}${x.result ? ' · ' + esc(x.result) : ''} · ${esc(x.sample === 'Bulk' ? 'bulk' : nameOf(x.sample))}`;
        const pending = x.syncStatus !== SYNC_STATUS.SYNCED;
        return `<li class="flex items-center justify-between gap-3 bg-white rounded-xl px-4 py-2 shadow-sm text-xs">
          <span class="min-w-0"><b>${esc(fmt(x.date))}</b> · ${x.kind === 'use' ? 'Use' : 'Check'}: ${what}${x.result === 'Fail' ? ' <span class="text-red-700 font-semibold">FAIL</span>' : ''}${pending ? ' <span class="text-amber-700">(not uploaded)</span>' : ''}</span>
          <button type="button" class="mu-del shrink-0 text-slate-400 hover:text-red-600" data-kind="${x.kind}" data-id="${esc(x.clientId)}">${pending ? 'Delete' : 'Cancel'}</button></li>`;
      }).join('') : '<li class="text-xs text-slate-400 px-1">Nothing entered on this phone yet.</li>';
      updateQuality();
    }

    function nextId(prefix, date, list, field) {
      const stem = prefix + date.slice(2, 4) + date.slice(5, 7) + date.slice(8, 10) + '-';
      let max = 0;
      list.forEach((x) => { if (x[field] && x[field].startsWith(stem)) max = Math.max(max, parseInt(x[field].slice(stem.length), 10) || 0); });
      return stem + String(max + 1).padStart(3, '0');
    }
    function baseRecord() {
      const now = new Date().toISOString();
      const s = getSession();
      return { clientId: makeUUID(), deviceId: getDeviceId(), recordedBy: s ? s.email : '', createdAt: now, updatedAt: now, syncStatus: SYNC_STATUS.PENDING, syncAttempts: 0, lastError: null, syncedAt: null };
    }
    function setError(sel, m) { const el = $(sel); el.textContent = m || ''; show(el, !!m); }

    async function saveUse(e) {
      e.preventDefault();
      setError('#mu-error', '');
      if (!getSession()) { toast('Sign in first', 'error'); return; }
      const date = $('#mu-date').value;
      const v = {};
      for (const [k, s] of [['homeL', '#mu-home'], ['spoiltL', '#mu-spoilt'], ['rejectedL', '#mu-rejected'], ['otherL', '#mu-other']]) {
        const raw = $(s).value.trim();
        v[k] = raw === '' ? '' : num(raw);
        if (raw !== '' && (v[k] === null || v[k] < 0 || v[k] > 500)) { setError('#mu-error', 'Litres must be between 0 and 500.'); return; }
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > todayLocal()) { setError('#mu-error', 'Pick the date (not in the future).'); return; }
      if (!(['homeL', 'spoiltL', 'rejectedL', 'otherL'].some((k) => v[k] > 0))) { setError('#mu-error', 'Enter at least one amount of milk.'); return; }
      const buyer = $('#mu-buyer').value.trim().slice(0, 80);
      if (v.rejectedL > 0 && !buyer) { setError('#mu-error', 'Which buyer rejected the milk?'); return; }
      const rec = { ...baseRecord(), useId: nextId('MU', date, uses, 'useId'), date, ...v, buyer: v.rejectedL > 0 ? buyer : '', reason: $('#mu-reason').value.trim().slice(0, 120), notes: $('#mu-notes').value.trim().slice(0, 300) };
      await db[USE].add(rec);
      ['#mu-home', '#mu-spoilt', '#mu-rejected', '#mu-other', '#mu-buyer', '#mu-reason', '#mu-notes'].forEach((s) => { $(s).value = ''; });
      toast('Milk use saved');
      requestSync('new-record', saveDebounceMs);
    }

    function lactoValue(raw) {
      const n = num(raw);
      if (n === null) return null;
      if (n >= 15 && n <= 45) return Math.round((1 + n / 1000) * 10000) / 10000;
      if (n >= 1.015 && n <= 1.045) return n;
      return null;
    }
    function updateQuality() {
      const t = $('#mq-test').value;
      show($('#mq-reading-wrap'), t === 'Lactometer' || t === 'Temperature');
      show($('#mq-result-wrap'), t !== 'Lactometer');
      $('#mq-reading-label').textContent = t === 'Temperature' ? 'Temperature (°C)' : 'Reading (e.g. 28 or 1.028)';
      const l = t === 'Lactometer' ? lactoValue($('#mq-reading').value) : null;
      $('#mq-verdict').innerHTML = t !== 'Lactometer' || $('#mq-reading').value.trim() === '' ? '' : l === null ? '<span class="text-red-700">Type the reading like 28 or 1.028.</span>'
        : l < LACTO[0] ? `<span class="text-red-700 font-semibold">${l.toFixed(3)}: FAIL, below ${LACTO[0]} — possible added water.</span>`
          : l > LACTO[1] ? `<span class="text-red-700 font-semibold">${l.toFixed(3)}: FAIL, above ${LACTO[1]} — possibly skimmed or added solids.</span>`
            : `<span class="text-farm-800 font-semibold">${l.toFixed(3)}: pass (${LACTO[0]}–${LACTO[1]}).</span>`;
    }
    async function saveCheck(e) {
      e.preventDefault();
      setError('#mq-error', '');
      if (!getSession()) { toast('Sign in first', 'error'); return; }
      const date = $('#mq-date').value;
      const test = $('#mq-test').value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > todayLocal()) { setError('#mq-error', 'Pick the date (not in the future).'); return; }
      let reading = '', result = test === 'Lactometer' ? '' : $('#mq-result').value;
      if (test === 'Lactometer') {
        reading = lactoValue($('#mq-reading').value);
        if (reading === null) { setError('#mq-error', 'Type the lactometer reading like 28 or 1.028.'); return; }
        result = reading >= LACTO[0] && reading <= LACTO[1] ? 'Pass' : 'Fail';
      } else if (test === 'Temperature') {
        reading = num($('#mq-reading').value);
        if (reading === null || reading < -5 || reading > 60) { setError('#mq-error', 'Type the temperature in °C.'); return; }
      } else if (!result) { setError('#mq-error', 'Choose pass or fail.'); return; }
      const rec = { ...baseRecord(), checkId: nextId('MQ', date, checks, 'checkId'), date, session: $('#mq-session').value, sample: $('#mq-sample').value, test, reading, result: result || '',
        notes: $('#mq-notes').value.trim().slice(0, 300) };
      await db[QUALITY].add(rec);
      ['#mq-reading', '#mq-notes'].forEach((s) => { $(s).value = ''; });
      updateQuality();
      toast(`Check saved${result ? ': ' + result : ''}`, result === 'Fail' ? 'error' : undefined);
      requestSync('new-record', saveDebounceMs);
    }

    async function deleteEntry(kind, clientId) {
      const store = kind === 'use' ? USE : QUALITY;
      const x = await db[store].where('clientId').equals(clientId).first();
      if (!x) return;
      if (x.syncStatus !== SYNC_STATUS.SYNCED) {
        if (!confirm('Delete this entry? It has not been uploaded yet.')) return;
        await db[store].delete(x.id);
        toast('Deleted', 'info');
        return;
      }
      const reason = prompt('Cancel this entry? It stays in the sheet marked Void.\n\nReason:');
      if (reason === null) return;
      if (!reason.trim()) { toast('A reason is needed to cancel', 'error'); return; }
      await queueCorrection({ sheet: kind === 'use' ? 'Milk_Use' : 'Milk_Quality', id: kind === 'use' ? x.useId : x.checkId, changes: {}, void: true, reason: reason.trim().slice(0, 300) });
      await db[store].update(x.id, { voided: true });
      toast('Cancelled: uploads with the next sync', 'info');
    }

    async function refresh(loud) {
      if (!navigator.onLine || !getSession()) { if (loud) toast('Updates when online and signed in', 'info'); return false; }
      try {
        const r = await callServer({ action: 'listMilkUse', days: 14 });
        if (!Array.isArray(r.days)) throw new Error('reply has no balance');
        server = { days: r.days, checks: r.checks || [], serverTime: r.serverTime };
        await db.kv.put({ key: 'milkUseList', value: server });
        renderUse();
        if (loud) toast('Milk balance updated', 'info');
        return true;
      } catch (err) {
        if (loud) toast('Could not update: ' + (err.message || err), 'error');
        return false;
      }
    }

    async function applyRename(storeName, rec, renamed) {
      if (![USE, QUALITY].includes(storeName) || !renamed || !renamed.value) return;
      await db[storeName].update(rec.id, storeName === USE ? { useId: renamed.value } : { checkId: renamed.value });
    }

    /* ================= edit a milking (v5.8.2) ================= */

    const SESSION_NAMES = ['Morning', 'Afternoon', 'Evening'];
    let editing = null; // the milk_logs record being edited

    function editValues() {
      return { cowId: $('#mk-edit-cow').value, session: $('#mk-edit-session').value, litres: num($('#mk-edit-litres').value), date: $('#mk-edit-date').value };
    }
    /** Another (not cancelled) entry on this phone for the same cow, day and milking. */
    function clash(v) {
      return milk.find((m) => m.id !== editing.id && m.cowId === v.cowId && m.date === v.date && m.session === v.session);
    }
    function updateEditWarn() {
      if (!editing) return;
      const c = clash(editValues());
      const w = $('#mk-edit-warn');
      w.innerHTML = c ? `${esc(nameOf(c.cowId))} already has a ${esc(c.session)} entry on ${esc(fmt(c.date))} (${L(c.litres)}). Saving gives two entries that are added together; if one is a mistake, cancel it instead.` : '';
      show(w, !!c);
    }

    async function openEdit(id) {
      const rec = await db.milk_logs.get(id);
      if (!rec || rec.voided) { toast('That entry is no longer here', 'error'); return; }
      editing = rec;
      const synced = rec.syncStatus === SYNC_STATUS.SYNCED;
      // Cows: the same list as the milk form, plus this entry's cow if she is no longer in it.
      const sel = $('#mk-edit-cow');
      const src = document.querySelector('#milk-cowId');
      sel.innerHTML = src ? src.innerHTML : '';
      [...sel.options].forEach((o) => { if (!o.value) o.remove(); });
      if (![...sel.options].some((o) => o.value === rec.cowId)) sel.insertAdjacentHTML('afterbegin', `<option value="${esc(rec.cowId)}">${esc(rec.cowName || rec.cowId)} (${esc(rec.cowId)})</option>`);
      sel.value = rec.cowId;
      $('#mk-edit-session').value = SESSION_NAMES.includes(rec.session) ? rec.session : 'Morning';
      $('#mk-edit-litres').value = rec.litres;
      $('#mk-edit-date').value = rec.date;
      $('#mk-edit-date').max = todayLocal();
      $('#mk-edit-reason').value = '';
      show($('#mk-edit-reason-wrap'), synced);
      $('#mk-edit-info').textContent = synced
        ? 'Already in Google Sheets: the sheet is corrected with the next sync, and the change is logged with your reason.'
        : 'Not uploaded yet: the entry on this phone is changed.';
      $('#mk-edit-void').textContent = synced ? 'Cancel this milking' : 'Delete this entry';
      setError('#mk-edit-error', '');
      updateEditWarn();
      show($('#mk-edit'), true);
      $('#mk-edit-litres').focus();
    }
    function closeEdit() { editing = null; show($('#mk-edit'), false); }

    async function saveEdit(e) {
      e.preventDefault();
      if (!editing) return;
      setError('#mk-edit-error', '');
      const v = editValues();
      if (!v.cowId) { setError('#mk-edit-error', 'Choose the cow.'); return; }
      if (v.litres === null || v.litres <= 0 || v.litres > 60) { setError('#mk-edit-error', 'Litres must be above 0 and at most 60.'); return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date) || v.date > todayLocal()) { setError('#mk-edit-error', 'Pick the date (not in the future).'); return; }
      const changes = {};
      if (v.cowId !== editing.cowId) { changes.cowId = v.cowId; changes.cowName = nameOf(v.cowId); }
      if (v.session !== editing.session) changes.session = v.session;
      if (Math.abs(v.litres - Number(editing.litres)) > 0.001) changes.litres = v.litres;
      if (v.date !== editing.date) changes.date = v.date;
      if (!Object.keys(changes).length) { closeEdit(); return; }
      const c = clash(v);
      if (c && !confirm(`${nameOf(c.cowId)} already has a ${c.session} entry that day (${r1(c.litres)} L). Keep both?`)) return;
      const synced = editing.syncStatus === SYNC_STATUS.SYNCED;
      const now = new Date().toISOString();
      if (!synced) {
        if (isMilkInFlight && isMilkInFlight(editing.id)) { setError('#mk-edit-error', 'This entry is uploading right now. Try again in a moment.'); return; }
        await db.milk_logs.update(editing.id, { ...changes, updatedAt: now });
        toast('Entry changed');
        closeEdit();
        return;
      }
      const reason = $('#mk-edit-reason').value.trim();
      if (!reason) { setError('#mk-edit-error', 'Give a reason for the change (it is kept with the record).'); return; }
      await queueCorrection({ sheet: 'Milk_Production', id: editing.clientId, changes, void: false, reason: reason.slice(0, 300) });
      await db.milk_logs.update(editing.id, { ...changes, corrected: true, updatedAt: now });
      toast('Changed: the sheet is corrected with the next sync');
      closeEdit();
    }

    async function voidEdit() {
      if (!editing) return;
      const rec = editing;
      if (rec.syncStatus !== SYNC_STATUS.SYNCED) {
        if (isMilkInFlight && isMilkInFlight(rec.id)) { setError('#mk-edit-error', 'This entry is uploading right now. Try again in a moment.'); return; }
        if (!confirm('Delete this entry? It has not been uploaded yet.')) return;
        await db.milk_logs.delete(rec.id);
        toast('Entry deleted', 'info');
        closeEdit();
        return;
      }
      const reason = $('#mk-edit-reason').value.trim();
      if (!reason) { setError('#mk-edit-error', 'Give a reason for cancelling (e.g. entered twice).'); $('#mk-edit-reason').focus(); return; }
      if (!confirm(`Cancel ${nameOf(rec.cowId)}'s ${rec.session} milking of ${r1(rec.litres)} L on ${fmt(rec.date)}? It stays in the sheet marked Void and is no longer counted.`)) return;
      await queueCorrection({ sheet: 'Milk_Production', id: rec.clientId, changes: {}, void: true, reason: reason.slice(0, 300) });
      await db.milk_logs.update(rec.id, { voided: true, updatedAt: new Date().toISOString() });
      toast('Milking cancelled: the sheet is updated with the next sync', 'info');
      closeEdit();
    }

    /* ================= init ================= */

    function init() {
      const t = todayLocal();
      ['#mu-date', '#mq-date'].forEach((s) => { $(s).value = t; $(s).max = t; });
      const h = new Date().getHours();
      $('#mq-session').value = h < 11 ? 'Morning' : h < 17 ? 'Afternoon' : 'Evening';
      $$('.mk-view-btn').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
      $('#mu-form').addEventListener('submit', saveUse);
      $('#mq-form').addEventListener('submit', saveCheck);
      ['#mu-home', '#mu-spoilt', '#mu-rejected', '#mu-other'].forEach((s) => $(s).addEventListener('input', renderGuide));
      $('#mu-date').addEventListener('change', renderGuide);
      $('#mq-test').addEventListener('change', updateQuality);
      $('#mq-reading').addEventListener('input', updateQuality);
      $('#mu-refresh').addEventListener('click', () => refresh(true));
      $('#mu-recent').addEventListener('click', (e) => { const b = e.target.closest('.mu-del'); if (b) deleteEntry(b.dataset.kind, b.dataset.id); });
      const watch = (q, set) => Dexie.liveQuery(q).subscribe({ next: (r) => { set(r); renderSummary(); renderUse(); }, error: (er) => console.error('Milk use query failed:', er) });
      watch(() => db.milk_logs.toArray(), (r) => { milk = r.filter((m) => !m.voided); });
      watch(() => db.calf_logs.toArray(), (r) => { calves = r; });
      watch(() => db.sales.toArray(), (r) => { sales = r; });
      watch(() => db.returns.toArray(), (r) => { returns = r; });
      watch(() => db[USE].toArray(), (r) => { uses = r; });
      watch(() => db[QUALITY].toArray(), (r) => { checks = r; });
      watch(() => db.animals.toArray(), (r) => { animals = r; });
      watch(() => db.customers.toArray(), (r) => { customers = r; });
      // Health records change the "withheld" line: redraw when they do.
      Dexie.liveQuery(() => db.health_events.count()).subscribe({ next: () => renderSummary() });
      db.kv.get('milkUseList').then((x) => { if (x && x.value) { server = x.value; renderUse(); } }).catch(() => {});
      // Edit a milking.
      $('#mk-edit-form').addEventListener('submit', saveEdit);
      $('#mk-edit-void').addEventListener('click', voidEdit);
      $('#mk-edit-close').addEventListener('click', closeEdit);
      $('#mk-edit').addEventListener('click', (e) => { if (e.target.id === 'mk-edit') closeEdit(); });
      ['#mk-edit-cow', '#mk-edit-session', '#mk-edit-date'].forEach((sel) => $(sel).addEventListener('change', updateEditWarn));
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && editing) closeEdit(); });
      setView('milking');
    }

    return Object.freeze({ init, refresh, applyRename, renderSummary, openEdit });
  }

  window.MaweMilkUse = Object.freeze({ create, USE, QUALITY, PAYLOAD });
})();
