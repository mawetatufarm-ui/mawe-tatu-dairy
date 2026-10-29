/* =====================================================================
 * Mawe Tatu Dairy — herd.js (Herd registry module)
 * ---------------------------------------------------------------------
 * Everything about the animals themselves: the `animals` store in
 * IndexedDB, validation, pedigree helpers, the Herd tab (list + form),
 * and the cow / calf dropdowns on the Milk and Calf Feed forms.
 *
 * Loaded by index.html BEFORE app.js:
 *     <script src="herd.js" defer></script>
 *     <script src="app.js" defer></script>
 * It only defines window.MaweHerd. app.js owns the database, the
 * sign-in session and the sync engine, and calls MaweHerd.create(deps)
 * during boot. Pre-cached by sw.js (keep the file name identical).
 *
 * IDs
 *   MT-001, MT-002, …  animals that are or were on the farm (never reused)
 *   X-001,  X-002,  …  outside animals: AI bulls and known ancestors
 *                      (never in the logging dropdowns, never counted)
 *
 * Sync (driven by app.js, contract in Code.gs)
 *   push  { action: 'upsertAnimals', records: [ toPayload(animal), … ] }
 *         → results [{ animalId, status: saved|duplicate|stale|rejected, error? }]
 *         An animal is UPDATED in place (unlike milk rows, which are only
 *         appended). The newer updatedAt wins; 'stale' means the sheet
 *         already holds a newer version, which the next pull brings down.
 *   pull  { action: 'listAnimals' } → { animals: [ … ] }
 *         The sheet is the source of truth: synced animals are replaced
 *         by the sheet's version; animals with unsent edits are kept.
 *
 * Sections
 *   1. Constants and option lists
 *   2. Small helpers
 *   3. Data access (save, delete, pending, payload)
 *   4. Sync helpers (apply push results, merge pull)
 *   5. Pedigree helpers (offspring, ancestors, inbreeding, breed)
 *   6. Validation
 *   7. Dropdowns on the Milk and Calf Feed forms
 *   8. Herd tab: list
 *   9. Herd tab: form
 *  10. init + public API
 * ===================================================================== */

