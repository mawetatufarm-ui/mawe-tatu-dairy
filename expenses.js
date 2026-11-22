/* =====================================================================
 * Mawe Tatu Dairy — expenses.js (Expenses tab)
 * ---------------------------------------------------------------------
 * Three views, switched by the buttons at the top of the tab (the third,
 * "All expenses" — list, filters, pay, edit, receipts, export — lives in
 * expense-list.js and is created here):
 *
 *  1. EXPENSE — record a dairy expense at the moment it is paid, offline:
 *     date, category, what was bought, amount, optional quantity + unit
 *     (price per unit, and per kg for sized bags, is worked out), how it
 *     was paid, M-Pesa / receipt reference, who was paid, the animal it
 *     was for (vet, AI, purchases). An optional M-Pesa / bank transaction
 *     charge is saved as its own "M-Pesa & bank charges" expense.
 *     v5.4: amount OR quantity × price per unit; payment status (paid in
 *     full / part paid / not paid yet = credit, with due date); a receipt
 *     photo; "repeat every month" saves a regular payment (salaries…)
 *     that is offered again each month under "Regular payments due".
 *
 *  2. FEED BATCH — cost a batch of home-made dairy meal from what went
 *     into it: each ingredient's kg and price per kg (bought ingredients
 *     prefilled from recent purchases, own maize at its market value),
 *     plus grinding, labour, transport and other costs. Shows the cost per
 *     kg and per 70 kg bag against ready-made dairy meal. A batch is NOT an
 *     expense (its purchases are already expenses); ticking "also record
 *     the payments as expenses" saves the grinding / labour / transport
 *     payments as ordinary expenses too.
 *
 * Decisions (22 Nov 2026): dairy only; salaries are ordinary expenses; a
 * salary advance is recorded when paid and only the balance at month end;
 * casual labour quantity = worker-days; animal purchases are capital
 * (shown apart from running costs); everything is paid on the spot.
 *
 * Stores (Dexie schema in app.js):
 *   expenses      v4 — append only → Expenses tab
 *   feed_batches  v5 — append only, one row per batch line → Feed_Batches
 *   kv 'feedPrices'  — last listFeedPrices reply (prices per kg)
 * IDs: E + YYMMDD + -NNN and B + YYMMDD + -NNN, numbered on this phone; if
 * the sheet already has the Expense ID the server adds a letter and app.js
 * calls applyRename.
 *
 * Loaded by index.html before app.js; defines window.MaweExpenses.
 * Expenses.gs EXP_CATEGORIES / EXP_UNITS / EXP_METHODS use the same lists.
 * ===================================================================== */

