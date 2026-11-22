/* =====================================================================
 * Mawe Tatu Dairy — reports.js (Reports screen)
 * ---------------------------------------------------------------------
 * Reports for dates you choose, shown on screen and downloaded as an
 * Excel (.xlsx) or PDF file:
 *   • Customer sales — one customer or all, From … To: opening balance,
 *     deliveries, returns, payments, running balance, amount due.
 *   • Milk output — one cow or all, From … To, by day / week / month:
 *     litres per session, totals, average per day, per-cow totals, and
 *     the lactations in the period (total and average per day).
 *   • Expenses — all or one group, From … To: totals by group and
 *     category, every expense, and (for all) milk sales, profit and
 *     cost per litre over the same dates.
 *
 * The full history lives in Google Sheets (the phone keeps only 30 days),
 * so reports need internet. The data comes from PeriodReports.gs:
 *   { action: 'customerPeriodReport', customerId, from, to }
 *   { action: 'milkPeriodReport', cowId, from, to, groupBy }
 *   { action: 'expensePeriodReport', from, to, group, groupBy: day|week|month|year }   (Expenses.gs)
 *
 * The Excel and PDF libraries are big, so they are downloaded only the
 * first time a file is made (internet is on anyway), not at app start:
 *   SheetJS  xlsx@0.18.5          (Excel)
 *   jsPDF    jspdf@2.5.1 + jspdf-autotable@3.8.2  (PDF)
 *
 * Loaded by index.html before app.js; defines window.MaweReports.
 * app.js calls MaweReports.create(deps) and then init().
 * ===================================================================== */

