/* =====================================================================
 * Mawe Tatu Dairy — app.js
 * Local-first storage (Dexie) + sync engine + service worker registration
 * ---------------------------------------------------------------------
 * Loaded by index.html with <script src="app.js" defer>.
 * Depends on the global `Dexie` from the dexie.js CDN script.
 * Works with: sw.js (offline app shell) and Code.gs (Apps Script backend).
 *
 * Sections
 *   1. Configuration  ← paste your Apps Script Web App URL here
 *   2. Constants
 *   3. Database (Dexie / IndexedDB) setup
 *   4. Utility helpers
 *   5. Data-access layer
 *   6. Validation
 *   7. Form submit handlers
 *   8. Tab navigation
 *   9. Status UI: sync badge, header detail, recent lists, ID suggestions
 *  10. Sync engine  (IndexedDB -> Apps Script -> Google Sheets)
 *  11. Service worker registration + update banner
 *  12. Boot
 * ===================================================================== */

(() => {
  'use strict';

  /* ------------------------------------------------------------------
   * 1. CONFIGURATION
   * ------------------------------------------------------------------
   * ENDPOINT_URL: your Apps Script deployment URL. It must end in /exec
   *   (Deploy → Manage deployments → copy "Web app URL").
   *   Until this is filled in, records are kept safely on the phone and the
   *   badge shows "Not set up".
   * API_KEY: optional shared key. If you set API_KEY in the Apps Script
   *   Script Properties, put the same value here. Note: anything in this
   *   file can be read by someone who opens the app, so this only keeps out
   *   casual/random traffic. Google Sign-In (OAuth) replaces it later.
   * ------------------------------------------------------------------ */

  const SYNC_CONFIG = Object.freeze({
    ENDPOINT_URL: 'PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE',
    API_KEY: '',

    BATCH_SIZE: 25,                 // records per POST (Apps Script handles this comfortably)
    REQUEST_TIMEOUT_MS: 30000,      // Apps Script cold starts can take several seconds
    INTERVAL_MS: 60000,             // routine check every 60 s while the app is open
    RETRY_BASE_MS: 30000,           // first retry after a failure…
    RETRY_MAX_MS: 15 * 60000,       // …doubling up to 15 minutes
    SAVE_DEBOUNCE_MS: 2000,         // wait 2 s after a save so quick entries go in one batch
    SYNCED_RETENTION_DAYS: 30,      // synced rows are pruned from the phone after this
  });

  /* ------------------------------------------------------------------
   * 2. CONSTANTS
   * ------------------------------------------------------------------ */

  const DB_NAME = 'MaweTatuDairyDB';

  const STORES = Object.freeze({
    MILK: 'milk_logs',
    CALF: 'calf_logs',
  });

  // pending -> (upload) -> synced
  // pending -> (server rejected the record) -> failed -> retried each run
  const SYNC_STATUS = Object.freeze({
    PENDING: 'pending',
    SYNCED: 'synced',
    FAILED: 'failed',
  });

  // Store -> Google Sheet tab. Must match the tabs in your spreadsheet
  // and the SHEETS config in Code.gs.
  const SHEET_FOR_STORE = Object.freeze({
    [STORES.MILK]: 'Milk_Production',
    [STORES.CALF]: 'Calf_Records',
  });

  // Exactly which fields are sent to the server for each store.
  // Local-only bookkeeping (id, syncStatus, syncAttempts…) is never sent.
  const PAYLOAD_FIELDS = Object.freeze({
    [STORES.MILK]: ['clientId', 'deviceId', 'date', 'cowId', 'session', 'litres', 'createdAt'],
    [STORES.CALF]: ['clientId', 'deviceId', 'date', 'calfId', 'feedType', 'quantityKg', 'createdAt'],
  });

  // The three daily milkings at Mawe Tatu: ~5:00 am, ~1:00 pm, ~8:30 pm.
  // Values must match the <option value="..."> entries in index.html and Code.gs.
  const MILK_SESSIONS = Object.freeze(['Morning', 'Afternoon', 'Evening']);
  const FEED_TYPES = Object.freeze(['Pellets', 'Hay', 'Milk']);

  const RECENT_LIMIT = 5;                   // rows shown under each form
  const TAB_KEY = 'mt_active_tab';          // localStorage: last-opened tab
  const DEVICE_KEY = 'mt_device_id';        // localStorage: this phone's ID
  const LAST_SYNC_KEY = 'mt_last_sync_at';  // localStorage: last successful sync time
  const SYNC_LOCK_NAME = 'mawe-tatu-sync';  // Web Locks name (one sync across all tabs)

  /* ------------------------------------------------------------------
   * 3. DATABASE SETUP (Dexie)
   * ------------------------------------------------------------------
   *   ++id                    auto-increment primary key (local only)
   *   &clientId               UNIQUE UUID made on the phone. Sent to Apps
   *                           Script, which skips any clientId it already
   *                           has — so a retry can never create a duplicate row.
   *   syncStatus              finds pending/failed rows quickly
   *   [cowId+session+date]    duplicate-entry warning on the form
   *
   * If you ever change this schema, ADD db.version(2).stores({...}) below —
   * never edit version(1) once phones have data in it.
   * ------------------------------------------------------------------ */

  const db = new Dexie(DB_NAME);

  db.version(1).stores({
    [STORES.MILK]: '++id, &clientId, syncStatus, date, cowId, [cowId+session+date], createdAt',
    [STORES.CALF]: '++id, &clientId, syncStatus, date, calfId, [calfId+feedType+date], createdAt',
  });

  /* ------------------------------------------------------------------
   * 4. UTILITY HELPERS
   * ------------------------------------------------------------------ */

  const $ = (sel) => document.querySelector(sel);

  /** Today's date as YYYY-MM-DD in the phone's local time zone. */
  function todayLocal() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  /** Likely milking session from the clock (cut-offs halfway between milkings):
   *  before 9:00 → Morning (5 am) · 9:00–16:59 → Afternoon (1 pm) · 17:00+ → Evening (8:30 pm) */
  function guessMilkSession(now = new Date()) {
    const h = now.getHours();
    if (h < 9) return 'Morning';
    if (h < 17) return 'Afternoon';
    return 'Evening';
  }

  /** UUID for clientId (fallback for non-secure contexts without crypto.randomUUID). */
  function makeUUID() {
    if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  /** Safe localStorage access (it can throw in private mode). */
  function lsGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
  function lsSet(key, val) { try { localStorage.setItem(key, val); } catch { /* ignore */ } }

  /** A stable ID per phone, so you can tell which device logged a record. */
  function getDeviceId() {
    let id = lsGet(DEVICE_KEY);
    if (!id) { id = 'dev-' + makeUUID().slice(0, 8); lsSet(DEVICE_KEY, id); }
    return id;
  }

  /** Escape text before inserting into innerHTML. */
  function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  const round1 = (n) => Math.round(n * 10) / 10;

  /** "21:42" for today, "28 Oct 21:42" otherwise. */
  function formatSyncTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const sameDay = d.toDateString() === new Date().toDateString();
    return sameDay ? time : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
  }

  /** Small toast message at the bottom of the screen. */
  let toastTimer;
  function toast(message, type = 'success') {
    const el = $('#toast');
    const colours = { success: 'bg-farm-700', error: 'bg-red-600', info: 'bg-slate-700' };
    el.className = `fixed left-1/2 -translate-x-1/2 bottom-6 z-30 max-w-[90vw] rounded-xl px-4 py-3 text-sm font-semibold text-white shadow-lg ${colours[type] || colours.info}`;
    el.textContent = message;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
  }

  function showFormError(prefix, message) {
    const el = $(`#${prefix}-error`);
    if (!message) { el.classList.add('hidden'); el.textContent = ''; return; }
    el.textContent = message;
    el.classList.remove('hidden');
  }

  /* ------------------------------------------------------------------
   * 5. DATA-ACCESS LAYER
   * ------------------------------------------------------------------ */

  // Records currently being uploaded, as "store:id". Used to stop a record
  // from being deleted while its POST is in flight (it may already be in
  // the sheet by the time the response arrives).
  const inFlight = new Set();
  const flightKey = (storeName, id) => `${storeName}:${id}`;

  function baseMeta() {
    const now = new Date().toISOString();
    return {
      clientId: makeUUID(),
      deviceId: getDeviceId(),
      createdAt: now,
      updatedAt: now,
      syncStatus: SYNC_STATUS.PENDING,
      syncAttempts: 0,
      lastError: null,
      syncedAt: null,
    };
  }

  async function addMilkLog({ cowId, session, litres, date }) {
    const record = { ...baseMeta(), cowId, session, litres, date };
    record.id = await db[STORES.MILK].add(record);
    return record;
  }

  async function addCalfLog({ calfId, feedType, quantityKg, date }) {
    const record = { ...baseMeta(), calfId, feedType, quantityKg, date };
    record.id = await db[STORES.CALF].add(record);
    return record;
  }

  function findMilkDuplicate(cowId, session, date) {
    return db[STORES.MILK].where('[cowId+session+date]').equals([cowId, session, date]).first();
  }

  function findCalfDuplicate(calfId, feedType, date) {
    return db[STORES.CALF].where('[calfId+feedType+date]').equals([calfId, feedType, date]).first();
  }

  /** Records still needing upload (pending + failed), oldest first. */
  function getPending(storeName) {
    return db[storeName]
      .where('syncStatus').anyOf(SYNC_STATUS.PENDING, SYNC_STATUS.FAILED)
      .sortBy('createdAt');
  }

  async function countPending() {
    const statuses = [SYNC_STATUS.PENDING, SYNC_STATUS.FAILED];
    const [m, c] = await Promise.all([
      db[STORES.MILK].where('syncStatus').anyOf(statuses).count(),
      db[STORES.CALF].where('syncStatus').anyOf(statuses).count(),
    ]);
    return m + c;
  }

  /** Mark rows as uploaded — called ONLY after the server confirmed them. */
  function markSynced(storeName, ids) {
    if (!ids.length) return Promise.resolve(0);
    const now = new Date().toISOString();
    return db[storeName].where(':id').anyOf(ids).modify({
      syncStatus: SYNC_STATUS.SYNCED, syncedAt: now, updatedAt: now, lastError: null,
    });
  }

  /** Mark rows as failed; they stay in the queue and are retried next run. */
  function markFailed(storeName, ids, errorMessage) {
    if (!ids.length) return Promise.resolve(0);
    return db[storeName].where(':id').anyOf(ids).modify((rec) => {
      rec.syncStatus = SYNC_STATUS.FAILED;
      rec.syncAttempts = (rec.syncAttempts || 0) + 1;
      rec.lastError = String(errorMessage || 'Unknown error').slice(0, 200);
      rec.updatedAt = new Date().toISOString();
    });
  }

  /** Delete a record — only before it has been synced and not while uploading. */
  async function deleteUnsynced(storeName, id) {
    if (inFlight.has(flightKey(storeName, id))) {
      throw new Error('This entry is uploading right now. Try again in a moment.');
    }
    const rec = await db[storeName].get(id);
    if (!rec) return false;
    if (rec.syncStatus === SYNC_STATUS.SYNCED) {
      throw new Error('This record is already in Google Sheets; correct it there.');
    }
    await db[storeName].delete(id);
    return true;
  }

  /** Remove synced rows older than the retention window to keep the phone light.
   *  Pending/failed rows are NEVER pruned. */
  function pruneSynced(storeName) {
    const cutoff = new Date(Date.now() - SYNC_CONFIG.SYNCED_RETENTION_DAYS * 86400000).toISOString();
    return db[storeName]
      .where('syncStatus').equals(SYNC_STATUS.SYNCED)
      .filter((r) => !!r.syncedAt && r.syncedAt < cutoff)
      .delete();
  }

  /* ------------------------------------------------------------------
   * 6. VALIDATION
   * ------------------------------------------------------------------ */

  const ID_PATTERN = /^[A-Z0-9][A-Z0-9\-_/ ]{0,19}$/;

  function validateDate(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return 'Please pick a date.';
    if (date > todayLocal()) return 'Date cannot be in the future.';
    return null;
  }

  function validateMilk(form) {
    const cowId = form.cowId.value.trim().toUpperCase();
    const session = form.session.value;
    const litres = parseFloat(form.litres.value);
    const date = form.date.value;

    if (!cowId) return { ok: false, error: 'Cow ID is required.' };
    if (!ID_PATTERN.test(cowId)) return { ok: false, error: 'Cow ID: use letters, numbers, - or _ (max 20).' };
    if (!MILK_SESSIONS.includes(session)) return { ok: false, error: 'Choose Morning, Afternoon or Evening.' };
    if (!Number.isFinite(litres) || litres <= 0) return { ok: false, error: 'Enter litres greater than 0.' };
    if (litres > 60) return { ok: false, error: 'Litres look too high for one session (max 60).' };
    const dateErr = validateDate(date);
    if (dateErr) return { ok: false, error: dateErr };

    return { ok: true, data: { cowId, session, litres: round1(litres), date } };
  }

  function validateCalf(form) {
    const calfId = form.calfId.value.trim().toUpperCase();
    const feedType = form.feedType.value;
    const quantityKg = parseFloat(form.quantityKg.value);
    const date = form.date.value;

    if (!calfId) return { ok: false, error: 'Calf ID is required.' };
    if (!ID_PATTERN.test(calfId)) return { ok: false, error: 'Calf ID: use letters, numbers, - or _ (max 20).' };
    if (!FEED_TYPES.includes(feedType)) return { ok: false, error: 'Choose a feed type.' };
    if (!Number.isFinite(quantityKg) || quantityKg <= 0) return { ok: false, error: 'Enter a quantity greater than 0.' };
    if (quantityKg > 50) return { ok: false, error: 'Quantity looks too high (max 50 kg).' };
    const dateErr = validateDate(date);
    if (dateErr) return { ok: false, error: dateErr };

    return { ok: true, data: { calfId, feedType, quantityKg: round1(quantityKg), date } };
  }

  /* ------------------------------------------------------------------
   * 7. FORM SUBMIT HANDLERS
   * ------------------------------------------------------------------
   * validate -> duplicate check -> save to IndexedDB -> reset -> queue sync.
   * The record is safe on the phone the moment add() resolves; the upload
   * happens separately and never blocks the form.
   * ------------------------------------------------------------------ */

  async function handleMilkSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const btn = form.querySelector('button[type="submit"]');
    showFormError('milk', null);

    const result = validateMilk(form);
    if (!result.ok) { showFormError('milk', result.error); return; }
    const { cowId, session, date } = result.data;

    btn.disabled = true;
    try {
      const dup = await findMilkDuplicate(cowId, session, date);
      if (dup && !confirm(`${cowId} already has ${dup.litres} L for ${session} on ${date}.\nSave another entry anyway?`)) {
        return;
      }

      await addMilkLog(result.data);
      toast(`Saved: ${cowId} · ${result.data.litres} L (${session})`);

      form.cowId.value = '';
      form.litres.value = '';
      form.cowId.focus();

      requestSync('new-record', SYNC_CONFIG.SAVE_DEBOUNCE_MS);
    } catch (err) {
      console.error('Milk save failed:', err);
      toast('Could not save on this phone: ' + (err.message || err), 'error');
    } finally {
      btn.disabled = false;
    }
  }

  async function handleCalfSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const btn = form.querySelector('button[type="submit"]');
    showFormError('calf', null);

    const result = validateCalf(form);
    if (!result.ok) { showFormError('calf', result.error); return; }
    const { calfId, feedType, date } = result.data;

    btn.disabled = true;
    try {
      const dup = await findCalfDuplicate(calfId, feedType, date);
      if (dup && !confirm(`${calfId} already has ${dup.quantityKg} kg of ${feedType} on ${date}.\nSave another feeding anyway?`)) {
        return;
      }

      await addCalfLog(result.data);
      toast(`Saved: ${calfId} · ${result.data.quantityKg} kg ${feedType}`);

      form.calfId.value = '';
      form.quantityKg.value = '';
      form.calfId.focus();

      requestSync('new-record', SYNC_CONFIG.SAVE_DEBOUNCE_MS);
    } catch (err) {
      console.error('Calf save failed:', err);
      toast('Could not save on this phone: ' + (err.message || err), 'error');
    } finally {
      btn.disabled = false;
    }
  }

  /* ------------------------------------------------------------------
   * 8. TAB NAVIGATION
   * ------------------------------------------------------------------ */

  const TAB_STYLES = {
    milk: { active: ['bg-farm-700', 'text-white', 'shadow'], idle: ['text-slate-600', 'hover:bg-slate-100'] },
    calf: { active: ['bg-calf-600', 'text-white', 'shadow'], idle: ['text-slate-600', 'hover:bg-slate-100'] },
  };

  function activateTab(name) {
    if (!TAB_STYLES[name]) name = 'milk';

    document.querySelectorAll('.tab-btn').forEach((btn) => {
      const tab = btn.dataset.tab;
      const isActive = tab === name;
      const styles = TAB_STYLES[tab];
      btn.classList.remove(...styles.active, ...styles.idle);
      btn.classList.add(...(isActive ? styles.active : styles.idle));
      btn.setAttribute('aria-selected', String(isActive));
      $(`#panel-${tab}`).classList.toggle('hidden', !isActive);
    });

    lsSet(TAB_KEY, name);
  }

  /* ------------------------------------------------------------------
   * 9. STATUS UI
   * ------------------------------------------------------------------
   * One state object drives the header badge and detail line, so the
   * network, sync and pending-count updates can never contradict each other.
   *   sync: 'idle' | 'syncing' | 'error' | 'unconfigured'
   * ------------------------------------------------------------------ */

  const status = {
    pending: 0,
    online: navigator.onLine,
    sync: 'idle',
    lastError: null,
    lastSyncAt: lsGet(LAST_SYNC_KEY),
  };

  function setStatus(patch) {
    Object.assign(status, patch);
    renderStatus();
  }

  const DOT_CLASSES = ['bg-slate-300', 'bg-green-300', 'bg-red-400', 'bg-yellow-200', 'bg-orange-300', 'animate-pulse'];
  const BADGE_BG = ['bg-white/15', 'bg-calf-500', 'bg-farm-600'];

  function renderStatus() {
    const { pending, online, sync, lastError, lastSyncAt } = status;

    let dot, label, detail;
    if (sync === 'unconfigured') {
      dot = ['bg-slate-300']; label = 'Not set up';
      detail = 'Add the Apps Script URL in app.js to start uploading';
    } else if (!online) {
      dot = ['bg-red-400']; label = 'Offline';
      detail = pending ? 'Saved on this phone · uploads when back online' : 'Offline · everything is uploaded';
    } else if (sync === 'syncing') {
      dot = ['bg-yellow-200', 'animate-pulse']; label = 'Syncing…';
      detail = `Uploading ${pending} record${pending === 1 ? '' : 's'}…`;
    } else if (sync === 'error') {
      dot = ['bg-orange-300']; label = 'Sync error';
      detail = lastError ? `Will retry · ${lastError}` : 'Will retry automatically';
    } else {
      dot = ['bg-green-300']; label = 'Online';
      detail = lastSyncAt ? `Last sync ${formatSyncTime(lastSyncAt)}` : 'Not synced yet';
    }

    const dotEl = $('#network-dot');
    dotEl.classList.remove(...DOT_CLASSES);
    dotEl.classList.add(...dot);
    $('#network-label').textContent = label;
    $('#pending-count').textContent = pending;
    $('#sync-detail').textContent = detail;

    const badge = $('#sync-badge');
    badge.classList.remove(...BADGE_BG);
    badge.classList.add(pending > 0 ? 'bg-calf-500' : 'bg-farm-600');
    badge.title = `${detail}. Tap to sync now.`;
    badge.setAttribute('aria-label', `${label}. ${pending} pending. ${detail}. Tap to sync now.`);
  }

  const STATUS_CHIP = {
    pending: '<span class="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-calf-100 text-calf-700">Pending</span>',
    failed: '<span class="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-red-100 text-red-700">Retrying</span>',
    synced: '<span class="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-farm-100 text-farm-800">Synced</span>',
  };

  function renderRecent(listEl, records, describe, storeName) {
    if (!records.length) {
      listEl.innerHTML = '<li class="text-sm text-slate-400 px-1">No entries yet.</li>';
      return;
    }
    listEl.innerHTML = records.map((r) => {
      const canDelete = r.syncStatus !== SYNC_STATUS.SYNCED;
      const errorLine = r.syncStatus === SYNC_STATUS.FAILED && r.lastError
        ? `<p class="text-xs text-red-600 truncate" title="${esc(r.lastError)}">${esc(r.lastError)}</p>`
        : '';
      return `
        <li class="flex items-center justify-between gap-3 bg-white rounded-xl px-4 py-3 shadow-sm">
          <div class="min-w-0">
            <p class="font-semibold text-sm truncate">${describe(r)}</p>
            <p class="text-xs text-slate-500">${esc(r.date)}</p>
            ${errorLine}
          </div>
          <div class="flex items-center gap-2 shrink-0">
            ${STATUS_CHIP[r.syncStatus] || ''}
            ${canDelete ? `<button type="button" class="del-btn text-slate-400 hover:text-red-600 text-lg leading-none px-1"
                 data-store="${storeName}" data-id="${r.id}" aria-label="Delete entry">&times;</button>` : ''}
          </div>
        </li>`;
    }).join('');
  }

  function fillDatalist(el, ids) {
    el.innerHTML = ids.map((id) => `<option value="${esc(id)}"></option>`).join('');
  }

  /** liveQuery re-runs whenever the tables it read change — including when
   *  the sync engine marks rows synced — so the UI never needs manual refresh. */
  function startLiveViews() {
    const { liveQuery } = Dexie;

    liveQuery(countPending).subscribe({
      next: (pending) => setStatus({ pending }),
      error: (e) => console.error('Badge query failed:', e),
    });

    liveQuery(() => db[STORES.MILK].orderBy('createdAt').reverse().limit(RECENT_LIMIT).toArray())
      .subscribe({
        next: (rows) => renderRecent($('#milk-recent'), rows,
          (r) => `${esc(r.cowId)} · ${r.litres} L <span class="font-normal text-slate-500">${esc(r.session)}</span>`,
          STORES.MILK),
        error: (e) => console.error('Milk list query failed:', e),
      });

    liveQuery(() => db[STORES.CALF].orderBy('createdAt').reverse().limit(RECENT_LIMIT).toArray())
      .subscribe({
        next: (rows) => renderRecent($('#calf-recent'), rows,
          (r) => `${esc(r.calfId)} · ${r.quantityKg} kg <span class="font-normal text-slate-500">${esc(r.feedType)}</span>`,
          STORES.CALF),
        error: (e) => console.error('Calf list query failed:', e),
      });

    liveQuery(() => db[STORES.MILK].orderBy('cowId').uniqueKeys())
      .subscribe({ next: (ids) => fillDatalist($('#cow-suggestions'), ids) });
    liveQuery(() => db[STORES.CALF].orderBy('calfId').uniqueKeys())
      .subscribe({ next: (ids) => fillDatalist($('#calf-suggestions'), ids) });
  }

  async function handleListClick(event) {
    const btn = event.target.closest('.del-btn');
    if (!btn) return;
    if (!confirm('Delete this entry from the phone? It has not been uploaded yet.')) return;
    try {
      await deleteUnsynced(btn.dataset.store, Number(btn.dataset.id));
      toast('Entry deleted', 'info');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* ------------------------------------------------------------------
   * 10. SYNC ENGINE
   * ------------------------------------------------------------------
   * When it runs:
   *   • on app start, and when the phone comes back online ('online' event)
   *   • when the app returns to the foreground (visibilitychange)
   *   • 2 s after a record is saved (debounced, so a run of entries is one batch)
   *   • every 60 s while the app is open
   *   • when the badge is tapped ("Sync now")
   *   • after a failure: retry with exponential backoff (30 s → 15 min)
   *
   * How a run works:
   *   1. For each store, take a snapshot of pending + failed rows.
   *   2. POST them in batches of 25 to Apps Script.
   *   3. Only rows the server explicitly confirms ('saved' or 'duplicate')
   *      are marked synced. Rejected rows are marked failed with the reason.
   *      Rows the server did not mention stay pending.
   *   4. A network error (offline, timeout) leaves rows untouched: they
   *      were not confirmed, so they will simply be sent again.
   *
   * Why resending is safe: every row carries a clientId and Code.gs skips
   * clientIds already in the sheet. If the sheet was written but the
   * response was lost, the retry comes back as 'duplicate' and the row is
   * then marked synced — never written twice.
   *
   * Server contract (Code.gs):
   *   Request  (POST, Content-Type text/plain to avoid a CORS preflight,
   *            which Apps Script cannot answer):
   *     { action: 'appendRecords', apiKey, sheet, records: [ {...}, … ] }
   *   Response:
   *     { status: 'success', results: [ { clientId, status: 'saved'|'duplicate'|'rejected', error? } ] }
   *     { status: 'error', message }
   * ------------------------------------------------------------------ */

  class SyncError extends Error {
    /** kind: 'network' (rows untouched, retry later) | 'server' (rows marked failed) */
    constructor(message, kind) {
      super(message);
      this.name = 'SyncError';
      this.kind = kind;
    }
  }

  const sync = {
    timer: null,
    running: false,
    rerunRequested: false,
    consecutiveFailures: 0,
  };

  function isEndpointConfigured() {
    return /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(SYNC_CONFIG.ENDPOINT_URL.trim());
  }

  /** Schedule a sync run after `delayMs`. A newer request replaces an older one. */
  function requestSync(reason, delayMs = 0) {
    clearTimeout(sync.timer);
    sync.timer = setTimeout(() => runSync(reason), delayMs);
  }

  function backoffDelay(failures) {
    const exp = Math.min(SYNC_CONFIG.RETRY_MAX_MS, SYNC_CONFIG.RETRY_BASE_MS * 2 ** Math.max(0, failures - 1));
    return Math.round(exp * (0.8 + Math.random() * 0.4)); // ±20 % jitter
  }

  /** Run fn under a cross-tab lock so two open tabs never upload the same rows.
   *  Returns { skipped: true } if another tab is already syncing. */
  async function withSyncLock(fn) {
    if (navigator.locks && typeof navigator.locks.request === 'function') {
      return navigator.locks.request(SYNC_LOCK_NAME, { ifAvailable: true }, async (lock) => {
        if (!lock) return { skipped: true };
        return fn();
      });
    }
    return fn();
  }

  async function runSync(reason) {
    clearTimeout(sync.timer);

    if (!isEndpointConfigured()) {
      setStatus({ sync: 'unconfigured' });
      return; // nothing scheduled: there is nowhere to send data
    }
    if (!navigator.onLine) {
      setStatus({ online: false, sync: 'idle' });
      return; // the 'online' event will restart syncing
    }
    if (sync.running) {
      sync.rerunRequested = true; // run again as soon as the current run ends
      return;
    }

    sync.running = true;
    let nextDelay = SYNC_CONFIG.INTERVAL_MS;

    try {
      const pendingNow = await countPending();
      if (pendingNow === 0) {
        setStatus({ sync: 'idle', lastError: null });
      } else {
        setStatus({ sync: 'syncing' });
        const outcome = await withSyncLock(syncAllStores);

        if (!outcome.skipped) {
          const now = new Date().toISOString();
          lsSet(LAST_SYNC_KEY, now);
          sync.consecutiveFailures = 0;

          if (outcome.rejected > 0) {
            setStatus({
              sync: 'error',
              lastSyncAt: now,
              lastError: `${outcome.rejected} record${outcome.rejected === 1 ? ' was' : 's were'} rejected — see the red notes`,
            });
          } else {
            setStatus({ sync: 'idle', lastSyncAt: now, lastError: null });
          }
          if (outcome.uploaded > 0 && reason === 'manual') {
            toast(`Uploaded ${outcome.uploaded} record${outcome.uploaded === 1 ? '' : 's'}`);
          }
        } else {
          setStatus({ sync: 'idle' });
        }
      }

      // Housekeeping runs whatever the pending count is.
      await Promise.all(Object.values(STORES).map(pruneSynced));
    } catch (err) {
      sync.consecutiveFailures += 1;
      nextDelay = backoffDelay(sync.consecutiveFailures);
      const msg = err instanceof SyncError ? err.message : `Unexpected error: ${err.message || err}`;
      console.warn(`Sync failed (${reason}); retry in ${Math.round(nextDelay / 1000)} s:`, err);
      setStatus({ sync: 'error', lastError: msg });
      if (reason === 'manual') toast(`Sync failed: ${msg}`, 'error');
    } finally {
      sync.running = false;
    }

    if (sync.rerunRequested) {
      sync.rerunRequested = false;
      requestSync('rerun', 0);
    } else if (navigator.onLine) {
      requestSync('interval', nextDelay);
    }
  }

  /** Upload every store. Throws SyncError on a network/server failure. */
  async function syncAllStores() {
    const totals = { uploaded: 0, rejected: 0 };
    for (const storeName of Object.values(STORES)) {
      const { uploaded, rejected } = await syncStore(storeName);
      totals.uploaded += uploaded;
      totals.rejected += rejected;
    }
    return totals;
  }

  async function syncStore(storeName) {
    // Snapshot once per run, so a row the server keeps rejecting cannot loop forever.
    const rows = await getPending(storeName);
    const totals = { uploaded: 0, rejected: 0 };

    for (let i = 0; i < rows.length; i += SYNC_CONFIG.BATCH_SIZE) {
      const batch = rows.slice(i, i + SYNC_CONFIG.BATCH_SIZE);
      const keys = batch.map((r) => flightKey(storeName, r.id));
      keys.forEach((k) => inFlight.add(k));

      try {
        // Re-read the batch: a row may have been deleted while earlier batches uploaded.
        const live = (await db[storeName].bulkGet(batch.map((r) => r.id)))
          .filter((r) => r && r.syncStatus !== SYNC_STATUS.SYNCED);
        if (!live.length) continue;

        let results;
        try {
          results = await postBatch(storeName, live);
        } catch (err) {
          if (err instanceof SyncError && err.kind === 'server') {
            await markFailed(storeName, live.map((r) => r.id), err.message);
          }
          throw err; // stop this run; runSync schedules the retry
        }

        const { uploaded, rejected } = await applyResults(storeName, live, results);
        totals.uploaded += uploaded;
        totals.rejected += rejected;
      } finally {
        keys.forEach((k) => inFlight.delete(k));
      }
    }
    return totals;
  }

  /** Build the minimal payload for one row. */
  function toPayload(storeName, record) {
    const out = {};
    for (const field of PAYLOAD_FIELDS[storeName]) out[field] = record[field];
    return out;
  }

  /** POST one batch. Returns the server's results array or throws SyncError. */
  async function postBatch(storeName, records) {
    const body = JSON.stringify({
      action: 'appendRecords',
      apiKey: SYNC_CONFIG.API_KEY,
      sheet: SHEET_FOR_STORE[storeName],
      records: records.map((r) => toPayload(storeName, r)),
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SYNC_CONFIG.REQUEST_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(SYNC_CONFIG.ENDPOINT_URL.trim(), {
        method: 'POST',
        // text/plain keeps this a "simple" CORS request (no OPTIONS preflight).
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body,
        redirect: 'follow',  // Apps Script answers via a 302 to googleusercontent.com
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new SyncError('Server took too long to answer', 'network');
      }
      // TypeError: no connection, DNS failure — or the deployment is not
      // shared with "Anyone" (Google then redirects to a sign-in page,
      // which the browser blocks as a CORS failure).
      throw new SyncError('Could not reach Google Sheets', 'network');
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const kind = response.status >= 500 || response.status === 429 ? 'network' : 'server';
      throw new SyncError(`Server replied HTTP ${response.status}`, kind);
    }

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // Apps Script returns an HTML page for script errors, missing doPost,
      // or access problems — all of which need fixing on the server side.
      throw new SyncError('Unexpected reply from Apps Script (check the deployment)', 'server');
    }

    if (data && data.status === 'error') {
      throw new SyncError(data.message || 'Apps Script reported an error', 'server');
    }
    if (!data || data.status !== 'success' || !Array.isArray(data.results)) {
      throw new SyncError('Apps Script reply is missing the results list', 'server');
    }
    return data.results;
  }

  /** Apply per-row results. Only explicitly confirmed rows become 'synced'. */
  async function applyResults(storeName, records, results) {
    const byClientId = new Map(
      results.filter((r) => r && typeof r.clientId === 'string').map((r) => [r.clientId, r]),
    );

    const syncedIds = [];
    const rejected = []; // [id, message]
    const unconfirmedIds = [];

    for (const rec of records) {
      const res = byClientId.get(rec.clientId);
      if (!res) unconfirmedIds.push(rec.id);
      else if (res.status === 'saved' || res.status === 'duplicate') syncedIds.push(rec.id);
      else if (res.status === 'rejected') rejected.push([rec.id, res.error || 'Rejected by server']);
      else unconfirmedIds.push(rec.id);
    }

    await db.transaction('rw', db[storeName], async () => {
      await markSynced(storeName, syncedIds);
      for (const [id, message] of rejected) await markFailed(storeName, [id], message);
      await markFailed(storeName, unconfirmedIds, 'Server did not confirm this record');
    });

    return { uploaded: syncedIds.length, rejected: rejected.length + unconfirmedIds.length };
  }

  function handleOnline() {
    setStatus({ online: true });
    sync.consecutiveFailures = 0; // fresh connection: don't wait out an old backoff
    requestSync('online', 0);
  }

  function handleOffline() {
    clearTimeout(sync.timer);
    setStatus({ online: false });
  }

  function handleVisibility() {
    if (document.visibilityState === 'visible') {
      setStatus({ online: navigator.onLine });
      requestSync('foreground', 0);
      checkForAppUpdate();
    }
  }

  function handleBadgeTap() {
    if (!isEndpointConfigured()) {
      toast('Sync is not set up yet: add the Apps Script URL in app.js', 'info');
      return;
    }
    if (!navigator.onLine) {
      toast('You are offline. Records are safe on this phone.', 'info');
      return;
    }
    sync.consecutiveFailures = 0;
    requestSync('manual', 0);
  }

  /* ------------------------------------------------------------------
   * 11. SERVICE WORKER REGISTRATION + UPDATE BANNER
   * ------------------------------------------------------------------
   * sw.js caches the app shell so the app opens with no signal at all.
   * Service workers only run on HTTPS (or http://localhost).
   *
   * Updates: when you change any app file, bump CACHE_VERSION in sw.js.
   * Phones download the new version in the background and show a
   * "Reload" banner; the switch happens only when the user taps it.
   * ------------------------------------------------------------------ */

  let swRegistration = null;
  let userAcceptedUpdate = false;

  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) {
      console.warn('Service workers not supported: the app will not open offline.');
      return;
    }
    if (!window.isSecureContext) {
      console.warn('Service worker needs HTTPS (or localhost): the app will not open offline.');
      return;
    }

    try {
      // Relative path + scope so it also works from a sub-folder (e.g. GitHub Pages).
      // updateViaCache 'none': always check the server for a new sw.js.
      swRegistration = await navigator.serviceWorker.register('./sw.js', {
        scope: './',
        updateViaCache: 'none',
      });
    } catch (err) {
      console.error('Service worker registration failed:', err);
      return;
    }

    // An update downloaded on a previous visit may already be waiting.
    if (swRegistration.waiting && navigator.serviceWorker.controller) {
      showUpdateBanner(swRegistration.waiting);
    }

    swRegistration.addEventListener('updatefound', () => {
      const incoming = swRegistration.installing;
      if (!incoming) return;
      incoming.addEventListener('statechange', () => {
        // 'installed' + an existing controller = an update (not the first install).
        if (incoming.state === 'installed' && navigator.serviceWorker.controller) {
          showUpdateBanner(incoming);
        }
      });
    });

    // Reload once the new worker takes control — but only if the user asked
    // for it. (The first install also fires this event; we ignore that.)
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!userAcceptedUpdate || reloading) return;
      reloading = true;
      window.location.reload();
    });

    // Long-open tabs: look for updates hourly.
    setInterval(checkForAppUpdate, 60 * 60 * 1000);
  }

  function checkForAppUpdate() {
    if (swRegistration && navigator.onLine) {
      swRegistration.update().catch(() => { /* offline or server down: try later */ });
    }
  }

  function showUpdateBanner(waitingWorker) {
    const banner = $('#update-banner');
    banner.classList.remove('hidden');
    $('#update-reload').onclick = () => {
      userAcceptedUpdate = true;
      banner.classList.add('hidden');
      waitingWorker.postMessage({ type: 'SKIP_WAITING' });
    };
  }

  /* ------------------------------------------------------------------
   * Public API for the browser console / future modules, e.g.
   *   await FarmDB.getPending('milk_logs')
   *   FarmDB.syncNow()
   * ------------------------------------------------------------------ */
  window.FarmDB = Object.freeze({
    db, STORES, SYNC_STATUS, SHEET_FOR_STORE, MILK_SESSIONS, FEED_TYPES,
    addMilkLog, addCalfLog, getPending, countPending,
    markSynced, markFailed, deleteUnsynced,
    syncNow: () => requestSync('manual', 0),
  });

  /* ------------------------------------------------------------------
   * 12. BOOT
   * ------------------------------------------------------------------ */

  async function init() {
    // Register the service worker first: even if storage fails below, the
    // app shell should still be cached for next time.
    registerServiceWorker();

    if (typeof Dexie === 'undefined') {
      toast('Storage library failed to load. Connect once to set up the app.', 'error');
      return;
    }

    try {
      await db.open();
    } catch (err) {
      console.error('IndexedDB open failed:', err);
      toast('This browser blocked local storage. Avoid private/incognito mode.', 'error');
      return;
    }

    // Ask the browser not to evict our data when the phone runs low on space.
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().then((granted) => {
        console.info('Persistent storage:', granted ? 'granted' : 'not granted (best-effort)');
      });
    }

    const today = todayLocal();
    ['#milk-date', '#calf-date'].forEach((sel) => {
      const el = $(sel);
      el.value = today;
      el.max = today;
    });
    $('#milk-session').value = guessMilkSession();

    $('#milk-form').addEventListener('submit', handleMilkSubmit);
    $('#calf-form').addEventListener('submit', handleCalfSubmit);
    document.querySelectorAll('.tab-btn').forEach((btn) =>
      btn.addEventListener('click', () => activateTab(btn.dataset.tab)));
    $('#milk-recent').addEventListener('click', handleListClick);
    $('#calf-recent').addEventListener('click', handleListClick);
    $('#sync-badge').addEventListener('click', handleBadgeTap);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    document.addEventListener('visibilitychange', handleVisibility);

    activateTab(lsGet(TAB_KEY) || 'milk');
    setStatus({ online: navigator.onLine, sync: isEndpointConfigured() ? 'idle' : 'unconfigured' });
    startLiveViews();

    requestSync('startup', 0);
  }

  init();
})();
