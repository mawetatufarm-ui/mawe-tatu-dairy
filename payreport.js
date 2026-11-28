/* =====================================================================
 * Mawe Tatu Dairy — payreport.js (Reports tab → Payments, v5.10)
 * ---------------------------------------------------------------------
 * Payments received from customers between two dates: one customer or all,
 * optionally one method (Cash / M-Pesa / Other) or one status (Verified /
 * Pending / Disputed). Shown on screen, and downloadable as Excel or PDF.
 *
 * Kept separate from reports.js on purpose (the Customer sales, Milk output
 * and Expenses reports are unchanged): this module adds its own button
 * (.rep-pay-btn) and panel (#payrep-view). Choosing it hides the shared
 * report form (#rep-form-card) and result (#rep-result); choosing any other
 * report button (.rep-view-btn) brings them back.
 *
 * Server: { action: 'customerPaymentsReport', customerId: 'C-001' | 'ALL', from, to,
 *           method: 'ALL'|'Cash'|'M-Pesa'|'Other', payStatus: 'ALL'|'Verified'|'Pending'|'Disputed' }
 *   (PeriodReports.gs prPaymentsReport_). Received = Verified + Pending, as in
 *   the balances; Disputed is listed but not counted; cancelled payments are left out.
 * Libraries (loaded on first download, like reports.js): SheetJS xlsx@0.18.5,
 * jsPDF 2.5.1 + jspdf-autotable 3.8.2. Online only.
 * Loaded before app.js; defines window.MawePayReport.
 * ===================================================================== */