(() => {
  'use strict';

  const LIBS = Object.freeze({
    xlsx: 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
    jspdf: 'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js',
    autotable: 'https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js',
  });
  const FARM = 'MAWE TATU FARM';
  const GREEN = [22, 101, 52];

  function create(deps) {
    const { db, callServer, requestSignIn, getSession, todayLocal, esc, toast } = deps;
    const $ = (s) => document.querySelector(s);
    const show = (el, v) => el && el.classList.toggle('hidden', !v);

    let view = 'sales';
    let current = { sales: null, milk: null, expenses: null };   // last report data per view
    const loaded = {};

    /* ---------------- helpers ---------------- */

    const money = (x) => Number(x || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const fmtDate = (k) => (k ? `${Number(k.slice(8, 10))} ${MONTHS[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}` : '');
    const toDate = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
    const safeName = (s) => String(s).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'report';
    /** Plain-ASCII text for the PDF's built-in font. */
    const ascii = (s) => String(s ?? '').replace(/[–—]/g, '-').replace(/[·•]/g, '-').replace(/×/g, 'x').replace(/[^\x20-\x7E]/g, '');

    function firstOfMonth() { const t = todayLocal(); return t.slice(0, 8) + '01'; }

    function loadScript(url) {
      if (loaded[url]) return loaded[url];
      loaded[url] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = url;
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => { delete loaded[url]; reject(new Error('Could not download the file maker. Check the internet connection and try again.')); };
        document.head.appendChild(s);
      });
      return loaded[url];
    }

    function setMsg(kind, text) {
      const el = $('#rep-' + kind);
      el.textContent = text || '';
      show(el, !!text);
    }

    function setBusy(on, text) {
      $('#rep-run').disabled = on;
      document.querySelectorAll('.rep-dl').forEach((b) => { b.disabled = on || !current[view]; });
      setMsg('status', on ? text : '');
    }

    /* ---------------- choices ---------------- */

    async function fillChoices() {
      const custSel = $('#rep-customer');
      const cowSel = $('#rep-cow');
      const keepC = custSel.value;
      const keepW = cowSel.value;
      const customers = (await db.customers.toArray()).sort((a, b) => a.name.localeCompare(b.name));
      custSel.innerHTML = '<option value="ALL">All customers</option>' +
        customers.map((c) => `<option value="${esc(c.customerId)}">${esc(c.name)}${c.status === 'Inactive' ? ' (inactive)' : ''}</option>`).join('');
      if (keepC && [...custSel.options].some((o) => o.value === keepC)) custSel.value = keepC;
      const animals = (await db.animals.toArray())
        .filter((a) => a.herd !== 'external' && a.sex === 'Female')
        .sort((a, b) => a.animalId.localeCompare(b.animalId));
      cowSel.innerHTML = '<option value="ALL">All cows</option>' +
        animals.map((a) => `<option value="${esc(a.animalId)}">${esc(a.name)} (${esc(a.animalId)})${a.status !== 'Active' ? ' – ' + esc(a.status) : ''}</option>`).join('');
      if (keepW && [...cowSel.options].some((o) => o.value === keepW)) cowSel.value = keepW;
    }

    function switchView(name) {
      view = name;
      document.querySelectorAll('.rep-view-btn').forEach((b) => {
        const on = b.dataset.view === name;
        b.classList.toggle('bg-teal-700', on); b.classList.toggle('text-white', on); b.classList.toggle('text-slate-600', !on);
        b.setAttribute('aria-selected', String(on));
      });
      show($('#rep-customer-wrap'), name === 'sales');
      show($('#rep-cow-wrap'), name === 'milk');
      show($('#rep-group-wrap'), name === 'milk');
      show($('#rep-expgroup-wrap'), name === 'expenses');
      setMsg('error', '');
      render();
    }

    /* ---------------- fetch ---------------- */

    async function run() {
      setMsg('error', '');
      const from = $('#rep-from').value;
      const to = $('#rep-to').value;
      if (!from || !to) { setMsg('error', 'Pick both dates.'); return; }
      if (from > to) { setMsg('error', 'The From date is after the To date.'); return; }
      if (!navigator.onLine) { setMsg('error', 'Reports need internet: the full history is in Google Sheets.'); return; }
      if (!getSession()) { requestSignIn(); return; }
      setBusy(true, 'Getting the report from Google Sheets…');
      try {
        const payload = view === 'sales'
          ? { action: 'customerPeriodReport', customerId: $('#rep-customer').value, from, to }
          : view === 'milk'
            ? { action: 'milkPeriodReport', cowId: $('#rep-cow').value, from, to, groupBy: $('#rep-group').value }
            : { action: 'expensePeriodReport', group: $('#rep-expgroup').value, groupBy: $('#rep-expby').value, from, to };
        current[view] = await callServer(payload);
        render();
      } catch (err) {
        if (err && err.kind === 'auth') { setMsg('error', 'Please sign in again, then tap Show report.'); requestSignIn(); }
        else setMsg('error', (err && err.message) || String(err));
      } finally {
        setBusy(false);
      }
    }

    /* ---------------- on-screen ---------------- */

    const card = (label, value, cls = '') =>
      `<div class="rounded-xl bg-white shadow-sm px-3 py-2"><p class="text-[11px] uppercase tracking-wide text-slate-400">${esc(label)}</p><p class="text-base font-bold ${cls}">${esc(value)}</p></div>`;

    function table(headers, rows, numericFrom = 1) {
      return `<div class="overflow-x-auto rounded-xl bg-white shadow-sm"><table class="min-w-full text-xs">
        <thead class="bg-teal-700 text-white"><tr>${headers.map((h, i) => `<th class="px-2 py-2 font-semibold ${i >= numericFrom ? 'text-right' : 'text-left'} whitespace-nowrap">${esc(h)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((r, k) => `<tr class="${k % 2 ? 'bg-slate-50' : ''} ${r._cls || ''}">${r.map((c, i) => `<td class="px-2 py-1.5 ${i >= numericFrom ? 'text-right tabular-nums' : ''} whitespace-nowrap">${c}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>`;
    }

    function renderSales(d) {
      const single = d.customers.length === 1;
      let html = `<p class="text-xs text-slate-500 px-1">${esc(fmtDate(d.from))} to ${esc(fmtDate(d.to))}</p>`;
      if (!d.customers.length) return html + '<p class="text-sm text-slate-400 px-1 mt-2">No sales, payments or balances in this period.</p>';
      if (single) {
        const c = d.customers[0];
        html += `<h3 class="text-base font-bold text-teal-800 px-1 mt-1">${esc(c.name)} <span class="font-normal text-slate-400">${esc(c.customerId)}</span></h3>
          <div class="grid grid-cols-2 gap-2 mt-2">
            ${card('Opening balance', 'KES ' + money(c.opening))}
            ${card('Milk delivered', `${c.totals.litres} L · KES ${money(c.totals.delivered)}`)}
            ${card('Returns credit', 'KES ' + money(c.totals.returns))}
            ${card('Paid', 'KES ' + money(c.totals.paid))}
          </div>
          <div class="mt-2">${card('Amount due on ' + fmtDate(d.to), (c.closing < 0 ? 'In credit KES ' + money(-c.closing) : 'KES ' + money(c.closing)), c.closing > 0.005 ? 'text-red-700' : 'text-farm-800')}</div>
          ${c.totals.disputed ? `<p class="text-xs text-red-700 mt-2 px-1">KES ${money(c.totals.disputed)} in disputed payments is not credited.</p>` : ''}`;
      } else {
        const g = d.grand;
        html += `<div class="grid grid-cols-2 gap-2 mt-2">
            ${card('Customers', String(d.customers.length))}
            ${card('Milk delivered', `${g.litres} L · KES ${money(g.delivered)}`)}
            ${card('Paid', 'KES ' + money(g.paid))}
            ${card('Owed on ' + fmtDate(d.to), 'KES ' + money(g.closing), g.closing > 0.005 ? 'text-red-700' : '')}
          </div><div class="mt-3">` +
          table(['Customer', 'Opening', 'Litres', 'Delivered', 'Returns', 'Paid', 'Closing'],
            d.customers.map((c) => [esc(c.name), money(c.opening), c.totals.litres, money(c.totals.delivered), money(c.totals.returns), money(c.totals.paid), `<b>${money(c.closing)}</b>`])) + '</div>';
      }
      if (single) {
        const c = d.customers[0];
        const rows = [['', 'Opening balance', '', '', '', '', `<b>${money(c.opening)}</b>`]]
          .concat(c.lines.map((l) => {
            const r = [esc(fmtDate(l.date)), esc(l.details), l.litres === '' ? '' : l.litres, l.price === '' ? '' : money(l.price),
              l.charged ? money(l.charged) : '', l.credited ? money(l.credited) : (l.disputed ? `(${money(l.disputed)})` : ''), money(l.balance)];
            if (l.disputed) r._cls = 'text-red-700';
            return r;
          }))
          .concat([['', '<b>Closing balance</b>', '', '', '', '', `<b>${money(c.closing)}</b>`]]);
        html += '<div class="mt-3">' + table(['Date', 'Details', 'Litres', 'Price', 'Charged', 'Credited', 'Balance'], rows, 2) + '</div>';
      }
      return html;
    }

    function renderMilk(d) {
      const G = { day: 'Day', week: 'Week', month: 'Month' }[d.groupBy];
      let html = `<p class="text-xs text-slate-500 px-1">${esc(d.cowName)} · ${esc(fmtDate(d.from))} to ${esc(fmtDate(d.to))} · by ${G.toLowerCase()}</p>
        <div class="grid grid-cols-2 gap-2 mt-2">
          ${card('Total milk', d.totals.total + ' L')}
          ${card('Days with records', String(d.totals.days))}
          ${card(d.cow === 'ALL' ? 'Herd average per day' : 'Average per day milked', (d.cow === 'ALL' ? d.totals.avgPerDay : (d.cows[0] ? d.cows[0].avgPerDay : 0)) + ' L')}
          ${card('Cow-days milked', String(d.totals.cowDays))}
        </div>`;
      if (!d.rows.length) return html + '<p class="text-sm text-slate-400 px-1 mt-2">No milk recorded in this period.</p>';
      if (d.cows.length > 1) {
        html += '<h4 class="text-sm font-semibold text-slate-600 px-1 mt-4 mb-1">Per cow, whole period</h4>' +
          table(['Cow', 'Days', 'Total L', 'Avg/day', 'Best day'], d.cows.map((c) => [esc(c.cowName), c.days, c.total, c.avgPerDay, `${c.bestDay} (${esc(fmtDate(c.bestDate))})`]));
      }
      html += `<h4 class="text-sm font-semibold text-slate-600 px-1 mt-4 mb-1">Per cow, by ${G.toLowerCase()}</h4>` +
        table([G, 'Cow', 'Days', 'AM', 'Noon', 'PM', 'Total L', 'Avg/day'],
          d.rows.map((r) => [esc(r.label), esc(r.cowName), r.days, r.morning, r.afternoon, r.evening, `<b>${r.total}</b>`, r.avgPerDay]), 2);
      if (d.lactations.length) {
        html += '<h4 class="text-sm font-semibold text-slate-600 px-1 mt-4 mb-1">Lactations in this period (whole lactation)</h4>' +
          table(['Cow', 'No.', 'From', 'Days in milk', 'Total L', 'Avg/day', 'Peak', 'Status'],
            d.lactations.map((l) => [esc(l.cowName), l.number, esc(fmtDate(l.firstRecord)), l.daysInMilk, `<b>${l.total}</b>`, `<b>${l.avgPerDay}</b>`, l.peak,
              (l.ongoing ? 'Ongoing' : 'Ended') + (l.startedBeforeRecords ? '*' : '')]), 3) +
          '<p class="text-[11px] text-slate-500 mt-1 px-1">Estimated from milk records until calving dates are recorded (45+ days without milk = dry). * Began before records started.</p>';
      }
      return html;
    }

    const PERIOD_NAME = { day: 'day', week: 'week', month: 'month', year: 'year' };
    const PERIOD_HEAD = { day: 'Day', week: 'Week of', month: 'Month', year: 'Year' };
    function periodLabel(by, k) {
      const [y, m, dd] = k.split('-').map(Number);
      if (by === 'year') return String(y);
      if (by === 'month') return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
      return new Date(y, m - 1, dd).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: by === 'week' ? '2-digit' : undefined });
    }

    function renderExpenses(d) {
      const inc = d.income;
      let html = `<p class="text-xs text-slate-500 px-1">${d.group === 'ALL' ? 'All expenses' : esc(d.group)} · ${esc(fmtDate(d.from))} to ${esc(fmtDate(d.to))}</p>
        <div class="grid grid-cols-2 gap-2 mt-2">
          ${card('Total expenses', 'KES ' + money(d.total), 'text-rose-800')}
          ${card('Expenses recorded', String(d.count))}
          ${d.paid !== undefined ? card('Paid', 'KES ' + money(d.paid), 'text-farm-800') + card('Still owed', 'KES ' + money(d.owing), d.owing > 0 ? 'text-red-700' : '') : ''}`;
      if (d.group === 'ALL') {
        const cap = Number(inc.capital || 0);
        html += `${card('Net milk sales', 'KES ' + money(inc.netSales))}
          ${card('Running costs', 'KES ' + money(inc.expenses))}
          ${card('Profit', 'KES ' + money(inc.profit), inc.profit < 0 ? 'text-red-700' : 'text-farm-800')}
          ${cap ? card('Animal purchases (capital)', 'KES ' + money(cap)) + card('Profit after animal purchases', 'KES ' + money(inc.profitAfterCapital), inc.profitAfterCapital < 0 ? 'text-red-700' : 'text-farm-800') : ''}
          ${card('Cost per litre produced', inc.costPerLitre === '' ? '—' : 'KES ' + money(inc.costPerLitre))}
          ${card('Average selling price', inc.avgPrice === '' ? '—' : 'KES ' + money(inc.avgPrice) + '/L')}`;
      }
      html += '</div>';
      if (!d.count) return html + '<p class="text-sm text-slate-400 px-1 mt-2">No expenses in this period.</p>';
      if (d.periods && d.periods.length) {
        html += `<h4 class="text-sm font-semibold text-slate-600 px-1 mt-4 mb-1">By ${esc(PERIOD_NAME[d.groupBy] || 'month')}</h4>` +
          table([PERIOD_HEAD[d.groupBy] || 'Month', 'Total', 'Running', 'Capital', 'Still owed', 'No.'], d.periods.map((p) => [esc(periodLabel(d.groupBy, p.period)), `<b>${money(p.total)}</b>`,
            money(p.running), p.capital ? money(p.capital) : '', p.owing ? `<span class="text-red-700">${money(p.owing)}</span>` : '', p.count]), 1);
      }
      html += '<h4 class="text-sm font-semibold text-slate-600 px-1 mt-4 mb-1">By category</h4>' +
        table(['Category', 'Group', 'KES', 'Payments', 'Quantity'], d.categories.map((c) => [esc(c.category), esc(c.group), `<b>${money(c.total)}</b>`, c.count, esc(c.quantity)]), 2);
      html += '<h4 class="text-sm font-semibold text-slate-600 px-1 mt-4 mb-1">Every expense</h4>' +
        table(['Date', 'Category', 'Item', 'KES', 'Qty', 'Paid to'], d.lines.map((x) => [esc(fmtDate(x.date)), esc(x.category), esc(x.item), money(x.amount),
          x.quantity === '' ? '' : `${x.quantity} ${esc(x.unit)}`, esc(x.payee)]), 3);
      return html;
    }

    function render() {
      const d = current[view];
      $('#rep-result').innerHTML = d ? (view === 'sales' ? renderSales(d) : view === 'milk' ? renderMilk(d) : renderExpenses(d)) : '';
      document.querySelectorAll('.rep-dl').forEach((b) => { b.disabled = !d; });
    }

    /* ---------------- Excel ---------------- */

    function sheetFrom(aoa, widths, formats) {
      const XLSX = window.XLSX;
      const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true });
      ws['!cols'] = widths.map((w) => ({ wch: w }));
      if (formats) {
        const range = XLSX.utils.decode_range(ws['!ref']);
        for (let R = range.s.r; R <= range.e.r; R++) {
          Object.keys(formats).forEach((C) => {
            const cell = ws[XLSX.utils.encode_cell({ r: R, c: Number(C) })];
            if (cell && cell.t === 'n') cell.z = formats[C];
            if (cell && cell.t === 'd') cell.z = 'dd-mmm-yyyy';
          });
        }
      }
      return ws;
    }

    const KES = '#,##0.00';

    function salesWorkbook(d) {
      const XLSX = window.XLSX;
      const wb = XLSX.utils.book_new();
      const head = (title) => [[FARM + ' - ' + title], [`Period: ${fmtDate(d.from)} to ${fmtDate(d.to)}`], ['Owed = Sales + Balance B/F - Returns - Payments (Verified and Pending). Disputed payments are not credited.'], []];
      if (d.customers.length !== 1) {
        const aoa = head('Customer sales, all customers').concat([[
          'Customer', 'ID', 'Opening balance (KES)', 'Litres', 'Milk delivered (KES)', 'Balance B/F entries (KES)', 'Returns (KES)', 'Paid (KES)', 'Disputed, not credited (KES)', 'Closing balance (KES)']])
          .concat(d.customers.map((c) => [c.name, c.customerId, c.opening, c.totals.litres, c.totals.delivered, c.totals.openingEntries, c.totals.returns, c.totals.paid, c.totals.disputed, c.closing]))
          .concat([['ALL CUSTOMERS', '', d.grand.opening, d.grand.litres, d.grand.delivered, d.grand.openingEntries, d.grand.returns, d.grand.paid, d.grand.disputed, d.grand.closing]]);
        XLSX.utils.book_append_sheet(wb, sheetFrom(aoa, [26, 8, 14, 9, 14, 14, 12, 14, 14, 14], { 2: KES, 3: '0.0', 4: KES, 5: KES, 6: KES, 7: KES, 8: KES, 9: KES }), 'Summary');
      }
      const all = [];
      d.customers.forEach((c) => {
        const aoa = head(`Statement: ${c.name} (${c.customerId})`).concat([
          ['Date', 'Details', 'Reference', 'Litres', 'Price (KES/L)', 'Charged (KES)', 'Credited (KES)', 'Disputed, not credited (KES)', 'Balance (KES)'],
          ['', 'Opening balance', '', '', '', '', '', '', c.opening]])
          .concat(c.lines.map((l) => [toDate(l.date), l.details, l.ref, l.litres, l.price, l.charged || '', l.credited || '', l.disputed || '', l.balance]))
          .concat([['', 'Closing balance' + (c.closing < 0 ? ' (in credit)' : ''), '', '', '', '', '', '', c.closing], [],
            ['', 'Milk delivered (L)', '', c.totals.litres], ['', 'Milk delivered (KES)', '', '', '', c.totals.delivered], ['', 'Returns credit (KES)', '', '', '', '', c.totals.returns],
            ['', 'Paid (KES)', '', '', '', '', c.totals.paid], ['', 'Amount due (KES)', '', '', '', '', '', '', c.closing]]);
        if (d.customers.length === 1) XLSX.utils.book_append_sheet(wb, sheetFrom(aoa, [13, 46, 14, 8, 11, 13, 13, 13, 13], { 3: '0.0', 4: KES, 5: KES, 6: KES, 7: KES, 8: KES }), 'Statement');
        c.lines.forEach((l) => all.push([toDate(l.date), c.name, c.customerId, l.kind, l.details, l.ref, l.litres, l.price, l.charged || '', l.credited || '', l.disputed || '', l.balance]));
      });
      if (d.customers.length !== 1) {
        const aoa = head('All transactions').concat([['Date', 'Customer', 'ID', 'Kind', 'Details', 'Reference', 'Litres', 'Price (KES/L)', 'Charged (KES)', 'Credited (KES)', 'Disputed (KES)', 'Customer balance (KES)']]).concat(all);
        XLSX.utils.book_append_sheet(wb, sheetFrom(aoa, [13, 24, 8, 12, 46, 14, 8, 11, 13, 13, 12, 14], { 6: '0.0', 7: KES, 8: KES, 9: KES, 10: KES, 11: KES }), 'Transactions');
      }
      return wb;
    }

    function milkWorkbook(d) {
      const XLSX = window.XLSX;
      const wb = XLSX.utils.book_new();
      const G = { day: 'Day', week: 'Week starting (Mon)', month: 'Month' }[d.groupBy];
      const head = (t) => [[FARM + ' - ' + t], [`${d.cowName}, ${fmtDate(d.from)} to ${fmtDate(d.to)}`], [`Total ${d.totals.total} L over ${d.totals.days} day(s) with records. Average per day = per day milked.`], []];
      const periodCell = (r) => (d.groupBy === 'month' ? r.label : toDate(r.period));
      XLSX.utils.book_append_sheet(wb, sheetFrom(head('Milk per cow by ' + d.groupBy).concat([[G, 'Cow', 'ID', 'Days milked', 'Morning (L)', 'Afternoon (L)', 'Evening (L)', 'Total (L)', 'Average per day (L)']])
        .concat(d.rows.map((r) => [periodCell(r), r.cowName, r.cowId, r.days, r.morning, r.afternoon, r.evening, r.total, r.avgPerDay])),
      [18, 14, 8, 11, 12, 12, 12, 10, 16], { 4: '0.0', 5: '0.0', 6: '0.0', 7: '0.0', 8: '0.0' }), 'By ' + d.groupBy);
      XLSX.utils.book_append_sheet(wb, sheetFrom(head('Per cow, whole period').concat([['Cow', 'ID', 'Days milked', 'Morning (L)', 'Afternoon (L)', 'Evening (L)', 'Total (L)', 'Average per day (L)', 'Best day (L)', 'Best day']])
        .concat(d.cows.map((c) => [c.cowName, c.cowId, c.days, c.morning, c.afternoon, c.evening, c.total, c.avgPerDay, c.bestDay, c.bestDate ? toDate(c.bestDate) : ''])),
      [14, 8, 11, 12, 12, 12, 10, 16, 12, 13], { 3: '0.0', 4: '0.0', 5: '0.0', 6: '0.0', 7: '0.0', 8: '0.0' }), 'Per cow');
      XLSX.utils.book_append_sheet(wb, sheetFrom(head('Herd by ' + d.groupBy).concat([[G, 'Cows milked', 'Cow-days', 'Total (L)', 'Average per cow per day (L)']])
        .concat(d.herd.map((h) => [d.groupBy === 'month' ? h.label : toDate(h.period), h.cows, h.cowDays, h.total, h.avgPerCowDay])),
      [18, 12, 10, 10, 22], { 3: '0.0', 4: '0.0' }), 'Herd');
      XLSX.utils.book_append_sheet(wb, sheetFrom(head('Lactations in this period (whole-lactation figures, estimated from milk records)').concat([[
        'Cow', 'ID', 'Lactation', 'First record', 'Last record', 'Days in milk', 'Total (L)', 'Average per day (L)', 'Peak day (L)', 'Peak date', 'Persistency', '305-day yield (L)', 'Litres in this period', 'Status']])
        .concat(d.lactations.map((l) => [l.cowName, l.cowId, l.number, toDate(l.firstRecord), toDate(l.lastRecord), l.daysInMilk, l.total, l.avgPerDay, l.peak, toDate(l.peakDate),
          l.persistency, l.y305, l.inPeriodTotal, (l.ongoing ? 'Ongoing' : 'Ended') + (l.startedBeforeRecords ? '; began before records' : '')])),
      [14, 8, 10, 13, 13, 12, 10, 16, 12, 13, 11, 15, 16, 26], { 6: '0.0', 7: '0.0', 8: '0.0', 10: '0%', 11: '0.0', 12: '0.0' }), 'Lactations');
      return wb;
    }

    function expensesWorkbook(d) {
      const XLSX = window.XLSX;
      const wb = XLSX.utils.book_new();
      const inc = d.income;
      const head = (t) => [[FARM + ' - ' + t], [`${d.group === 'ALL' ? 'All dairy expenses' : d.group}, ${fmtDate(d.from)} to ${fmtDate(d.to)}`], []];
      const summary = head('Expenses summary').concat([['Total expenses (KES)', d.total], ['Expenses recorded', d.count]]);
      if (d.paid !== undefined) summary.push(['Paid (KES)', d.paid], ['Still owed (KES)', d.owing]);
      if (d.group === 'ALL') {
        summary.push(['Milk produced (L)', inc.produced], ['Milk sold (L)', inc.sold], ['Net milk sales (KES)', inc.netSales],
          ['Running costs (KES, excl. animal purchases)', inc.expenses], ['Profit (KES)', inc.profit],
          ['Animal purchases - capital (KES)', inc.capital || 0], ['Profit after animal purchases (KES)', inc.profitAfterCapital ?? inc.profit],
          ['Cost per litre produced (KES)', inc.costPerLitre], ['Feed & fodder cost per litre (KES)', inc.feedCostPerLitre], ['Average selling price (KES/L)', inc.avgPrice]);
      }
      summary.push([], ['Group', 'Amount (KES)', 'Share']);
      d.groups.forEach((g) => summary.push([g.group, g.total, g.share]));
      XLSX.utils.book_append_sheet(wb, sheetFrom(summary, [30, 16, 10], { 1: KES, 2: '0%' }), 'Summary');
      if (d.periods && d.periods.length) {
        XLSX.utils.book_append_sheet(wb, sheetFrom(head('Totals by ' + d.groupBy).concat([[PERIOD_HEAD[d.groupBy], 'Total (KES)', 'Running costs (KES)', 'Animal purchases (KES)', 'Still owed (KES)', 'Expenses']])
          .concat(d.periods.map((p) => [d.groupBy === 'year' ? Number(p.period.slice(0, 4)) : toDate(p.period), p.total, p.running, p.capital, p.owing, p.count])),
        [14, 14, 18, 20, 16, 10], { 1: KES, 2: KES, 3: KES, 4: KES }), 'By ' + d.groupBy);
      }
      XLSX.utils.book_append_sheet(wb, sheetFrom(head('By category').concat([['Group', 'Category', 'Amount (KES)', 'Payments', 'Quantity bought']])
        .concat(d.categories.map((c) => [c.group, c.category, c.total, c.count, c.quantity])), [16, 26, 14, 10, 20], { 2: KES }), 'By category');
      XLSX.utils.book_append_sheet(wb, sheetFrom(head('Every expense').concat([['Date', 'Expense ID', 'Group', 'Category', 'Item', 'Quantity', 'Unit', 'Price per unit (KES)', 'Amount (KES)', 'Paid by', 'Reference', 'Paid to', 'Animal', 'Notes']])
        .concat(d.lines.map((x) => [toDate(x.date), x.expenseId, x.group, x.category, x.item, x.quantity, x.unit, x.unitPrice, x.amount, x.paymentMethod, x.receiptRef, x.payee, x.animalId, x.notes])),
      [13, 14, 14, 24, 22, 9, 7, 13, 13, 9, 14, 20, 9, 24], { 5: '0.0', 7: KES, 8: KES }), 'Expenses');
      return wb;
    }

    async function downloadExcel() {
      const d = current[view];
      if (!d) return;
      setBusy(true, 'Making the Excel file…');
      try {
        await loadScript(LIBS.xlsx);
        const wb = view === 'sales' ? salesWorkbook(d) : view === 'milk' ? milkWorkbook(d) : expensesWorkbook(d);
        window.XLSX.writeFile(wb, `${fileStem(d)}_${d.from}_to_${d.to}.xlsx`);
        toast('Excel file downloaded');
      } catch (err) {
        setMsg('error', err.message || String(err));
      } finally {
        setBusy(false);
      }
    }

    /* ---------------- PDF ---------------- */

    function pdfHeader(doc, title, sub) {
      doc.setFillColor(...GREEN);
      doc.rect(0, 0, doc.internal.pageSize.getWidth(), 22, 'F');
      doc.setTextColor(255);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
      doc.text(FARM, 14, 10);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
      doc.text(ascii(title), 14, 17);
      doc.setTextColor(60);
      doc.setFontSize(9);
      doc.text(ascii(sub), 14, 29);
      return 34;
    }

    function pdfFooter(doc) {
      const n = doc.getNumberOfPages();
      for (let i = 1; i <= n; i++) {
        doc.setPage(i);
        doc.setFontSize(7.5); doc.setTextColor(120);
        doc.text(ascii(`Mawe Tatu Farm, Nangili - generated ${fmtDate(todayLocal())}`), 14, doc.internal.pageSize.getHeight() - 8);
        doc.text(`Page ${i} of ${n}`, doc.internal.pageSize.getWidth() - 14, doc.internal.pageSize.getHeight() - 8, { align: 'right' });
      }
    }

    const tableStyle = { styles: { fontSize: 8, cellPadding: 1.5 }, headStyles: { fillColor: GREEN, textColor: 255 }, alternateRowStyles: { fillColor: [245, 247, 250] }, margin: { left: 14, right: 14 } };

    function salesPdf(d) {
      const doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4' });
      const period = `Period: ${fmtDate(d.from)} to ${fmtDate(d.to)}`;
      if (d.customers.length !== 1) {
        let y = pdfHeader(doc, 'Customer sales - all customers', period);
        doc.autoTable({ ...tableStyle, startY: y,
          head: [['Customer', 'Opening', 'Litres', 'Delivered', 'Returns', 'Paid', 'Disputed', 'Closing']],
          body: d.customers.map((c) => [ascii(c.name), money(c.opening), c.totals.litres, money(c.totals.delivered + c.totals.openingEntries), money(c.totals.returns), money(c.totals.paid), c.totals.disputed ? money(c.totals.disputed) : '', money(c.closing)])
            .concat([['ALL CUSTOMERS', money(d.grand.opening), d.grand.litres, money(d.grand.delivered + d.grand.openingEntries), money(d.grand.returns), money(d.grand.paid), d.grand.disputed ? money(d.grand.disputed) : '', money(d.grand.closing)]]),
          columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'right' }, 7: { halign: 'right', fontStyle: 'bold' } },
          didParseCell: (h) => { if (h.section === 'body' && h.row.index === d.customers.length) h.cell.styles.fontStyle = 'bold'; } });
        doc.setFontSize(8); doc.setTextColor(90);
        doc.text('Delivered includes any balance brought forward. Disputed payments are not credited. Statements per customer follow.', 14, doc.lastAutoTable.finalY + 6);
      }
      d.customers.forEach((c, i) => {
        if (d.customers.length !== 1 || i > 0) doc.addPage();
        const y = pdfHeader(doc, `Statement for ${c.name}${c.location ? ', ' + c.location : ''}`, period);
        doc.autoTable({ ...tableStyle, startY: y,
          head: [['Date', 'Details', 'Litres', 'Price', 'Charged', 'Credited', 'Balance']],
          body: [['', 'Opening balance', '', '', '', '', money(c.opening)]]
            .concat(c.lines.map((l) => [ascii(fmtDate(l.date)), ascii(l.details), l.litres === '' ? '' : l.litres, l.price === '' ? '' : money(l.price),
              l.charged ? money(l.charged) : '', l.credited ? money(l.credited) : (l.disputed ? `(${money(l.disputed)})` : ''), money(l.balance)]))
            .concat([['', 'Closing balance' + (c.closing < 0 ? ' (in credit)' : ''), '', '', '', '', money(c.closing)]]),
          columnStyles: { 0: { cellWidth: 22 }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'right' } },
          didParseCell: (h) => { if (h.section === 'body' && (h.row.index === 0 || h.row.index === c.lines.length + 1)) h.cell.styles.fontStyle = 'bold'; } });
        let yy = doc.lastAutoTable.finalY + 7;
        doc.setFontSize(9); doc.setTextColor(40);
        [`Milk delivered: ${c.totals.litres} L, KES ${money(c.totals.delivered)}`, `Returns credited: KES ${money(c.totals.returns)}`, `Payments received: KES ${money(c.totals.paid)}`]
          .forEach((t) => { doc.text(ascii(t), 14, yy); yy += 5; });
        doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
        doc.text(ascii(`Amount due on ${fmtDate(d.to)}: KES ${money(c.closing)}${c.closing < 0 ? ' (in credit)' : ''}`), 14, yy + 2);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(90);
        doc.text('Pending payments are credited but still being verified. Disputed payments are shown in brackets and not credited.', 14, yy + 9);
      });
      pdfFooter(doc);
      return doc;
    }

    function milkPdf(d) {
      const doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4' });
      const G = { day: 'Day', week: 'Week of', month: 'Month' }[d.groupBy];
      let y = pdfHeader(doc, `Milk output - ${d.cowName}`, `${fmtDate(d.from)} to ${fmtDate(d.to)} - by ${d.groupBy} - total ${d.totals.total} L over ${d.totals.days} day(s)`);
      if (d.cows.length) {
        doc.autoTable({ ...tableStyle, startY: y, head: [['Cow', 'Days milked', 'Morning', 'Afternoon', 'Evening', 'Total (L)', 'Avg/day (L)', 'Best day']],
          body: d.cows.map((c) => [ascii(c.cowName), c.days, c.morning, c.afternoon, c.evening, c.total, c.avgPerDay, `${c.bestDay} (${ascii(fmtDate(c.bestDate))})`]),
          columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right', fontStyle: 'bold' }, 6: { halign: 'right' } } });
        y = doc.lastAutoTable.finalY + 6;
      }
      doc.autoTable({ ...tableStyle, startY: y, head: [[G, 'Cow', 'Days', 'Morning', 'Afternoon', 'Evening', 'Total (L)', 'Avg/day (L)']],
        body: d.rows.length ? d.rows.map((r) => [ascii(d.groupBy === 'week' ? fmtDate(r.period) : r.label), ascii(r.cowName), r.days, r.morning, r.afternoon, r.evening, r.total, r.avgPerDay])
          : [['No milk recorded in this period.', '', '', '', '', '', '', '']],
        columnStyles: { 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'right', fontStyle: 'bold' }, 7: { halign: 'right' } } });
      if (d.lactations.length) {
        y = doc.lastAutoTable.finalY + 8;
        doc.setFontSize(10); doc.setTextColor(40); doc.text('Lactations in this period (whole-lactation figures)', 14, y);
        doc.autoTable({ ...tableStyle, startY: y + 2, head: [['Cow', 'No.', 'First record', 'Days in milk', 'Total (L)', 'Avg/day (L)', 'Peak (L)', 'Persistency', 'Status']],
          body: d.lactations.map((l) => [ascii(l.cowName), l.number, ascii(fmtDate(l.firstRecord)), l.daysInMilk, l.total, l.avgPerDay, l.peak,
            l.persistency === '' ? '' : Math.round(l.persistency * 100) + '%', (l.ongoing ? 'Ongoing' : 'Ended') + (l.startedBeforeRecords ? ' *' : '')]),
          columnStyles: { 3: { halign: 'right' }, 4: { halign: 'right', fontStyle: 'bold' }, 5: { halign: 'right', fontStyle: 'bold' }, 6: { halign: 'right' }, 7: { halign: 'right' } } });
        doc.setFontSize(7.5); doc.setTextColor(90);
        doc.text('Estimated from milk records until calving dates are recorded (45+ days without milk = dry). * Began before records started.', 14, doc.lastAutoTable.finalY + 5);
      }
      pdfFooter(doc);
      return doc;
    }

    function fileStem(d) {
      if (view === 'sales') return 'Sales_' + safeName(d.customers.length === 1 ? d.customers[0].name : 'All_customers');
      if (view === 'milk') return 'Milk_' + safeName(d.cowName);
      return 'Expenses_' + safeName(d.group === 'ALL' ? 'All' : d.group);
    }

    function expensesPdf(d) {
      const doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4' });
      const inc = d.income;
      let y = pdfHeader(doc, `Dairy expenses${d.group === 'ALL' ? '' : ' - ' + d.group}`, `${fmtDate(d.from)} to ${fmtDate(d.to)} - total KES ${money(d.total)} in ${d.count} payment(s)`);
      if (d.group === 'ALL') {
        doc.autoTable({ ...tableStyle, startY: y, head: [['Milk produced', 'Net milk sales', 'Running costs', 'Profit', 'Cost per litre', 'Avg selling price']],
          body: [[`${inc.produced} L`, money(inc.netSales), money(inc.expenses), money(inc.profit), inc.costPerLitre === '' ? '-' : money(inc.costPerLitre), inc.avgPrice === '' ? '-' : money(inc.avgPrice)]] });
        y = doc.lastAutoTable.finalY + 2;
        if (Number(inc.capital || 0)) {
          doc.setFontSize(9);
          doc.text(ascii(`Animal purchases (capital, not in running costs): KES ${money(inc.capital)}. Profit after animal purchases: KES ${money(inc.profitAfterCapital)}.`), 14, y + 4);
          y += 6;
        }
        y += 4;
      }
      if (d.paid !== undefined) { doc.setFontSize(9); doc.text(ascii(`Paid KES ${money(d.paid)} - still owed KES ${money(d.owing)}.`), 14, y); y += 5; }
      if (d.periods && d.periods.length > 1) {
        doc.autoTable({ ...tableStyle, startY: y, head: [[PERIOD_HEAD[d.groupBy], 'Total', 'Running costs', 'Animal purchases', 'Still owed', 'No.']],
          body: d.periods.map((p) => [ascii(periodLabel(d.groupBy, p.period)), money(p.total), money(p.running), p.capital ? money(p.capital) : '', p.owing ? money(p.owing) : '', p.count]),
          columnStyles: { 1: { halign: 'right', fontStyle: 'bold' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' } } });
        y = doc.lastAutoTable.finalY + 6;
      }
      doc.autoTable({ ...tableStyle, startY: y, head: [['Category', 'Group', 'Amount (KES)', 'Payments', 'Quantity']],
        body: d.categories.length ? d.categories.map((c) => [ascii(c.category), ascii(c.group), money(c.total), c.count, ascii(c.quantity)]) : [['No expenses in this period.', '', '', '', '']],
        columnStyles: { 2: { halign: 'right', fontStyle: 'bold' }, 3: { halign: 'right' } } });
      if (d.lines.length) {
        doc.autoTable({ ...tableStyle, startY: doc.lastAutoTable.finalY + 6, head: [['Date', 'Category', 'Item', 'Qty', 'Amount', 'Paid by', 'Paid to']],
          body: d.lines.map((x) => [ascii(fmtDate(x.date)), ascii(x.category), ascii(x.item), x.quantity === '' ? '' : `${x.quantity} ${ascii(x.unit)}`, money(x.amount), ascii(x.paymentMethod), ascii(x.payee)]),
          columnStyles: { 4: { halign: 'right' } } });
      }
      pdfFooter(doc);
      return doc;
    }

    async function downloadPdf() {
      const d = current[view];
      if (!d) return;
      setBusy(true, 'Making the PDF…');
      try {
        await loadScript(LIBS.jspdf);
        await loadScript(LIBS.autotable);
        const doc = view === 'sales' ? salesPdf(d) : view === 'milk' ? milkPdf(d) : expensesPdf(d);
        doc.save(`${fileStem(d).replace(/^Sales_/, 'Statement_')}_${d.from}_to_${d.to}.pdf`);
        toast('PDF downloaded');
      } catch (err) {
        setMsg('error', err.message || String(err));
      } finally {
        setBusy(false);
      }
    }

    /* ---------------- init ---------------- */

    function init() {
      $('#rep-from').value = firstOfMonth();
      $('#rep-to').value = todayLocal();
      $('#rep-from').max = todayLocal();
      $('#rep-to').max = todayLocal();
      document.querySelectorAll('.rep-view-btn').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));
      $('#rep-run').addEventListener('click', run);
      $('#rep-xlsx').addEventListener('click', downloadExcel);
      $('#rep-pdf').addEventListener('click', downloadPdf);
      document.querySelectorAll('.rep-quick').forEach((b) => b.addEventListener('click', () => {
        const t = todayLocal();
        const [y, m] = [Number(t.slice(0, 4)), Number(t.slice(5, 7))];
        const pad = (n) => String(n).padStart(2, '0');
        if (b.dataset.range === 'this') { $('#rep-from').value = t.slice(0, 8) + '01'; $('#rep-to').value = t; }
        if (b.dataset.range === 'last') {
          const py = m === 1 ? y - 1 : y; const pm = m === 1 ? 12 : m - 1;
          $('#rep-from').value = `${py}-${pad(pm)}-01`;
          $('#rep-to').value = `${py}-${pad(pm)}-${pad(new Date(py, pm, 0).getDate())}`;
        }
        if (b.dataset.range === '30') {
          const d = new Date(); d.setDate(d.getDate() - 29);
          $('#rep-from').value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; $('#rep-to').value = t;
        }
        if (b.dataset.range === 'year') { $('#rep-from').value = `${y}-01-01`; $('#rep-to').value = t; }
      }));
      Dexie.liveQuery(() => Promise.all([db.customers.count(), db.animals.count()])).subscribe({ next: () => fillChoices() });
      switchView('sales');
    }

    return Object.freeze({ init, switchView, run, current: () => current });
  }

  window.MaweReports = Object.freeze({ create, LIBS });
})();
