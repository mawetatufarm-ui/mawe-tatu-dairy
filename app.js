/* =====================================================================
 * Mawe Tatu Dairy — app.js
 * Local-first storage (Dexie) + Google Sign-In + sync engine + service worker
 * ---------------------------------------------------------------------
 * Loaded by index.html with <script src="app.js" defer>.
 * Depends on: the global `Dexie` (dexie.js CDN) and, when online, the
 * Google Identity Services script (#gis-script in index.html).
 * Works with: sw.js (offline app shell) and Code.gs (Apps Script backend).
 *
 * Sections
 *   1. Configuration  ← paste your Apps Script URL and Google Client ID here
 *   2. Constants
 *   3. Database (Dexie / IndexedDB) setup
 *   4. Utility helpers
 *   5. Data-access layer
 *   6. Validation
 *   7. Form submit handlers
 *   8. Tab navigation
 *   9. Status UI: sync badge, header detail, recent lists, ID suggestions
 *  10. Authentication (Google Sign-In, offline session, logout)
 *  11. Sync engine  (IndexedDB -> Apps Script -> Google Sheets)
 *  12. Service worker registration + update banner
 *  13. Boot
 * ===================================================================== */

(() => {
  'use strict';

  /* ------------------------------------------------------------------
   * 1. CONFIGURATION
   * ------------------------------------------------------------------
   * ENDPOINT_URL: your Apps Script deployment URL, ending in /exec
   *   (Deploy → Manage deployments → copy "Web app URL").
   * GOOGLE_CLIENT_ID: the OAuth 2.0 Web client ID from Google Cloud
   *   Console (APIs & Services → Credentials). It ends in
   *   .apps.googleusercontent.com. Put the SAME value in the Apps Script
   *   Script Property GOOGLE_CLIENT_ID.
   * ------------------------------------------------------------------ */

  const SYNC_CONFIG = Object.freeze({
    ENDPOINT_URL: 'https://script.google.com/macros/s/AKfycbyD32v0BqQcdmsn11TYS9VhbzoGqbSbBjCb2PE_ybqe8UDLJBrXAr25c19hSkuioHCR/exec',

    BATCH_SIZE: 25,                 // records per POST (Apps Script handles this comfortably)
    REQUEST_TIMEOUT_MS: 30000,      // Apps Script cold starts can take several seconds
    INTERVAL_MS: 60000,             // routine check every 60 s while the app is open
    RETRY_BASE_MS: 30000,           // first retry after a failure…
    RETRY_MAX_MS: 15 * 60000,       // …doubling up to 15 minutes
    SAVE_DEBOUNCE_MS: 2000,         // wait 2 s after a save so quick entries go in one batch
    SYNCED_RETENTION_DAYS: 30,      // synced rows are pruned from the phone after this
  });

  const AUTH_CONFIG = Object.freeze({
    GOOGLE_CLIENT_ID: '810514188486-sviqs36dl9na7rlk8o1k430fvq7v6ohh.apps.googleusercontent.com',

    // Google ID tokens live 1 hour. Treat a token as expired a little early
    // so it cannot run out between the check and the server receiving it.
    TOKEN_EXPIRY_MARGIN_MS: 5 * 60000,
    GIS_LOAD_TIMEOUT_MS: 15000,     // give up waiting for Google's script after 15 s
    VERIFY_TIMEOUT_MS: 15000,       // access check with Apps Script at sign-in
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

  // Store -> Google Sheet tab. Must match your spreadsheet and Code.gs SHEETS.
  const SHEET_FOR_STORE = Object.freeze({
    [STORES.MILK]: 'Milk_Production',
    [STORES.CALF]: 'Calf_Records',
  });

  // Exactly which fields are sent to the server for each store.
  // recordedBy = email of the person signed in when the entry was saved;
  // Code.gs writes it to the Recorded_By column.
  const PAYLOAD_FIELDS = Object.freeze({
    [STORES.MILK]: ['clientId', 'deviceId', 'date', 'cowId', 'session', 'litres', 'recordedBy', 'createdAt'],
    [STORES.CALF]: ['clientId', 'deviceId', 'date', 'calfId', 'feedType', 'quantityKg', 'recordedBy', 'createdAt'],
  });

  // The three daily milkings at Mawe Tatu: ~5:00 am, ~1:00 pm, ~8:30 pm.
  const MILK_SESSIONS = Object.freeze(['Morning', 'Afternoon', 'Evening']);
  const FEED_TYPES = Object.freeze(['Pellets', 'Hay', 'Milk']);

  const RECENT_LIMIT = 5;                   // rows shown under each form
  const TAB_KEY = 'mt_active_tab';          // localStorage: last-opened tab
  const DEVICE_KEY = 'mt_device_id';        // localStorage: this phone's ID
  const LAST_SYNC_KEY = 'mt_last_sync_at';  // localStorage: last successful sync time
  const SESSION_KEY = 'mt_session';         // localStorage: signed-in user + ID token
  const SYNC_LOCK_NAME = 'mawe-tatu-sync';  // Web Locks name (one sync across all tabs)

  const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

  /* ------------------------------------------------------------------
   * 3. DATABASE SETUP (Dexie)
   * ------------------------------------------------------------------
   *   ++id                    auto-increment primary key (local only)
   *   &clientId               UNIQUE UUID made on the phone; Code.gs skips
   *                           clientIds it already has (no duplicate rows)
   *   syncStatus              finds pending/failed rows quickly
   *   [cowId+session+date]    duplicate-entry warning on the form
   * recordedBy is stored on each row but not indexed, so no schema change
   * is needed. If you ever change the schema, ADD db.version(2) below.
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
  const show = (el, visible) => el.classList.toggle('hidden', !visible);

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
  function lsRemove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } }

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

  // Records currently being uploaded, as "store:id" — they cannot be
  // deleted mid-upload (they may already be in the sheet).
  const inFlight = new Set();
  const flightKey = (storeName, id) => `${storeName}:${id}`;

  function baseMeta() {
    const now = new Date().toISOString();
    return {
      clientId: makeUUID(),
      deviceId: getDeviceId(),
      recordedBy: session ? session.email : '',
      createdAt: now,
      updatedAt: now,
      syncStatus: SYNC_STATUS.PENDING,
      syncAttempts: 0,
      lastError: null,
      syncedAt: null,
    };
  }

  async function addMilkLog({ cowId, session: milkSession, litres, date }) {
    const record = { ...baseMeta(), cowId, session: milkSession, litres, date };
    record.id = await db[STORES.MILK].add(record);
    return record;
  }

  async function addCalfLog({ calfId, feedType, quantityKg, date }) {
    const record = { ...baseMeta(), calfId, feedType, quantityKg, date };
    record.id = await db[STORES.CALF].add(record);
    return record;
  }

  function findMilkDuplicate(cowId, milkSession, date) {
    return db[STORES.MILK].where('[cowId+session+date]').equals([cowId, milkSession, date]).first();
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

  /** Remove synced rows older than the retention window. Pending/failed rows are NEVER pruned. */
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
    const milkSession = form.session.value;
    const litres = parseFloat(form.litres.value);
    const date = form.date.value;

    if (!cowId) return { ok: false, error: 'Cow ID is required.' };
    if (!ID_PATTERN.test(cowId)) return { ok: false, error: 'Cow ID: use letters, numbers, - or _ (max 20).' };
    if (!MILK_SESSIONS.includes(milkSession)) return { ok: false, error: 'Choose Morning, Afternoon or Evening.' };
    if (!Number.isFinite(litres) || litres <= 0) return { ok: false, error: 'Enter litres greater than 0.' };
    if (litres > 60) return { ok: false, error: 'Litres look too high for one session (max 60).' };
    const dateErr = validateDate(date);
    if (dateErr) return { ok: false, error: dateErr };

    return { ok: true, data: { cowId, session: milkSession, litres: round1(litres), date } };
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
   * Forms are only reachable while signed in (see section 10).
   * ------------------------------------------------------------------ */

  async function handleMilkSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const btn = form.querySelector('button[type="submit"]');
    showFormError('milk', null);

    if (!session) { showAuthScreen('signin'); return; }

    const result = validateMilk(form);
    if (!result.ok) { showFormError('milk', result.error); return; }
    const { cowId, session: milkSession, date } = result.data;

    btn.disabled = true;
    try {
      const dup = await findMilkDuplicate(cowId, milkSession, date);
      if (dup && !confirm(`${cowId} already has ${dup.litres} L for ${milkSession} on ${date}.\nSave another entry anyway?`)) {
        return;
      }

      await addMilkLog(result.data);
      toast(`Saved: ${cowId} · ${result.data.litres} L (${milkSession})`);

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

    if (!session) { showAuthScreen('signin'); return; }

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
   * One state object drives the header badge and detail line.
   *   sync: 'idle' | 'syncing' | 'error' | 'unconfigured' | 'auth'
   *   ('auth' = records are waiting but a fresh Google sign-in is needed)
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
    const { pending, online, sync: syncState, lastError, lastSyncAt } = status;
    const plural = pending === 1 ? '' : 's';

    let dot, label, detail;
    if (syncState === 'unconfigured') {
      dot = ['bg-slate-300']; label = 'Not set up';
      detail = 'Add the Apps Script URL in app.js to start uploading';
    } else if (!online) {
      dot = ['bg-red-400']; label = 'Offline';
      detail = pending ? 'Saved on this phone · uploads when back online' : 'Offline · everything is uploaded';
    } else if (syncState === 'auth') {
      dot = ['bg-orange-300']; label = 'Sign in';
      detail = lastError || `Tap to sign in again and upload ${pending} record${plural}`;
    } else if (syncState === 'syncing') {
      dot = ['bg-yellow-200', 'animate-pulse']; label = 'Syncing…';
      detail = `Uploading ${pending} record${plural}…`;
    } else if (syncState === 'error') {
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

  /** liveQuery re-runs whenever the tables it read change, so the UI
   *  never needs manual refresh. */
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
   * 10. AUTHENTICATION (Google Identity Services)
   * ------------------------------------------------------------------
   * Two separate jobs:
   *
   * A) Opening the app (works offline). After the first online sign-in,
   *    the user's name/email and Google ID token are kept in localStorage
   *    (SESSION_KEY). On later launches — even with no signal — the app
   *    opens straight to the forms. This is a convenience lock for the
   *    phone, NOT the security boundary: anyone holding the phone is
   *    treated as the signed-in user until they log out.
   *
   * B) Writing to Google Sheets (the real security). Every upload carries
   *    the Google ID token. Code.gs asks Google to verify it, checks it
   *    was issued for YOUR client ID, and checks the email is on the
   *    ALLOWED_EMAILS list. Nobody else can add rows, even if they read
   *    this file.
   *
   * ID tokens expire after 1 hour. Entries saved offline are uploaded
   * later, so when a token has expired the app first tries a silent
   * re-sign-in (Google One Tap with auto-select). If Google needs a tap,
   * the badge turns orange ("Sign in") and the records wait safely on the
   * phone until the user signs in again.
   * ------------------------------------------------------------------ */

  /** Current session: { email, name, givenName, sub, idToken, tokenExp (ms), signedInAt } */
  let session = null;

  const auth = {
    gisPromise: null,        // resolves to google.accounts.id once loaded
    gisInitialized: false,
    silentRefreshTried: false,
    screenMode: null,        // null (hidden) | 'signin' | 'reauth'
  };

  function isClientIdConfigured() {
    const id = AUTH_CONFIG.GOOGLE_CLIENT_ID.trim();
    return /^[\w-]+\.apps\.googleusercontent\.com$/.test(id) && !id.startsWith('YOUR_');
  }

  function loadSession() {
    try {
      const s = JSON.parse(lsGet(SESSION_KEY) || 'null');
      if (!s || typeof s.email !== 'string' || !s.email.includes('@')) return null;
      return s;
    } catch {
      return null;
    }
  }

  function saveSession(s) { lsSet(SESSION_KEY, JSON.stringify(s)); }

  function hasFreshToken() {
    return !!(session && session.idToken && Number(session.tokenExp) - Date.now() > AUTH_CONFIG.TOKEN_EXPIRY_MARGIN_MS);
  }

  /** Mark the stored token as expired (e.g. the server rejected it). */
  function expireToken() {
    if (!session) return;
    session.tokenExp = 0;
    saveSession(session);
  }

  /** Decode the middle (payload) part of a JWT. Base64url + UTF-8 safe,
   *  so names with accents or non-Latin letters display correctly.
   *  NOTE: this only READS the token; the signature is verified on the
   *  server by Code.gs, which is what actually grants access. */
  function decodeJwtPayload(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) throw new Error('Not a JWT');
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    b64 += '='.repeat((4 - (b64.length % 4)) % 4);
    const binary = atob(b64);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  /** Basic local sanity checks on the token claims. Returns an error message or null. */
  function checkClaims(c) {
    if (!c || typeof c !== 'object') return 'Google returned an unreadable sign-in.';
    if (!GOOGLE_ISSUERS.includes(c.iss)) return 'This sign-in did not come from Google.';
    if (c.aud !== AUTH_CONFIG.GOOGLE_CLIENT_ID.trim()) return 'This sign-in was issued for a different app.';
    if (c.email_verified !== true) return 'Your Google email address is not verified.';
    if (typeof c.email !== 'string' || !c.email.includes('@')) return 'Google did not share an email address.';
    if (!Number.isFinite(c.exp) || c.exp * 1000 <= Date.now()) return 'This sign-in has already expired. Please try again.';
    return null;
  }

  /** Load Google's script. The <script id="gis-script"> tag in index.html
   *  records success/failure in data attributes; if it failed (e.g. the app
   *  was opened offline) a fresh copy is injected once we are online. */
  function loadGis() {
    if (auth.gisPromise) return auth.gisPromise;

    auth.gisPromise = new Promise((resolve, reject) => {
      const api = () => window.google && window.google.accounts && window.google.accounts.id;
      if (api()) { resolve(api()); return; }
      if (!navigator.onLine) { reject(new Error('offline')); return; }

      let el = document.getElementById('gis-script');
      if (!el || el.dataset.failed === '1') {
        if (el) el.remove();
        el = document.createElement('script');
        el.id = 'gis-script';
        el.src = 'https://accounts.google.com/gsi/client';
        el.async = true;
        document.head.appendChild(el);
      }

      const timer = setTimeout(() => reject(new Error('timeout')), AUTH_CONFIG.GIS_LOAD_TIMEOUT_MS);
      el.addEventListener('load', () => {
        clearTimeout(timer);
        if (api()) resolve(api()); else reject(new Error('Google Sign-In loaded without its API'));
      }, { once: true });
      el.addEventListener('error', () => {
        clearTimeout(timer);
        el.dataset.failed = '1';
        reject(new Error('Could not load Google Sign-In'));
      }, { once: true });
    });

    // Allow a later retry if this attempt failed.
    auth.gisPromise.catch(() => { auth.gisPromise = null; });
    return auth.gisPromise;
  }

  async function initGis() {
    const gid = await loadGis();
    if (!auth.gisInitialized) {
      gid.initialize({
        client_id: AUTH_CONFIG.GOOGLE_CLIENT_ID.trim(),
        callback: handleCredentialResponse,
        auto_select: true,             // returning users are signed in without a tap where Google allows
        cancel_on_tap_outside: false,
        itp_support: true,
        use_fedcm_for_prompt: true,    // Chrome's FedCM sign-in sheet (Google's current recommendation)
        context: 'signin',
      });
      auth.gisInitialized = true;
    }
    return gid;
  }

  /* ---------- Sign-in screen ---------- */

  function setAuthMessage(text) { $('#auth-message').textContent = text; }

  function setAuthError(text) {
    const el = $('#auth-error');
    el.textContent = text || '';
    show(el, !!text);
  }

  function setAuthBusy(text) {
    const el = $('#auth-status');
    el.textContent = text || '';
    show(el, !!text);
  }

  /** mode 'signin': nobody is signed in (forms hidden, no way past).
   *  mode 'reauth': signed in, but uploads need a fresh Google sign-in;
   *                 "Not now" returns to the forms. */
  async function showAuthScreen(mode) {
    auth.screenMode = mode;
    show($('#app-main'), false);
    show($('#auth-screen'), true);
    show($('#auth-cancel'), mode === 'reauth');
    setAuthError('');
    setAuthBusy('');

    $('#auth-title').textContent = mode === 'reauth' ? 'Sign in again to upload' : 'Sign in to Mawe Tatu Dairy';
    setAuthMessage(mode === 'reauth'
      ? 'For security, Google sign-ins last one hour. Your records are safe on this phone and will upload as soon as you sign in.'
      : 'Use your Google account. You need internet for this first sign-in; after that the app works offline.');

    await renderGoogleButton();
  }

  async function renderGoogleButton() {
    const holder = $('#g-signin-btn');
    holder.innerHTML = '';

    if (!isClientIdConfigured()) {
      setAuthError('Google Sign-In is not set up yet: add your Client ID in app.js (AUTH_CONFIG.GOOGLE_CLIENT_ID).');
      return;
    }
    if (!navigator.onLine) {
      setAuthBusy('You are offline. Connect to the internet to sign in.');
      return;
    }

    setAuthBusy('Loading Google Sign-In…');
    try {
      const gid = await initGis();
      setAuthBusy('');
      holder.innerHTML = '';
      gid.renderButton(holder, {
        type: 'standard', theme: 'filled_blue', size: 'large',
        text: 'signin_with', shape: 'pill', logo_alignment: 'left',
        width: Math.min(300, holder.clientWidth || 300),
      });
      gid.prompt(); // also offer One Tap / account chooser
    } catch (err) {
      console.warn('Google Sign-In unavailable:', err);
      setAuthBusy('');
      setAuthError(navigator.onLine
        ? 'Could not load Google Sign-In. Check your connection and try again.'
        : 'You are offline. Connect to the internet to sign in.');
    }
  }

  function hideAuthScreen() {
    auth.screenMode = null;
    show($('#auth-screen'), false);
  }

  /** Show the logging app for the signed-in user. */
  function enterApp() {
    hideAuthScreen();
    show($('#app-main'), true);
    const first = session.givenName || session.name || session.email;
    $('#user-name').textContent = first;
    $('#user-bar').title = session.email;
    $('#user-email').textContent = session.email;
  }

  /* ---------- Google callback ---------- */

  /** Called by Google with { credential: <ID token JWT> } after a button
   *  click, One Tap or a silent auto-select. */
  async function handleCredentialResponse(response) {
    const token = response && response.credential;
    let claims;
    try {
      claims = decodeJwtPayload(token);
    } catch {
      reportAuthProblem('Google returned an unreadable sign-in. Please try again.');
      return;
    }
    const problem = checkClaims(claims);
    if (problem) { reportAuthProblem(problem); return; }

    // Ask the server whether this account may use the farm app, so a
    // stranger gets a clear message now rather than failed uploads later.
    if (auth.screenMode) setAuthBusy('Checking access…');
    const verdict = await verifyWithServer(token);
    setAuthBusy('');

    if (verdict.result === 'forbidden') {
      try { window.google.accounts.id.disableAutoSelect(); } catch { /* ignore */ }
      if (session && session.email === claims.email.toLowerCase()) {
        // An existing user was removed from the allowed list: sign them out.
        endSession();
      }
      if (!auth.screenMode) await showAuthScreen('signin');
      setAuthError(`${claims.email} is not allowed to use this farm app. Ask the farm owner to add it.`);
      return;
    }
    if (verdict.result === 'invalid') {
      reportAuthProblem(verdict.message || 'The farm server could not confirm this sign-in.');
      return;
    }
    // 'ok' or 'unknown' (server unreachable / not set up): accept the sign-in.
    // The server still checks every upload, so nothing is weakened.

    const isNewUser = !session || session.email !== claims.email.toLowerCase();
    session = {
      email: claims.email.toLowerCase(),
      name: claims.name || claims.email,
      givenName: claims.given_name || '',
      sub: claims.sub,
      idToken: token,
      tokenExp: claims.exp * 1000,
      signedInAt: new Date().toISOString(),
    };
    saveSession(session);
    auth.silentRefreshTried = false;

    enterApp();
    toast(isNewUser ? `Welcome, ${session.givenName || session.name}` : 'Signed in · uploading records', 'success');

    sync.consecutiveFailures = 0;
    requestSync('signed-in', 0);
  }

  function reportAuthProblem(message) {
    if (auth.screenMode) {
      setAuthError(message);
    } else {
      // Happened during a silent refresh: keep working, show it on the badge.
      setStatus({ sync: 'auth', lastError: message });
    }
  }

  /** Check the token with Apps Script (action: verifySession).
   *  Returns { result: 'ok' | 'forbidden' | 'invalid' | 'unknown', message? }. */
  async function verifyWithServer(idToken) {
    if (!isEndpointConfigured() || !navigator.onLine) return { result: 'unknown' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AUTH_CONFIG.VERIFY_TIMEOUT_MS);
    try {
      const res = await fetch(SYNC_CONFIG.ENDPOINT_URL.trim(), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'verifySession', idToken }),
        redirect: 'follow',
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal,
      });
      if (!res.ok) return { result: 'unknown' };
      const data = JSON.parse(await res.text());
      if (data.status === 'success') return { result: 'ok' };
      if (data.code === 'AUTH_FORBIDDEN') return { result: 'forbidden', message: data.message };
      if (data.code === 'AUTH_INVALID') return { result: 'invalid', message: data.message };
      return { result: 'unknown' };
    } catch {
      return { result: 'unknown' };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Try to get a fresh token without bothering the user (One Tap
   *  auto-select). At most once per app visit; if Google needs a tap,
   *  the badge shows "Sign in" instead. */
  async function trySilentRefresh() {
    if (auth.silentRefreshTried || !navigator.onLine || !isClientIdConfigured()) return;
    auth.silentRefreshTried = true;
    try {
      const gid = await initGis();
      gid.prompt(); // on success Google calls handleCredentialResponse
    } catch (err) {
      console.warn('Silent sign-in refresh unavailable:', err);
    }
  }

  /* ---------- Logout ---------- */

  function endSession() {
    lsRemove(SESSION_KEY);
    session = null;
    clearTimeout(sync.timer);
  }

  async function handleLogout() {
    const pending = status.pending;
    const message = pending
      ? `${pending} record${pending === 1 ? ' has' : 's have'} not uploaded yet. ` +
        'They stay safely on this phone and will upload after the next sign-in.\n\nLog out now?'
      : 'Log out of Mawe Tatu Dairy?';
    if (!confirm(message)) return;

    endSession();
    try {
      // Stop Google from silently signing the same account back in.
      if (window.google && window.google.accounts && window.google.accounts.id) {
        window.google.accounts.id.disableAutoSelect();
      }
    } catch { /* ignore */ }

    setStatus({ sync: isEndpointConfigured() ? 'idle' : 'unconfigured', lastError: null });
    await showAuthScreen('signin');
    toast('Logged out', 'info');
  }

  /* ------------------------------------------------------------------
   * 11. SYNC ENGINE
   * ------------------------------------------------------------------
   * When it runs: app start, back online, app back in the foreground,
   * 2 s after a save, every 60 s, after signing in, badge tap, and on a
   * backoff schedule (30 s → 15 min) after failures.
   *
   * A run: snapshot pending + failed rows → POST in batches of 25 with
   * the Google ID token → mark ONLY server-confirmed rows as synced.
   *   • network error (offline/timeout): rows untouched, retry later
   *   • server error: rows marked failed with the reason, retried
   *   • auth error (token expired / not allowed): rows untouched, the
   *     badge asks the user to sign in; no pointless retries meanwhile
   * Resending is safe: Code.gs skips clientIds it already has.
   *
   * Server contract (Code.gs):
   *   Request (POST, text/plain to avoid a CORS preflight):
   *     { action: 'appendRecords', idToken, sheet, records: [ {...}, … ] }
   *   Response:
   *     { status: 'success', results: [ { clientId, status: 'saved'|'duplicate'|'rejected', error? } ] }
   *     { status: 'error', code?, message }   code: AUTH_EXPIRED | AUTH_INVALID | AUTH_FORBIDDEN
   * ------------------------------------------------------------------ */

  class SyncError extends Error {
    /** kind: 'network' (retry later) | 'server' (rows marked failed) | 'auth' (needs sign-in) */
    constructor(message, kind) {
      super(message);
      this.name = 'SyncError';
      this.kind = kind;
    }
  }

  const AUTH_ERROR_CODES = ['AUTH_EXPIRED', 'AUTH_INVALID', 'AUTH_FORBIDDEN'];

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

  /** Run fn under a cross-tab lock so two open tabs never upload the same rows. */
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
      return;
    }
    if (!navigator.onLine) {
      setStatus({ online: false });
      return; // the 'online' event restarts syncing
    }
    if (sync.running) {
      sync.rerunRequested = true;
      return;
    }

    sync.running = true;
    let nextDelay = SYNC_CONFIG.INTERVAL_MS;
    let schedule = true;

    try {
      const pendingNow = await countPending();

      if (pendingNow === 0) {
        setStatus({ sync: 'idle', lastError: null });
      } else if (!session) {
        // Signed out: records wait until somebody signs in.
        setStatus({ sync: 'auth', lastError: `Sign in to upload ${pendingNow} record${pendingNow === 1 ? '' : 's'}` });
        schedule = false;
      } else if (!hasFreshToken()) {
        setStatus({ sync: 'auth', lastError: null });
        trySilentRefresh(); // on success, handleCredentialResponse restarts sync
        schedule = false;
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

      await Promise.all(Object.values(STORES).map(pruneSynced));
    } catch (err) {
      if (err instanceof SyncError && err.kind === 'auth') {
        // Wait for a sign-in instead of retrying with a token that will fail again.
        setStatus({ sync: 'auth', lastError: err.message });
        if (err.code !== 'AUTH_FORBIDDEN') trySilentRefresh();
        schedule = false;
      } else {
        sync.consecutiveFailures += 1;
        nextDelay = backoffDelay(sync.consecutiveFailures);
        const msg = err instanceof SyncError ? err.message : `Unexpected error: ${err.message || err}`;
        console.warn(`Sync failed (${reason}); retry in ${Math.round(nextDelay / 1000)} s:`, err);
        setStatus({ sync: 'error', lastError: msg });
        if (reason === 'manual') toast(`Sync failed: ${msg}`, 'error');
      }
    } finally {
      sync.running = false;
    }

    if (sync.rerunRequested) {
      sync.rerunRequested = false;
      requestSync('rerun', 0);
    } else if (schedule && navigator.onLine) {
      requestSync('interval', nextDelay);
    }
  }

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
        // Re-read: a row may have been deleted while earlier batches uploaded.
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
          throw err; // stop this run; runSync decides what happens next
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

  /** Build the minimal payload for one row. Rows saved before sign-in
   *  existed have no recordedBy; Code.gs then uses the uploader's email. */
  function toPayload(storeName, record) {
    const out = {};
    for (const field of PAYLOAD_FIELDS[storeName]) out[field] = record[field] ?? '';
    return out;
  }

  /** POST one batch. Returns the server's results array or throws SyncError. */
  async function postBatch(storeName, records) {
    if (!hasFreshToken()) throw new SyncError('Sign in again to upload', 'auth');

    const body = JSON.stringify({
      action: 'appendRecords',
      idToken: session.idToken,
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
      if (err.name === 'AbortError') throw new SyncError('Server took too long to answer', 'network');
      // TypeError: no connection, DNS failure — or the deployment is not
      // shared with "Anyone" (Google redirects to a sign-in page, which the
      // browser blocks as a CORS failure).
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
      throw new SyncError('Unexpected reply from Apps Script (check the deployment)', 'server');
    }

    if (data && data.status === 'error') {
      if (AUTH_ERROR_CODES.includes(data.code)) {
        if (data.code !== 'AUTH_FORBIDDEN') expireToken();
        const err = new SyncError(
          data.code === 'AUTH_FORBIDDEN'
            ? `${session ? session.email : 'This account'} is not allowed to upload`
            : 'Sign in again to upload',
          'auth',
        );
        err.code = data.code;
        throw err;
      }
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

  /* ---------- Connectivity & lifecycle events ---------- */

  function handleOnline() {
    setStatus({ online: true });
    sync.consecutiveFailures = 0;
    auth.silentRefreshTried = false;
    if (auth.screenMode) renderGoogleButton(); // offline sign-in screen can now load Google
    requestSync('online', 0);
  }

  function handleOffline() {
    clearTimeout(sync.timer);
    setStatus({ online: false });
  }

  function handleVisibility() {
    if (document.visibilityState === 'visible') {
      setStatus({ online: navigator.onLine });
      auth.silentRefreshTried = false;
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
    if (!session) {
      showAuthScreen('signin');
      return;
    }
    if (status.sync === 'auth' && status.pending > 0) {
      showAuthScreen('reauth');
      return;
    }
    sync.consecutiveFailures = 0;
    requestSync('manual', 0);
  }

  /* ------------------------------------------------------------------
   * 12. SERVICE WORKER REGISTRATION + UPDATE BANNER
   * ------------------------------------------------------------------
   * sw.js caches the app shell so the app opens with no signal at all.
   * When you change any app file, bump CACHE_VERSION in sw.js; phones
   * then show a "Reload" banner and switch only when the user taps it.
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
      swRegistration = await navigator.serviceWorker.register('./sw.js', {
        scope: './',
        updateViaCache: 'none',
      });
    } catch (err) {
      console.error('Service worker registration failed:', err);
      return;
    }

    if (swRegistration.waiting && navigator.serviceWorker.controller) {
      showUpdateBanner(swRegistration.waiting);
    }

    swRegistration.addEventListener('updatefound', () => {
      const incoming = swRegistration.installing;
      if (!incoming) return;
      incoming.addEventListener('statechange', () => {
        if (incoming.state === 'installed' && navigator.serviceWorker.controller) {
          showUpdateBanner(incoming);
        }
      });
    });

    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!userAcceptedUpdate || reloading) return;
      reloading = true;
      window.location.reload();
    });

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
   * Public API for the browser console, e.g.
   *   await FarmDB.getPending('milk_logs')   ·   FarmDB.syncNow()
   * ------------------------------------------------------------------ */
  window.FarmDB = Object.freeze({
    db, STORES, SYNC_STATUS, SHEET_FOR_STORE, MILK_SESSIONS, FEED_TYPES,
    addMilkLog, addCalfLog, getPending, countPending,
    markSynced, markFailed, deleteUnsynced,
    syncNow: () => requestSync('manual', 0),
    currentUser: () => (session ? { email: session.email, name: session.name } : null),
  });

  /* ------------------------------------------------------------------
   * 13. BOOT
   * ------------------------------------------------------------------ */

  async function init() {
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
    $('#logout-btn').addEventListener('click', handleLogout);
    $('#auth-cancel').addEventListener('click', () => { if (session) enterApp(); });
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    document.addEventListener('visibilitychange', handleVisibility);

    activateTab(lsGet(TAB_KEY) || 'milk');
    setStatus({ online: navigator.onLine, sync: isEndpointConfigured() ? 'idle' : 'unconfigured' });
    startLiveViews();

    // Signed in before (even offline)? Go straight to the forms.
    session = loadSession();
    if (session) {
      enterApp();
    } else {
      await showAuthScreen('signin');
    }

    requestSync('startup', 0);
  }

  init();
})();
