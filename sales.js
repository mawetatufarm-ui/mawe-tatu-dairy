/* =====================================================================
 * Mawe Tatu Dairy — sales.js (milk sales module)
 * ---------------------------------------------------------------------
 * The Sales tab: record a Sale, a Payment or a Return at the gate, offline,
 * and keep the Customers list and prices. Loaded by index.html BEFORE
 * app.js (both `defer`); defines window.MaweSales. app.js owns the
 * database, sign-in and sync engine, and calls MaweSales.create(deps).
 * Pre-cached by sw.js (keep the file name identical).
 *
 * Rules (agreed with the farm owner)
 *   • A sale keeps the price that applied on its date. Price changes are
 *     saved with an "effective from" date and never alter older sales.
 *   • A Cash sale also creates a Payment row automatically (linked to the
 *     sale), as the farm has always done. Cash/Credit never changes the
 *     balance by itself.
 *   • Owed = sales + balance B/F − returns − payments that are Verified or
 *     Pending. Disputed payments are not deducted.
 *   • Sale / Payment / Return IDs: S|P|R + YYMMDD + "-" + 001, numbered on
 *     this phone. If the sheet already has that ID, the server adds a letter
 *     (S261030-001B) and the phone takes the new ID.
 *
 * Stores (IndexedDB, schema v3 in app.js)
 *   customers  key customerId (C-001 …)     pushed with upsertCustomers, pulled with listCustomers
 *   prices     ++id, &clientId              append-only; pulled list replaces synced ones
 *   sales, payments, returns  ++id, &clientId   append-only, like milk_logs
 *   kv         key 'salesSnapshot'          balances + recent sales from the server
 *
 * Sections
 *   1. Constants
 *   2. Helpers (money, prices, balances, IDs)
 *   3. Saving and deleting
 *   4. Sync helpers (called by app.js)
 *   5. Rendering: selects, info lines, recent lists, customer list
 *   6. Forms: Sale, Payment, Return, Customer, Default price
 *   7. init + public API
 * ===================================================================== * v5.10 (28 Nov 2026): EDIT / CANCEL SALES. Each sale in the recent list has
 * Edit (#se-sheet): customer, date, litres, price (amount = litres × price),
 * Cash/Credit, notes. Not uploaded → the phone's sale (and its unsent cash
 * payment) are changed; Delete removes it. Uploaded → a reason is required and
 * a correction is queued for the sheet (Corrections.gs: the sale row is
 * changed in place, the linked cash payment follows, Record_Changes logs it);
 * Cancel this sale = Status Void (kept, but out of balances and reports).
 * A sale with returns cannot be cancelled, moved to another customer or cut
 * below the litres returned. "Show more" lists up to 40 sales on this phone.
 */