(() => {
  'use strict';

  const CATEGORIES = Object.freeze([
    { group: 'Feed', items: ['Ready-made dairy meal', 'Dairy meal raw materials', 'Hay (bought)', 'Silage (bought)', 'Napier & fodder (bought)',
      'Calf feeds', 'Minerals & supplements', 'Grinding / milling'] },
    { group: 'Fodder production', items: ['Land preparation & ploughing', 'Tractor hire', 'Seeds & planting materials', 'Fertiliser',
      'Herbicides & pesticides', 'Irrigation', 'Fuel for farm machinery', 'Silage harvesting', 'Chopping & ensiling', 'Silage bags & storage',
      'Hay cutting & baling', 'Napier cutting & chopping', 'Fencing & pasture maintenance'] },
    { group: 'Animal health', items: ['Vet services', 'Drugs & dewormers', 'Acaricides & spraying', 'Vaccines'] },
    { group: 'Breeding', items: ['AI service & semen', 'Animal registration'] },
    { group: 'Animal purchases', items: ['Purchase of dairy cows', 'Purchase of heifers', 'Purchase of calves', 'Animal transportation'] },
    { group: 'Labour', items: ['Salaries & wages', 'Casual labour', 'Salary advance', 'Staff shopping & rations', 'Statutory deductions'] },
    { group: 'Utilities & supplies', items: ['Electricity & solar', 'Water bills', 'Water pumping', 'Internet & telephone', 'Cleaning detergents',
      'Disinfectants', 'Milking & parlour sanitation', 'Office supplies', 'Licences & permits'] },
    { group: 'Repairs & maintenance', items: ['Milking machine repairs', 'Freezer maintenance', 'Chaff cutter maintenance', 'Water pump repairs',
      'Equipment spare parts', 'Building repairs', 'Fencing repairs', 'Plumbing & electrical repairs', 'Milk cans & utensils'] },
    { group: 'Transport & charges', items: ['Boda boda transport', 'Pickup / vehicle hire', 'M-Pesa & bank charges'] },
    { group: 'Other', items: ['Other'] },
  ]);
  /** Capital: kept out of running costs and cost per litre. */
  const CAPITAL_GROUPS = ['Animal purchases'];
  const UNITS = Object.freeze(['kg', 'bags (70 kg)', 'bags (50 kg)', 'bags (90 kg)', 'bags (other)', 'litres', 'bales', 'pieces', 'doses',
    'straws', 'days', 'months', 'acres', 'hours', 'trips', 'other']);
  const KG_PER_UNIT = Object.freeze({ 'kg': 1, 'bags (70 kg)': 70, 'bags (50 kg)': 50, 'bags (90 kg)': 90 });
  const METHODS = Object.freeze(['Cash', 'M-Pesa', 'Bank', 'Other', 'Credit']);
  const PAY_NOW_METHODS = ['Cash', 'M-Pesa', 'Bank', 'Other'];
  const ITEM_REQUIRED = ['Dairy meal raw materials', 'Other'];
  const ANIMAL_GROUPS = ['Animal health', 'Breeding', 'Animal purchases'];
  const CHARGE_CATEGORY = 'M-Pesa & bank charges';

  // Suggestions offered in "What was bought" (any text is allowed).
  const ITEM_HINTS = Object.freeze({
    'Dairy meal raw materials': ['Maize germ', 'Wheat bran', 'Wheat pollard', 'Cotton seed cake', 'Sunflower cake', 'Soya meal', 'Maize', 'Molasses',
      'Fish meal (omena)', 'Limestone', 'Dairy premix', 'Salt'],
    'Ready-made dairy meal': ['Dairy meal'],
    'Hay (bought)': ['Boma Rhodes hay', 'Rhodes hay', 'Lucerne hay'],
    'Silage (bought)': ['Maize silage'],
    'Napier & fodder (bought)': ['Napier', 'Desmodium', 'Sweet potato vines', 'Maize stover'],
    'Grinding / milling': ['Posho mill charge'],
    'Seeds & planting materials': ['Maize seed', 'Napier cuttings', 'Boma Rhodes seed', 'Brachiaria seed', 'Desmodium seed', 'Lucerne seed'],
    'Fertiliser': ['CAN', 'DAP', 'NPK 17:17:17', 'NPK 23:23:0', 'Urea', 'Manure'],
    'Herbicides & pesticides': ['Herbicide', 'Pesticide', 'Fall armyworm spray'],
    'Silage bags & storage': ['Silage tube bags', 'Polythene sheet', 'Molasses for silage'],
    'Salaries & wages': ['Salary'],
    'Casual labour': ['Weeding', 'Planting', 'Harvesting', 'Cutting Napier', 'Silage making'],
    'Staff shopping & rations': ['Monthly shopping', 'Maize flour', 'Sugar', 'Cooking oil'],
    'Statutory deductions': ['NSSF', 'SHIF', 'Housing Levy', 'PAYE'],
    'Boda boda transport': ['Feeds from agrovet', 'Milk delivery', 'Vet / AI technician'],
    'Pickup / vehicle hire': ['Feeds', 'Hay', 'Animal'],
    'Electricity & solar': ['KPLC tokens'],
    'Internet & telephone': ['Airtime', 'Data bundles'],
  });
  // What to put in Quantity, and the usual unit.
  const QTY_HELP = Object.freeze({
    'Casual labour': { unit: 'days', label: 'Worker-days', hint: 'Worker-days = workers × days (3 workers for 2 days = 6). The rate per day is shown.' },
    'Salaries & wages': { unit: 'months', label: 'Quantity (optional)' },
    'Tractor hire': { unit: 'acres', label: 'Acres (optional)' },
    'Land preparation & ploughing': { unit: 'acres', label: 'Acres (optional)' },
    'Hay (bought)': { unit: 'bales', label: 'Bales (optional)' },
    'Hay cutting & baling': { unit: 'bales', label: 'Bales (optional)' },
    'Boda boda transport': { unit: 'trips', label: 'Trips (optional)' },
    'Pickup / vehicle hire': { unit: 'trips', label: 'Trips (optional)' },
    'Ready-made dairy meal': { unit: 'bags (70 kg)', label: 'Quantity (optional)' },
    'AI service & semen': { unit: 'straws', label: 'Straws (optional)' },
  });
  // A line of guidance under the category for the cases that need it.
  const CATEGORY_HINT = Object.freeze({
    'Salary advance': 'Record the advance on the day you pay it. At the end of the month record only the balance under Salaries & wages, so the pay is not counted twice.',
    'Salaries & wages': 'If an advance was paid this month, record only the balance here.',
    'Statutory deductions': 'NSSF, SHIF, Housing Levy, PAYE paid for staff — say which in "What was paid for".',
    'Staff shopping & rations': 'Food or goods bought for staff, monthly or whenever.',
    'Grinding / milling': 'Paying the posho mill. For a dairy meal batch you can record it in Feed batch and tick "also record the payments".',
    'Dairy meal raw materials': 'Choose a bag size (e.g. bags (70 kg)) so the price per kg is known for batch costing. Maize from your own shamba is not an expense: value it in Feed batch.',
    'Animal transportation': 'Transport when buying animals. For moving feed use Boda boda or Pickup hire.',
    'M-Pesa & bank charges': 'Charges on their own. When paying an expense by M-Pesa, you can type its charge in the box under the amount instead.',
  });
  const GROUP_HINT = Object.freeze({
    'Animal purchases': 'Capital: shown apart from running costs, so it does not raise this month\'s cost per litre.',
    'Fodder production': 'Costs of growing your own fodder and maize. They count in feed & fodder cost per litre.',
  });

  const STORE = 'expenses';
  const BATCH_STORE = 'feed_batches';
  const PAYLOAD = Object.freeze({
    [STORE]: ['clientId', 'deviceId', 'expenseId', 'date', 'group', 'category', 'item', 'quantity', 'unit', 'unitPrice', 'amount',
      'paymentMethod', 'receiptRef', 'payee', 'animalId', 'notes', 'recordedBy', 'createdAt', 'paymentStatus', 'amountPaid', 'dueDate'],
    [BATCH_STORE]: ['clientId', 'deviceId', 'batchId', 'date', 'product', 'lineType', 'item', 'source', 'kg', 'pricePerKg', 'cost',
      'batchOutputKg', 'batchTotalCost', 'costPerKg', 'notes', 'recordedBy', 'createdAt'],
  });
  const groupOf = (category) => (CATEGORIES.find((g) => g.items.includes(category)) || {}).group || '';
  const kgPerUnit = (unit) => KG_PER_UNIT[unit] || 0;
  const EXTRA_LINES = Object.freeze([
    { type: 'Grinding', id: 'batch-grinding', category: 'Grinding / milling', item: 'Grinding' },
    { type: 'Labour', id: 'batch-labour', category: 'Casual labour', item: 'Mixing' },
    { type: 'Transport', id: 'batch-transport', category: 'Boda boda transport', item: 'Transport for batch' },
    { type: 'Other', id: 'batch-other', category: 'Other', item: 'Other batch cost' },
  ]);

  function create(deps) {
    const { db, SYNC_STATUS, getSession, getDeviceId, makeUUID, todayLocal, esc, toast, requestSync, saveDebounceMs, isInFlight, callServer } = deps;
    // The "All expenses" view (expense-list.js), if loaded.
    const list = window.MaweExpenseList ? window.MaweExpenseList.create({ ...deps, CATEGORIES, METHODS, UNITS, groupOf }) : null;
    let templates = [];   // regular payments (kv 'expenseTemplates')
    const $ = (s) => document.querySelector(s);
    const $$ = (s) => [...document.querySelectorAll(s)];
    const show = (el, v) => el && el.classList.toggle('hidden', !v);
    const num = (v) => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
    const r2 = (x) => Math.round(x * 100) / 100;
    const money = (x) => 'KES ' + Number(x || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const fmtDate = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString([], { day: 'numeric', month: 'short' }); };

    let rows = [];        // expenses on this phone
    let batchRows = [];   // feed batch lines on this phone
    let animals = [];
    let prices = null;    // last listFeedPrices reply (kv 'feedPrices')

    /* ================= IDs ================= */

    function nextNumbered(list, field, prefix, date) {
      const stem = prefix + date.slice(2, 4) + date.slice(5, 7) + date.slice(8, 10) + '-';
      let max = 0;
      list.forEach((r) => { if (r[field] && r[field].startsWith(stem)) { const n = parseInt(r[field].slice(stem.length), 10); if (n > max) max = n; } });
      return stem + String(max + 1).padStart(3, '0');
    }
    const nextId = (date, extra = []) => nextNumbered(rows.concat(extra), 'expenseId', 'E', date);
    const nextBatchId = (date) => nextNumbered(batchRows, 'batchId', 'B', date);

    function baseRecord() {
      const now = new Date().toISOString();
      const session = getSession();
      return {
        clientId: makeUUID(), deviceId: getDeviceId(), recordedBy: session ? session.email : '', createdAt: now, updatedAt: now,
        syncStatus: SYNC_STATUS.PENDING, syncAttempts: 0, lastError: null, syncedAt: null,
      };
    }

    /* ================= view switch ================= */

    function setView(view) {
      $$('.exp-view-btn').forEach((b) => {
        const on = b.dataset.view === view;
        b.setAttribute('aria-pressed', String(on));
        b.classList.toggle('bg-rose-700', on); b.classList.toggle('text-white', on);
        b.classList.toggle('bg-white', !on); b.classList.toggle('text-rose-800', !on);
      });
      show($('#exp-view-expense'), view === 'expense');
      show($('#exp-view-batch'), view === 'batch');
      show($('#exp-view-list'), view === 'list');
      if (view === 'list' && list) list.show();
      if (view === 'batch') { if (!$('#batch-ings').children.length) { addIngredient(); addIngredient(); } refreshPrices(false); }
    }

    /* ================= expense form ================= */

    function fillStatic() {
      $('#exp-category').innerHTML = '<option value="">Choose…</option>' + CATEGORIES.map((g) =>
        `<optgroup label="${esc(g.group)}">${g.items.map((c) => `<option>${esc(c)}</option>`).join('')}</optgroup>`).join('');
      $('#exp-unit').innerHTML = '<option value="">—</option>' + UNITS.map((u) => `<option>${esc(u)}</option>`).join('');
      $('#exp-method').innerHTML = PAY_NOW_METHODS.map((m) => `<option>${esc(m)}</option>`).join('');
      $('#batch-method').innerHTML = PAY_NOW_METHODS.map((m) => `<option>${esc(m)}</option>`).join('');
    }

    function fillAnimals() {
      const sel = $('#exp-animal');
      const keep = sel.value;
      const list = animals.filter((a) => a.herd !== 'external' && a.status === 'Active').sort((a, b) => a.animalId.localeCompare(b.animalId));
      sel.innerHTML = '<option value="">Whole herd / not for one animal</option>' +
        list.map((a) => `<option value="${esc(a.animalId)}">${esc(a.name)} (${esc(a.animalId)})</option>`).join('');
      if (keep && list.some((a) => a.animalId === keep)) sel.value = keep;
    }

    /** Suggestions: built-in hints + items and payees already used on this phone. */
    function fillSuggestions() {
      const cat = $('#exp-category').value;
      const items = new Set(ITEM_HINTS[cat] || []);
      rows.filter((r) => r.category === cat && r.item).forEach((r) => items.add(r.item));
      $('#exp-item-list').innerHTML = [...items].map((i) => `<option value="${esc(i)}"></option>`).join('');
      const payees = new Set(rows.filter((r) => r.payee).map((r) => r.payee));
      $('#exp-payee-list').innerHTML = [...payees].map((p) => `<option value="${esc(p)}"></option>`).join('');
    }

    /** Category changed: usual unit, labels and guidance. */
    function onCategory() {
      const cat = $('#exp-category').value;
      const help = QTY_HELP[cat];
      if (help && !$('#exp-qty').value) $('#exp-unit').value = help.unit;
      fillSuggestions();
      update();
    }

    /** Salary advances already recorded this month for this payee (on this phone). */
    function advancesThisMonth(payee) {
      const month = ($('#exp-date').value || todayLocal()).slice(0, 7);
      const p = payee.trim().toLowerCase();
      return rows.filter((r) => r.category === 'Salary advance' && r.date && r.date.startsWith(month) && (!p || (r.payee || '').toLowerCase() === p))
        .reduce((t, r) => t + r.amount, 0);
    }

    function update() {
      const cat = $('#exp-category').value;
      const g = groupOf(cat);
      const help = QTY_HELP[cat] || {};
      show($('#exp-animal-wrap'), ANIMAL_GROUPS.includes(g));
      $('#exp-item-label').textContent = ITEM_REQUIRED.includes(cat) ? 'What was bought' : (g === 'Labour' ? 'What for / worker (optional)' : 'What was bought (optional)');
      $('#exp-item').placeholder = g === 'Labour' ? 'e.g. Salary November, worker\'s name' : g === 'Feed' ? 'e.g. Maize germ'
        : g === 'Fodder production' ? 'e.g. CAN, ploughing 2 acres' : g === 'Animal purchases' ? 'e.g. Friesian heifer, 18 months' : 'e.g. what was bought';
      $('#exp-qty-label').textContent = help.label || 'Quantity (optional)';

      // Guidance line.
      let hint = [CATEGORY_HINT[cat], GROUP_HINT[g], help.hint].filter(Boolean).join(' ');
      if (cat === 'Salaries & wages') {
        const adv = advancesThisMonth($('#exp-payee').value);
        if (adv > 0) hint += ` Advances this month${$('#exp-payee').value.trim() ? ' to ' + $('#exp-payee').value.trim() : ''}: ${money(adv)}.`;
      }
      $('#exp-hint').textContent = hint;

      // Price per unit (and per kg for sized bags).
      const amount = num($('#exp-amount').value);
      const qty = num($('#exp-qty').value);
      const unit = $('#exp-unit').value;
      let line = '';
      if (amount > 0 && qty > 0) {
        const per = unit === 'days' ? 'day' : unit.replace(/^bags \(.*\)$/, 'bag').replace(/s$/, '') || 'unit';
        line = `= ${money(r2(amount / qty))} per ${per}`;
        if (kgPerUnit(unit) > 1) line += ` (${money(r2(amount / (qty * kgPerUnit(unit))))} per kg)`;
      }
      $('#exp-unitprice').textContent = line;

      // Last price paid for the same item, as a guide.
      const item = $('#exp-item').value.trim().toLowerCase();
      const last = item && rows.filter((r) => r.item && r.item.toLowerCase() === item && r.unitPrice > 0 && (!unit || r.unit === unit))
        .sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
      $('#exp-lastprice').textContent = last ? `Last time: ${money(last.unitPrice)} per ${last.unit} (${fmtDate(last.date)}${last.payee ? ', ' + last.payee : ''})` : '';

      const method = $('#exp-method').value;
      const pay = $('#exp-paystatus').value;
      show($('#exp-method-wrap'), pay !== 'Unpaid');
      show($('#exp-paidnow-wrap'), pay === 'Part paid');
      show($('#exp-due-wrap'), pay !== 'Paid');
      show($('#exp-ref-wrap'), pay !== 'Unpaid' && method !== 'Cash');
      show($('#exp-charge-wrap'), pay !== 'Unpaid' && (method === 'M-Pesa' || method === 'Bank') && cat !== CHARGE_CATEGORY);
      const paidNow = num($('#exp-paidnow').value);
      $('#exp-owe').textContent = pay === 'Unpaid' && amount > 0 ? `You will owe ${money(amount)}${$('#exp-payee').value.trim() ? ' to ' + $('#exp-payee').value.trim() : ''}. Pay it later in All expenses.`
        : pay === 'Part paid' && amount > 0 && paidNow > 0 && paidNow < amount ? `Balance owed: ${money(r2(amount - paidNow))}.` : '';
    }

    /** Typing a price per unit fills the amount (quantity × price). Typing the amount clears that link. */
    function onUnitPriceInput() {
      const qty = num($('#exp-qty').value);
      const up = num($('#exp-uprice').value);
      $('#exp-uprice').dataset.driver = $('#exp-uprice').value.trim() ? '1' : '0';
      if (qty > 0 && up > 0) $('#exp-amount').value = r2(qty * up);
      update();
    }
    function onQtyInput() {
      if ($('#exp-uprice').dataset.driver === '1') onUnitPriceInput(); else update();
    }
    function onAmountInput() { $('#exp-uprice').dataset.driver = '0'; $('#exp-uprice').value = ''; update(); }

    function setError(sel, msg) { const el = $(sel); el.textContent = msg || ''; show(el, !!msg); }

    function validate() {
      const date = $('#exp-date').value;
      const category = $('#exp-category').value;
      const item = $('#exp-item').value.trim();
      const amount = num($('#exp-amount').value);
      const qtyRaw = $('#exp-qty').value.trim();
      const qty = qtyRaw === '' ? null : num(qtyRaw);
      const unit = $('#exp-unit').value;
      const method = $('#exp-method').value;
      const ref = method === 'Cash' ? '' : $('#exp-ref').value.trim();
      const chargeRaw = $('#exp-charge').value.trim();
      const charge = $('#exp-paystatus').value !== 'Unpaid' && (method === 'M-Pesa' || method === 'Bank') && category !== CHARGE_CATEGORY && chargeRaw !== '' ? num(chargeRaw) : null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'Pick a date.' };
      if (date > todayLocal()) return { error: 'Date cannot be in the future.' };
      if (!groupOf(category)) return { error: 'Choose a category.' };
      if (ITEM_REQUIRED.includes(category) && !item) return { error: 'Say what was bought (e.g. Maize germ).' };
      if (amount === null || amount <= 0) return { error: 'Enter the amount paid.' };
      if (amount > 10000000) return { error: 'Amount looks too high.' };
      if (qtyRaw !== '' && (qty === null || qty <= 0)) return { error: 'Quantity must be a number above 0, or blank.' };
      if (qty !== null && !unit) return { error: 'Choose the unit for the quantity (kg, bags…).' };
      const payStatus = $('#exp-paystatus').value;
      const paidNow = payStatus === 'Part paid' ? num($('#exp-paidnow').value) : null;
      const due = payStatus === 'Paid' ? '' : $('#exp-due').value;
      if (payStatus !== 'Unpaid' && !PAY_NOW_METHODS.includes(method)) return { error: 'Choose how it was paid.' };
      if (payStatus === 'Part paid' && !(paidNow > 0 && paidNow < amount)) return { error: 'Part paid: enter the amount paid now (above 0 and below the total).' };
      if (due && due < date) return { error: 'The due date cannot be before the purchase date.' };
      if (payStatus !== 'Paid' && !$('#exp-payee').value.trim()) return { error: 'Say who you owe (Paid to) for a purchase on credit.' };
      if (chargeRaw !== '' && charge !== null && (charge < 0 || charge > 5000)) return { error: 'Transaction charge should be between 0 and 5,000.' };
      if (chargeRaw !== '' && charge === null && (method === 'M-Pesa' || method === 'Bank') && category !== CHARGE_CATEGORY) return { error: 'Transaction charge must be a number, or blank.' };
      const warnings = [];
      if (payStatus !== 'Unpaid' && method === 'M-Pesa' && !ref) warnings.push('No M-Pesa code entered.');
      if (category === 'Casual labour' && qty === null) warnings.push('No worker-days entered: the rate per day will not be known.');
      if (category === 'Dairy meal raw materials' && unit === 'bags (other)') warnings.push('Bag size unknown: no price per kg for batch costing. Use kg or a bag size if you can.');
      const dup = rows.find((r) => r.date === date && r.category === category && Math.abs(r.amount - amount) < 0.005 &&
        (r.payee || '').toLowerCase() === $('#exp-payee').value.trim().toLowerCase());
      if (dup) warnings.push(`An expense of ${money(amount)} for ${category} on this day is already saved (${dup.expenseId}).`);
      if (category === 'Salaries & wages') {
        const adv = advancesThisMonth($('#exp-payee').value);
        if (adv > 0) warnings.push(`${money(adv)} was paid as an advance this month. Is ${money(amount)} only the balance?`);
      }
      return {
        warnings,
        charge: charge > 0 ? r2(charge) : 0,
        data: {
          date, group: groupOf(category), category, item: item.slice(0, 80), quantity: qty === null ? '' : Math.round(qty * 100) / 100,
          unit: qty === null ? '' : unit, unitPrice: qty ? r2(amount / qty) : '', amount: r2(amount), paymentMethod: payStatus === 'Unpaid' ? 'Credit' : method,
          paymentStatus: payStatus, amountPaid: payStatus === 'Paid' ? r2(amount) : payStatus === 'Unpaid' ? 0 : r2(paidNow), dueDate: due,
          receiptRef: payStatus === 'Unpaid' ? '' : ref.slice(0, 300), payee: $('#exp-payee').value.trim().slice(0, 80),
          animalId: ANIMAL_GROUPS.includes(groupOf(category)) ? $('#exp-animal').value : '', notes: $('#exp-notes').value.trim().slice(0, 300),
        },
      };
    }

    /** The separate charge row for an M-Pesa / bank payment. */
    function chargeRecord(main, charge) {
      return {
        ...baseRecord(), date: main.date, group: groupOf(CHARGE_CATEGORY), category: CHARGE_CATEGORY,
        item: (`${main.paymentMethod} charge: ${main.item || main.category}`).slice(0, 80), quantity: '', unit: '', unitPrice: '', amount: charge,
        paymentMethod: main.paymentMethod, receiptRef: main.receiptRef, payee: main.paymentMethod === 'M-Pesa' ? 'Safaricom' : 'Bank',
        animalId: '', notes: `Charge for ${main.expenseId}`, expenseId: nextId(main.date, [main]),
      };
    }

    async function handleSubmit(e) {
      e.preventDefault();
      setError('#exp-error', '');
      if (!getSession()) { toast('Sign in first', 'error'); return; }
      const v = validate();
      if (v.error) { setError('#exp-error', v.error); return; }
      if (v.warnings.length && !confirm(v.warnings.join('\n') + '\n\nSave anyway?')) return;
      const btn = $('#exp-form button[type="submit"]');
      btn.disabled = true;
      try {
        // Read the receipt first: if the photo cannot be read, nothing is saved.
        const file = $('#exp-receipt').files && $('#exp-receipt').files[0];
        const picked = file && window.MaweExpenseList ? await window.MaweExpenseList.readReceipt(file) : null;
        const rec = { ...baseRecord(), ...v.data, expenseId: nextId(v.data.date), templateId: $('#exp-form').dataset.templateId || '' };
        const recs = [rec];
        if (v.charge > 0) recs.push(chargeRecord(rec, v.charge));
        await db.transaction('rw', db[STORE], () => db[STORE].bulkAdd(recs));
        if (picked && list) await list.queueReceipt(rec.expenseId, picked);
        if ($('#exp-repeat').checked) await saveTemplate(rec);
        $('#exp-form').dataset.templateId = '';
        $('#exp-receipt').value = '';
        $('#exp-repeat').checked = false;
        $('#exp-paystatus').value = 'Paid';
        ['#exp-paidnow', '#exp-due', '#exp-uprice'].forEach((s) => { $(s).value = ''; });
        toast(`Saved: ${rec.category} · ${money(rec.amount)}${v.charge ? ` + charge ${money(v.charge)}` : ''}${rec.paymentStatus !== 'Paid' ? ` · owed ${money(r2(rec.amount - rec.amountPaid))}` : ''}${picked ? ' · receipt attached' : ''}`);
        ['#exp-item', '#exp-amount', '#exp-qty', '#exp-ref', '#exp-notes', '#exp-charge'].forEach((s) => { $(s).value = ''; });
        $('#exp-unit').value = (QTY_HELP[rec.category] || {}).unit || '';
        $('#exp-animal').value = '';
        update();
        $('#exp-amount').focus();
        requestSync('new-record', saveDebounceMs);
      } catch (err) {
        setError('#exp-error', 'Could not save on this phone: ' + (err.message || err));
      } finally {
        btn.disabled = false;
      }
    }

    /* ================= recent expenses ================= */

    const CHIP = {
      pending: '<span class="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-calf-100 text-calf-700">Pending</span>',
      failed: '<span class="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-red-100 text-red-700">Retrying</span>',
      synced: '<span class="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-farm-100 text-farm-800">Synced</span>',
    };

    function render() {
      const list = rows.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || String(b.expenseId).localeCompare(String(a.expenseId))).slice(0, 8);
      $('#exp-recent').innerHTML = list.length ? list.map((r) => `
        <li class="flex items-center justify-between gap-3 bg-white rounded-xl px-4 py-3 shadow-sm">
          <div class="min-w-0">
            <p class="font-semibold text-sm truncate">${esc(r.item || r.category)} · ${money(r.amount)}</p>
            <p class="text-xs text-slate-500 truncate">${esc(fmtDate(r.date))} · ${esc(r.category)}${r.quantity ? ` · ${r.quantity} ${esc(r.unit)}` : ''}${r.payee ? ' · ' + esc(r.payee) : ''}</p>
            ${r.paymentStatus && r.paymentStatus !== 'Paid' ? `<p class="text-xs text-red-700">${r.paymentStatus === 'Unpaid' ? 'On credit' : 'Part paid'}: owed ${money(r2(r.amount - (r.amountPaid || 0)))}</p>` : ''}
            ${r.syncStatus === SYNC_STATUS.FAILED && r.lastError ? `<p class="text-xs text-red-600">${esc(r.lastError)}</p>` : ''}
          </div>
          <div class="flex items-center gap-2 shrink-0">${CHIP[r.syncStatus] || ''}
            ${r.syncStatus !== SYNC_STATUS.SYNCED ? `<button type="button" class="exp-del text-slate-400 hover:text-red-600 text-lg leading-none px-1" data-id="${r.id}" aria-label="Delete entry">&times;</button>` : ''}
          </div>
        </li>`).join('') : '<li class="text-sm text-slate-400 px-1">No expenses on this phone yet.</li>';

      // This month on this phone (synced entries are kept 30 days, so treat it as a guide).
      const month = todayLocal().slice(0, 7);
      const mine = rows.filter((r) => r.date && r.date.startsWith(month));
      const running = mine.filter((r) => !CAPITAL_GROUPS.includes(r.group));
      const capital = mine.filter((r) => CAPITAL_GROUPS.includes(r.group)).reduce((t, r) => t + r.amount, 0);
      const byG = {};
      running.forEach((r) => { byG[r.group] = (byG[r.group] || 0) + r.amount; });
      const total = running.reduce((t, r) => t + r.amount, 0);
      $('#exp-month').textContent = mine.length
        ? `This month on this phone: running costs ${money(total)} — ` + Object.keys(byG).sort((a, b) => byG[b] - byG[a]).map((g) => `${g} ${money(byG[g])}`).join(', ') +
          (capital ? `. Animal purchases (capital): ${money(capital)}.` : '')
        : 'Nothing recorded this month yet. Full totals: Reports tab → Expenses.';
    }

    async function handleListClick(e) {
      const b = e.target.closest('.exp-del');
      if (!b) return;
      const id = Number(b.dataset.id);
      if (!confirm('Delete this expense from the phone? It has not been uploaded yet.')) return;
      if (isInFlight(STORE, id)) { toast('Uploading right now. Try again in a moment.', 'error'); return; }
      const rec = await db[STORE].get(id);
      if (!rec || rec.syncStatus === SYNC_STATUS.SYNCED) { toast('Already in Google Sheets: correct it there.', 'error'); return; }
      await db[STORE].delete(id);
      toast('Expense deleted', 'info');
    }

    /** The server gave a different Expense ID (it was taken). */
    async function applyRename(storeName, rec, renamed) {
      if (storeName !== STORE || !renamed || !renamed.value) return;
      const old = rec.expenseId;
      await db[STORE].update(rec.id, { expenseId: renamed.value });
      rec.expenseId = renamed.value;
      // Receipts and payments waiting for this expense follow the new ID.
      if (window.MaweExpenseList) {
        await db[window.MaweExpenseList.RECEIPT_STORE].where('expenseId').equals(old).modify({ expenseId: renamed.value });
        await db[window.MaweExpenseList.PAY_STORE].where('expenseId').equals(old).modify({ expenseId: renamed.value });
      }
      toast(`${old} was already used: saved as ${renamed.value}`, 'info');
    }

    /** Payment IDs (EP…) renamed by the server. */
    async function applyPaymentRename(rec, renamed) {
      await db[window.MaweExpenseList.PAY_STORE].update(rec.id, { paymentId: renamed.value });
    }

    /* ================= regular payments (recurring) ================= */

    async function loadTemplates() {
      const x = await db.kv.get('expenseTemplates').catch(() => null);
      templates = (x && Array.isArray(x.value)) ? x.value : [];
      renderTemplates();
    }
    async function storeTemplates() { await db.kv.put({ key: 'expenseTemplates', value: templates }); renderTemplates(); }

    async function saveTemplate(rec) {
      const t = { id: makeUUID(), category: rec.category, item: rec.item, amount: rec.amount, payee: rec.payee, paymentMethod: rec.paymentMethod === 'Credit' ? 'Cash' : rec.paymentMethod,
        quantity: rec.quantity, unit: rec.unit, day: Number(rec.date.slice(8, 10)), createdAt: new Date().toISOString() };
      templates = templates.filter((x) => !(x.category === t.category && x.payee === t.payee && x.item === t.item)).concat([t]);
      await storeTemplates();
      // This month's record counts as done.
      await db[STORE].where('clientId').equals(rec.clientId).modify({ templateId: t.id });
    }

    /** Regular payments not yet recorded this month (on this phone). */
    function dueTemplates() {
      const month = todayLocal().slice(0, 7);
      return templates.filter((t) => !rows.some((r) => r.date && r.date.startsWith(month) && (r.templateId === t.id ||
        (r.category === t.category && (r.payee || '') === (t.payee || '') && (r.item || '') === (t.item || '')))));
    }

    function renderTemplates() {
      const el = $('#exp-recurring');
      if (!el) return;
      const due = dueTemplates();
      show(el, templates.length > 0);
      el.innerHTML = templates.length ? `<h3 class="text-sm font-semibold text-slate-600 mb-2">Regular payments ${due.length ? `<span class="text-rose-700">· ${due.length} due this month</span>` : '· all recorded this month ✓'}</h3>
        <ul class="space-y-1">${templates.map((t) => {
          const isDue = due.includes(t);
          return `<li class="flex items-center justify-between gap-2 text-sm">
            <span class="min-w-0 truncate ${isDue ? '' : 'text-slate-400'}">${esc(t.item || t.category)}${t.payee ? ' · ' + esc(t.payee) : ''} · ${money(t.amount)} <span class="text-xs">(around day ${t.day})</span></span>
            <span class="flex gap-2 shrink-0">${isDue ? `<button type="button" class="exp-tpl-use text-xs font-semibold bg-rose-700 text-white rounded-lg px-2 py-1" data-id="${t.id}">Record</button>` : ''}
            <button type="button" class="exp-tpl-del text-slate-400 hover:text-red-600 text-lg leading-none px-1" data-id="${t.id}" aria-label="Stop this regular payment">&times;</button></span></li>`;
        }).join('')}</ul>` : '';
    }

    function useTemplate(id) {
      const t = templates.find((x) => x.id === id);
      if (!t) return;
      $('#exp-date').value = todayLocal();
      $('#exp-category').value = t.category;
      onCategory();
      $('#exp-item').value = t.item || '';
      $('#exp-qty').value = t.quantity || '';
      $('#exp-unit').value = t.unit || '';
      $('#exp-amount').value = t.amount;
      $('#exp-payee').value = t.payee || '';
      $('#exp-method').value = PAY_NOW_METHODS.includes(t.paymentMethod) ? t.paymentMethod : 'Cash';
      $('#exp-paystatus').value = 'Paid';
      $('#exp-form').dataset.templateId = t.id;
      update();
      $('#exp-amount').focus();
      toast('Check the amount, then Save', 'info');
    }

    async function handleTemplateClick(e) {
      const use = e.target.closest('.exp-tpl-use');
      if (use) { useTemplate(use.dataset.id); return; }
      const del = e.target.closest('.exp-tpl-del');
      if (del && confirm('Stop offering this regular payment? (Expenses already recorded stay.)')) {
        templates = templates.filter((t) => t.id !== del.dataset.id);
        await storeTemplates();
      }
    }

    /* ================= feed prices ================= */

    /** Price per kg of bought feed items from this phone's own expenses (fallback when offline). */
    function localPurchased() {
      const by = {};
      rows.filter((r) => groupOf(r.category) === 'Feed' && r.quantity > 0 && kgPerUnit(r.unit)).forEach((r) => {
        const k = (r.item || r.category).trim().toLowerCase();
        const x = by[k] || (by[k] = { item: r.item || r.category, kg: 0, spent: 0, lastDate: '', category: r.category });
        x.kg += r.quantity * kgPerUnit(r.unit); x.spent += r.amount;
        if (r.date > x.lastDate) x.lastDate = r.date;
      });
      return Object.values(by).map((x) => ({ item: x.item, pricePerKg: r2(x.spent / x.kg), lastDate: x.lastDate, category: x.category }));
    }

    /** Merge server prices with this phone's: { purchased: Map, own: Map, readyMadePerKg, products } (keys lower-case). */
    function priceBook() {
      const purchased = new Map();
      ((prices && prices.purchased) || []).forEach((p) => purchased.set(p.item.toLowerCase(), p));
      localPurchased().forEach((p) => {
        const s = purchased.get(p.item.toLowerCase());
        if (!s || p.lastDate > s.lastDate) purchased.set(p.item.toLowerCase(), { ...p, local: true });
      });
      const own = new Map();
      ((prices && prices.own) || []).forEach((o) => own.set(o.item.toLowerCase(), o));
      batchRows.filter((l) => l.lineType === 'Ingredient' && l.source === 'Own produce').sort((a, b) => String(a.date).localeCompare(String(b.date)))
        .forEach((l) => { const s = own.get(l.item.toLowerCase()); if (!s || l.date >= s.date) own.set(l.item.toLowerCase(), { item: l.item, pricePerKg: l.pricePerKg, date: l.date }); });
      let ready = prices && typeof prices.readyMadePerKg === 'number' ? prices.readyMadePerKg : null;
      const localReady = localPurchased().filter((p) => p.category === 'Ready-made dairy meal');
      if (ready === null && localReady.length) ready = localReady[0].pricePerKg;
      const products = new Set(['Dairy meal (home mix)', 'Calf meal', ...((prices && prices.products) || []), ...batchRows.map((l) => l.product)]);
      return { purchased, own, readyMadePerKg: ready, products: [...products].filter(Boolean) };
    }

    /** Download the latest prices (listFeedPrices) into kv. Quiet unless asked. */
    async function refreshPrices(loud) {
      if (!callServer || !navigator.onLine || !getSession()) { if (loud) toast('Prices update when online and signed in', 'info'); return false; }
      try {
        const data = await callServer({ action: 'listFeedPrices' });
        if (!Array.isArray(data.purchased)) throw new Error('reply has no price list');
        prices = { purchased: data.purchased, own: data.own || [], readyMadePerKg: data.readyMadePerKg, products: data.products || [], serverTime: data.serverTime };
        await db.kv.put({ key: 'feedPrices', value: prices });
        fillBatchLists(); updateBatch();
        if (loud) toast('Feed prices updated', 'info');
        return true;
      } catch (err) {
        if (loud) toast('Could not update prices: ' + (err.message || err), 'error');
        return false;
      }
    }

    /* ================= feed batch form ================= */

    let ingSeq = 0;
    function addIngredient(pref = {}) {
      const i = ++ingSeq;
      const li = document.createElement('li');
      li.className = 'batch-ing grid grid-cols-12 gap-2 items-end bg-amber-50/60 rounded-xl p-2';
      li.innerHTML = `
        <div class="col-span-7"><label class="hf-label" for="ing-item-${i}">Ingredient</label>
          <input id="ing-item-${i}" class="hf-input ing-item" list="batch-ing-list" maxlength="80" placeholder="e.g. Maize" value="${esc(pref.item || '')}" /></div>
        <div class="col-span-5"><label class="hf-label" for="ing-src-${i}">Source</label>
          <select id="ing-src-${i}" class="hf-input ing-src"><option value="Bought">Bought</option><option value="Own produce">From my farm</option></select></div>
        <div class="col-span-4"><label class="hf-label" for="ing-kg-${i}">Kg used</label>
          <input id="ing-kg-${i}" class="hf-input ing-kg" type="number" min="0" step="0.1" inputmode="decimal" value="${pref.kg ?? ''}" /></div>
        <div class="col-span-4"><label class="hf-label" for="ing-price-${i}">KES per kg</label>
          <input id="ing-price-${i}" class="hf-input ing-price" type="number" min="0" step="0.01" inputmode="decimal" value="${pref.pricePerKg ?? ''}" /></div>
        <div class="col-span-3 pb-2 text-right text-sm font-semibold text-amber-900 ing-cost"></div>
        <button type="button" class="col-span-1 pb-2 ing-del text-slate-400 hover:text-red-600 text-lg leading-none" aria-label="Remove ingredient">&times;</button>
        <p class="col-span-12 -mt-1 text-[11px] text-slate-500 ing-note empty:hidden"></p>`;
      if (pref.source) li.querySelector('.ing-src').value = pref.source;
      $('#batch-ings').appendChild(li);
      updateBatch();
      return li;
    }

    /** Ingredient name / source changed: prefill the price per kg if it is empty or was prefilled. */
    function prefillPrice(li) {
      const book = priceBook();
      const item = li.querySelector('.ing-item').value.trim().toLowerCase();
      const src = li.querySelector('.ing-src').value;
      const priceEl = li.querySelector('.ing-price');
      const note = li.querySelector('.ing-note');
      if (!item) { note.textContent = ''; return; }
      const hit = src === 'Own produce' ? book.own.get(item) : book.purchased.get(item);
      if (hit && (priceEl.value === '' || priceEl.dataset.auto === '1')) { priceEl.value = hit.pricePerKg; priceEl.dataset.auto = '1'; }
      if (src === 'Own produce') {
        note.textContent = hit ? `Last value used: ${money(hit.pricePerKg)}/kg (${fmtDate(hit.date)}). Use today's farm-gate price, e.g. KES 4,000 per 90 kg bag = KES 44.44/kg.`
          : 'Enter what it would sell for at the farm gate today, per kg (90 kg bag price ÷ 90). Not an expense: its growing costs already are.';
      } else {
        note.textContent = hit ? `From ${hit.local ? 'this phone\'s' : 'recent'} purchases: ${money(hit.pricePerKg)}/kg${hit.lastDate ? ', last bought ' + fmtDate(hit.lastDate) : ''}.`
          : 'No purchase with a kg or bag size found for this name: type the price per kg.';
      }
    }

    function fillBatchLists() {
      const book = priceBook();
      const names = new Set([...book.purchased.values()].map((p) => p.item).concat([...book.own.values()].map((o) => o.item),
        ITEM_HINTS['Dairy meal raw materials'], ['Maize (own)']));
      $('#batch-ing-list').innerHTML = [...names].map((n) => `<option value="${esc(n)}"></option>`).join('');
      $('#batch-product-list').innerHTML = book.products.map((n) => `<option value="${esc(n)}"></option>`).join('');
    }

    function readBatch() {
      const ings = $$('.batch-ing').map((li) => ({
        li, item: li.querySelector('.ing-item').value.trim(), source: li.querySelector('.ing-src').value,
        kg: num(li.querySelector('.ing-kg').value), pricePerKg: num(li.querySelector('.ing-price').value),
      })).filter((x) => x.item || x.kg !== null || x.pricePerKg !== null);
      const extras = EXTRA_LINES.map((x) => ({ ...x, cost: num($('#' + x.id).value) || 0 }));
      const ingKg = ings.reduce((t, x) => t + (x.kg || 0), 0);
      const ingCost = ings.reduce((t, x) => t + (x.kg > 0 && x.pricePerKg >= 0 ? r2(x.kg * x.pricePerKg) : 0), 0);
      const extraCost = extras.reduce((t, x) => t + x.cost, 0);
      const outRaw = $('#batch-output').value.trim();
      const outputKg = outRaw === '' ? ingKg : num(outRaw);
      const total = r2(ingCost + extraCost);
      return { ings, extras, ingKg, ingCost: r2(ingCost), extraCost: r2(extraCost), total, outputKg, outRaw,
        costPerKg: outputKg > 0 ? r2(total / outputKg) : null,
        own: r2(ings.filter((x) => x.source === 'Own produce').reduce((t, x) => t + (x.kg > 0 && x.pricePerKg >= 0 ? x.kg * x.pricePerKg : 0), 0)) };
    }

    function updateBatch() {
      const b = readBatch();
      b.ings.forEach((x) => { x.li.querySelector('.ing-cost').textContent = x.kg > 0 && x.pricePerKg >= 0 ? money(r2(x.kg * x.pricePerKg)).replace('KES ', '') : ''; });
      $$('.batch-ing').forEach((li) => { if (!b.ings.some((x) => x.li === li)) li.querySelector('.ing-cost').textContent = ''; });
      $('#batch-output').placeholder = b.ingKg > 0 ? `${Math.round(b.ingKg * 10) / 10} (ingredients)` : 'kg';
      const ready = priceBook().readyMadePerKg;
      const el = $('#batch-summary');
      if (!(b.total > 0) || !(b.outputKg > 0)) { el.innerHTML = '<p class="text-slate-500">Add ingredients with kg and price per kg to see the cost.</p>'; return; }
      const bag = r2(b.costPerKg * 70);
      let cmp = '<p class="text-xs text-slate-500">Record ready-made dairy meal purchases (bags (70 kg)) to compare with buying.</p>';
      if (ready > 0) {
        const diff = r2((ready - b.costPerKg) * 70);
        cmp = `<p class="${diff >= 0 ? 'text-farm-800' : 'text-red-700'} font-semibold">Ready-made: ${money(r2(ready * 70))} per 70 kg bag — ${diff >= 0 ? 'you save' : 'home mix costs'} ${money(Math.abs(diff))} per bag${diff >= 0 ? '' : ' more'}.</p>`;
      }
      el.innerHTML = `
        <div class="grid grid-cols-2 gap-x-3 gap-y-1">
          <span class="text-slate-500">Ingredients (${Math.round(b.ingKg * 10) / 10} kg)</span><span class="text-right">${money(b.ingCost)}</span>
          ${b.own > 0 ? `<span class="text-slate-500 pl-3">of which from my farm</span><span class="text-right text-slate-500">${money(b.own)}</span>` : ''}
          <span class="text-slate-500">Grinding, labour, transport, other</span><span class="text-right">${money(b.extraCost)}</span>
          <span class="font-semibold">Total for ${Math.round(b.outputKg * 10) / 10} kg</span><span class="text-right font-semibold">${money(b.total)}</span>
        </div>
        <p class="mt-2 text-lg font-bold text-amber-900">${money(b.costPerKg)} per kg · ${money(bag)} per 70 kg bag</p>${cmp}`;
    }

    function validateBatch() {
      const date = $('#batch-date').value;
      const product = $('#batch-product').value.trim();
      const b = readBatch();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'Pick the date the batch was made.' };
      if (date > todayLocal()) return { error: 'Date cannot be in the future.' };
      if (!product) return { error: 'Name the product (e.g. Dairy meal (home mix)).' };
      if (!b.ings.length) return { error: 'Add at least one ingredient.' };
      for (const x of b.ings) {
        if (!x.item) return { error: 'Every ingredient needs a name.' };
        if (!(x.kg > 0)) return { error: `Enter the kg of ${x.item} used.` };
        if (x.pricePerKg === null || x.pricePerKg < 0) return { error: `Enter the price per kg of ${x.item} (0 if it cost nothing).` };
      }
      if (b.outRaw !== '' && !(b.outputKg > 0)) return { error: 'Output must be the kg of feed made, or blank to use the ingredients\' total.' };
      if (b.extras.some((x) => x.cost < 0)) return { error: 'Costs cannot be negative.' };
      const warnings = [];
      if (b.outputKg > b.ingKg * 1.05) warnings.push(`Output ${b.outputKg} kg is more than the ingredients (${Math.round(b.ingKg * 10) / 10} kg).`);
      const own0 = b.ings.find((x) => x.source === 'Own produce' && x.pricePerKg === 0);
      if (own0) warnings.push(`${own0.item} from your farm is valued at 0: the cost per kg will look lower than it really is.`);
      return { date, product, b, warnings };
    }

    async function handleBatchSubmit(e) {
      e.preventDefault();
      setError('#batch-error', '');
      if (!getSession()) { toast('Sign in first', 'error'); return; }
      const v = validateBatch();
      if (v.error) { setError('#batch-error', v.error); return; }
      if (v.warnings.length && !confirm(v.warnings.join('\n') + '\n\nSave anyway?')) return;
      const { date, product, b } = v;
      const btn = $('#batch-form button[type="submit"]');
      btn.disabled = true;
      try {
        const batchId = nextBatchId(date);
        const notes = $('#batch-notes').value.trim().slice(0, 300);
        const common = { batchId, date, product: product.slice(0, 60), batchOutputKg: Math.round(b.outputKg * 10) / 10, batchTotalCost: b.total, notes };
        common.costPerKg = r2(b.total / common.batchOutputKg);
        const lines = b.ings.map((x) => ({ ...baseRecord(), ...common, lineType: 'Ingredient', item: x.item.slice(0, 80), source: x.source,
          kg: Math.round(x.kg * 100) / 100, pricePerKg: r2(x.pricePerKg), cost: r2(Math.round(x.kg * 100) / 100 * r2(x.pricePerKg)) }));
        // Ingredient costs are rounded per line: keep the total equal to their sum.
        const fix = r2(lines.reduce((t, l) => t + l.cost, 0) + b.extraCost);
        lines.forEach((l) => { l.batchTotalCost = fix; l.costPerKg = r2(fix / common.batchOutputKg); });
        b.extras.filter((x) => x.cost > 0).forEach((x) => lines.push({ ...baseRecord(), ...common, batchTotalCost: fix, costPerKg: r2(fix / common.batchOutputKg),
          lineType: x.type, item: x.item, source: '', kg: '', pricePerKg: '', cost: r2(x.cost) }));

        // Optionally also record the cash paid out for grinding / labour / transport / other as expenses.
        const exp = [];
        if ($('#batch-also-exp').checked) {
          const method = $('#batch-method').value;
          b.extras.filter((x) => x.cost > 0).forEach((x) => {
            const r = { ...baseRecord(), date, group: groupOf(x.category), category: x.category, item: `${x.item} (${batchId})`.slice(0, 80),
              quantity: '', unit: '', unitPrice: '', amount: r2(x.cost), paymentMethod: method, receiptRef: '', payee: '', animalId: '', notes: `Feed batch ${batchId}` };
            r.expenseId = nextId(date, exp);
            exp.push(r);
          });
        }
        await db.transaction('rw', db[BATCH_STORE], db[STORE], async () => {
          await db[BATCH_STORE].bulkAdd(lines);
          if (exp.length) await db[STORE].bulkAdd(exp);
        });
        toast(`Batch ${batchId}: ${money(lines[0].costPerKg)}/kg${exp.length ? ` · ${exp.length} expense${exp.length > 1 ? 's' : ''} recorded` : ''}`);
        $('#batch-ings').innerHTML = '';
        EXTRA_LINES.forEach((x) => { $('#' + x.id).value = ''; });
        ['#batch-output', '#batch-notes'].forEach((s) => { $(s).value = ''; });
        // Start the next batch with the same ingredients and prices (most batches repeat the recipe).
        b.ings.forEach((x) => addIngredient({ item: x.item, source: x.source, kg: x.kg, pricePerKg: x.pricePerKg }));
        updateBatch();
        requestSync('new-record', saveDebounceMs);
      } catch (err) {
        setError('#batch-error', 'Could not save on this phone: ' + (err.message || err));
      } finally {
        btn.disabled = false;
      }
    }

    function renderBatches() {
      const by = new Map();
      batchRows.forEach((l) => { const k = l.batchId; if (!by.has(k)) by.set(k, { ...l, lines: [] }); by.get(k).lines.push(l); });
      const list = [...by.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 6);
      $('#batch-recent').innerHTML = list.length ? list.map((b) => {
        const st = b.lines.some((l) => l.syncStatus === SYNC_STATUS.FAILED) ? 'failed' : b.lines.every((l) => l.syncStatus === SYNC_STATUS.SYNCED) ? 'synced' : 'pending';
        const err = b.lines.find((l) => l.lastError && l.syncStatus === SYNC_STATUS.FAILED);
        const ings = b.lines.filter((l) => l.lineType === 'Ingredient').map((l) => `${l.item} ${l.kg} kg`).join(', ');
        return `<li class="flex items-center justify-between gap-3 bg-white rounded-xl px-4 py-3 shadow-sm">
          <div class="min-w-0">
            <p class="font-semibold text-sm truncate">${esc(b.product)} · ${b.batchOutputKg} kg · ${money(b.costPerKg)}/kg</p>
            <p class="text-xs text-slate-500 truncate">${esc(fmtDate(b.date))} · ${esc(b.batchId)} · ${esc(ings)}</p>
            ${err ? `<p class="text-xs text-red-600">${esc(err.lastError)}</p>` : ''}
          </div>
          <div class="flex items-center gap-2 shrink-0">${CHIP[st]}
            ${st !== 'synced' ? `<button type="button" class="batch-del text-slate-400 hover:text-red-600 text-lg leading-none px-1" data-batch="${esc(b.batchId)}" aria-label="Delete batch">&times;</button>` : ''}
          </div></li>`;
      }).join('') : '<li class="text-sm text-slate-400 px-1">No batches on this phone yet.</li>';
    }

    async function handleBatchListClick(e) {
      const btn = e.target.closest('.batch-del');
      if (!btn) return;
      const id = btn.dataset.batch;
      const lines = batchRows.filter((l) => l.batchId === id);
      if (lines.some((l) => l.syncStatus === SYNC_STATUS.SYNCED)) { toast('Part of this batch is already in Google Sheets: correct it there.', 'error'); return; }
      if (lines.some((l) => isInFlight(BATCH_STORE, l.id))) { toast('Uploading right now. Try again in a moment.', 'error'); return; }
      if (!confirm(`Delete batch ${id} from the phone? (Any expenses it recorded stay: delete them in the Expense view.)`)) return;
      await db[BATCH_STORE].bulkDelete(lines.map((l) => l.id));
      toast('Batch deleted', 'info');
    }

    /* ================= init ================= */

    function init() {
      fillStatic();
      const t = todayLocal();
      ['#exp-date', '#batch-date'].forEach((s) => { $(s).value = t; $(s).max = t; });
      $$('.exp-view-btn').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
      $('#exp-form').addEventListener('submit', handleSubmit);
      $('#exp-category').addEventListener('change', onCategory);
      ['#exp-item', '#exp-payee', '#exp-paidnow'].forEach((s) => $(s).addEventListener('input', update));
      $('#exp-amount').addEventListener('input', onAmountInput);
      $('#exp-qty').addEventListener('input', onQtyInput);
      $('#exp-uprice').addEventListener('input', onUnitPriceInput);
      ['#exp-unit', '#exp-method', '#exp-date', '#exp-paystatus'].forEach((s) => $(s).addEventListener('change', update));
      $('#exp-recurring').addEventListener('click', handleTemplateClick);
      if (list) list.init();
      loadTemplates();
      $('#exp-recent').addEventListener('click', handleListClick);

      $('#batch-form').addEventListener('submit', handleBatchSubmit);
      $('#batch-add-ing').addEventListener('click', () => addIngredient().querySelector('.ing-item').focus());
      $('#batch-ings').addEventListener('input', (e) => {
        const li = e.target.closest('.batch-ing');
        if (e.target.classList.contains('ing-price')) e.target.dataset.auto = '0';
        if (li && e.target.classList.contains('ing-item')) prefillPrice(li);
        updateBatch();
      });
      $('#batch-ings').addEventListener('change', (e) => {
        const li = e.target.closest('.batch-ing');
        if (li && (e.target.classList.contains('ing-src') || e.target.classList.contains('ing-item'))) { prefillPrice(li); updateBatch(); }
      });
      $('#batch-ings').addEventListener('click', (e) => { const d = e.target.closest('.ing-del'); if (d) { d.closest('.batch-ing').remove(); updateBatch(); } });
      ['#batch-output', ...EXTRA_LINES.map((x) => '#' + x.id)].forEach((s) => $(s).addEventListener('input', updateBatch));
      $('#batch-also-exp').addEventListener('change', () => show($('#batch-method-wrap'), $('#batch-also-exp').checked));
      $('#batch-refresh').addEventListener('click', () => refreshPrices(true));
      $('#batch-recent').addEventListener('click', handleBatchListClick);

      Dexie.liveQuery(() => db[STORE].toArray()).subscribe({
        next: (r) => { rows = r; render(); fillSuggestions(); update(); fillBatchLists(); renderTemplates(); },
        error: (e) => console.error('Expenses query failed:', e),
      });
      Dexie.liveQuery(() => db[BATCH_STORE].toArray()).subscribe({
        next: (r) => { batchRows = r; renderBatches(); fillBatchLists(); },
        error: (e) => console.error('Batch query failed:', e),
      });
      Dexie.liveQuery(() => db.animals.toArray()).subscribe({ next: (a) => { animals = a; fillAnimals(); } });
      db.kv.get('feedPrices').then((x) => { if (x && x.value) { prices = x.value; fillBatchLists(); updateBatch(); } }).catch(() => {});
      setView('expense');
      update();
    }

    /** For app.js: corrections and receipts upload after the append stores. */
    const syncExtras = () => (list ? list.syncExtras() : Promise.resolve({ uploaded: 0, rejected: 0 }));
    const countPendingExtras = () => (list ? list.countPending() : Promise.resolve(0));

    return Object.freeze({ init, applyRename, applyPaymentRename, nextId, refreshPrices, syncExtras, countPendingExtras });
  }

  window.MaweExpenses = Object.freeze({ create, STORE, BATCH_STORE, PAYLOAD, CATEGORIES, CAPITAL_GROUPS, UNITS, METHODS, groupOf });
})();