(() => {
  'use strict';

  /* ------------------------------------------------------------------
   * 1. CONSTANTS AND OPTION LISTS
   * ------------------------------------------------------------------
   * Code.gs validates against the same lists (ANIMAL_OPTIONS): change
   * both together.
   * ------------------------------------------------------------------ */

  const STORE = 'animals';
  const ID_PATTERN = /^(MT|X)-\d{3,4}$/;
  const HERD = Object.freeze({ FARM: 'farm', EXTERNAL: 'external' });
  const PREFIX = Object.freeze({ [HERD.FARM]: 'MT', [HERD.EXTERNAL]: 'X' });

  const OPTIONS = Object.freeze({
    sex: ['Female', 'Male'],
    categoryFarm: ['Calf', 'Heifer', 'Cow', 'Bull'],
    categoryExternal: ['AI bull', 'Reference'],
    breed: ['Unknown', 'Friesian', 'Ayrshire', 'Jersey', 'Guernsey', 'Fleckvieh', 'Sahiwal', 'Boran', 'Cross'],
    source: ['Born on farm', 'Purchased'],
    statusFarm: ['Active', 'Sold', 'Dead', 'Culled'],
    milking: ['Lactating', 'Dry', 'N/A'],
    pregnancy: ['Open', 'In-calf', 'N/A'],
    semenType: ['', 'Conventional', 'Sexed'],
  });

  // Categories that can only be one sex.
  const CATEGORY_SEX = Object.freeze({ Heifer: 'Female', Cow: 'Female', Bull: 'Male', 'AI bull': 'Male' });
  // Female categories that have milking / pregnancy status.
  const BREEDING_FEMALE = ['Cow', 'Heifer'];

  // Exactly the fields sent to (and read back from) the Animals sheet.
  const PAYLOAD_FIELDS = Object.freeze([
    'animalId', 'name', 'herd', 'sex', 'category', 'breed', 'breedNote',
    'dateOfBirth', 'dobApprox', 'source', 'purchaseDate', 'damId', 'sireId',
    'status', 'statusDate', 'salePrice', 'statusNote',
    'milkingStatus', 'pregnancyStatus', 'pregnancySireId',
    'aiCode', 'semenSupplier', 'semenType', 'notes',
    'clientId', 'updatedBy', 'deviceId', 'createdAt', 'updatedAt',
  ]);

  /* ==================================================================
   * create(deps) — builds the module around app.js's database and session.
   *   deps: { db, logStores: { MILK, CALF }, SYNC_STATUS, getSession,
   *           getDeviceId, makeUUID, todayLocal, esc, toast,
   *           requestSync(reason, delayMs), activateTab(name), saveDebounceMs }
   * ================================================================== */
  function create(deps) {
    const {
      db, logStores, SYNC_STATUS, getSession, getDeviceId, makeUUID,
      todayLocal, esc, toast, requestSync, activateTab, saveDebounceMs,
    } = deps;

    const table = () => db[STORE];
    const $ = (sel) => document.querySelector(sel);
    const show = (el, visible) => el && el.classList.toggle('hidden', !visible);

    /* ----------------------------------------------------------------
     * 2. SMALL HELPERS
     * ---------------------------------------------------------------- */

    let animals = [];               // every animal on this phone, sorted by ID
    const byId = new Map();         // animalId -> animal (kept current by liveQuery)
    const inFlight = new Set();     // animalIds being uploaded right now (set by app.js)
    let listFilter = 'active';      // 'active' | 'inactive' | 'outside'
    let editing = null;             // { originalId, isNew } while the form is open
    let breedTouched = false;       // user picked a breed by hand: stop auto-suggesting

    const herdOf = (id) => (String(id).startsWith('X-') ? HERD.EXTERNAL : HERD.FARM);
    const isFarm = (a) => a.herd === HERD.FARM;
    const isActiveFarm = (a) => isFarm(a) && a.status === 'Active';
    const label = (a) => `${a.animalId} · ${a.name || 'unnamed'}`;
    const idNumber = (id) => Number(String(id).split('-')[1]) || 0;
    const sortById = (a, b) => (a.herd === b.herd
      ? idNumber(a.animalId) - idNumber(b.animalId)
      : (a.herd === HERD.FARM ? -1 : 1));

    /** Next free number for a prefix: one more than the highest ever used on
     *  this phone (sold and dead animals included, so numbers are never reused). */
    function nextId(herd) {
      const prefix = PREFIX[herd];
      const max = animals
        .filter((a) => a.animalId.startsWith(prefix + '-'))
        .reduce((m, a) => Math.max(m, idNumber(a.animalId)), 0);
      return `${prefix}-${String(max + 1).padStart(3, '0')}`;
    }

    function getAnimal(id) { return byId.get(id) || null; }

    /* ----------------------------------------------------------------
     * 3. DATA ACCESS
     * ---------------------------------------------------------------- */

    /** Animals with edits not yet confirmed by the server, oldest edit first. */
    async function getPendingAnimals() {
      const rows = await table()
        .where('syncStatus').anyOf(SYNC_STATUS.PENDING, SYNC_STATUS.FAILED)
        .toArray();
      return rows.sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
    }

    function countPending() {
      return table().where('syncStatus').anyOf(SYNC_STATUS.PENDING, SYNC_STATUS.FAILED).count();
    }

    /** Minimal record for the server (same field list as the sheet columns). */
    function toPayload(rec) {
      const out = {};
      for (const f of PAYLOAD_FIELDS) out[f] = rec[f] ?? '';
      out.dobApprox = rec.dobApprox === true;
      out.salePrice = rec.salePrice === '' || rec.salePrice == null ? '' : Number(rec.salePrice);
      return out;
    }

    /**
     * Save a new or edited animal locally and queue it for upload.
     * Renumbering is allowed only for an animal that has never reached the
     * sheet (e.g. the server said its ID was taken by another phone); its
     * unsent milk / feed entries and pedigree links move to the new ID.
     */
    async function saveAnimal(data, { originalId, isNew }) {
      const session = getSession();
      const now = new Date().toISOString();
      const milk = db[logStores.MILK];
      const calf = db[logStores.CALF];

      return db.transaction('rw', table(), milk, calf, async () => {
        const existing = originalId ? await table().get(originalId) : null;
        const renumber = !!existing && originalId !== data.animalId;

        if (isNew || renumber) {
          if (await table().get(data.animalId)) throw new Error(`${data.animalId} is already used on this phone.`);
        }
        if (renumber) {
          if (existing.syncedAt) throw new Error('This animal is already in Google Sheets, so its ID cannot change.');
          if (inFlight.has(originalId)) throw new Error('This animal is uploading right now. Try again in a moment.');
        }

        // updatedAt decides which version wins on the server, so it must move
        // forward even if this phone's clock is behind the previous edit.
        let updatedAt = now;
        if (existing && existing.updatedAt && updatedAt <= existing.updatedAt) {
          updatedAt = new Date(Date.parse(existing.updatedAt) + 1).toISOString();
        }

        const record = {
          ...(existing || {}),
          ...data,
          clientId: existing ? existing.clientId : makeUUID(),
          createdAt: existing ? existing.createdAt : now,
          updatedAt,
          updatedBy: session ? session.email : '',
          deviceId: getDeviceId(),
          syncStatus: SYNC_STATUS.PENDING,
          syncAttempts: 0,
          lastError: null,
          syncedAt: existing ? (existing.syncedAt || null) : null,
        };

        if (renumber) {
          const oldId = originalId;
          const newId = data.animalId;
          await table().delete(oldId);
          await milk.where('cowId').equals(oldId)
            .filter((r) => r.syncStatus !== SYNC_STATUS.SYNCED).modify({ cowId: newId });
          await calf.where('calfId').equals(oldId)
            .filter((r) => r.syncStatus !== SYNC_STATUS.SYNCED).modify({ calfId: newId });
          await table()
            .filter((a) => a.damId === oldId || a.sireId === oldId || a.pregnancySireId === oldId)
            .modify((a) => {
              if (a.damId === oldId) a.damId = newId;
              if (a.sireId === oldId) a.sireId = newId;
              if (a.pregnancySireId === oldId) a.pregnancySireId = newId;
              a.updatedAt = new Date(Math.max(Date.now(), Date.parse(a.updatedAt || 0) + 1)).toISOString();
              a.syncStatus = SYNC_STATUS.PENDING;
            });
        }

        await table().put(record);
        return record;
      });
    }

    /** Delete an animal that never reached the sheet (a mistaken entry).
     *  Uploaded animals are never deleted: mark them Sold / Dead instead. */
    async function deleteUnsyncedAnimal(id) {
      const rec = await table().get(id);
      if (!rec) return false;
      if (rec.syncedAt) throw new Error('This animal is already in Google Sheets. Change its status instead.');
      if (inFlight.has(id)) throw new Error('This animal is uploading right now. Try again in a moment.');
      const refs = animals.filter((a) => a.damId === id || a.sireId === id || a.pregnancySireId === id);
      if (refs.length) throw new Error(`${refs.map(label).join(', ')} name this animal as a parent.`);
      const [m, c] = await Promise.all([
        db[logStores.MILK].where('cowId').equals(id).count(),
        db[logStores.CALF].where('calfId').equals(id).count(),
      ]);
      if (m + c) throw new Error('Milk or feed entries on this phone use this animal.');
      await table().delete(id);
      return true;
    }

    /* ----------------------------------------------------------------
     * 4. SYNC HELPERS (called by app.js)
     * ---------------------------------------------------------------- */

    /**
     * Apply the server's per-animal results. Only an animal that was NOT
     * edited again during the upload is marked synced; otherwise it stays
     * pending and its newer version goes up on the next run.
     * Returns { uploaded, rejected, stale }.
     */
    async function applyPushResults(sent, results) {
      const resultFor = new Map(
        (results || []).filter((r) => r && typeof r.animalId === 'string').map((r) => [r.animalId, r]),
      );
      const now = new Date().toISOString();
      const totals = { uploaded: 0, rejected: 0, stale: 0 };

      await db.transaction('rw', table(), async () => {
        for (const rec of sent) {
          const cur = await table().get(rec.animalId);
          if (!cur) continue;
          const res = resultFor.get(rec.animalId);

          if (res && ['saved', 'duplicate', 'stale'].includes(res.status)) {
            if (res.status === 'stale') totals.stale += 1; else totals.uploaded += 1;
            if (cur.updatedAt === rec.updatedAt) {
              await table().update(rec.animalId, {
                syncStatus: SYNC_STATUS.SYNCED, syncedAt: now, syncAttempts: 0, lastError: null,
              });
            }
          } else {
            totals.rejected += 1;
            await table().update(rec.animalId, {
              syncStatus: SYNC_STATUS.FAILED,
              syncAttempts: (cur.syncAttempts || 0) + 1,
              lastError: String(res ? (res.error || 'Rejected by server') : 'Server did not confirm this animal').slice(0, 200),
            });
          }
        }
      });
      return totals;
    }

    /** Field-by-field comparison, so an unchanged animal is not rewritten. */
    function sameContent(a, b) {
      return PAYLOAD_FIELDS.every((f) => String(a[f] ?? '') === String(b[f] ?? ''));
    }

    /**
     * Merge the sheet's animal list into the phone.
     *   • not on the phone, or on the phone and synced → take the sheet's version
     *   • on the phone with unsent edits               → keep (it uploads next)
     *   • synced on the phone but gone from the sheet  → removed from the phone
     * Returns { added, updated, removed }.
     */
    async function mergePulled(list) {
      const now = new Date().toISOString();
      const serverIds = new Set();
      const totals = { added: 0, updated: 0, removed: 0 };

      await db.transaction('rw', table(), async () => {
        for (const s of list) {
          if (!s || typeof s.animalId !== 'string' || !ID_PATTERN.test(s.animalId)) continue;
          serverIds.add(s.animalId);

          const local = await table().get(s.animalId);
          if (local && local.syncStatus !== SYNC_STATUS.SYNCED) continue;

          const clean = {};
          for (const f of PAYLOAD_FIELDS) clean[f] = s[f] ?? '';
          clean.herd = herdOf(s.animalId);
          clean.dobApprox = s.dobApprox === true;
          if (!clean.clientId) clean.clientId = `sheet-${s.animalId}`;
          if (local && sameContent(local, clean)) continue;

          await table().put({
            ...clean, syncStatus: SYNC_STATUS.SYNCED, syncedAt: now, syncAttempts: 0, lastError: null,
          });
          if (local) totals.updated += 1; else totals.added += 1;
        }

        const localSynced = await table().where('syncStatus').equals(SYNC_STATUS.SYNCED).toArray();
        for (const a of localSynced) {
          if (!serverIds.has(a.animalId)) {
            await table().delete(a.animalId);
            totals.removed += 1;
          }
        }
      });
      return totals;
    }

    /* ----------------------------------------------------------------
     * 5. PEDIGREE HELPERS
     * ---------------------------------------------------------------- */

    function offspringOf(id) {
      return animals.filter((a) => a.damId === id || a.sireId === id).sort(sortById);
    }

    /** Ancestor IDs up to `depth` generations (parents = 1, grandparents = 2…). */
    function ancestors(id, depth = 3, out = new Set()) {
      if (depth === 0) return out;
      const a = byId.get(id);
      if (!a) return out;
      for (const parent of [a.damId, a.sireId]) {
        if (parent && !out.has(parent)) {
          out.add(parent);
          ancestors(parent, depth - 1, out);
        }
      }
      return out;
    }

    /**
     * Warning text if serving a female with `sireId` is a close mating, else null.
     * `parents` ({ damId, sireId }) are the female's parents as currently typed
     * in the form, so an unsaved change to her pedigree is taken into account.
     */
    function inbreedingWarning(femaleId, sireId, parents) {
      if (!sireId) return null;
      const sire = byId.get(sireId);
      const sireName = sire ? label(sire) : sireId;
      const p = parents || byId.get(femaleId) || {};
      const herAncestors = new Set();
      for (const parent of [p.damId, p.sireId]) {
        if (parent) { herAncestors.add(parent); ancestors(parent, 2, herAncestors); }
      }
      if (herAncestors.has(sireId)) {
        return `${sireName} is already in this animal's pedigree (her sire or grandsire).`;
      }
      const shared = [...ancestors(sireId)].filter((x) => herAncestors.has(x));
      if (shared.length) {
        const names = shared.map((x) => (byId.get(x) ? label(byId.get(x)) : x)).join(', ');
        return `${sireName} and this animal share an ancestor: ${names}.`;
      }
      return null;
    }

    /** Suggested breed for a calf from its parents' breeds ('' when unknown). */
    function suggestBreed(damId, sireId) {
      const d = byId.get(damId);
      const s = byId.get(sireId);
      const db1 = d ? d.breed : '';
      const sb = s ? s.breed : '';
      const known = (b) => b && b !== 'Unknown';
      if (db1 === 'Cross' || sb === 'Cross') return 'Cross';
      if (known(db1) && known(sb)) return db1 === sb ? db1 : 'Cross';
      return '';
    }

    /* ----------------------------------------------------------------
     * 6. VALIDATION
     * ----------------------------------------------------------------
     * Returns { ok, data, errors[], warnings[] }. Errors block the save;
     * warnings ask for confirmation. Fields that do not apply (e.g. milking
     * status for a bull, sale price for an active cow) are cleared so the
     * sheet never shows contradictory values.
     * ---------------------------------------------------------------- */

    function validateAnimal(raw, ctx) {
      const errors = [];
      const warnings = [];
      const t = (v) => String(v ?? '').trim();
      const today = todayLocal();

      const d = {
        animalId: t(raw.animalId).toUpperCase(),
        name: t(raw.name),
        sex: t(raw.sex),
        category: t(raw.category),
        breed: t(raw.breed) || 'Unknown',
        breedNote: t(raw.breedNote).slice(0, 120),
        dateOfBirth: t(raw.dateOfBirth),
        dobApprox: !!raw.dobApprox,
        source: t(raw.source),
        purchaseDate: t(raw.purchaseDate),
        damId: t(raw.damId).toUpperCase(),
        sireId: t(raw.sireId).toUpperCase(),
        status: t(raw.status),
        statusDate: t(raw.statusDate),
        salePrice: t(raw.salePrice),
        statusNote: t(raw.statusNote).slice(0, 120),
        milkingStatus: t(raw.milkingStatus),
        pregnancyStatus: t(raw.pregnancyStatus),
        pregnancySireId: t(raw.pregnancySireId).toUpperCase(),
        aiCode: t(raw.aiCode).slice(0, 40),
        semenSupplier: t(raw.semenSupplier).slice(0, 60),
        semenType: t(raw.semenType),
        notes: t(raw.notes).slice(0, 500),
      };

      // --- Identity ---
      if (!ID_PATTERN.test(d.animalId)) {
        errors.push('ID must look like MT-008 (farm animal) or X-001 (outside animal).');
      } else {
        d.herd = herdOf(d.animalId);
        if (raw.herd && raw.herd !== d.herd) {
          errors.push(raw.herd === HERD.EXTERNAL ? 'Outside animals use X- IDs.' : 'Farm animals use MT- IDs.');
        }
        const changedId = ctx.isNew || (ctx.originalId && ctx.originalId !== d.animalId);
        if (changedId && byId.has(d.animalId)) errors.push(`${d.animalId} is already used. Pick another number.`);
      }
      const farm = d.herd !== HERD.EXTERNAL;

      if (!d.name) errors.push('Name is required (for an unknown ancestor use e.g. "Dam of Star").');
      if (d.name.length > 40) errors.push('Name is too long (max 40 letters).');
      if (!OPTIONS.sex.includes(d.sex)) errors.push('Choose Female or Male.');

      const categories = farm ? OPTIONS.categoryFarm : OPTIONS.categoryExternal;
      if (!categories.includes(d.category)) errors.push('Choose a category.');
      else if (CATEGORY_SEX[d.category] && CATEGORY_SEX[d.category] !== d.sex) {
        errors.push(`A ${d.category.toLowerCase()} must be ${CATEGORY_SEX[d.category].toLowerCase()}.`);
      }
      if (!OPTIONS.breed.includes(d.breed)) errors.push('Choose a breed.');

      // --- Dates (all optional, none in the future) ---
      for (const [field, name] of [['dateOfBirth', 'Date of birth'], ['purchaseDate', 'Purchase date'], ['statusDate', 'Status date']]) {
        if (!d[field]) continue;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d[field])) errors.push(`${name} is not a valid date.`);
        else if (d[field] > today) errors.push(`${name} cannot be in the future.`);
      }
      if (!d.dateOfBirth) d.dobApprox = false;

      // --- Parents ---
      for (const [field, sex, word] of [['damId', 'Female', 'Dam'], ['sireId', 'Male', 'Sire']]) {
        const id = d[field];
        if (!id) continue;
        if (id === d.animalId) { errors.push(`${word} cannot be the animal itself.`); continue; }
        const p = byId.get(id);
        if (!p) warnings.push(`${word} ${id} is not in the herd list on this phone.`);
        else if (p.sex !== sex) errors.push(`${word} must be ${sex.toLowerCase()} (${label(p)} is not).`);
      }

      // --- Farm-only fields ---
      if (farm) {
        if (d.source && !OPTIONS.source.includes(d.source)) errors.push('Choose where the animal came from.');
        if (d.source !== 'Purchased') d.purchaseDate = '';
        if (!OPTIONS.statusFarm.includes(d.status)) errors.push('Choose a status.');
        if (d.status === 'Active') { d.statusDate = ''; d.statusNote = ''; }
        if (d.status !== 'Sold') d.salePrice = '';
        if (d.salePrice !== '') {
          const price = Number(d.salePrice.replace(/,/g, ''));
          if (!Number.isFinite(price) || price < 0 || price > 10000000) errors.push('Sale price must be a number in KES.');
          else d.salePrice = Math.round(price);
        }
        d.aiCode = ''; d.semenSupplier = ''; d.semenType = '';
      } else {
        Object.assign(d, { source: '', purchaseDate: '', status: 'Reference', statusDate: '', salePrice: '', statusNote: '' });
        if (d.category !== 'AI bull') { d.aiCode = ''; d.semenSupplier = ''; d.semenType = ''; }
        if (!OPTIONS.semenType.includes(d.semenType)) errors.push('Choose a semen type.');
      }

      // --- Milking / pregnancy (farm cows and heifers only) ---
      const breedingFemale = farm && d.sex === 'Female' && BREEDING_FEMALE.includes(d.category);
      if (breedingFemale) {
        if (!OPTIONS.milking.includes(d.milkingStatus)) d.milkingStatus = d.category === 'Cow' ? 'Dry' : 'N/A';
        if (!OPTIONS.pregnancy.includes(d.pregnancyStatus)) d.pregnancyStatus = 'Open';
        if (d.pregnancyStatus !== 'In-calf') d.pregnancySireId = '';
        if (d.pregnancySireId) {
          const s = byId.get(d.pregnancySireId);
          if (s && s.sex !== 'Male') errors.push('The pregnancy sire must be male.');
          const w = inbreedingWarning(d.animalId, d.pregnancySireId, { damId: d.damId, sireId: d.sireId });
          if (w) warnings.push(w);
        }
        if (d.status !== 'Active' && d.milkingStatus === 'Lactating') d.milkingStatus = 'N/A';
      } else {
        d.milkingStatus = 'N/A'; d.pregnancyStatus = 'N/A'; d.pregnancySireId = '';
      }

      // Same name twice makes old name-based records ambiguous.
      const twin = animals.find((a) => a.animalId !== (ctx.originalId || d.animalId)
        && a.herd === HERD.FARM && farm && a.name.toLowerCase() === d.name.toLowerCase());
      if (twin) warnings.push(`${label(twin)} has the same name.`);

      return { ok: errors.length === 0, data: d, errors, warnings };
    }

    /* ----------------------------------------------------------------
     * 7. DROPDOWNS ON THE MILK AND CALF FEED FORMS
     * ----------------------------------------------------------------
     * Rebuilt whenever the herd changes. The current choice is kept.
     * "➕ Add a new animal…" jumps to the Herd tab form.
     * ---------------------------------------------------------------- */

    const ADD_VALUE = '__add__';
    const option = (a) => `<option value="${esc(a.animalId)}">${esc(a.name)} (${esc(a.animalId)})</option>`;

    function milkingCows() {
      return animals.filter((a) => isActiveFarm(a) && a.sex === 'Female' && a.milkingStatus === 'Lactating');
    }

    function renderSelects() {
      const milkSel = $('#milk-cowId');
      const calfSel = $('#calf-calfId');
      if (!milkSel || !calfSel) return;

      // Milk: cows marked Lactating first, then other active cows (e.g. a dry
      // cow that has just calved but whose status was not yet updated).
      const lactating = milkingCows();
      const otherCows = animals.filter((a) => isActiveFarm(a) && a.sex === 'Female'
        && a.category === 'Cow' && a.milkingStatus !== 'Lactating');
      let html = lactating.length || otherCows.length
        ? '<option value="">Choose a cow…</option>'
        : '<option value="">No cows yet: add them in the Herd tab</option>';
      if (lactating.length) html += `<optgroup label="Milking now">${lactating.map(option).join('')}</optgroup>`;
      if (otherCows.length) html += `<optgroup label="Not marked as milking">${otherCows.map(option).join('')}</optgroup>`;
      html += `<option value="${ADD_VALUE}">➕ Add a new animal…</option>`;
      const keepMilk = milkSel.value;
      milkSel.innerHTML = html;
      if (keepMilk && byId.has(keepMilk)) milkSel.value = keepMilk;

      // Calf feed: young stock that is still on the farm.
      const young = animals.filter((a) => isActiveFarm(a) && ['Calf', 'Heifer', 'Bull'].includes(a.category));
      let chtml = young.length
        ? '<option value="">Choose a calf…</option>'
        : '<option value="">No calves yet: add them in the Herd tab</option>';
      const byCat = (cat) => young.filter((a) => a.category === cat);
      for (const [cat, title] of [['Calf', 'Calves'], ['Heifer', 'Heifers'], ['Bull', 'Young bulls']]) {
        const list = byCat(cat);
        if (list.length) chtml += `<optgroup label="${title}">${list.map(option).join('')}</optgroup>`;
      }
      chtml += `<option value="${ADD_VALUE}">➕ Add a new animal…</option>`;
      const keepCalf = calfSel.value;
      calfSel.innerHTML = chtml;
      if (keepCalf && byId.has(keepCalf)) calfSel.value = keepCalf;
    }

    function handleLoggerSelectChange(event) {
      if (event.target.value !== ADD_VALUE) return;
      event.target.value = '';
      const forCalf = event.target.id === 'calf-calfId';
      activateTab('herd');
      openForm(null, forCalf ? { category: 'Calf' } : { category: 'Cow', sex: 'Female' });
    }

    /** After saving a milk entry: the next lactating cow in the list ('' at the end). */
    function nextMilkingCow(currentId) {
      const list = milkingCows();
      const i = list.findIndex((a) => a.animalId === currentId);
      return i >= 0 && i + 1 < list.length ? list[i + 1].animalId : '';
    }

    /* ----------------------------------------------------------------
     * 8. HERD TAB: LIST
     * ---------------------------------------------------------------- */

    const CHIP = {
      pending: '<span class="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-calf-100 text-calf-700">Pending</span>',
      failed: '<span class="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-red-100 text-red-700">Retrying</span>',
      synced: '<span class="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-farm-100 text-farm-800">Synced</span>',
    };
    const badge = (text, cls) => `<span class="text-[11px] font-semibold px-2 py-0.5 rounded-full ${cls}">${esc(text)}</span>`;

    function badgesFor(a) {
      const out = [];
      if (isFarm(a) && a.status !== 'Active') out.push(badge(a.status, a.status === 'Sold' ? 'bg-slate-200 text-slate-700' : 'bg-red-100 text-red-700'));
      if (a.milkingStatus === 'Lactating') out.push(badge('Milking', 'bg-farm-100 text-farm-800'));
      if (a.milkingStatus === 'Dry') out.push(badge('Dry', 'bg-slate-100 text-slate-600'));
      if (a.pregnancyStatus === 'In-calf') out.push(badge('In-calf', 'bg-calf-100 text-calf-700'));
      if (a.category === 'AI bull' && a.aiCode) out.push(badge(a.aiCode, 'bg-sky-100 text-sky-800'));
      return out.join('');
    }

    function describe(a) {
      const parts = [a.category, a.breed && a.breed !== 'Unknown' ? a.breed : null];
      if (isFarm(a) && a.source) parts.push(a.source);
      if (a.damId) parts.push(`dam ${byId.get(a.damId) ? byId.get(a.damId).name : a.damId}`);
      return parts.filter(Boolean).join(' · ');
    }

    function renderList() {
      const listEl = $('#herd-list');
      if (!listEl) return;

      const groups = {
        active: animals.filter(isActiveFarm),
        inactive: animals.filter((a) => isFarm(a) && a.status !== 'Active'),
        outside: animals.filter((a) => !isFarm(a)),
      };
      const rows = groups[listFilter];

      document.querySelectorAll('.herd-filter').forEach((btn) => {
        const on = btn.dataset.filter === listFilter;
        btn.classList.toggle('bg-sky-700', on);
        btn.classList.toggle('text-white', on);
        btn.classList.toggle('text-slate-600', !on);
        btn.setAttribute('aria-pressed', String(on));
        const count = btn.querySelector('.herd-count');
        if (count) count.textContent = groups[btn.dataset.filter].length;
      });

      const summary = $('#herd-summary');
      if (listFilter === 'active') {
        const milking = groups.active.filter((a) => a.milkingStatus === 'Lactating').length;
        const inCalf = groups.active.filter((a) => a.pregnancyStatus === 'In-calf').length;
        summary.textContent = `${groups.active.length} on the farm · ${milking} milking · ${inCalf} in-calf`;
      } else if (listFilter === 'inactive') {
        summary.textContent = 'Sold, dead and culled animals stay here as history.';
      } else {
        summary.textContent = 'AI bulls from your straw records and known ancestors. Never counted in the herd.';
      }

      if (!rows.length) {
        const empty = {
          active: animals.length
            ? 'No active animals.'
            : 'No animals on this phone yet. Connect to the internet and tap the sync badge to download the herd list.',
          inactive: 'No sold, dead or culled animals recorded.',
          outside: 'No outside animals yet. Add AI bulls (from the straw label) or ancestors such as a dam you never owned.',
        };
        listEl.innerHTML = `<li class="text-sm text-slate-400 px-1">${empty[listFilter]}</li>`;
        return;
      }

      listEl.innerHTML = rows.map((a) => {
        const kids = offspringOf(a.animalId).length;
        const errorLine = a.syncStatus === SYNC_STATUS.FAILED && a.lastError
          ? `<p class="text-xs text-red-600 mt-1">${esc(a.lastError)}</p>` : '';
        return `
          <li>
            <button type="button" class="herd-item w-full text-left flex items-start justify-between gap-3 bg-white rounded-xl px-4 py-3 shadow-sm active:scale-[.99] transition"
                    data-id="${esc(a.animalId)}">
              <div class="min-w-0">
                <p class="font-semibold text-sm truncate">${esc(a.name)} <span class="font-normal text-slate-400">${esc(a.animalId)}</span></p>
                <p class="text-xs text-slate-500 truncate">${esc(describe(a))}${kids ? ` · ${kids} offspring` : ''}</p>
                <div class="flex flex-wrap gap-1 mt-1 empty:hidden">${badgesFor(a)}</div>
                ${errorLine}
              </div>
              <div class="shrink-0 pt-0.5">${CHIP[a.syncStatus] || ''}</div>
            </button>
          </li>`;
      }).join('');
    }

    /* ----------------------------------------------------------------
     * 9. HERD TAB: FORM
     * ---------------------------------------------------------------- */

    const FORM_FIELDS = [
      'animalId', 'name', 'sex', 'category', 'breed', 'breedNote', 'dateOfBirth', 'source',
      'purchaseDate', 'damId', 'sireId', 'status', 'statusDate', 'salePrice', 'statusNote',
      'milkingStatus', 'pregnancyStatus', 'pregnancySireId', 'aiCode', 'semenSupplier',
      'semenType', 'notes',
    ];
    const field = (name) => $(`#hf-${name}`);

    /** Fill a <select> with values (or [value, label] pairs) and select `current`. */
    function fillSelect(sel, values, current, blankLabel) {
      const pairs = values.map((v) => (Array.isArray(v) ? v : [v, v || '—']));
      if (current && !pairs.some(([v]) => v === current)) pairs.push([current, `${current} (not on this phone)`]);
      sel.innerHTML = (blankLabel != null ? `<option value="">${esc(blankLabel)}</option>` : '')
        + pairs.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
      sel.value = current || '';
    }

    function parentChoices(sex, selfId) {
      return animals
        .filter((a) => a.sex === sex && a.animalId !== selfId)
        .sort(sortById)
        .map((a) => [a.animalId, `${label(a)}${isFarm(a) ? '' : ` (${a.category})`}`]);
    }

    function fillParentSelects(selfId, values) {
      fillSelect(field('damId'), parentChoices('Female', selfId), values.damId, 'Unknown / not recorded');
      fillSelect(field('sireId'), parentChoices('Male', selfId), values.sireId, 'Unknown / not recorded');
      // AI bulls first for the pregnancy sire: that is the usual case.
      const males = parentChoices('Male', selfId);
      const ai = males.filter(([id]) => byId.get(id) && byId.get(id).category === 'AI bull');
      const rest = males.filter((m) => !ai.includes(m));
      fillSelect(field('pregnancySireId'), [...ai, ...rest], values.pregnancySireId, 'Not recorded');
    }

    function currentHerd() { return field('herd').value === HERD.EXTERNAL ? HERD.EXTERNAL : HERD.FARM; }

    /** Show only the fields that apply to this animal. */
    function updateVisibility() {
      const herd = currentHerd();
      const farm = herd === HERD.FARM;
      const sex = field('sex').value;
      const category = field('category').value;
      const status = field('status').value;
      const breedingFemale = farm && sex === 'Female' && BREEDING_FEMALE.includes(category);

      show($('#hfg-source'), farm);
      show($('#hfg-purchaseDate'), farm && field('source').value === 'Purchased');
      show($('#hfg-status'), farm);
      show($('#hfg-salePrice'), farm && status === 'Sold');
      show($('#hfg-statusNote'), farm && status !== 'Active');
      $('#hf-statusNote-label').textContent = status === 'Sold' ? 'Buyer (optional, keep it general)' : 'Reason / note (optional)';
      show($('#hfg-female'), breedingFemale);
      show($('#hfg-pregnancySire'), breedingFemale && field('pregnancyStatus').value === 'In-calf');
      show($('#hfg-ai'), !farm && category === 'AI bull');

      // Live pedigree warning for the current pregnancy.
      const warn = breedingFemale && field('pregnancyStatus').value === 'In-calf'
        ? inbreedingWarning(field('animalId').value.trim().toUpperCase(), field('pregnancySireId').value,
          { damId: field('damId').value, sireId: field('sireId').value })
        : null;
      setFormMessage('warning', warn);
    }

    function setCategoryOptions(herd, current) {
      const list = herd === HERD.EXTERNAL ? OPTIONS.categoryExternal : OPTIONS.categoryFarm;
      fillSelect(field('category'), list, list.includes(current) ? current : '', 'Choose…');
    }

    function setFormMessage(kind, text) {
      const el = $(kind === 'error' ? '#herd-error' : '#herd-warning');
      el.textContent = text || '';
      show(el, !!text);
    }

    /**
     * Open the form. id = null → new animal (preset = default values).
     */
    function openForm(id, preset = {}) {
      const a = id ? byId.get(id) : null;
      if (id && !a) { toast('That animal is no longer on this phone', 'error'); return; }

      const isNew = !a;
      const herd = a ? a.herd : (preset.herd || (listFilter === 'outside' ? HERD.EXTERNAL : HERD.FARM));
      const values = a || {
        animalId: nextId(herd), herd, name: '', sex: preset.sex || '', category: preset.category || '',
        breed: 'Unknown', source: herd === HERD.FARM ? 'Born on farm' : '', status: 'Active',
        milkingStatus: preset.category === 'Cow' ? 'Lactating' : 'N/A',
        pregnancyStatus: preset.category === 'Calf' ? 'N/A' : 'Open', semenType: '',
      };
      editing = { originalId: a ? a.animalId : null, isNew };
      breedTouched = !isNew;

      // Header
      $('#herd-form-title').textContent = isNew ? 'Add an animal' : `${a.name} · ${a.animalId}`;
      $('#herd-form-sync').innerHTML = a ? (CHIP[a.syncStatus] || '') : '';

      // Herd kind and ID: the kind is fixed once saved; the ID can change
      // only while the animal has never reached the sheet.
      field('herd').value = herd;
      field('herd').disabled = !isNew;
      const idEditable = isNew || !a.syncedAt;
      field('animalId').readOnly = !idEditable;
      field('animalId').classList.toggle('bg-slate-50', !idEditable);
      $('#herd-id-hint').textContent = isNew
        ? 'Next free number. Numbers are never reused.'
        : (idEditable ? 'Not uploaded yet, so the number can still change.' : 'Permanent ID.');

      setCategoryOptions(herd, values.category);
      fillSelect(field('sex'), OPTIONS.sex, values.sex, 'Choose…');
      fillSelect(field('breed'), OPTIONS.breed, values.breed || 'Unknown');
      fillSelect(field('source'), OPTIONS.source, values.source, 'Not recorded');
      fillSelect(field('status'), OPTIONS.statusFarm, values.status === 'Reference' ? 'Active' : (values.status || 'Active'));
      fillSelect(field('milkingStatus'), OPTIONS.milking, values.milkingStatus || 'N/A');
      fillSelect(field('pregnancyStatus'), OPTIONS.pregnancy, values.pregnancyStatus || 'Open');
      fillSelect(field('semenType'), OPTIONS.semenType.map((v) => [v, v || 'Not recorded']), values.semenType || '');
      fillParentSelects(values.animalId, values);

      for (const name of ['animalId', 'name', 'breedNote', 'dateOfBirth', 'purchaseDate', 'statusDate',
        'salePrice', 'statusNote', 'aiCode', 'semenSupplier', 'notes']) {
        field(name).value = values[name] ?? '';
      }
      field('dobApprox').checked = values.dobApprox === true;
      const today = todayLocal();
      ['dateOfBirth', 'purchaseDate', 'statusDate'].forEach((n) => { field(n).max = today; });

      // Offspring and last-change line for existing animals.
      const meta = $('#herd-form-meta');
      if (a) {
        const kids = offspringOf(a.animalId);
        const kidsText = kids.length ? `Offspring: ${kids.map((k) => `${k.name} (${k.animalId})`).join(', ')}` : 'No offspring recorded.';
        const changed = a.updatedAt ? `Last changed ${new Date(a.updatedAt).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}${a.updatedBy && a.updatedBy !== 'seed' ? ` by ${a.updatedBy}` : ''}.` : '';
        meta.innerHTML = `<p>${esc(kidsText)}</p><p>${esc(changed)}</p>${a.lastError && a.syncStatus === SYNC_STATUS.FAILED ? `<p class="text-red-600">${esc(a.lastError)}</p>` : ''}`;
      } else {
        meta.innerHTML = '';
      }
      show(meta, !!a);

      show($('#herd-delete'), !!a && !a.syncedAt);
      setFormMessage('error', null);

      show($('#herd-list-view'), false);
      show($('#herd-form'), true);
      updateVisibility();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      if (isNew) field('name').focus();
    }

    function closeForm() {
      editing = null;
      show($('#herd-form'), false);
      show($('#herd-list-view'), true);
      setFormMessage('error', null);
      setFormMessage('warning', null);
    }

    function readForm() {
      const raw = { herd: currentHerd(), dobApprox: field('dobApprox').checked };
      for (const name of FORM_FIELDS) raw[name] = field(name).value;
      return raw;
    }

    function handleHerdKindChange() {
      if (!editing || !editing.isNew) return;
      const herd = currentHerd();
      field('animalId').value = nextId(herd);
      setCategoryOptions(herd, '');
      if (herd === HERD.EXTERNAL) field('source').value = '';
      updateVisibility();
    }

    function handleCategoryChange() {
      const forced = CATEGORY_SEX[field('category').value];
      if (forced) field('sex').value = forced;
      if (field('category').value === 'Cow' && field('milkingStatus').value === 'N/A') field('milkingStatus').value = 'Dry';
      updateVisibility();
    }

    function handleParentChange() {
      if (breedTouched) return;
      const s = suggestBreed(field('damId').value, field('sireId').value);
      if (s) field('breed').value = s;
    }

    async function handleSubmit(event) {
      event.preventDefault();
      if (!editing) return;
      if (!getSession()) { toast('Sign in first', 'error'); return; }

      const result = validateAnimal(readForm(), editing);
      if (!result.ok) {
        setFormMessage('error', result.errors[0]);
        return;
      }
      setFormMessage('error', null);
      if (result.warnings.length && !confirm(`${result.warnings.join('\n')}\n\nSave anyway?`)) return;

      const btn = $('#herd-save');
      btn.disabled = true;
      try {
        const saved = await saveAnimal(result.data, editing);
        toast(`${editing.isNew ? 'Added' : 'Saved'}: ${saved.name} (${saved.animalId})`);
        if (editing.isNew) listFilter = saved.herd === HERD.EXTERNAL ? 'outside' : (saved.status === 'Active' ? 'active' : 'inactive');
        closeForm();
        renderList();
        requestSync('herd-save', saveDebounceMs);
      } catch (err) {
        console.error('Animal save failed:', err);
        setFormMessage('error', err.message || String(err));
      } finally {
        btn.disabled = false;
      }
    }

    async function handleDelete() {
      if (!editing || !editing.originalId) return;
      if (!confirm(`Delete ${editing.originalId} from this phone? It has not been uploaded yet.`)) return;
      try {
        await deleteUnsyncedAnimal(editing.originalId);
        toast('Animal deleted', 'info');
        closeForm();
      } catch (err) {
        setFormMessage('error', err.message);
      }
    }

    /* ----------------------------------------------------------------
     * 10. INIT + PUBLIC API
     * ---------------------------------------------------------------- */

    function init() {
      $('#herd-add').addEventListener('click', () => openForm(null));
      $('#herd-list').addEventListener('click', (e) => {
        const item = e.target.closest('.herd-item');
        if (item) openForm(item.dataset.id);
      });
      document.querySelectorAll('.herd-filter').forEach((btn) =>
        btn.addEventListener('click', () => { listFilter = btn.dataset.filter; renderList(); }));

      $('#herd-form').addEventListener('submit', handleSubmit);
      $('#herd-cancel').addEventListener('click', closeForm);
      $('#herd-back').addEventListener('click', closeForm);
      $('#herd-delete').addEventListener('click', handleDelete);
      field('herd').addEventListener('change', handleHerdKindChange);
      field('category').addEventListener('change', handleCategoryChange);
      field('breed').addEventListener('change', () => { breedTouched = true; });
      field('damId').addEventListener('change', () => { handleParentChange(); updateVisibility(); });
      field('sireId').addEventListener('change', () => { handleParentChange(); updateVisibility(); });
      ['sex', 'source', 'status', 'pregnancyStatus', 'pregnancySireId'].forEach((n) =>
        field(n).addEventListener('change', updateVisibility));

      $('#milk-cowId').addEventListener('change', handleLoggerSelectChange);
      $('#calf-calfId').addEventListener('change', handleLoggerSelectChange);

      // One live query keeps the list, the dropdowns and the lookup map current.
      Dexie.liveQuery(() => table().toArray()).subscribe({
        next: (rows) => {
          animals = rows.sort(sortById);
          byId.clear();
          for (const a of animals) byId.set(a.animalId, a);
          renderList();
          renderSelects();
        },
        error: (e) => console.error('Herd query failed:', e),
      });
    }

    return Object.freeze({
      STORE,
      init,
      getAnimal,
      isEmpty: () => animals.length === 0,
      isEditing: () => !!editing,
      nextMilkingCow,
      openForm,
      // sync helpers for app.js
      inFlight,
      getPendingAnimals,
      countPending,
      toPayload,
      applyPushResults,
      mergePulled,
      // exposed for console checks
      validateAnimal,
      ancestors,
      offspringOf,
      suggestBreed,
      nextId,
    });
  }

  window.MaweHerd = Object.freeze({ create, STORE, ID_PATTERN, OPTIONS, PAYLOAD_FIELDS, HERD });
})();
