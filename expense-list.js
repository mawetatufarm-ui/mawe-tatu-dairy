/* =====================================================================
 * Mawe Tatu Dairy — expense-list.js ("All expenses" view of the Expenses tab)
 * ---------------------------------------------------------------------
 * The list of every expense in Google Sheets (not only this phone), with:
 *
 *   • Filters: dates (quick: this month / last month / this year), group,
 *     category, supplier, payment status (owing / paid / part paid /
 *     unpaid), animal, and free text (item, notes, M-Pesa code, ID).
 *   • Totals (amount, paid, still owed) and what is owed to each supplier.
 *   • PAY a balance (credit purchases): saved on the phone first in the
 *     `expense_payments` store → Expense_Payments tab (appendRecords).
 *   • EDIT (correct) or CANCEL (void, with a reason) an expense already in
 *     the sheet: saved first in `expense_edits` → action updateExpenses.
 *   • RECEIPT photos / PDFs: added here or on the expense form; photos are
 *     shrunk to ≤1280 px JPEG on the phone, kept in `receipts`, then sent
 *     one by one with action uploadReceipt (saved in Google Drive).
 *   • Export the filtered list to CSV or Excel.
 *
 * Online: the list comes from the server (listExpenses) and is cached in
 * kv 'expenseList' so the last list can still be read offline. Payments,
 * edits and receipts made offline wait on the phone and upload with the
 * next sync (app.js calls syncExtras() after the append stores).
 *
 * Loaded by index.html after expenses.js and before app.js; defines
 * window.MaweExpenseList. Field names match ExpenseLedger.gs.
 * ===================================================================== */