(() => {
  'use strict';

  /* ------------------------------------------------------------------
   * 1. CONSTANTS — Sales.gs SALES_OPTIONS uses the same values
   * ------------------------------------------------------------------ */

  const OPTIONS = Object.freeze({
    customerType: ['Dairy Cooperative', 'Milk Vendor', 'Hotel/Restaurant', 'Household', 'School/Institution', 'Other'],
    customerStatus: ['Active', 'Inactive'],
    saleType: ['Credit', 'Cash'],
    paymentStatus: ['Verified', 'Pending', 'Disputed'],
  });

  const STORES = Object.freeze({
    CUSTOMERS: 'customers', PRICES: 'prices', SALES: 'sales', PAYMENTS: 'payments', RETURNS: 'returns', KV: 'kv',
  });

  /** Fields sent to the sheet for each append-only store (Sales.gs column lists). */
  const PAYLOAD = Object.freeze({
    [STORES.PRICES]: ['clientId', 'deviceId', 'date', 'customerId', 'pricePerLitre', 'notes', 'recordedBy', 'createdAt'],
    [STORES.SALES]: ['clientId', 'deviceId', 'saleId', 'date', 'customerId', 'customerName', 'customerType', 'transactionType',
      'litres', 'pricePerLitre', 'amount', 'saleType', 'invoiceRef', 'notes', 'recordedBy', 'createdAt'],
    [STORES.PAYMENTS]: ['clientId', 'deviceId', 'paymentId', 'date', 'customerId', 'customerName', 'cashPaid', 'mpesaPaid',
      'otherPaid', 'totalPaid', 'receiptRef', 'note', 'status', 'linkedSaleId', 'recordedBy', 'createdAt'],
    [STORES.RETURNS]: ['clientId', 'deviceId', 'returnId', 'date', 'saleId', 'customerId', 'customerName', 'originalLitres',
      'unitPrice', 'litresReturned', 'litresSoldThrough', 'totalLitres', 'amount', 'note', 'recordedBy', 'createdAt'],
  });
  const SHEETS = Object.freeze({ [STORES.PRICES]: 'Prices', [STORES.SALES]: 'Sales', [STORES.PAYMENTS]: 'Payments', [STORES.RETURNS]: 'Returns' });
  const ID_FIELD = Object.freeze({ [STORES.SALES]: 'saleId', [STORES.PAYMENTS]: 'paymentId', [STORES.RETURNS]: 'returnId' });
  const CUSTOMER_FIELDS = ['customerId', 'name', 'customerType', 'phone', 'location', 'status', 'notes',
    'clientId', 'updatedBy', 'deviceId', 'createdAt', 'updatedAt'];
  const CUSTOMER_ID = /^C-\d{3,4}$/;
  const SNAPSHOT_KEY = 'salesSnapshot';
  const RECENT = 5;

  function create(deps) {
    const {
      db, SYNC_STATUS, getSession, getDeviceId, makeUUID, todayLocal, esc, toast, requestSync,
      saveDebounceMs, isInFlight, queueCorrection,
    } = deps;
    const $ = (sel) => document.querySelector(sel);
    const show = (el, visible) => el && el.classList.toggle('hidden', !visible);

    /* ----------------------------------------------------------------
     * 2. HELPERS
     * ---------------------------------------------------------------- */

    let customers = [];
    const byId = new Map();
    let prices = [];
    let snapshot = { balances: {}, recentSales: [], usedIds: [], serverTime: '' };
    const local = { sales: [], payments: [], returns: [] };
    const inFlightCustomers = new Set();
    let view = 'sale';
    let customerFilter = 'Active';
    let editingCustomer = null;      // { originalId, isNew }
    let saleTouchedPayment = false;  // user typed in the cash-sale payment boxes
    let editingSale = null;          // v5.10: the sale open in #se-sheet
    let salesShowAll = false;        // v5.10: "Show more" in the sales list

    const r2 = (x) => Math.round(x * 100) / 100;
    const r1 = (x) => Math.round(x * 10) / 10;
    const num = (v) => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
    const money = (x) => 'KES ' + Number(x || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const fmtDate = (k) => {
      if (!k) return '';
      const [y, m, d] = k.split('-').map(Number);
      return new Date(y, m - 1, d).toLocaleDateString([], { day: 'numeric', month: 'short' });
    };
    const custName = (id) => (byId.get(id) ? byId.get(id).name : id);
    const isSynced = (r) => r.syncStatus === SYNC_STATUS.SYNCED;
    const activeCustomers = () => customers.filter((c) => c.status !== 'Inactive')
      .sort((a, b) => a.name.localeCompare(b.name));

    /** Price per litre for a customer on a date (special price first, then the default). */
    function priceFor(customerId, date) {
      let special;
      let dflt = null;
      prices.filter((p) => p.date && p.date <= date)
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.createdAt).localeCompare(String(b.createdAt))))
        .forEach((p) => {
          const v = p.pricePerLitre === '' || p.pricePerLitre === null || p.pricePerLitre === undefined ? null : Number(p.pricePerLitre);
          if (!p.customerId) dflt = v;
          else if (p.customerId === customerId) special = v;
        });
      return special !== undefined && special !== null ? special : dflt;
    }

    /** { price, since } for the default price on a date. */
    function defaultPriceInfo(date) {
      const list = prices.filter((p) => !p.customerId && p.date && p.date <= date)
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.createdAt).localeCompare(String(b.createdAt))));
      const last = list[list.length - 1];
      return last ? { price: Number(last.pricePerLitre), since: last.date } : null;
    }

    function specialPriceInfo(customerId, date) {
      const list = prices.filter((p) => p.customerId === customerId && p.date && p.date <= date)
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.createdAt).localeCompare(String(b.createdAt))));
      const last = list[list.length - 1];
      if (!last || last.pricePerLitre === '' || last.pricePerLitre === null) return null;
      return { price: Number(last.pricePerLitre), since: last.date };
    }

    /** A local row the server snapshot does not include yet. */
    function notInSnapshot(r) {
      if (!isSynced(r) || !snapshot.serverTime) return true;
      return !!r.syncedAt && r.syncedAt > snapshot.serverTime;
    }

    /** What a customer owes now: last server figure + this phone's newer entries. */
    function balanceOf(id) {
      let b = snapshot.balances[id] ? Number(snapshot.balances[id].balance) || 0 : 0;
      local.sales.forEach((s) => { if (s.customerId === id && !s.voided && notInSnapshot(s)) b += Number(s.amount) || 0; });
      local.returns.forEach((r) => { if (r.customerId === id && notInSnapshot(r)) b -= Number(r.amount) || 0; });
      local.payments.forEach((p) => {
        if (p.customerId === id && p.status !== 'Disputed' && !p.voided && notInSnapshot(p)) b -= Number(p.totalPaid) || 0;
      });
      return r2(b);
    }

    function owesText(id) {
      const b = balanceOf(id);
      if (Math.abs(b) < 0.005) return 'Nothing owed';
      return b > 0 ? `Owes ${money(b)}` : `In credit ${money(-b)}`;
    }

    /** Next free S/P/R + YYMMDD + -NNN for a date. */
    function nextDocId(prefix, date) {
      const stem = prefix + date.slice(2, 4) + date.slice(5, 7) + date.slice(8, 10) + '-';
      const used = new Set(snapshot.usedIds || []);
      local.sales.forEach((s) => used.add(s.saleId));
      local.payments.forEach((p) => used.add(p.paymentId));
      local.returns.forEach((r) => used.add(r.returnId));
      let max = 0;
      used.forEach((id) => {
        if (id && id.startsWith(stem)) { const n = parseInt(id.slice(stem.length), 10); if (n > max) max = n; }
      });
      return stem + String(max + 1).padStart(3, '0');
    }

    function nextCustomerId() {
      const max = customers.reduce((m, c) => { const x = /^C-(\d+)$/.exec(c.customerId); return x ? Math.max(m, +x[1]) : m; }, 0);
      return 'C-' + String(max + 1).padStart(3, '0');
    }

    /** A customer's recent sales that can still take a return, newest first. */
    function returnableSales(customerId) {
      const map = new Map();
      const voided = new Set(local.sales.filter((s) => s.voided).map((s) => s.saleId));
      (snapshot.recentSales || []).forEach((s) => { if (s.customerId === customerId && !voided.has(s.saleId)) map.set(s.saleId, { ...s, fromServer: true }); });
      local.sales.forEach((s) => {
        if (s.customerId !== customerId || s.transactionType !== 'Sale' || !(s.litres > 0) || s.voided) return;
        const prev = map.get(s.saleId);
        map.set(s.saleId, { saleId: s.saleId, date: s.date, customerId: s.customerId, litres: s.litres,
          pricePerLitre: s.pricePerLitre, returnedLitres: prev ? prev.returnedLitres : 0 });
      });
      // Returns made on this phone that the snapshot does not count yet.
      local.returns.forEach((r) => {
        const s = map.get(r.saleId);
        if (s && (notInSnapshot(r) || !s.fromServer)) s.returnedLitres = r1((s.returnedLitres || 0) + (Number(r.totalLitres) || 0));
      });
      return [...map.values()]
        .map((s) => ({ ...s, remaining: r1(s.litres - (s.returnedLitres || 0)) }))
        .filter((s) => s.remaining > 0)
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (a.saleId < b.saleId ? 1 : -1)));
    }

    function baseMeta() {
      const now = new Date().toISOString();
      const session = getSession();
      return {
        clientId: makeUUID(), deviceId: getDeviceId(), recordedBy: session ? session.email : '',
        createdAt: now, updatedAt: now, syncStatus: SYNC_STATUS.PENDING, syncAttempts: 0, lastError: null, syncedAt: null,
      };
    }

    /* ----------------------------------------------------------------
     * 3. SAVING AND DELETING
     * ---------------------------------------------------------------- */

    /** Save a sale; for a cash sale also the payment received with it. */
    async function saveSale(sale, payment) {
      return db.transaction('rw', db[STORES.SALES], db[STORES.PAYMENTS], async () => {
        const s = { ...baseMeta(), ...sale };
        s.id = await db[STORES.SALES].add(s);
        let p = null;
        if (payment) {
          p = { ...baseMeta(), ...payment, linkedSaleId: s.saleId };
          p.id = await db[STORES.PAYMENTS].add(p);
        }
        return { sale: s, payment: p };
      });
    }

    async function savePayment(payment) {
      const p = { ...baseMeta(), ...payment };
      p.id = await db[STORES.PAYMENTS].add(p);
      return p;
    }

    async function saveReturn(ret) {
      const r = { ...baseMeta(), ...ret };
      r.id = await db[STORES.RETURNS].add(r);
      return r;
    }

    async function savePrice(customerId, pricePerLitre, date, notes) {
      const p = { ...baseMeta(), customerId: customerId || '', pricePerLitre: pricePerLitre === null ? '' : pricePerLitre, date, notes: notes || '' };
      p.id = await db[STORES.PRICES].add(p);
      return p;
    }

    async function saveCustomer(data, { originalId, isNew }) {
      const session = getSession();
      const now = new Date().toISOString();
      return db.transaction('rw', db[STORES.CUSTOMERS], async () => {
        const existing = originalId ? await db[STORES.CUSTOMERS].get(originalId) : null;
        if (isNew && await db[STORES.CUSTOMERS].get(data.customerId)) throw new Error(`${data.customerId} is already used on this phone.`);
        let updatedAt = now;
        if (existing && existing.updatedAt && updatedAt <= existing.updatedAt) updatedAt = new Date(Date.parse(existing.updatedAt) + 1).toISOString();
        const rec = {
          ...(existing || {}), ...data,
          clientId: existing ? existing.clientId : makeUUID(),
          createdAt: existing ? existing.createdAt : now,
          updatedAt, updatedBy: session ? session.email : '', deviceId: getDeviceId(),
          syncStatus: SYNC_STATUS.PENDING, syncAttempts: 0, lastError: null,
          syncedAt: existing ? (existing.syncedAt || null) : null,
        };
        await db[STORES.CUSTOMERS].put(rec);
        return rec;
      });
    }

    /** Delete an entry that has not been uploaded (a sale takes its unsent linked payment with it). */
    async function deleteEntry(store, id) {
      if (isInFlight(store, id)) throw new Error('This entry is uploading right now. Try again in a moment.');
      const rec = await db[store].get(id);
      if (!rec) return false;
      if (isSynced(rec)) throw new Error('Already in Google Sheets: correct it there.');
      if (store === STORES.SALES) {
        const linked = await db[STORES.PAYMENTS].filter((p) => p.linkedSaleId === rec.saleId && !isSynced(p)).toArray();
        const rets = await db[STORES.RETURNS].filter((r) => r.saleId === rec.saleId && !isSynced(r)).count();
        if (rets) throw new Error('A return on this phone refers to this sale: delete the return first.');
        await db.transaction('rw', db[STORES.SALES], db[STORES.PAYMENTS], async () => {
          await db[STORES.SALES].delete(id);
          for (const p of linked) await db[STORES.PAYMENTS].delete(p.id);
        });
        return true;
      }
      await db[store].delete(id);
      return true;
    }

    /* ----------------------------------------------------------------
     * 4. SYNC HELPERS (called by app.js)
     * ---------------------------------------------------------------- */

    async function getPendingCustomers() {
      const rows = await db[STORES.CUSTOMERS].where('syncStatus').anyOf(SYNC_STATUS.PENDING, SYNC_STATUS.FAILED).toArray();
      return rows.sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
    }

    function customerPayload(c) {
      const out = {};
      CUSTOMER_FIELDS.forEach((f) => { out[f] = c[f] ?? ''; });
      return out;
    }

    /** Results of upsertCustomers. Returns { uploaded, rejected, stale }. */
    async function applyCustomerResults(sent, results) {
      const map = new Map((results || []).filter((r) => r && r.customerId).map((r) => [r.customerId, r]));
      const now = new Date().toISOString();
      const t = { uploaded: 0, rejected: 0, stale: 0 };
      await db.transaction('rw', db[STORES.CUSTOMERS], async () => {
        for (const rec of sent) {
          const cur = await db[STORES.CUSTOMERS].get(rec.customerId);
          if (!cur) continue;
          const res = map.get(rec.customerId);
          if (res && ['saved', 'duplicate', 'stale'].includes(res.status)) {
            if (res.status === 'stale') t.stale += 1; else t.uploaded += 1;
            if (cur.updatedAt === rec.updatedAt) {
              await db[STORES.CUSTOMERS].update(rec.customerId, { syncStatus: SYNC_STATUS.SYNCED, syncedAt: now, lastError: null, syncAttempts: 0 });
            }
          } else {
            t.rejected += 1;
            await db[STORES.CUSTOMERS].update(rec.customerId, {
              syncStatus: SYNC_STATUS.FAILED, syncAttempts: (cur.syncAttempts || 0) + 1,
              lastError: String(res ? (res.error || 'Rejected by server') : 'Server did not confirm this customer').slice(0, 200),
            });
          }
        }
      });
      return t;
    }

    /** Merge the server snapshot (listCustomers): customers, prices, balances, recent sales. */
    async function mergeSnapshot(data) {
      const now = new Date().toISOString();
      await db.transaction('rw', db[STORES.CUSTOMERS], db[STORES.PRICES], db[STORES.KV], async () => {
        // Customers: like the herd — synced ones follow the sheet, unsent edits are kept.
        const serverIds = new Set();
        for (const c of data.customers || []) {
          if (!c || !CUSTOMER_ID.test(c.customerId)) continue;
          serverIds.add(c.customerId);
          const cur = await db[STORES.CUSTOMERS].get(c.customerId);
          if (cur && !isSynced(cur)) continue;
          const clean = {};
          CUSTOMER_FIELDS.forEach((f) => { clean[f] = c[f] ?? ''; });
          await db[STORES.CUSTOMERS].put({ ...clean, syncStatus: SYNC_STATUS.SYNCED, syncedAt: now, syncAttempts: 0, lastError: null });
        }
        const synced = await db[STORES.CUSTOMERS].where('syncStatus').equals(SYNC_STATUS.SYNCED).toArray();
        for (const c of synced) if (!serverIds.has(c.customerId)) await db[STORES.CUSTOMERS].delete(c.customerId);

        // Prices: replace every synced price with the sheet's list; keep unsent ones.
        await db[STORES.PRICES].where('syncStatus').equals(SYNC_STATUS.SYNCED).delete();
        const pendingIds = new Set((await db[STORES.PRICES].toArray()).map((p) => p.clientId));
        const rows = (data.prices || []).filter((p) => p && p.date && !pendingIds.has(p.clientId)).map((p) => ({
          clientId: p.clientId, date: p.date, customerId: p.customerId || '', pricePerLitre: p.pricePerLitre === '' ? '' : Number(p.pricePerLitre),
          notes: p.notes || '', createdAt: p.createdAt || '', syncStatus: SYNC_STATUS.SYNCED, syncedAt: now,
        }));
        if (rows.length) await db[STORES.PRICES].bulkPut(rows);

        await db[STORES.KV].put({
          key: SNAPSHOT_KEY, balances: data.balances || {}, recentSales: data.recentSales || [],
          usedIds: data.usedIds || [], serverTime: data.serverTime || now,
        });
      });
      return { customers: (data.customers || []).length };
    }

    /**
     * The server gave a different ID (it was taken). Update the record and,
     * for a sale, the unsent payment and returns that point to it.
     */
    async function applyRename(store, rec, renamed) {
      if (!renamed || !renamed.value || !ID_FIELD[store]) return;
      const field = ID_FIELD[store];
      const oldId = rec[field];
      await db[store].update(rec.id, { [field]: renamed.value });
      rec[field] = renamed.value;
      if (store === STORES.SALES && oldId) {
        await db[STORES.PAYMENTS].filter((p) => p.linkedSaleId === oldId && !isSynced(p)).modify({ linkedSaleId: renamed.value });
        await db[STORES.RETURNS].filter((r) => r.saleId === oldId && !isSynced(r)).modify({ saleId: renamed.value });
      }
      toast(`${oldId} was already used: saved as ${renamed.value}`, 'info');
    }

    /* ----------------------------------------------------------------
     * 5. RENDERING
     * ---------------------------------------------------------------- */

    const ADD_VALUE = '__add__';
    const NEW_CUSTOMER_OPTION = `<option value="${ADD_VALUE}">➕ New customer…</option>`;

    function fillCustomerSelect(sel) {
      if (!sel) return;
      const keep = sel.value;
      const list = activeCustomers();
      sel.innerHTML = (list.length ? '<option value="">Choose a customer…</option>' : '<option value="">No customers yet: add one</option>') +
        list.map((c) => `<option value="${esc(c.customerId)}">${esc(c.name)}</option>`).join('') + NEW_CUSTOMER_OPTION;
      if (keep && byId.has(keep)) sel.value = keep;
    }

    function renderSelects() {
      ['#sale-customer', '#pay-customer', '#ret-customer'].forEach((s) => fillCustomerSelect($(s)));
      updateSaleForm();
      updatePaymentForm();
      updateReturnForm();
    }

    const CHIP = {
      pending: '<span class="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-calf-100 text-calf-700">Pending</span>',
      failed: '<span class="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-red-100 text-red-700">Retrying</span>',
      synced: '<span class="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-farm-100 text-farm-800">Synced</span>',
    };

    function renderList(el, rows, store, describe) {
      if (!el) return;
      if (!rows.length) { el.innerHTML = '<li class="text-sm text-slate-400 px-1">No entries yet.</li>'; return; }
      el.innerHTML = rows.map((r) => {
        if (r.voided) {
          return `
          <li class="flex items-center justify-between gap-3 bg-white/60 rounded-xl px-4 py-3 shadow-sm">
            <div class="min-w-0 line-through text-slate-400"><p class="font-semibold text-sm truncate">${describe(r)}</p>
              <p class="text-xs">${esc(r[ID_FIELD[store]] || '')} · ${esc(fmtDate(r.date))}</p></div>
            <span class="shrink-0 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">Cancelled</span>
          </li>`;
        }
        const err = r.syncStatus === SYNC_STATUS.FAILED && r.lastError ? `<p class="text-xs text-red-600">${esc(r.lastError)}</p>` : '';
        return `
          <li class="flex items-center justify-between gap-3 bg-white rounded-xl px-4 py-3 shadow-sm">
            <div class="min-w-0">
              <p class="font-semibold text-sm truncate">${describe(r)}</p>
              <p class="text-xs text-slate-500">${esc(r[ID_FIELD[store]] || '')} · ${esc(fmtDate(r.date))}</p>
              ${err}
            </div>
            <div class="flex items-center gap-2 shrink-0">
              ${r.corrected ? '<span class="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">Corrected</span>' : CHIP[r.syncStatus] || ''}
              ${store === STORES.SALES && queueCorrection ? `<button type="button" class="sale-edit text-xs font-semibold text-sky-700 underline px-1" data-id="${r.id}">Edit</button>` : ''}
              ${!isSynced(r) ? `<button type="button" class="sales-del text-slate-400 hover:text-red-600 text-lg leading-none px-1" data-store="${store}" data-id="${r.id}" aria-label="Delete entry">&times;</button>` : ''}
            </div>
          </li>`;
      }).join('');
    }

    const newest = (list) => list.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, RECENT);

    function renderLists() {
      const saleRows = local.sales.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      const more = $('#sale-more');
      if (more) { show(more, saleRows.length > RECENT); more.textContent = salesShowAll ? 'Show fewer' : `Show more (last ${Math.min(40, saleRows.length)})`; }
      renderList($('#sale-recent'), saleRows.slice(0, salesShowAll ? 40 : RECENT), STORES.SALES, (s) =>
        s.transactionType === 'Balance B/F'
          ? `${esc(custName(s.customerId))} · B/F ${money(s.amount)}`
          : `${esc(custName(s.customerId))} · ${s.litres} L · ${money(s.amount)} <span class="font-normal text-slate-500">${esc(s.saleType)}</span>`);
      renderList($('#pay-recent'), newest(local.payments), STORES.PAYMENTS, (p) =>
        `${esc(custName(p.customerId))} · ${money(p.totalPaid)} <span class="font-normal ${p.status === 'Disputed' ? 'text-red-600' : 'text-slate-500'}">${esc(p.status)}</span>`);
      renderList($('#ret-recent'), newest(local.returns), STORES.RETURNS, (r) =>
        `${esc(custName(r.customerId))} · ${r.totalLitres} L · ${money(r.amount)} <span class="font-normal text-slate-500">${esc(r.saleId)}</span>`);
    }

    function renderCustomers() {
      const listEl = $('#cust-list');
      if (!listEl) return;
      const today = todayLocal();
      const dp = defaultPriceInfo(today);
      $('#price-default-text').textContent = dp ? `${money(dp.price)} per litre (since ${fmtDate(dp.since)} ${dp.since.slice(0, 4)})` : 'Not set yet: sync, or set it here';

      document.querySelectorAll('.cust-filter').forEach((b) => {
        const on = b.dataset.filter === customerFilter;
        b.classList.toggle('bg-violet-700', on); b.classList.toggle('text-white', on); b.classList.toggle('text-slate-600', !on);
        b.setAttribute('aria-pressed', String(on));
        const n = b.querySelector('.cust-count');
        if (n) n.textContent = customers.filter((c) => (c.status || 'Active') === b.dataset.filter).length;
      });
      const rows = customers.filter((c) => (c.status || 'Active') === customerFilter).sort((a, b) => balanceOf(b.customerId) - balanceOf(a.customerId) || a.name.localeCompare(b.name));
      const total = rows.reduce((t, c) => t + Math.max(0, balanceOf(c.customerId)), 0);
      $('#cust-summary').textContent = customerFilter === 'Active'
        ? `${rows.length} active customer(s) · ${money(total)} owed in total${snapshot.serverTime ? '' : ' (sync to load balances)'}`
        : 'Inactive customers stay here with their history.';
      if (!rows.length) { listEl.innerHTML = `<li class="text-sm text-slate-400 px-1">${customers.length ? 'None.' : 'No customers yet. Sync to download them, or tap + Add.'}</li>`; return; }
      listEl.innerHTML = rows.map((c) => {
        const sp = specialPriceInfo(c.customerId, today);
        const b = balanceOf(c.customerId);
        const err = c.syncStatus === SYNC_STATUS.FAILED && c.lastError ? `<p class="text-xs text-red-600 mt-1">${esc(c.lastError)}</p>` : '';
        return `
          <li>
            <button type="button" class="cust-item w-full text-left flex items-start justify-between gap-3 bg-white rounded-xl px-4 py-3 shadow-sm active:scale-[.99]" data-id="${esc(c.customerId)}">
              <div class="min-w-0">
                <p class="font-semibold text-sm truncate">${esc(c.name)} <span class="font-normal text-slate-400">${esc(c.customerId)}</span></p>
                <p class="text-xs text-slate-500 truncate">${esc([c.customerType, c.location].filter(Boolean).join(' · '))}${sp ? ` · special ${money(sp.price)}` : ''}</p>
                <p class="text-xs mt-0.5 ${b > 0.005 ? 'text-red-700 font-semibold' : 'text-slate-500'}">${esc(owesText(c.customerId))}</p>
                ${err}
              </div>
              <div class="shrink-0 pt-0.5">${CHIP[c.syncStatus] || ''}</div>
            </button>
          </li>`;
      }).join('');
    }

    function renderAll() {
      renderSelects();
      renderLists();
      renderCustomers();
    }

    function setError(id, msg) {
      const el = $(id);
      el.textContent = msg || '';
      show(el, !!msg);
    }

    function switchView(name) {
      view = name;
      document.querySelectorAll('.sales-view-btn').forEach((b) => {
        const on = b.dataset.view === name;
        b.classList.toggle('bg-violet-700', on); b.classList.toggle('text-white', on); b.classList.toggle('text-slate-600', !on);
        b.setAttribute('aria-selected', String(on));
      });
      ['sale', 'payment', 'return', 'customers'].forEach((v) => show($(`#sv-${v}`), v === name));
    }

    /* ----------------------------------------------------------------
     * 6. FORMS
     * ---------------------------------------------------------------- */

    /* ---------- Sale ---------- */

    function saleAmount() {
      if ($('#sale-entry').value === 'Balance B/F') return num($('#sale-bf-amount').value);
      const l = num($('#sale-litres').value);
      const p = num($('#sale-price').value);
      return l !== null && p !== null ? r2(l * p) : null;
    }

    let lastPriceKey = '';
    function updateSaleForm(changed) {
      const id = $('#sale-customer').value;
      const date = $('#sale-date').value || todayLocal();
      const bf = $('#sale-entry').value === 'Balance B/F';
      show($('#sale-milk-fields'), !bf);
      show($('#sale-bf-fields'), bf);
      show($('#sale-type-wrap'), !bf);

      const c = byId.get(id);
      $('#sale-customer-info').textContent = c ? `${c.customerType} · ${owesText(id)}` : '';

      // Fill the price when the customer or date changes (the user can still edit it).
      const listPrice = c ? priceFor(id, date) : null;
      const key = id + '|' + date;
      if (c && key !== lastPriceKey && (changed === 'customer' || changed === 'date' || !$('#sale-price').value)) {
        $('#sale-price').value = listPrice !== null ? listPrice : '';
        lastPriceKey = key;
        // Remember the customer's usual sale type.
        if (changed === 'customer') {
          const last = local.sales.filter((s) => s.customerId === id && s.transactionType === 'Sale')
            .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
          $('#sale-type').value = last ? last.saleType : 'Credit';
        }
      }
      const p = num($('#sale-price').value);
      $('#sale-price-note').textContent = c && listPrice === null ? 'No price list yet: type the price.'
        : (c && p !== null && listPrice !== null && Math.abs(p - listPrice) > 0.005 ? `Price list says ${money(listPrice)}: this sale will use ${money(p)}.` : '');

      const amount = saleAmount();
      $('#sale-amount').textContent = amount !== null ? money(amount) : '—';

      const cash = !bf && $('#sale-type').value === 'Cash';
      show($('#sale-cash-fields'), cash);
      if (cash && !saleTouchedPayment) {
        $('#sale-pay-cash').value = amount !== null ? amount : '';
        $('#sale-pay-mpesa').value = '';
      }
    }

    function validateSale() {
      const date = $('#sale-date').value;
      const id = $('#sale-customer').value;
      const bf = $('#sale-entry').value === 'Balance B/F';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'Pick a date.' };
      if (date > todayLocal()) return { error: 'Date cannot be in the future.' };
      const c = byId.get(id);
      if (!c) return { error: 'Choose a customer.' };
      const base = { date, customerId: id, customerName: c.name, customerType: c.customerType,
        invoiceRef: $('#sale-invoice').value.trim().slice(0, 40), notes: $('#sale-notes').value.trim().slice(0, 300) };

      if (bf) {
        const amount = num($('#sale-bf-amount').value);
        if (amount === null || amount === 0) return { error: 'Enter the balance brought forward (negative if they are in credit).' };
        return { sale: { ...base, transactionType: 'Balance B/F', litres: null, pricePerLitre: null, amount: r2(amount), saleType: 'Credit' } };
      }
      const litres = num($('#sale-litres').value);
      const price = num($('#sale-price').value);
      if (litres === null || litres <= 0) return { error: 'Enter litres above 0.' };
      if (litres > 1000) return { error: 'Litres look too high (max 1,000).' };
      if (price === null || price <= 0 || price > 1000) return { error: 'Enter the price per litre.' };
      const amount = r2(litres * price);
      const saleType = $('#sale-type').value === 'Cash' ? 'Cash' : 'Credit';
      const sale = { ...base, transactionType: 'Sale', litres: r1(litres), pricePerLitre: r2(price), amount: r2(r1(litres) * r2(price)), saleType };

      let payment = null;
      const warnings = [];
      const listPrice = priceFor(id, date);
      if (listPrice !== null && Math.abs(listPrice - price) > 0.005) warnings.push(`Price ${money(price)} differs from the price list (${money(listPrice)}).`);
      if (saleType === 'Cash') {
        const cash = num($('#sale-pay-cash').value) || 0;
        const mpesa = num($('#sale-pay-mpesa').value) || 0;
        const total = r2(cash + mpesa);
        if (cash < 0 || mpesa < 0) return { error: 'Payment amounts cannot be negative.' };
        if (total <= 0) return { error: 'A cash sale needs the money received (cash and/or M-Pesa).' };
        const ref = $('#sale-pay-ref').value.trim();
        if (mpesa > 0 && !ref) warnings.push('No M-Pesa receipt reference entered.');
        if (Math.abs(total - sale.amount) > 0.005) warnings.push(total < sale.amount
          ? `Received ${money(total)} of ${money(sale.amount)}: the rest stays owed.`
          : `Received ${money(total)}, more than the sale (${money(sale.amount)}): the extra counts as credit.`);
        payment = { date, customerId: id, customerName: c.name, cashPaid: r2(cash), mpesaPaid: r2(mpesa), otherPaid: 0,
          totalPaid: total, receiptRef: ref.slice(0, 300), note: 'Paid with the sale', status: 'Verified' };
      }
      void amount;
      return { sale, payment, warnings };
    }

    async function handleSaleSubmit(e) {
      e.preventDefault();
      setError('#sale-error', null);
      if (!getSession()) { toast('Sign in first', 'error'); return; }
      const v = validateSale();
      if (v.error) { setError('#sale-error', v.error); return; }
      if (v.warnings && v.warnings.length && !confirm(v.warnings.join('\n') + '\n\nSave anyway?')) return;
      const btn = $('#sale-form button[type="submit"]');
      btn.disabled = true;
      try {
        v.sale.saleId = nextDocId('S', v.sale.date);
        if (v.payment) v.payment.paymentId = nextDocId('P', v.sale.date);
        await saveSale(v.sale, v.payment);
        toast(v.sale.transactionType === 'Sale'
          ? `Saved: ${v.sale.customerName} · ${v.sale.litres} L · ${money(v.sale.amount)}${v.payment ? ' (paid)' : ''}`
          : `Saved opening balance for ${v.sale.customerName}`);
        $('#sale-litres').value = '';
        $('#sale-bf-amount').value = '';
        $('#sale-invoice').value = '';
        $('#sale-notes').value = '';
        $('#sale-pay-ref').value = '';
        saleTouchedPayment = false;
        $('#sale-customer').value = '';
        lastPriceKey = '';
        $('#sale-price').value = '';
        $('#sale-entry').value = 'Sale';
        updateSaleForm();
        $('#sale-customer').focus();
        requestSync('new-record', saveDebounceMs);
      } catch (err) {
        console.error('Sale save failed:', err);
        setError('#sale-error', 'Could not save on this phone: ' + (err.message || err));
      } finally {
        btn.disabled = false;
      }
    }

    /* ---------- Payment ---------- */

    function updatePaymentForm() {
      const id = $('#pay-customer').value;
      $('#pay-customer-info').textContent = byId.get(id) ? owesText(id) : '';
      const total = r2((num($('#pay-cash').value) || 0) + (num($('#pay-mpesa').value) || 0) + (num($('#pay-other').value) || 0));
      $('#pay-total').textContent = money(total);
    }

    async function handlePaymentSubmit(e) {
      e.preventDefault();
      setError('#pay-error', null);
      if (!getSession()) { toast('Sign in first', 'error'); return; }
      const date = $('#pay-date').value;
      const id = $('#pay-customer').value;
      const c = byId.get(id);
      const cash = num($('#pay-cash').value) || 0;
      const mpesa = num($('#pay-mpesa').value) || 0;
      const other = num($('#pay-other').value) || 0;
      const total = r2(cash + mpesa + other);
      const ref = $('#pay-ref').value.trim();
      const status = $('#pay-status').value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { setError('#pay-error', 'Pick a date.'); return; }
      if (date > todayLocal()) { setError('#pay-error', 'Date cannot be in the future.'); return; }
      if (!c) { setError('#pay-error', 'Choose a customer.'); return; }
      if (cash < 0 || mpesa < 0 || other < 0) { setError('#pay-error', 'Amounts cannot be negative.'); return; }
      if (total <= 0) { setError('#pay-error', 'Enter the amount received.'); return; }
      if (!OPTIONS.paymentStatus.includes(status)) { setError('#pay-error', 'Choose a status.'); return; }
      const warnings = [];
      if (mpesa > 0 && !ref) warnings.push('No M-Pesa receipt reference entered.');
      const dupRef = ref && local.payments.find((p) => p.receiptRef && p.receiptRef.toUpperCase() === ref.toUpperCase());
      if (dupRef) warnings.push(`Receipt ${ref} is already on a payment from ${custName(dupRef.customerId)} (${fmtDate(dupRef.date)}).`);
      if (warnings.length && !confirm(warnings.join('\n') + '\n\nSave anyway?')) return;

      const btn = $('#pay-form button[type="submit"]');
      btn.disabled = true;
      try {
        await savePayment({ paymentId: nextDocId('P', date), date, customerId: id, customerName: c.name, cashPaid: r2(cash),
          mpesaPaid: r2(mpesa), otherPaid: r2(other), totalPaid: total, receiptRef: ref.slice(0, 300),
          note: $('#pay-note').value.trim().slice(0, 300), status, linkedSaleId: '' });
        toast(`Saved: ${c.name} paid ${money(total)}${status !== 'Verified' ? ' (' + status + ')' : ''}`);
        ['#pay-cash', '#pay-mpesa', '#pay-other', '#pay-ref', '#pay-note'].forEach((s) => { $(s).value = ''; });
        $('#pay-status').value = 'Verified';
        $('#pay-customer').value = '';
        updatePaymentForm();
        requestSync('new-record', saveDebounceMs);
      } catch (err) {
        setError('#pay-error', 'Could not save on this phone: ' + (err.message || err));
      } finally {
        btn.disabled = false;
      }
    }

    /* ---------- Return ---------- */

    function selectedReturnSale() {
      const id = $('#ret-customer').value;
      return returnableSales(id).find((s) => s.saleId === $('#ret-sale').value) || null;
    }

    function updateReturnForm(changed) {
      const id = $('#ret-customer').value;
      const sel = $('#ret-sale');
      if (changed !== 'sale' && changed !== 'litres') {
        const keep = sel.value;
        const list = byId.get(id) ? returnableSales(id) : [];
        sel.innerHTML = !byId.get(id) ? '<option value="">Choose the customer first</option>'
          : (list.length ? '<option value="">Choose the sale…</option>' : '<option value="">No recent sales to return</option>') +
            list.map((s) => `<option value="${esc(s.saleId)}">${esc(fmtDate(s.date))} · ${s.litres} L @ ${s.pricePerLitre} · ${esc(s.saleId)}</option>`).join('');
        if (keep && list.some((s) => s.saleId === keep)) sel.value = keep;
      }
      const s = selectedReturnSale();
      $('#ret-sale-info').textContent = s ? `Up to ${s.remaining} L can be credited${s.returnedLitres ? ` (${s.returnedLitres} L already)` : ''}.` : '';
      const returned = num($('#ret-returned').value) || 0;
      const through = num($('#ret-soldthrough').value) || 0;
      const total = r1(returned + through);
      $('#ret-total').textContent = s ? `${total} L · ${money(r2(total * s.pricePerLitre))}` : `${total} L`;
    }

    async function handleReturnSubmit(e) {
      e.preventDefault();
      setError('#ret-error', null);
      if (!getSession()) { toast('Sign in first', 'error'); return; }
      const date = $('#ret-date').value;
      const id = $('#ret-customer').value;
      const c = byId.get(id);
      const s = selectedReturnSale();
      const returned = num($('#ret-returned').value) || 0;
      const through = num($('#ret-soldthrough').value) || 0;
      const total = r1(returned + through);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { setError('#ret-error', 'Pick a date.'); return; }
      if (date > todayLocal()) { setError('#ret-error', 'Date cannot be in the future.'); return; }
      if (!c) { setError('#ret-error', 'Choose a customer.'); return; }
      if (!s) { setError('#ret-error', 'Choose the sale the milk came from.'); return; }
      if (returned < 0 || through < 0) { setError('#ret-error', 'Litres cannot be negative.'); return; }
      if (total <= 0) { setError('#ret-error', 'Enter the litres returned and/or sold-through.'); return; }
      if (total > s.remaining + 0.01) { setError('#ret-error', `Only ${s.remaining} L of that sale can still be credited.`); return; }
      if (date < s.date) { setError('#ret-error', 'A return cannot be dated before the sale.'); return; }
      const btn = $('#ret-form button[type="submit"]');
      btn.disabled = true;
      try {
        await saveReturn({ returnId: nextDocId('R', date), date, saleId: s.saleId, customerId: id, customerName: c.name,
          originalLitres: s.litres, unitPrice: s.pricePerLitre, litresReturned: r1(returned), litresSoldThrough: r1(through),
          totalLitres: total, amount: r2(total * s.pricePerLitre), note: $('#ret-note').value.trim().slice(0, 300) });
        toast(`Saved: ${c.name} credited ${total} L · ${money(r2(total * s.pricePerLitre))}`);
        ['#ret-returned', '#ret-soldthrough', '#ret-note'].forEach((x) => { $(x).value = ''; });
        $('#ret-sale').value = '';
        updateReturnForm();
        requestSync('new-record', saveDebounceMs);
      } catch (err) {
        setError('#ret-error', 'Could not save on this phone: ' + (err.message || err));
      } finally {
        btn.disabled = false;
      }
    }

    /* ---------- Customer ---------- */

    const cf = (n) => $(`#cf-${n}`);

    function openCustomerForm(id, fromSelect) {
      const c = id ? byId.get(id) : null;
      editingCustomer = { originalId: c ? c.customerId : null, isNew: !c, returnTo: fromSelect || null };
      const today = todayLocal();
      $('#cust-form-title').textContent = c ? `${c.name} · ${c.customerId}` : 'Add a customer';
      cf('customerId').value = c ? c.customerId : nextCustomerId();
      cf('name').value = c ? c.name : '';
      cf('customerType').innerHTML = OPTIONS.customerType.map((t) => `<option>${esc(t)}</option>`).join('');
      cf('customerType').value = c ? c.customerType : 'Milk Vendor';
      cf('phone').value = c ? c.phone || '' : '';
      cf('location').value = c ? c.location || '' : '';
      cf('status').value = c ? c.status || 'Active' : 'Active';
      cf('notes').value = c ? c.notes || '' : '';
      const sp = c ? specialPriceInfo(c.customerId, today) : null;
      cf('special').value = sp ? sp.price : '';
      cf('special').dataset.original = sp ? String(sp.price) : '';
      cf('special-date').value = today;
      cf('special-date').max = today;
      const dp = defaultPriceInfo(today);
      $('#cf-special-hint').textContent = (sp ? `Special price ${money(sp.price)} since ${fmtDate(sp.since)} ${sp.since.slice(0, 4)}. ` : '') +
        `Leave blank to use the default${dp ? ' (' + money(dp.price) + ')' : ''}. A change applies from the date below; older sales keep their price.`;
      $('#cust-form-meta').textContent = c ? owesText(c.customerId) : '';
      show($('#cf-delete'), !!c && !c.syncedAt);
      setError('#cf-error', null);
      show($('#cust-list-view'), false);
      show($('#cust-form'), true);
      if (!c) cf('name').focus();
    }

    function closeCustomerForm() {
      const back = editingCustomer && editingCustomer.returnTo;
      editingCustomer = null;
      show($('#cust-form'), false);
      show($('#cust-list-view'), true);
      if (back) switchView(back);
    }

    async function handleCustomerSubmit(e) {
      e.preventDefault();
      if (!editingCustomer) return;
      if (!getSession()) { toast('Sign in first', 'error'); return; }
      const data = {
        customerId: cf('customerId').value.trim().toUpperCase(),
        name: cf('name').value.trim().replace(/\s+/g, ' '),
        customerType: cf('customerType').value,
        phone: cf('phone').value.trim(),
        location: cf('location').value.trim().slice(0, 60),
        status: cf('status').value,
        notes: cf('notes').value.trim().slice(0, 300),
      };
      if (!CUSTOMER_ID.test(data.customerId)) { setError('#cf-error', 'ID must look like C-010.'); return; }
      if (!data.name) { setError('#cf-error', 'Name is required.'); return; }
      if (data.name.length > 60) { setError('#cf-error', 'Name is too long (max 60).'); return; }
      if (!OPTIONS.customerType.includes(data.customerType)) { setError('#cf-error', 'Choose a type.'); return; }
      if (data.phone && !/^[+0-9 ()\-]{3,20}$/.test(data.phone)) { setError('#cf-error', 'Phone: digits, spaces and + only.'); return; }
      const twin = customers.find((c) => c.customerId !== editingCustomer.originalId && c.name.toLowerCase() === data.name.toLowerCase());
      if (twin && !confirm(`${twin.name} (${twin.customerId}) already exists. Save another customer with the same name?`)) return;

      const specialRaw = cf('special').value.trim();
      const special = specialRaw === '' ? null : num(specialRaw);
      if (specialRaw !== '' && (special === null || special <= 0 || special > 1000)) { setError('#cf-error', 'Special price must be a number of shillings, or blank.'); return; }
      const specialDate = cf('special-date').value || todayLocal();
      const original = cf('special').dataset.original;
      const priceChanged = (original === '' ? null : Number(original)) !== special;
      if (priceChanged && specialDate > todayLocal()) { setError('#cf-error', 'The price date cannot be in the future.'); return; }

      const btn = cf('save');
      btn.disabled = true;
      try {
        const saved = await saveCustomer(data, editingCustomer);
        if (priceChanged) await savePrice(saved.customerId, special, specialDate, special === null ? 'Back to the default price' : 'Special price');
        toast(`${editingCustomer.isNew ? 'Added' : 'Saved'}: ${saved.name} (${saved.customerId})`);
        const back = editingCustomer.returnTo;
        closeCustomerForm();
        if (back) {
          const sel = $({ sale: '#sale-customer', payment: '#pay-customer', return: '#ret-customer' }[back]);
          setTimeout(() => { fillCustomerSelect(sel); sel.value = saved.customerId; sel.dispatchEvent(new Event('change')); }, 50);
        }
        requestSync('customer-save', saveDebounceMs);
      } catch (err) {
        setError('#cf-error', err.message || String(err));
      } finally {
        btn.disabled = false;
      }
    }

    async function handleCustomerDelete() {
      if (!editingCustomer || !editingCustomer.originalId) return;
      const id = editingCustomer.originalId;
      const used = local.sales.some((s) => s.customerId === id) || local.payments.some((p) => p.customerId === id) || local.returns.some((r) => r.customerId === id);
      if (used) { setError('#cf-error', 'Entries on this phone use this customer: set Status to Inactive instead.'); return; }
      if (inFlightCustomers.has(id)) { setError('#cf-error', 'Uploading right now: try again in a moment.'); return; }
      if (!confirm(`Delete ${id} from this phone? It has not been uploaded yet.`)) return;
      const rec = await db[STORES.CUSTOMERS].get(id);
      if (rec && rec.syncedAt) { setError('#cf-error', 'Already uploaded: set Status to Inactive instead.'); return; }
      await db[STORES.CUSTOMERS].delete(id);
      await db[STORES.PRICES].filter((p) => p.customerId === id && !isSynced(p)).delete();
      toast('Customer deleted', 'info');
      closeCustomerForm();
    }

    /* ---------- Default price ---------- */

    function openDefaultPrice() {
      const dp = defaultPriceInfo(todayLocal());
      $('#pd-price').value = dp ? dp.price : '';
      $('#pd-date').value = todayLocal();
      $('#pd-date').max = todayLocal();
      setError('#pd-error', null);
      show($('#price-default-form'), true);
      $('#pd-price').focus();
    }

    async function handleDefaultPriceSubmit(e) {
      e.preventDefault();
      if (!getSession()) { toast('Sign in first', 'error'); return; }
      const price = num($('#pd-price').value);
      const date = $('#pd-date').value;
      if (price === null || price <= 0 || price > 1000) { setError('#pd-error', 'Enter the new price per litre.'); return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > todayLocal()) { setError('#pd-error', 'Pick the date the price applies from (not in the future).'); return; }
      const dp = defaultPriceInfo(date);
      if (dp && Math.abs(dp.price - price) < 0.005) { setError('#pd-error', 'That is already the default price.'); return; }
      if (!confirm(`Default price ${money(price)} per litre from ${fmtDate(date)} ${date.slice(0, 4)}?\nSales before that date keep their price.`)) return;
      await savePrice('', price, date, 'Default price');
      toast(`Default price set to ${money(price)} from ${fmtDate(date)}`);
      show($('#price-default-form'), false);
      requestSync('price-save', saveDebounceMs);
    }

    /* ----------------------------------------------------------------
     * 7. INIT + PUBLIC API
     * ---------------------------------------------------------------- */

    function handleCustomerSelect(e, viewName) {
      if (e.target.value !== ADD_VALUE) return;
      e.target.value = '';
      switchView('customers');
      openCustomerForm(null, viewName);
    }

    /* ----------------------------------------------------------------
     * EDIT / CANCEL A SALE (v5.10)
     * ---------------------------------------------------------------- */

    /** Litres already returned on a sale (sheet figure + this phone's newer returns). */
    function returnedFor(saleId) {
      const srv = (snapshot.recentSales || []).find((x) => x.saleId === saleId);
      let l = srv ? Number(srv.returnedLitres) || 0 : 0;
      local.returns.forEach((r) => { if (r.saleId === saleId && (notInSnapshot(r) || !srv)) l += Number(r.totalLitres) || 0; });
      return r1(l);
    }
    function seError(m) { const el = $('#se-error'); el.textContent = m || ''; show(el, !!m); }

    function openSaleEdit(id) {
      const s = local.sales.find((x) => x.id === id);
      if (!s || s.voided) { toast('That sale is no longer on this phone', 'error'); return; }
      editingSale = s;
      const synced = isSynced(s);
      const bf = s.transactionType === 'Balance B/F';
      const sel = $('#se-customer');
      sel.innerHTML = customers.filter((c) => c.status !== 'Inactive' || c.customerId === s.customerId)
        .map((c) => `<option value="${esc(c.customerId)}">${esc(c.name)} (${esc(c.customerId)})</option>`).join('');
      if (!byId.has(s.customerId)) sel.insertAdjacentHTML('afterbegin', `<option value="${esc(s.customerId)}">${esc(s.customerName || s.customerId)}</option>`);
      sel.value = s.customerId;
      $('#se-title').textContent = `Edit ${bf ? 'balance brought forward' : 'sale'} ${s.saleId}`;
      $('#se-date').value = s.date; $('#se-date').max = todayLocal();
      $('#se-litres').value = bf ? '' : s.litres;
      $('#se-price').value = bf ? '' : s.pricePerLitre;
      $('#se-amount').value = bf ? s.amount : '';
      $('#se-type').value = s.saleType || 'Credit';
      $('#se-notes').value = s.notes || '';
      $('#se-reason').value = ''; $('#se-payref').value = ''; $('#se-paymethod').value = 'Cash';
      show($('#se-sale-fields'), !bf); show($('#se-bf-fields'), bf);
      show($('#se-reason-wrap'), synced);
      const ret = bf ? 0 : returnedFor(s.saleId);
      $('#se-returns').textContent = ret > 0 ? `${ret} L of this sale was returned: it cannot be cancelled, moved to another customer or cut below ${ret} L.` : '';
      show($('#se-returns'), ret > 0);
      $('#se-info').textContent = synced
        ? 'Already in Google Sheets: the sheet is corrected at the next sync (a cash sale\'s payment follows), and the change is logged with your reason.'
        : 'Not uploaded yet: the sale on this phone is changed.';
      $('#se-void').textContent = synced ? 'Cancel this sale' : 'Delete this sale';
      seError('');
      updateSaleEdit();
      show($('#se-sheet'), true);
    }
    function closeSaleEdit() { editingSale = null; show($('#se-sheet'), false); }

    function updateSaleEdit() {
      const s = editingSale;
      if (!s) return;
      const l = num($('#se-litres').value), p = num($('#se-price').value);
      $('#se-total').textContent = l && p ? `Amount: ${money(r2(l * p))}` : '';
      // Credit → Cash: ask how it was paid (a payment is added).
      show($('#se-pay-wrap'), s.transactionType !== 'Balance B/F' && s.saleType !== 'Cash' && $('#se-type').value === 'Cash');
      const c = byId.get($('#se-customer').value);
      $('#se-custnote').textContent = c && c.customerId !== s.customerId ? `Moves the sale to ${c.name}${s.saleType === 'Cash' ? ' (its payment moves too)' : ''}.` : '';
    }

    /** The changes made in the panel, or { error }. */
    function saleEditChanges() {
      const s = editingSale;
      const bf = s.transactionType === 'Balance B/F';
      const date = $('#se-date').value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > todayLocal()) return { error: 'Pick the date (not in the future).' };
      const ch = {};
      if (date !== s.date) ch.date = date;
      const cid = $('#se-customer').value;
      if (cid !== s.customerId) { const c = byId.get(cid); ch.customerId = cid; ch.customerName = c ? c.name : ''; ch.customerType = c ? c.customerType : ''; }
      if (bf) {
        const a = num($('#se-amount').value);
        if (a === null || a === 0 || Math.abs(a) > 10000000) return { error: 'Enter the balance (negative if they were in credit).' };
        if (Math.abs(a - Number(s.amount)) > 0.005) ch.amount = r2(a);
      } else {
        const l = num($('#se-litres').value), p = num($('#se-price').value);
        if (l === null || l <= 0 || l > 1000) return { error: 'Litres must be above 0 and at most 1,000.' };
        if (p === null || p <= 0 || p > 1000) return { error: 'Enter the price per litre.' };
        if (Math.abs(l - Number(s.litres)) > 0.0001) ch.litres = l;
        if (Math.abs(p - Number(s.pricePerLitre)) > 0.0001) ch.pricePerLitre = p;
        const amount = r2(l * p);
        if (Math.abs(amount - Number(s.amount)) > 0.005) ch.amount = amount;
        if ($('#se-type').value !== s.saleType) ch.saleType = $('#se-type').value;
        const ret = returnedFor(s.saleId);
        if (ret > 0 && l < ret - 0.01) return { error: `${ret} L of this sale was returned: litres cannot be less than that.` };
        if (ret > 0 && ch.customerId) return { error: 'This sale has returns: it cannot be moved to another customer.' };
      }
      const notes = $('#se-notes').value.trim().slice(0, 300);
      if (notes !== (s.notes || '')) ch.notes = notes;
      return { changes: ch };
    }

    /** New split of a payment for a new amount: one method keeps it all; otherwise the largest part takes the difference. */
    function rebalance(p, amount) {
      const parts = { cashPaid: Number(p.cashPaid) || 0, mpesaPaid: Number(p.mpesaPaid) || 0, otherPaid: Number(p.otherPaid) || 0 };
      const total = r2(parts.cashPaid + parts.mpesaPaid + parts.otherPaid);
      const keys = Object.keys(parts).filter((k) => parts[k] > 0);
      const big = (keys.length ? keys : ['cashPaid']).sort((a, b) => parts[b] - parts[a])[0];
      parts[big] = r2(parts[big] + amount - total);
      if (parts[big] < 0) { Object.keys(parts).forEach((k) => { parts[k] = 0; }); parts[big] = amount; }
      return { ...parts, totalPaid: amount };
    }

    async function saveSaleEdit(e) {
      e.preventDefault();
      const s = editingSale;
      if (!s) return;
      seError('');
      const r = saleEditChanges();
      if (r.error) { seError(r.error); return; }
      const ch = r.changes;
      if (!Object.keys(ch).length) { closeSaleEdit(); return; }
      const merged = { ...s, ...ch };
      const now = new Date().toISOString();
      const linked = local.payments.filter((p) => p.linkedSaleId === s.saleId && !p.voided);
      if (!isSynced(s)) {
        if (isInFlight(STORES.SALES, s.id) || linked.some((p) => isInFlight(STORES.PAYMENTS, p.id))) { seError('This sale is uploading right now. Try again in a moment.'); return; }
        await db.transaction('rw', db[STORES.SALES], db[STORES.PAYMENTS], async () => {
          await db[STORES.SALES].update(s.id, { ...ch, updatedAt: now });
          const unsent = linked.filter((p) => !isSynced(p));
          if (merged.saleType === 'Cash' && merged.transactionType === 'Sale') {
            if (unsent.length) {
              for (const p of unsent) await db[STORES.PAYMENTS].update(p.id, { ...rebalance(p, Number(merged.amount)), date: merged.date, customerId: merged.customerId, customerName: merged.customerName || p.customerName, updatedAt: now });
            } else {
              const m = $('#se-paymethod').value;
              const amount = Number(merged.amount);
              await db[STORES.PAYMENTS].add({ ...baseMeta(), paymentId: nextDocId('P', merged.date), date: merged.date, customerId: merged.customerId, customerName: merged.customerName || '',
                cashPaid: m === 'Cash' ? amount : 0, mpesaPaid: m === 'M-Pesa' ? amount : 0, otherPaid: m === 'Other' ? amount : 0, totalPaid: amount,
                receiptRef: $('#se-payref').value.trim().slice(0, 300), note: 'Paid with the sale', status: 'Verified', linkedSaleId: s.saleId });
            }
          } else {
            for (const p of unsent) await db[STORES.PAYMENTS].delete(p.id);
          }
        });
        toast('Sale changed');
        closeSaleEdit();
        return;
      }
      const reason = $('#se-reason').value.trim();
      if (!reason) { seError('Give a reason for the change (it is kept with the record).'); $('#se-reason').focus(); return; }
      const extra = ch.saleType === 'Cash' ? { payMethod: $('#se-paymethod').value, payRef: $('#se-payref').value.trim().slice(0, 300) } : null;
      await queueCorrection({ sheet: 'Sales', id: s.saleId, changes: ch, void: false, reason: reason.slice(0, 300), extra });
      await db[STORES.SALES].update(s.id, { ...ch, corrected: true, updatedAt: now });
      // The phone's copy of the linked payment, for display (the sheet does the real change).
      for (const p of linked) {
        if (merged.saleType === 'Cash') await db[STORES.PAYMENTS].update(p.id, { ...rebalance(p, Number(merged.amount)), date: merged.date, customerId: merged.customerId, corrected: true, updatedAt: now });
        else await db[STORES.PAYMENTS].update(p.id, { voided: true, updatedAt: now });
      }
      toast('Changed: the sheet is corrected with the next sync');
      closeSaleEdit();
    }

    async function voidSaleEdit() {
      const s = editingSale;
      if (!s) return;
      seError('');
      if (!isSynced(s)) {
        if (!confirm(`Delete sale ${s.saleId}? It has not been uploaded yet.`)) return;
        try { await deleteEntry(STORES.SALES, s.id); toast('Sale deleted', 'info'); closeSaleEdit(); } catch (err) { seError(err.message); }
        return;
      }
      if (s.transactionType !== 'Balance B/F' && returnedFor(s.saleId) > 0) { seError('This sale has returns: it cannot be cancelled.'); return; }
      const reason = $('#se-reason').value.trim();
      if (!reason) { seError('Give a reason for cancelling (e.g. entered twice).'); $('#se-reason').focus(); return; }
      if (!confirm(`Cancel sale ${s.saleId} (${custName(s.customerId)}, ${money(s.amount)})? It stays in the sheet marked Void and no longer counts in balances, statements or reports${s.saleType === 'Cash' ? '; its payment is cancelled too' : ''}.`)) return;
      await queueCorrection({ sheet: 'Sales', id: s.saleId, changes: {}, void: true, reason: reason.slice(0, 300) });
      const now = new Date().toISOString();
      await db[STORES.SALES].update(s.id, { voided: true, updatedAt: now });
      for (const p of local.payments.filter((x) => x.linkedSaleId === s.saleId)) await db[STORES.PAYMENTS].update(p.id, { voided: true, updatedAt: now });
      toast('Sale cancelled: the sheet is updated with the next sync', 'info');
      closeSaleEdit();
    }

    async function handleListClick(e) {
      const ed = e.target.closest('.sale-edit');
      if (ed) { openSaleEdit(Number(ed.dataset.id)); return; }
      const btn = e.target.closest('.sales-del');
      if (!btn) return;
      if (!confirm('Delete this entry from the phone? It has not been uploaded yet.')) return;
      try {
        await deleteEntry(btn.dataset.store, Number(btn.dataset.id));
        toast('Entry deleted', 'info');
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    function init() {
      const today = todayLocal();
      ['#sale-date', '#pay-date', '#ret-date'].forEach((s) => { $(s).value = today; $(s).max = today; });

      document.querySelectorAll('.sales-view-btn').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));
      $('#sale-form').addEventListener('submit', handleSaleSubmit);
      $('#pay-form').addEventListener('submit', handlePaymentSubmit);
      $('#ret-form').addEventListener('submit', handleReturnSubmit);
      $('#cust-form').addEventListener('submit', handleCustomerSubmit);
      $('#price-default-form').addEventListener('submit', handleDefaultPriceSubmit);

      $('#sale-customer').addEventListener('change', (e) => { handleCustomerSelect(e, 'sale'); saleTouchedPayment = false; updateSaleForm('customer'); });
      $('#sale-date').addEventListener('change', () => updateSaleForm('date'));
      $('#sale-entry').addEventListener('change', () => updateSaleForm());
      $('#sale-type').addEventListener('change', () => { saleTouchedPayment = false; updateSaleForm(); });
      ['#sale-litres', '#sale-price', '#sale-bf-amount'].forEach((s) => $(s).addEventListener('input', () => updateSaleForm()));
      ['#sale-pay-cash', '#sale-pay-mpesa'].forEach((s) => $(s).addEventListener('input', () => { saleTouchedPayment = true; }));

      $('#pay-customer').addEventListener('change', (e) => { handleCustomerSelect(e, 'payment'); updatePaymentForm(); });
      ['#pay-cash', '#pay-mpesa', '#pay-other'].forEach((s) => $(s).addEventListener('input', updatePaymentForm));

      $('#ret-customer').addEventListener('change', (e) => { handleCustomerSelect(e, 'return'); updateReturnForm(); });
      $('#ret-sale').addEventListener('change', () => updateReturnForm('sale'));
      ['#ret-returned', '#ret-soldthrough'].forEach((s) => $(s).addEventListener('input', () => updateReturnForm('litres')));

      ['#sale-recent', '#pay-recent', '#ret-recent'].forEach((s) => $(s).addEventListener('click', handleListClick));
      // v5.10: edit / cancel a sale.
      if ($('#se-form')) {
        $('#se-form').addEventListener('submit', saveSaleEdit);
        $('#se-void').addEventListener('click', voidSaleEdit);
        $('#se-close').addEventListener('click', closeSaleEdit);
        $('#se-sheet').addEventListener('click', (ev) => { if (ev.target.id === 'se-sheet') closeSaleEdit(); });
        ['#se-litres', '#se-price'].forEach((x) => $(x).addEventListener('input', updateSaleEdit));
        ['#se-type', '#se-customer'].forEach((x) => $(x).addEventListener('change', updateSaleEdit));
        $('#sale-more').addEventListener('click', () => { salesShowAll = !salesShowAll; renderLists(); });
      }
      $('#cust-add').addEventListener('click', () => openCustomerForm(null));
      $('#cust-list').addEventListener('click', (e) => { const b = e.target.closest('.cust-item'); if (b) openCustomerForm(b.dataset.id); });
      document.querySelectorAll('.cust-filter').forEach((b) => b.addEventListener('click', () => { customerFilter = b.dataset.filter; renderCustomers(); }));
      $('#cf-cancel').addEventListener('click', closeCustomerForm);
      $('#cf-back').addEventListener('click', closeCustomerForm);
      $('#cf-delete').addEventListener('click', handleCustomerDelete);
      $('#price-default-change').addEventListener('click', openDefaultPrice);
      $('#pd-cancel').addEventListener('click', () => show($('#price-default-form'), false));

      const { liveQuery } = Dexie;
      liveQuery(() => db[STORES.CUSTOMERS].toArray()).subscribe({
        next: (rows) => { customers = rows; byId.clear(); rows.forEach((c) => byId.set(c.customerId, c)); renderAll(); },
        error: (e) => console.error('Customers query failed:', e),
      });
      liveQuery(() => db[STORES.PRICES].toArray()).subscribe({ next: (rows) => { prices = rows; renderAll(); } });
      liveQuery(() => db[STORES.KV].get(SNAPSHOT_KEY)).subscribe({
        next: (s) => { snapshot = s || { balances: {}, recentSales: [], usedIds: [], serverTime: '' }; renderAll(); },
      });
      [STORES.SALES, STORES.PAYMENTS, STORES.RETURNS].forEach((st) => {
        liveQuery(() => db[st].toArray()).subscribe({ next: (rows) => { local[st] = rows; renderAll(); } });
      });
      switchView('sale');
    }

    return Object.freeze({
      init,
      isEmpty: () => customers.length === 0,
      switchView,
      // sync helpers for app.js
      inFlightCustomers,
      getPendingCustomers, customerPayload, applyCustomerResults, mergeSnapshot, applyRename,
      // exposed for console checks
      priceFor, balanceOf, nextDocId, returnableSales,
    });
  }

  window.MaweSales = Object.freeze({ create, STORES, OPTIONS, PAYLOAD, SHEETS, ID_FIELD });
})();