(() => {
  'use strict';

  const LIBS = {
    xlsx: 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
    jspdf: 'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js',
    autotable: 'https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js',
  };

  function create(deps) {
    const { db, callServer, esc, toast, todayLocal, getSession } = deps;
    const $ = (s) => document.querySelector(s);
    const show = (el, v) => el && el.classList.toggle('hidden', !v);
    const money = (x) => Number(x || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const fmt = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };
    const monthName = (k) => { const [y, m] = k.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }); };
    let last = null; // the last report shown

    /* ---------------- view switch ---------------- */

    function activate(on) {
      show($('#payrep-view'), on);
      show($('#rep-form-card'), !on);
      show($('#rep-result'), !on);
      const b = $('.rep-pay-btn');
      b.classList.toggle('bg-teal-700', on); b.classList.toggle('text-white', on); b.classList.toggle('text-slate-600', !on);
      b.setAttribute('aria-selected', String(on));
      if (on) {
        document.querySelectorAll('.rep-view-btn').forEach((x) => { x.classList.remove('bg-teal-700', 'text-white'); x.classList.add('text-slate-600'); x.setAttribute('aria-selected', 'false'); });
        fillCustomers();
      }
    }

    async function fillCustomers() {
      const sel = $('#payrep-customer');
      const keep = sel.value || 'ALL';
      const list = (await db.customers.toArray()).sort((a, b) => String(a.name).localeCompare(String(b.name)));
      sel.innerHTML = '<option value="ALL">All customers</option>' + list.map((c) => `<option value="${esc(c.customerId)}">${esc(c.name)}${c.status === 'Inactive' ? ' (inactive)' : ''}</option>`).join('');
      sel.value = [...sel.options].some((o) => o.value === keep) ? keep : 'ALL';
    }

    function quick(range) {
      const t = todayLocal();
      const [y, m] = t.split('-').map(Number);
      const key = (d) => d.toISOString().slice(0, 10);
      let from = t, to = t;
      if (range === 'this') from = `${t.slice(0, 7)}-01`;
      else if (range === 'last') { from = key(new Date(Date.UTC(y, m - 2, 1))); to = key(new Date(Date.UTC(y, m - 1, 0))); }
      else if (range === '30') from = key(new Date(Date.UTC(y, m - 1, Number(t.slice(8, 10)) - 29)));
      else if (range === 'year') from = `${y}-01-01`;
      $('#payrep-from').value = from; $('#payrep-to').value = to;
    }

    function setError(m) { const el = $('#payrep-error'); el.textContent = m || ''; show(el, !!m); }

    /* ---------------- run ---------------- */

    async function run() {
      setError('');
      const from = $('#payrep-from').value, to = $('#payrep-to').value;
      if (!from || !to) { setError('Choose the From and To dates.'); return; }
      if (from > to) { setError('The From date is after the To date.'); return; }
      if (!navigator.onLine) { setError('Reports need internet: the full history is kept in Google Sheets.'); return; }
      if (!getSession()) { setError('Sign in first.'); return; }
      const btn = $('#payrep-run');
      btn.disabled = true; btn.textContent = 'Getting the report…';
      try {
        const r = await callServer({ action: 'customerPaymentsReport', customerId: $('#payrep-customer').value, from, to,
          method: $('#payrep-method').value, payStatus: $('#payrep-status').value });
        if (!Array.isArray(r.customers)) throw new Error(r.message || 'the reply has no report');
        last = r;
        render(r);
        $('#payrep-xlsx').disabled = false; $('#payrep-pdf').disabled = false;
      } catch (err) {
        setError('Could not get the report: ' + (err.message || err));
      } finally {
        btn.disabled = false; btn.textContent = 'Show report';
      }
    }

    function filterText(r) {
      return [r.method !== 'ALL' ? `${r.method} only` : '', r.payStatus !== 'ALL' ? `${r.payStatus} only` : ''].filter(Boolean).join(' · ');
    }

    function render(r) {
      const g = r.grand;
      const single = $('#payrep-customer').value !== 'ALL';
      const statusChip = (s) => s === 'Disputed' ? '<span class="text-red-700 font-semibold">Disputed</span>' : s === 'Pending' ? '<span class="text-amber-700">Pending</span>' : esc(s);
      let html = `<div class="bg-white rounded-2xl shadow-sm p-4">
        <p class="text-xs text-slate-500">${esc(fmt(r.from))} to ${esc(fmt(r.to))}${filterText(r) ? ' · ' + esc(filterText(r)) : ''}</p>
        <p class="text-2xl font-bold text-teal-800 mt-1">KES ${money(g.received)}</p>
        <p class="text-xs text-slate-600">received in ${g.count} payment${g.count === 1 ? '' : 's'}${g.pending ? ` · of which pending KES ${money(g.pending)}` : ''}</p>
        <div class="grid grid-cols-3 gap-2 mt-3 text-center text-xs">
          <div class="rounded-lg bg-teal-50 py-1.5">Cash<br><b>${money(g.cash)}</b></div>
          <div class="rounded-lg bg-teal-50 py-1.5">M-Pesa<br><b>${money(g.mpesa)}</b></div>
          <div class="rounded-lg bg-teal-50 py-1.5">Other<br><b>${money(g.other)}</b></div>
        </div>
        ${g.disputed ? `<p class="text-xs text-red-700 mt-2">Disputed, not counted: KES ${money(g.disputed)}</p>` : ''}
      </div>`;
      if (!single && r.customers.length) {
        html += `<div class="bg-white rounded-2xl shadow-sm p-4 overflow-x-auto"><h3 class="text-sm font-bold text-slate-700 mb-2">By customer</h3>
          <table class="w-full text-xs"><thead><tr class="text-slate-500 text-right"><th class="text-left font-semibold">Customer</th><th>No.</th><th>Received</th><th>Disputed</th></tr></thead><tbody>
          ${r.customers.map((c) => `<tr class="border-t border-slate-100 text-right"><td class="text-left py-1">${esc(c.name)}</td><td>${c.totals.count}</td><td class="font-semibold">${money(c.totals.received)}</td><td>${c.totals.disputed ? money(c.totals.disputed) : ''}</td></tr>`).join('')}
          </tbody></table></div>`;
      }
      if (r.months.length > 1) {
        html += `<div class="bg-white rounded-2xl shadow-sm p-4"><h3 class="text-sm font-bold text-slate-700 mb-2">By month</h3>
          <table class="w-full text-xs"><tbody>${r.months.map((m) => `<tr class="border-t border-slate-100 first:border-0"><td class="py-1">${esc(monthName(m.month))}</td><td class="text-right">${m.count}</td><td class="text-right font-semibold">${money(m.received)}</td></tr>`).join('')}</tbody></table></div>`;
      }
      html += r.customers.map((c) => `<div class="bg-white rounded-2xl shadow-sm p-4 overflow-x-auto">
          <h3 class="text-sm font-bold text-slate-700">${esc(c.name)} <span class="font-normal text-slate-400">${esc(c.customerId)}</span></h3>
          <p class="text-xs text-slate-500 mb-2">KES ${money(c.totals.received)} in ${c.totals.count} payment${c.totals.count === 1 ? '' : 's'}</p>
          ${c.lines.length ? `<table class="w-full text-xs whitespace-nowrap"><thead><tr class="text-slate-500 text-right"><th class="text-left font-semibold">Date</th><th>How</th><th>Amount</th><th class="text-left pl-2">Code</th><th>Status</th></tr></thead><tbody>
          ${c.lines.map((l) => `<tr class="border-t border-slate-100 text-right ${l.status === 'Disputed' ? 'bg-red-50' : l.status === 'Pending' ? 'bg-amber-50' : ''}"><td class="text-left py-1">${esc(fmt(l.date))}<br><span class="text-[10px] text-slate-400">${esc(l.paymentId)}${l.linkedSaleId ? ' · sale ' + esc(l.linkedSaleId) : ''}</span></td>
            <td>${[l.cash ? 'Cash' : '', l.mpesa ? 'M-Pesa' : '', l.other ? 'Other' : ''].filter(Boolean).join(' + ')}</td><td class="font-semibold">${money(l.total)}</td>
            <td class="text-left pl-2">${esc(l.receiptRef)}</td><td>${statusChip(l.status)}</td></tr>`).join('')}</tbody></table>` : '<p class="text-xs text-slate-400">No payments in this period.</p>'}
        </div>`).join('');
      if (!r.customers.length) html += '<p class="text-sm text-slate-400 px-1">No payments in this period.</p>';
      $('#payrep-result').innerHTML = html;
    }

    /* ---------------- downloads ---------------- */

    const loaded = {};
    function loadScript(url) {
      if (loaded[url]) return loaded[url];
      loaded[url] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = url; s.onload = resolve; s.onerror = () => { delete loaded[url]; reject(new Error('could not load ' + url.split('/npm/')[1])); };
        document.head.appendChild(s);
      });
      return loaded[url];
    }
    const fileName = (ext) => `Mawe_Tatu_payments_${last.from}_to_${last.to}${$('#payrep-customer').value !== 'ALL' ? '_' + last.customers[0].name.replace(/[^A-Za-z0-9]+/g, '_') : ''}.${ext}`;
    function lineRows() {
      return last.customers.flatMap((c) => c.lines.map((l) => [l.date, c.name, c.customerId, l.paymentId, l.cash, l.mpesa, l.other, l.total, l.receiptRef, l.status, l.linkedSaleId, l.note]));
    }

    async function toExcel() {
      if (!last) return;
      try {
        await loadScript(LIBS.xlsx);
        const X = window.XLSX;
        const wb = X.utils.book_new();
        const g = last.grand;
        const head = [['Mawe Tatu Farm — payments received'], [`${last.from} to ${last.to}${filterText(last) ? ' · ' + filterText(last) : ''}`], [],
          ['Payments', 'Cash (KES)', 'M-Pesa (KES)', 'Other (KES)', 'Received (KES)', 'of which Pending (KES)', 'Disputed, not counted (KES)'],
          [g.count, g.cash, g.mpesa, g.other, g.received, g.pending, g.disputed], [],
          ['Customer', 'ID', 'Payments', 'Cash (KES)', 'M-Pesa (KES)', 'Other (KES)', 'Received (KES)', 'of which Pending (KES)', 'Disputed (KES)']]
          .concat(last.customers.map((c) => [c.name, c.customerId, c.totals.count, c.totals.cash, c.totals.mpesa, c.totals.other, c.totals.received, c.totals.pending, c.totals.disputed]));
        X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(head), 'Summary');
        X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([['Date', 'Customer', 'ID', 'Payment', 'Cash (KES)', 'M-Pesa (KES)', 'Other (KES)', 'Total (KES)', 'Receipt / M-Pesa code', 'Status', 'For sale', 'Note']].concat(lineRows())), 'Payments');
        if (last.months.length) X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([['Month', 'Payments', 'Cash (KES)', 'M-Pesa (KES)', 'Other (KES)', 'Received (KES)', 'Disputed (KES)']]
          .concat(last.months.map((m) => [m.month, m.count, m.cash, m.mpesa, m.other, m.received, m.disputed]))), 'By month');
        X.writeFile(wb, fileName('xlsx'));
      } catch (err) { toast('Excel failed: ' + (err.message || err), 'error'); }
    }

    async function toPdf() {
      if (!last) return;
      try {
        await loadScript(LIBS.jspdf);
        await loadScript(LIBS.autotable);
        const doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4' });
        const g = last.grand;
        const single = $('#payrep-customer').value !== 'ALL';
        doc.setFontSize(15); doc.text('Mawe Tatu Farm — payments received' + (single ? ': ' + last.customers[0].name : ''), 14, 16);
        doc.setFontSize(9);
        doc.text(`${fmt(last.from)} to ${fmt(last.to)}${filterText(last) ? ' · ' + filterText(last) : ''}`, 14, 22);
        doc.text(`Received KES ${money(g.received)} in ${g.count} payment(s): cash ${money(g.cash)} · M-Pesa ${money(g.mpesa)} · other ${money(g.other)}` +
          (g.pending ? ` · pending ${money(g.pending)}` : '') + (g.disputed ? ` · disputed (not counted) ${money(g.disputed)}` : ''), 14, 27, { maxWidth: 182 });
        let y = 34;
        const style = { fontSize: 8, cellPadding: 1.5 };
        const headStyles = { fillColor: [15, 118, 110] };
        if (!single && last.customers.length > 1) {
          doc.autoTable({ startY: y, head: [['Customer', 'Payments', 'Cash', 'M-Pesa', 'Other', 'Received', 'Disputed']], styles: style, headStyles,
            body: last.customers.map((c) => [c.name, c.totals.count, money(c.totals.cash), money(c.totals.mpesa), money(c.totals.other), money(c.totals.received), c.totals.disputed ? money(c.totals.disputed) : ''])
              .concat([['ALL CUSTOMERS', g.count, money(g.cash), money(g.mpesa), money(g.other), money(g.received), g.disputed ? money(g.disputed) : '']]),
            columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'right' } } });
          y = doc.lastAutoTable.finalY + 6;
        }
        doc.autoTable({ startY: y, head: [['Date', ...(single ? [] : ['Customer']), 'Payment', 'Cash', 'M-Pesa', 'Other', 'Total', 'Code', 'Status']], styles: style, headStyles,
          body: last.customers.flatMap((c) => c.lines.map((l) => [fmt(l.date), ...(single ? [] : [c.name]), l.paymentId, l.cash ? money(l.cash) : '', l.mpesa ? money(l.mpesa) : '', l.other ? money(l.other) : '', money(l.total), l.receiptRef, l.status])),
          didParseCell: (d) => { if (d.section === 'body' && d.row.raw[d.row.raw.length - 1] === 'Disputed') d.cell.styles.textColor = [185, 28, 28]; } });
        doc.setFontSize(7);
        doc.text('Received = Verified and Pending payments. Disputed payments are listed but not counted. Made by the Mawe Tatu Dairy app.', 14, 290);
        doc.save(fileName('pdf'));
      } catch (err) { toast('PDF failed: ' + (err.message || err), 'error'); }
    }

    /* ---------------- init ---------------- */

    function init() {
      if (!$('#payrep-view')) return;
      quick('this');
      $('.rep-pay-btn').addEventListener('click', () => activate(true));
      document.querySelectorAll('.rep-view-btn').forEach((b) => b.addEventListener('click', () => activate(false)));
      document.querySelectorAll('.payrep-quick').forEach((b) => b.addEventListener('click', () => quick(b.dataset.range)));
      $('#payrep-run').addEventListener('click', run);
      $('#payrep-xlsx').addEventListener('click', toExcel);
      $('#payrep-pdf').addEventListener('click', toPdf);
      ['#payrep-customer', '#payrep-from', '#payrep-to', '#payrep-method', '#payrep-status'].forEach((s) => $(s).addEventListener('change', () => {
        $('#payrep-xlsx').disabled = true; $('#payrep-pdf').disabled = true;
      }));
    }

    return Object.freeze({ init });
  }

  window.MawePayReport = Object.freeze({ create });
})();