(() => {
  'use strict';

  const PAY_STORE = 'expense_payments';
  const EDIT_STORE = 'expense_edits';
  const RECEIPT_STORE = 'receipts';
  const PAY_METHODS = ['Cash', 'M-Pesa', 'Bank', 'Other'];
  const PAYLOAD = Object.freeze({
    [PAY_STORE]: ['clientId', 'deviceId', 'paymentId', 'date', 'expenseId', 'payee', 'amount', 'paymentMethod', 'receiptRef', 'notes', 'recordedBy', 'createdAt'],
  });
  const XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
  const MAX_SIDE = 1280;          // px, longest side of a receipt photo
  const MAX_PDF_BYTES = 2500000;  // ~2.5 MB

  /**
   * Read a chosen receipt file into { mimeType, data (base64), fileName }.
   * Photos are redrawn as JPEG ≤1280 px (a phone photo of 3–5 MB becomes ~150 KB).
   */
  async function readReceipt(file) {
    if (!file) return null;
    const asDataUrl = (blob) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(fr.error); fr.readAsDataURL(blob); });
    if (file.type === 'application/pdf') {
      if (file.size > MAX_PDF_BYTES) throw new Error('PDF is larger than 2.5 MB: take a photo of it instead.');
      const url = await asDataUrl(file);
      return { mimeType: 'application/pdf', data: url.split(',')[1], fileName: file.name || 'receipt.pdf' };
    }
    if (!/^image\//.test(file.type)) throw new Error('Choose a photo or a PDF.');
    const url = await asDataUrl(file);
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Could not read the photo.')); i.src = url; });
    const k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round((img.naturalWidth || img.width) * k));
    c.height = Math.max(1, Math.round((img.naturalHeight || img.height) * k));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const out = c.toDataURL('image/jpeg', 0.72);
    return { mimeType: 'image/jpeg', data: out.split(',')[1], fileName: (file.name || 'receipt').replace(/\.\w+$/, '') + '.jpg' };
  }

  function create(deps) {
    const { db, SYNC_STATUS, getSession, getDeviceId, makeUUID, todayLocal, esc, toast, requestSync, saveDebounceMs, callServer, SyncError,
      CATEGORIES, METHODS, groupOf } = deps;
    const $ = (s) => document.querySelector(s);
    const show = (el, v) => el && el.classList.toggle('hidden', !v);
    const num = (v) => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
    const r2 = (x) => Math.round(x * 100) / 100;
    const money = (x) => 'KES ' + Number(x || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const fmtDate = (k) => { if (!k) return ''; const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString([], { day: 'numeric', month: 'short', year: '2-digit' }); };
    const pad = (n) => String(n).padStart(2, '0');

    let data = null;        // last listExpenses reply (+ cachedAt)
    let payRows = [];       // expense_payments on this phone
    let editRows = [];      // expense_edits on this phone
    let receiptRows = [];   // receipts waiting to upload
    let animals = [];
    let xlsxPromise = null;

    function baseRecord() {
      const now = new Date().toISOString();
      const s = getSession();
      return { clientId: makeUUID(), deviceId: getDeviceId(), createdAt: now, updatedAt: now, syncStatus: SYNC_STATUS.PENDING, syncAttempts: 0, lastError: null, syncedAt: null, recordedBy: s ? s.email : '' };
    }

    /* ================= filters ================= */

    function setRange(kind) {
      const t = todayLocal();
      let from = t.slice(0, 8) + '01', to = t;
      if (kind === 'last') {
        const [y, m] = t.split('-').map(Number);
        const d = new Date(y, m - 2, 1);
        from = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`;
        const e = new Date(y, m - 1, 0);
        to = `${e.getFullYear()}-${pad(e.getMonth() + 1)}-${pad(e.getDate())}`;
      } else if (kind === 'year') from = t.slice(0, 4) + '-01-01';
      else if (kind === 'all') from = String(Number(t.slice(0, 4)) - 2) + t.slice(4);
      $('#exl-from').value = from; $('#exl-to').value = to;
    }

    function fillFilters() {
      $('#exl-group').innerHTML = '<option value="ALL">All groups</option>' + CATEGORIES.map((g) => `<option>${esc(g.group)}</option>`).join('');
      fillCategories();
      fillAnimals();
    }
    function fillCategories() {
      const g = $('#exl-group').value;
      const list = CATEGORIES.filter((x) => g === 'ALL' || x.group === g).flatMap((x) => x.items);
      $('#exl-category').innerHTML = '<option value="">All categories</option>' + list.map((c) => `<option>${esc(c)}</option>`).join('');
    }
    function fillAnimals() {
      const sel = $('#exl-animal');
      const keep = sel.value;
      sel.innerHTML = '<option value="">Any animal</option>' + animals.filter((a) => a.herd !== 'external').sort((a, b) => a.animalId.localeCompare(b.animalId))
        .map((a) => `<option value="${esc(a.animalId)}">${esc(a.name)} (${esc(a.animalId)})</option>`).join('');
      sel.value = keep;
    }

    function filters() {
      return { from: $('#exl-from').value, to: $('#exl-to').value, group: $('#exl-group').value, category: $('#exl-category').value,
        payee: $('#exl-payee').value.trim(), status: $('#exl-status').value, animalId: $('#exl-animal').value, q: $('#exl-q').value.trim() };
    }

    /* ================= loading ================= */

    function setMsg(kind, text) {
      const el = $('#exl-msg');
      el.textContent = text || '';
      el.className = 'text-sm rounded-lg px-3 py-2 ' + (kind === 'error' ? 'bg-red-50 text-red-700' : kind === 'info' ? 'bg-amber-50 text-amber-900' : 'hidden');
      show(el, !!text);
    }

    async function load() {
      const f = filters();
      if (!f.from || !f.to || f.from > f.to) { setMsg('error', 'Choose a From date before the To date.'); return; }
      if (!navigator.onLine || !getSession()) { await showCached(f, !getSession() ? 'Sign in to see the full list.' : 'Offline.'); return; }
      const btn = $('#exl-run');
      btn.disabled = true; btn.textContent = 'Loading…';
      try {
        const reply = await callServer({ action: 'listExpenses', ...f });
        data = { ...reply, filters: f, cachedAt: new Date().toISOString() };
        try { await db.kv.put({ key: 'expenseList', value: data }); } catch (e) { /* cache is optional */ }
        setMsg('', '');
        render();
      } catch (err) {
        await showCached(f, (err && err.message) || 'Could not load the list.');
      } finally {
        btn.disabled = false; btn.textContent = 'Show';
      }
    }

    async function showCached(f, why) {
      const c = await db.kv.get('expenseList').catch(() => null);
      if (c && c.value) {
        data = c.value;
        setMsg('info', `${why} Showing the list from ${new Date(data.cachedAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} (${fmtDate(data.from)} – ${fmtDate(data.to)}).`);
        render();
      } else {
        setMsg('info', `${why} The list needs the internet once; new expenses, payments and edits can still be recorded offline.`);
      }
    }

    /* ================= rendering ================= */

    /** Unsent payments / edits on this phone for an expense. */
    const localPaid = (id) => payRows.filter((p) => p.expenseId === id && p.syncStatus !== SYNC_STATUS.SYNCED).reduce((t, p) => t + p.amount, 0);
    const pendingEdit = (id) => editRows.find((e) => e.expenseId === id && e.syncStatus !== SYNC_STATUS.SYNCED);
    const pendingReceipts = (id) => receiptRows.filter((r) => r.expenseId === id).length;

    function chip(line) {
      const bal = r2(line.balance - localPaid(line.expenseId));
      if (bal <= 0.005) return '<span class="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-farm-100 text-farm-800">Paid</span>';
      const cls = line.paid > 0 || localPaid(line.expenseId) > 0 ? 'bg-amber-100 text-amber-900' : 'bg-red-100 text-red-700';
      return `<span class="text-[11px] font-semibold px-2 py-0.5 rounded-full ${cls}">Owe ${money(bal).replace('KES ', '')}</span>`;
    }

    function render() {
      if (!data) return;
      const t = data.totals;
      const unsent = payRows.filter((p) => p.syncStatus !== SYNC_STATUS.SYNCED).reduce((s, p) => s + p.amount, 0);
      $('#exl-totals').innerHTML = `
        <div class="grid grid-cols-3 gap-2 text-center">
          <div class="bg-white rounded-xl p-2 shadow-sm"><p class="text-[11px] text-slate-500">${t.count} expense${t.count === 1 ? '' : 's'}</p><p class="font-bold text-rose-800 text-sm">${money(t.amount)}</p></div>
          <div class="bg-white rounded-xl p-2 shadow-sm"><p class="text-[11px] text-slate-500">Paid</p><p class="font-bold text-farm-800 text-sm">${money(t.paid)}</p></div>
          <div class="bg-white rounded-xl p-2 shadow-sm"><p class="text-[11px] text-slate-500">Still owed</p><p class="font-bold ${t.owing > 0 ? 'text-red-700' : 'text-slate-700'} text-sm">${money(t.owing)}</p></div>
        </div>
        ${unsent > 0 ? `<p class="text-xs text-amber-800 mt-1 px-1">${money(unsent)} of payments on this phone not uploaded yet.</p>` : ''}
        ${data.truncated ? '<p class="text-xs text-amber-800 mt-1 px-1">Showing the latest 1,500: narrow the dates or filters to see older ones.</p>' : ''}`;
      const sup = data.suppliers || [];
      $('#exl-suppliers').innerHTML = sup.length ? `<p class="text-xs font-semibold text-slate-500 uppercase tracking-wide px-1 mb-1">Owed to suppliers (all dates)</p>
        <div class="flex flex-wrap gap-2">${sup.map((s) => `<button type="button" class="exl-sup text-xs bg-red-50 text-red-800 rounded-full px-3 py-1" data-payee="${esc(s.payee)}">${esc(s.payee)} · ${money(s.owing)}</button>`).join('')}</div>` : '';
      $('#exl-list').innerHTML = data.lines.length ? data.lines.map((x) => `
        <li class="bg-white rounded-xl shadow-sm" data-id="${esc(x.expenseId)}">
          <button type="button" class="exl-row w-full text-left px-4 py-3 flex items-start justify-between gap-3">
            <span class="min-w-0">
              <span class="block font-semibold text-sm truncate">${esc(x.item || x.category)} · ${money(x.amount)}</span>
              <span class="block text-xs text-slate-500 truncate">${esc(fmtDate(x.date))} · ${esc(x.category)}${x.payee ? ' · ' + esc(x.payee) : ''}${x.quantity !== '' ? ` · ${x.quantity} ${esc(x.unit)}` : ''}</span>
              ${pendingEdit(x.expenseId) ? '<span class="block text-[11px] text-amber-800">Correction waiting to upload</span>' : ''}
            </span>
            <span class="flex flex-col items-end gap-1 shrink-0">${chip(x)}${x.receiptFile || pendingReceipts(x.expenseId) ? '<span class="text-[11px] text-slate-500">📎 receipt</span>' : ''}</span>
          </button>
          <div class="exl-detail hidden px-4 pb-3 text-xs text-slate-600 space-y-1"></div>
        </li>`).join('') : '<li class="text-sm text-slate-400 px-1">No expenses match.</li>';
    }

    function detailHtml(x) {
      const bal = r2(x.balance - localPaid(x.expenseId));
      const pays = (x.payments || []).map((p) => `<li>${esc(fmtDate(p.date))} · ${money(p.amount)} · ${esc(p.paymentMethod)}${p.receiptRef ? ' ' + esc(p.receiptRef) : ''}</li>`)
        .concat(payRows.filter((p) => p.expenseId === x.expenseId && p.syncStatus !== SYNC_STATUS.SYNCED).map((p) => `<li class="text-amber-800">${esc(fmtDate(p.date))} · ${money(p.amount)} · ${esc(p.paymentMethod)} (not uploaded yet)</li>`));
      const links = String(x.receiptFile || '').split(/\s+/).filter(Boolean).map((u, i) => `<a class="underline text-rose-800" href="${esc(u)}" target="_blank" rel="noopener">Receipt ${i + 1}</a>`).join(' · ');
      return `
        <p><b>${esc(x.expenseId)}</b> · ${esc(x.group)}${x.animalId ? ' · ' + esc(x.animalId) : ''}${x.receiptRef ? ' · ref ' + esc(x.receiptRef) : ''}</p>
        <p>Paid at purchase: ${money(x.amountPaid)} (${esc(x.paymentMethod)})${x.dueDate ? ' · due ' + esc(fmtDate(x.dueDate)) : ''}</p>
        ${pays.length ? `<p class="font-semibold">Later payments</p><ul class="list-disc pl-5">${pays.join('')}</ul>` : ''}
        <p>Balance: <b class="${bal > 0 ? 'text-red-700' : 'text-farm-800'}">${money(bal)}</b></p>
        ${x.notes ? `<p>Notes: ${esc(x.notes)}</p>` : ''}
        ${links ? `<p>${links}</p>` : ''}${pendingReceipts(x.expenseId) ? `<p class="text-amber-800">${pendingReceipts(x.expenseId)} receipt(s) waiting to upload</p>` : ''}
        <div class="flex flex-wrap gap-2 pt-2">
          ${bal > 0.005 ? `<button type="button" class="exl-pay rounded-lg bg-farm-700 text-white font-semibold px-3 py-1.5" data-id="${esc(x.expenseId)}">Pay</button>` : ''}
          <button type="button" class="exl-edit rounded-lg bg-rose-700 text-white font-semibold px-3 py-1.5" data-id="${esc(x.expenseId)}">Edit</button>
          <label class="rounded-lg bg-slate-100 text-slate-700 font-semibold px-3 py-1.5 cursor-pointer">Add receipt<input type="file" class="exl-rcpt hidden" accept="image/*,application/pdf" data-id="${esc(x.expenseId)}" /></label>
          <button type="button" class="exl-void rounded-lg bg-white border border-slate-300 text-slate-600 font-semibold px-3 py-1.5" data-id="${esc(x.expenseId)}">Cancel expense</button>
        </div>`;
    }

    const lineOf = (id) => data && data.lines.find((x) => x.expenseId === id);

    /* ================= sheet (overlay) ================= */

    function openSheet(title, html, onSubmit) {
      $('#exl-sheet-title').textContent = title;
      $('#exl-sheet-body').innerHTML = html;
      setSheetError('');
      show($('#exl-sheet'), true);
      document.body.classList.add('overflow-hidden');
      $('#exl-sheet-form').onsubmit = async (e) => {
        e.preventDefault();
        setSheetError('');
        const btn = $('#exl-sheet-form button[type="submit"]');
        btn.disabled = true;
        try { const done = await onSubmit(); if (done !== false) closeSheet(); } catch (err) { setSheetError(err.message || String(err)); } finally { btn.disabled = false; }
      };
      const first = $('#exl-sheet-body input, #exl-sheet-body select');
      if (first) first.focus();
    }
    function closeSheet() { show($('#exl-sheet'), false); document.body.classList.remove('overflow-hidden'); }
    function setSheetError(m) { const el = $('#exl-sheet-error'); el.textContent = m || ''; show(el, !!m); }

    /* ================= pay ================= */

    function nextPaymentId(date) {
      const stem = 'EP' + date.slice(2, 4) + date.slice(5, 7) + date.slice(8, 10) + '-';
      let max = 0;
      payRows.forEach((p) => { if (p.paymentId && p.paymentId.startsWith(stem)) max = Math.max(max, parseInt(p.paymentId.slice(stem.length), 10) || 0); });
      return stem + String(max + 1).padStart(3, '0');
    }

    function openPay(id) {
      const x = lineOf(id);
      if (!x) return;
      const bal = r2(x.balance - localPaid(id));
      openSheet(`Pay ${x.payee || x.category}`, `
        <p class="text-sm text-slate-600">${esc(x.item || x.category)} · ${esc(fmtDate(x.date))} · balance <b>${money(bal)}</b></p>
        <div class="grid grid-cols-2 gap-3">
          <div><label class="hf-label" for="exl-p-date">Date paid</label><input id="exl-p-date" type="date" class="hf-input" value="${todayLocal()}" max="${todayLocal()}" min="${esc(x.date)}" /></div>
          <div><label class="hf-label" for="exl-p-amount">Amount (KES)</label><input id="exl-p-amount" type="number" min="1" step="0.01" inputmode="decimal" class="hf-input" value="${bal}" /></div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div><label class="hf-label" for="exl-p-method">Paid by</label><select id="exl-p-method" class="hf-input">${PAY_METHODS.map((m) => `<option>${m}</option>`).join('')}</select></div>
          <div><label class="hf-label" for="exl-p-ref">M-Pesa code / ref</label><input id="exl-p-ref" type="text" maxlength="300" class="hf-input uppercase" /></div>
        </div>
        <input id="exl-p-notes" type="text" maxlength="300" class="hf-input" placeholder="Notes (optional)" aria-label="Payment notes" />`, async () => {
        const date = $('#exl-p-date').value;
        const amount = num($('#exl-p-amount').value);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > todayLocal()) throw new Error('Pick the date paid (not in the future).');
        if (date < x.date) throw new Error('The payment cannot be before the purchase.');
        if (!(amount > 0)) throw new Error('Enter the amount paid.');
        if (amount > bal + 0.005) throw new Error(`That is more than the balance (${money(bal)}).`);
        const rec = { ...baseRecord(), paymentId: nextPaymentId(date), date, expenseId: x.expenseId, payee: (x.payee || '').slice(0, 80), amount: r2(amount),
          paymentMethod: $('#exl-p-method').value, receiptRef: $('#exl-p-ref').value.trim().toUpperCase().slice(0, 300), notes: $('#exl-p-notes').value.trim().slice(0, 300) };
        await db[PAY_STORE].add(rec);
        toast(`Payment of ${money(rec.amount)} saved${bal - amount > 0.005 ? ` · ${money(r2(bal - amount))} still owed` : ' · bill cleared'}`);
        requestSync('new-record', saveDebounceMs);
      });
    }

    /* ================= edit / void ================= */

    function openEdit(id) {
      const x = lineOf(id);
      if (!x) return;
      const units = deps.UNITS;
      openSheet(`Correct ${x.expenseId}`, `
        <div class="grid grid-cols-2 gap-3">
          <div><label class="hf-label" for="exl-e-date">Date</label><input id="exl-e-date" type="date" class="hf-input" value="${esc(x.date)}" max="${todayLocal()}" /></div>
          <div><label class="hf-label" for="exl-e-amount">Amount (KES)</label><input id="exl-e-amount" type="number" min="1" step="0.01" class="hf-input" value="${x.amount}" /></div>
        </div>
        <div><label class="hf-label" for="exl-e-category">Category</label><select id="exl-e-category" class="hf-input">${CATEGORIES.map((g) => `<optgroup label="${esc(g.group)}">${g.items.map((c) => `<option${c === x.category ? ' selected' : ''}>${esc(c)}</option>`).join('')}</optgroup>`).join('')}</select></div>
        <div><label class="hf-label" for="exl-e-item">What was bought</label><input id="exl-e-item" type="text" maxlength="80" class="hf-input" value="${esc(x.item)}" /></div>
        <div class="grid grid-cols-2 gap-3">
          <div><label class="hf-label" for="exl-e-qty">Quantity</label><input id="exl-e-qty" type="number" min="0" step="0.01" class="hf-input" value="${x.quantity}" /></div>
          <div><label class="hf-label" for="exl-e-unit">Unit</label><select id="exl-e-unit" class="hf-input"><option value="">—</option>${units.concat(units.includes(x.unit) || !x.unit ? [] : [x.unit]).map((u) => `<option${u === x.unit ? ' selected' : ''}>${esc(u)}</option>`).join('')}</select></div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div><label class="hf-label" for="exl-e-status">At purchase</label><select id="exl-e-status" class="hf-input">
            ${[['Paid', 'Paid in full'], ['Part paid', 'Part paid'], ['Unpaid', 'Not paid (credit)']].map(([v, l]) => `<option value="${v}"${v === x.paymentStatus ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
          <div id="exl-e-paid-wrap"><label class="hf-label" for="exl-e-paid">Paid then (KES)</label><input id="exl-e-paid" type="number" min="0" step="0.01" class="hf-input" value="${x.amountPaid}" /></div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div id="exl-e-method-wrap"><label class="hf-label" for="exl-e-method">Paid by</label><select id="exl-e-method" class="hf-input">${METHODS.filter((m) => m !== 'Credit').map((m) => `<option${m === x.paymentMethod ? ' selected' : ''}>${m}</option>`).join('')}</select></div>
          <div><label class="hf-label" for="exl-e-ref">Code / receipt no.</label><input id="exl-e-ref" type="text" maxlength="300" class="hf-input uppercase" value="${esc(x.receiptRef)}" /></div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div><label class="hf-label" for="exl-e-payee">Paid to</label><input id="exl-e-payee" type="text" maxlength="80" class="hf-input" value="${esc(x.payee)}" /></div>
          <div><label class="hf-label" for="exl-e-due">Due date</label><input id="exl-e-due" type="date" class="hf-input" value="${esc(x.dueDate || '')}" /></div>
        </div>
        <div><label class="hf-label" for="exl-e-animal">Animal</label><select id="exl-e-animal" class="hf-input"><option value="">—</option>${animals.filter((a) => a.herd !== 'external').map((a) => `<option value="${esc(a.animalId)}"${a.animalId === x.animalId ? ' selected' : ''}>${esc(a.name)} (${esc(a.animalId)})</option>`).join('')}</select></div>
        <input id="exl-e-notes" type="text" maxlength="300" class="hf-input" placeholder="Notes" value="${esc(x.notes)}" aria-label="Notes" />
        <div><label class="hf-label" for="exl-e-reason">Reason for the correction</label><input id="exl-e-reason" type="text" maxlength="300" class="hf-input" placeholder="e.g. typed 1,200 instead of 1,500" /></div>
        <p class="text-xs text-slate-500">The old values are kept in the sheet's Expense_Changes tab.</p>`, async () => {
        const v = (s) => $(s).value.trim();
        const status = v('#exl-e-status');
        const amount = num(v('#exl-e-amount'));
        const qty = v('#exl-e-qty') === '' ? '' : num(v('#exl-e-qty'));
        if (!(amount > 0)) throw new Error('Enter the amount.');
        if (qty !== '' && !(qty > 0)) throw new Error('Quantity must be above 0, or blank.');
        if (qty !== '' && !v('#exl-e-unit')) throw new Error('Choose the unit.');
        if (qty === '' && v('#exl-e-unit')) throw new Error('A unit needs a quantity.');
        const paidThen = status === 'Paid' ? amount : status === 'Unpaid' ? 0 : num(v('#exl-e-paid'));
        if (status === 'Part paid' && !(paidThen > 0 && paidThen < amount)) throw new Error('Part paid: enter what was paid then (above 0, below the amount).');
        const later = (x.payments || []).reduce((t, p) => t + p.amount, 0) + localPaid(x.expenseId);
        if (amount < paidThen + later - 0.005) throw new Error(`The amount cannot be less than what has been paid (${money(paidThen + later)}).`);
        if (['Dairy meal raw materials', 'Other'].includes(v('#exl-e-category')) && !v('#exl-e-item')) throw new Error('Say what was bought.');
        if (!v('#exl-e-reason')) throw new Error('Give a short reason for the correction.');
        const next = { date: v('#exl-e-date'), category: v('#exl-e-category'), item: v('#exl-e-item'), quantity: qty === '' ? '' : r2(qty), unit: qty === '' ? '' : v('#exl-e-unit'),
          unitPrice: qty ? r2(amount / qty) : '', amount: r2(amount), paymentStatus: status, amountPaid: r2(paidThen),
          paymentMethod: status === 'Unpaid' ? 'Credit' : v('#exl-e-method'), receiptRef: v('#exl-e-ref').toUpperCase(), payee: v('#exl-e-payee'),
          dueDate: v('#exl-e-due'), animalId: v('#exl-e-animal'), notes: v('#exl-e-notes') };
        if (next.date > todayLocal()) throw new Error('Date cannot be in the future.');
        const changes = {};
        Object.keys(next).forEach((k) => { if (String(next[k] ?? '') !== String(x[k] ?? '')) changes[k] = next[k]; });
        if (!Object.keys(changes).length) throw new Error('Nothing was changed.');
        await db[EDIT_STORE].add({ ...baseRecord(), expenseId: x.expenseId, changes, void: false, reason: v('#exl-e-reason').slice(0, 300), updatedBy: getSession() ? getSession().email : '' });
        Object.assign(x, next, { group: groupOf(next.category) });
        render();
        toast('Correction saved: uploads with the next sync');
        requestSync('new-record', saveDebounceMs);
      });
      const sync = () => {
        const st = $('#exl-e-status').value;
        show($('#exl-e-paid-wrap'), st === 'Part paid');
        show($('#exl-e-method-wrap'), st !== 'Unpaid');
      };
      $('#exl-e-status').addEventListener('change', sync);
      sync();
    }

    function openVoid(id) {
      const x = lineOf(id);
      if (!x) return;
      if ((x.payments || []).length || localPaid(id) > 0) { toast('Payments were made against this expense: it cannot be cancelled.', 'error'); return; }
      openSheet(`Cancel ${x.expenseId}?`, `
        <p class="text-sm text-slate-600">${esc(x.item || x.category)} · ${money(x.amount)} · ${esc(fmtDate(x.date))}</p>
        <p class="text-sm">It stays in the sheet marked <b>Void</b> and is left out of every report.</p>
        <div><label class="hf-label" for="exl-v-reason">Reason</label><input id="exl-v-reason" type="text" maxlength="300" class="hf-input" placeholder="e.g. entered twice" /></div>`, async () => {
        const reason = $('#exl-v-reason').value.trim();
        if (!reason) throw new Error('Give a reason.');
        await db[EDIT_STORE].add({ ...baseRecord(), expenseId: x.expenseId, changes: {}, void: true, reason: reason.slice(0, 300), updatedBy: getSession() ? getSession().email : '' });
        data.lines = data.lines.filter((l) => l.expenseId !== x.expenseId);
        data.totals.count -= 1; data.totals.amount = r2(data.totals.amount - x.amount); data.totals.paid = r2(data.totals.paid - x.paid); data.totals.owing = r2(data.totals.owing - x.balance);
        render();
        toast('Expense cancelled: uploads with the next sync', 'info');
        requestSync('new-record', saveDebounceMs);
      });
    }

    /* ================= receipts ================= */

    /** Keep a receipt on the phone until it is uploaded. Called by the expense form too. */
    async function queueReceipt(expenseId, picked) {
      if (!picked) return;
      await db[RECEIPT_STORE].add({ ...baseRecord(), expenseId, mimeType: picked.mimeType, data: picked.data, fileName: picked.fileName });
      requestSync('new-record', saveDebounceMs);
    }

    async function onReceiptPicked(input) {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        const picked = await readReceipt(file);
        await queueReceipt(input.dataset.id, picked);
        toast('Receipt saved: uploads with the next sync');
        render();
      } catch (err) {
        toast(err.message || String(err), 'error');
      } finally {
        input.value = '';
      }
    }

    /* ================= export ================= */

    function exportRows() {
      return data.lines.map((x) => ({
        Date: x.date, 'Expense ID': x.expenseId, Group: x.group, Category: x.category, Item: x.item, Quantity: x.quantity, Unit: x.unit,
        'Unit price (KES)': x.unitPrice, 'Amount (KES)': x.amount, 'Paid (KES)': x.paid, 'Balance (KES)': x.balance, 'Payment status': x.payStatus,
        'Paid by': x.paymentMethod, Reference: x.receiptRef, 'Paid to': x.payee, 'Due date': x.dueDate || '', Animal: x.animalId, Notes: x.notes, Receipt: x.receiptFile,
      }));
    }
    const fileStem = () => `Expenses_list_${data.from}_to_${data.to}`;
    function download(name, blob) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }
    function exportCsv() {
      if (!data || !data.lines.length) { toast('Nothing to export', 'error'); return; }
      const rows = exportRows();
      const head = Object.keys(rows[0]);
      const cell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? '"' + (/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""') + '"' : s; };
      const csv = '﻿' + [head.join(',')].concat(rows.map((r) => head.map((h) => cell(r[h])).join(','))).join('\r\n');
      download(fileStem() + '.csv', new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    }
    async function exportXlsx() {
      if (!data || !data.lines.length) { toast('Nothing to export', 'error'); return; }
      try {
        if (!window.XLSX) {
          xlsxPromise = xlsxPromise || new Promise((res, rej) => { const s = document.createElement('script'); s.src = XLSX_URL; s.onload = res; s.onerror = () => { xlsxPromise = null; rej(new Error('Could not download the Excel maker: check the internet.')); }; document.head.appendChild(s); });
          await xlsxPromise;
        }
        const X = window.XLSX;
        const rows = exportRows().map((r) => ({ ...r, Date: (() => { const [y, m, d] = r.Date.split('-').map(Number); return new Date(y, m - 1, d); })() }));
        const ws = X.utils.json_to_sheet(rows, { cellDates: true });
        ws['!cols'] = Object.keys(rows[0]).map((k) => ({ wch: Math.min(40, Math.max(10, k.length + 2)) }));
        const wb = X.utils.book_new();
        X.utils.book_append_sheet(wb, ws, 'Expenses');
        const t = data.totals;
        X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([['Mawe Tatu Dairy - expense list'], [`${data.from} to ${data.to}`], [],
          ['Expenses', t.count], ['Amount (KES)', t.amount], ['Paid (KES)', t.paid], ['Still owed (KES)', t.owing], [], ['Owed to suppliers (all dates)', 'KES'],
          ...(data.suppliers || []).map((s) => [s.payee, s.owing])]), 'Totals');
        X.writeFile(wb, fileStem() + '.xlsx');
      } catch (err) { toast(err.message || String(err), 'error'); }
    }

    /* ================= sync (called by app.js) ================= */

    /** Number of edits and receipts still to upload (for the pending badge). */
    async function countPending() {
      const st = [SYNC_STATUS.PENDING, SYNC_STATUS.FAILED];
      const [e, r] = await Promise.all([db[EDIT_STORE].where('syncStatus').anyOf(st).count(), db[RECEIPT_STORE].where('syncStatus').anyOf(st).count()]);
      return e + r;
    }

    /**
     * Upload corrections, then receipts. Receipts for an expense not in the
     * sheet yet wait for a later run. Throws SyncError on network/auth.
     */
    async function syncExtras() {
      const totals = { uploaded: 0, rejected: 0 };
      const st = [SYNC_STATUS.PENDING, SYNC_STATUS.FAILED];
      const edits = await db[EDIT_STORE].where('syncStatus').anyOf(st).sortBy('createdAt');
      if (edits.length) {
        const reply = await callServer({ action: 'updateExpenses', records: edits.map((e) => ({ clientId: e.clientId, expenseId: e.expenseId, changes: e.changes,
          void: !!e.void, reason: e.reason, updatedBy: e.updatedBy, deviceId: e.deviceId, updatedAt: e.createdAt })) });
        if (!Array.isArray(reply.results)) throw new SyncError('Apps Script reply is missing the results list', 'server');
        const now = new Date().toISOString();
        for (const e of edits) {
          const res = reply.results.find((x) => x.clientId === e.clientId);
          if (!res) continue;
          if (res.status === 'saved' || res.status === 'duplicate') { await db[EDIT_STORE].update(e.id, { syncStatus: SYNC_STATUS.SYNCED, syncedAt: now, lastError: null }); totals.uploaded++; }
          else { await db[EDIT_STORE].update(e.id, { syncStatus: SYNC_STATUS.FAILED, lastError: res.error || 'rejected', syncAttempts: (e.syncAttempts || 0) + 1 }); totals.rejected++; toast(`Correction to ${e.expenseId} refused: ${res.error}`, 'error'); }
        }
      }
      const receipts = await db[RECEIPT_STORE].where('syncStatus').anyOf(st).sortBy('createdAt');
      for (const r of receipts) {
        const exp = await db.expenses.where('expenseId').equals(r.expenseId).first();
        if (exp && exp.syncStatus !== SYNC_STATUS.SYNCED) continue; // its expense uploads first
        let reply;
        try {
          reply = await callServer({ action: 'uploadReceipt', clientId: r.clientId, expenseId: r.expenseId, mimeType: r.mimeType, data: r.data, fileName: r.fileName });
        } catch (err) {
          if (err instanceof SyncError && err.kind === 'server') {
            await db[RECEIPT_STORE].update(r.id, { syncStatus: SYNC_STATUS.FAILED, lastError: err.message, syncAttempts: (r.syncAttempts || 0) + 1 });
            totals.rejected++;
            continue;
          }
          throw err;
        }
        if (!reply.attached && (r.syncAttempts || 0) < 5) {
          await db[RECEIPT_STORE].update(r.id, { syncStatus: SYNC_STATUS.FAILED, lastError: 'expense not in the sheet yet', syncAttempts: (r.syncAttempts || 0) + 1 });
          continue;
        }
        await db[RECEIPT_STORE].delete(r.id); // the photo is in Drive now; free the phone's space
        totals.uploaded++;
      }
      return totals;
    }

    /* ================= init ================= */

    function show_() { if (!data || data.cachedAt < new Date(Date.now() - 60000).toISOString()) load(); else render(); }

    function init() {
      fillFilters();
      setRange('this');
      $('#exl-group').addEventListener('change', fillCategories);
      $('#exl-filters').addEventListener('submit', (e) => { e.preventDefault(); load(); });
      document.querySelectorAll('.exl-quick').forEach((b) => b.addEventListener('click', () => { setRange(b.dataset.range); load(); }));
      $('#exl-csv').addEventListener('click', exportCsv);
      $('#exl-xlsx').addEventListener('click', exportXlsx);
      $('#exl-sheet-close').addEventListener('click', closeSheet);
      $('#exl-sheet').addEventListener('click', (e) => { if (e.target.id === 'exl-sheet') closeSheet(); });
      $('#exl-suppliers').addEventListener('click', (e) => {
        const b = e.target.closest('.exl-sup');
        if (!b) return;
        $('#exl-payee').value = b.dataset.payee === '(no name)' ? '' : b.dataset.payee;
        $('#exl-status').value = 'Owing';
        setRange('all');
        load();
      });
      $('#exl-list').addEventListener('click', (e) => {
        const act = e.target.closest('.exl-pay, .exl-edit, .exl-void');
        if (act) {
          if (act.classList.contains('exl-pay')) openPay(act.dataset.id);
          else if (act.classList.contains('exl-edit')) openEdit(act.dataset.id);
          else openVoid(act.dataset.id);
          return;
        }
        const row = e.target.closest('.exl-row');
        if (!row) return;
        const li = row.closest('li');
        const d = li.querySelector('.exl-detail');
        const open = d.classList.contains('hidden');
        if (open) d.innerHTML = detailHtml(lineOf(li.dataset.id));
        show(d, open);
      });
      $('#exl-list').addEventListener('change', (e) => { if (e.target.classList.contains('exl-rcpt')) onReceiptPicked(e.target); });
      Dexie.liveQuery(() => db[PAY_STORE].toArray()).subscribe({ next: (r) => { payRows = r; render(); } });
      Dexie.liveQuery(() => db[EDIT_STORE].toArray()).subscribe({ next: (r) => { editRows = r; render(); } });
      Dexie.liveQuery(() => db[RECEIPT_STORE].toArray()).subscribe({ next: (r) => { receiptRows = r; } });
      Dexie.liveQuery(() => db.animals.toArray()).subscribe({ next: (a) => { animals = a; fillAnimals(); } });
    }

    return Object.freeze({ init, show: show_, load, syncExtras, countPending, queueReceipt });
  }

  window.MaweExpenseList = Object.freeze({ create, readReceipt, PAY_STORE, EDIT_STORE, RECEIPT_STORE, PAYLOAD });
})();
