/**
 * Travel Planner Google Drive JSON sync backend.
 *
 * Setup:
 * 1. Go to https://script.google.com and create a new Apps Script project.
 * 2. Paste this file.
 * 3. In the function dropdown, run setupTravelPlannerCloud once and authorize Drive access.
 * 4. Deploy -> New deployment -> Web app.
 * 5. Execute as: Me. Who has access: Anyone with the link.
 * 6. Copy the /exec URL into the travel planner.
 *
 * Storage:
 * - GitHub Pages stores only the app code.
 * - This script stores each trip as one JSON file in Google Drive:
 *   Travel Planner Cloud/trip-planner_<tripId>.json
 */

const DRIVE_FOLDER_NAME = 'Travel Planner Cloud';
const FILE_PREFIX = 'trip-planner_';
const FILE_SUFFIX = '.json';
const LOCK_TTL_MS = 5 * 60 * 1000;

function setupTravelPlannerCloud() {
  const folder = getFolder_();
  Logger.log(`Travel Planner Cloud folder ready: ${folder.getName()} (${folder.getId()})`);
  return { ok: true, folderName: folder.getName(), folderId: folder.getId() };
}

function doGet(e) {
  const callback = String(e.parameter.callback || '').trim();
  try {
    const action = String(e.parameter.action || 'load');
    if (action === 'ping') return json_({ ok: true, now: new Date().toISOString(), storage: 'google-drive-json' }, callback);
    if (action === 'list') return json_({ ok: true, trips: listTrips_() }, callback);
    if (action === 'load') {
      const tripId = cleanTripId_(e.parameter.tripId);
      if (!tripId) return json_({ ok: false, error: 'Missing tripId' }, callback);
      const doc = readTripDoc_(tripId);
      return json_({ ok: true, trip: doc ? doc.trip : null, meta: doc ? publicMeta_(doc) : null }, callback);
    }
    if (action === 'acquireLock' || action === 'renewLock' || action === 'releaseLock') {
      const scriptLock = LockService.getScriptLock();
      scriptLock.waitLock(12000);
      try {
        return json_(handleLockAction_(action, e.parameter), callback);
      } finally {
        scriptLock.releaseLock();
      }
    }
    return json_({ ok: false, error: `Unknown action: ${action}` }, callback);
  } catch (err) {
    return json_({ ok: false, error: err.message || String(err) }, callback);
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(12000);
  try {
    const action = String(e.parameter.action || 'save');
    if (action === 'acquireLock' || action === 'renewLock' || action === 'releaseLock') {
      return json_(handleLockAction_(action, e.parameter));
    }
    if (action !== 'save') return json_({ ok: false, error: `Unknown action: ${action}` });
    const tripId = cleanTripId_(e.parameter.tripId);
    const token = String(e.parameter.token || '');
    const actor = String(e.parameter.actor || 'anonymous').slice(0, 80);
    const ownerId = String(e.parameter.ownerId || '').slice(0, 120);
    const baseRevision = String(e.parameter.baseRevision || '');
    const force = String(e.parameter.force || '') === '1';
    const payloadText = String(e.parameter.payload || '');
    if (!tripId) return json_({ ok: false, error: 'Missing tripId' });
    if (!token) return json_({ ok: false, error: 'Missing edit token' });
    if (!ownerId) return json_({ ok: false, error: 'Missing lock ownerId' });
    if (!payloadText) return json_({ ok: false, error: 'Missing payload' });

    const trip = JSON.parse(payloadText);
    trip.id = tripId;
    trip.updatedAt = new Date().toISOString();
    trip.updatedBy = actor;

    const existing = readTripDoc_(tripId);
    if (existing && String(existing.editToken || '') !== token) {
      throw new Error('Edit token does not match this trip');
    }
    if (existing && existing.trip) {
      const now = new Date();
      const lockInfo = activeLockInfo_(existing.lock, now);
      if (!lockInfo.active) {
        throw new Error('No active edit lock. Please press Start Editing before saving.');
      }
      if (String(existing.lock.ownerId || '') !== ownerId) {
        throw new Error(`Trip is locked by ${existing.lock.ownerName || 'another editor'} until ${existing.lock.expiresAt || ''}`);
      }
      existing.lock = makeLock_(ownerId, actor, now);
    } else if (existing && existing.lock) {
      const lockInfo = activeLockInfo_(existing.lock, new Date());
      if (lockInfo.active && String(existing.lock.ownerId || '') !== ownerId) {
        throw new Error(`Trip is locked by ${existing.lock.ownerName || 'another editor'} until ${existing.lock.expiresAt || ''}`);
      }
      existing.lock = makeLock_(ownerId, actor, new Date());
    }
    const existingRevision = existing ? String(existing.revision || existing.updatedAt || '') : '';
    if (!force && existingRevision && baseRevision && baseRevision !== existingRevision) {
      throw new Error(`Cloud version changed since you loaded it. Please load cloud first. current=${existingRevision}`);
    }
    if (!force && existingRevision && !baseRevision) {
      throw new Error('Cloud version already exists, but this device has not loaded it yet. Please load cloud first.');
    }

    const log = Array.isArray(existing && existing.log) ? existing.log.slice(0, 99) : [];
    log.unshift({ time: trip.updatedAt, actor, action: force ? 'force_save' : existing ? 'save' : 'create' });
    const revision = `${Date.now()}_${Utilities.getUuid().slice(0, 8)}`;
    const doc = {
      _app: 'travel-planner-cloud',
      _schema: 2,
      storage: 'google-drive-json',
      tripId,
      title: trip.title || tripId,
      updatedAt: trip.updatedAt,
      updatedBy: actor,
      revision,
      editToken: token,
      lock: existing && existing.lock ? existing.lock : makeLock_(ownerId, actor, new Date()),
      log,
      trip
    };

    const file = writeTripDoc_(tripId, doc);
    return json_({
      ok: true,
      tripId,
      updatedAt: doc.updatedAt,
      updatedBy: actor,
      revision,
      fileId: file.getId(),
      fileName: file.getName(),
      bytes: JSON.stringify(doc).length
    });
  } catch (err) {
    return json_({ ok: false, error: err.message || String(err) });
  } finally {
    lock.releaseLock();
  }
}

function handleLockAction_(action, params) {
  const tripId = cleanTripId_(params.tripId);
  const token = String(params.token || '');
  const actor = String(params.actor || 'anonymous').slice(0, 80);
  const ownerId = String(params.ownerId || '').slice(0, 120);
  if (!tripId) return { ok: false, error: 'Missing tripId' };
  if (!token) return { ok: false, error: 'Missing edit token' };
  if (!ownerId) return { ok: false, error: 'Missing ownerId' };

  let doc = readTripDoc_(tripId);
  if (doc && String(doc.editToken || '') !== token) {
    throw new Error('Edit token does not match this trip');
  }
  const now = new Date();
  const current = activeLockInfo_(doc && doc.lock, now);

  if (action === 'acquireLock') {
    if (current.active && String(doc.lock.ownerId || '') !== ownerId) {
      return { ok: false, locked: true, error: `Trip is locked by ${doc.lock.ownerName || 'another editor'}`, meta: publicMeta_(doc) };
    }
    const lock = makeLock_(ownerId, actor, now);
    if (!doc) {
      doc = {
        _app: 'travel-planner-cloud',
        _schema: 2,
        storage: 'google-drive-json',
        tripId,
        title: tripId,
        updatedAt: '',
        updatedBy: '',
        revision: `lock_${Date.now()}_${Utilities.getUuid().slice(0, 8)}`,
        editToken: token,
        lock,
        log: [],
        trip: null
      };
    } else {
      doc.lock = lock;
      doc.revision = doc.revision || `lock_${Date.now()}_${Utilities.getUuid().slice(0, 8)}`;
    }
    const file = writeTripDoc_(tripId, doc);
    return { ok: true, locked: false, trip: doc.trip || null, meta: publicMeta_(doc, file) };
  }

  if (!doc) return { ok: false, error: 'Cloud trip does not exist yet' };
  if (!current.active) {
    return { ok: false, expired: true, error: 'Edit lock expired. Please acquire a new lock.', meta: publicMeta_(doc) };
  }
  if (String(doc.lock.ownerId || '') !== ownerId) {
    return { ok: false, locked: true, error: `Trip is locked by ${doc.lock.ownerName || 'another editor'}`, meta: publicMeta_(doc) };
  }

  if (action === 'renewLock') {
    doc.lock = makeLock_(ownerId, actor, now);
    const file = writeTripDoc_(tripId, doc);
    return { ok: true, meta: publicMeta_(doc, file) };
  }

  if (action === 'releaseLock') {
    doc.lock = null;
    const log = Array.isArray(doc.log) ? doc.log.slice(0, 99) : [];
    log.unshift({ time: now.toISOString(), actor, action: 'release_lock' });
    doc.log = log;
    const file = writeTripDoc_(tripId, doc);
    return { ok: true, meta: publicMeta_(doc, file) };
  }

  return { ok: false, error: `Unknown lock action: ${action}` };
}

function listTrips_() {
  const folder = getFolder_();
  const files = folder.getFiles();
  const trips = [];
  while (files.hasNext()) {
    const file = files.next();
    if (!file.getName().startsWith(FILE_PREFIX) || !file.getName().endsWith(FILE_SUFFIX)) continue;
    try {
      const doc = JSON.parse(file.getBlob().getDataAsString('UTF-8'));
      trips.push(publicMeta_(doc, file));
    } catch (err) {
      trips.push({
        tripId: file.getName(),
        title: file.getName(),
        updatedAt: file.getLastUpdated().toISOString(),
        updatedBy: '',
        fileId: file.getId(),
        parseError: err.message || String(err)
      });
    }
  }
  return trips.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function readTripDoc_(tripId) {
  const file = findTripFile_(tripId);
  if (!file) return null;
  const text = file.getBlob().getDataAsString('UTF-8');
  if (!text) return null;
  return JSON.parse(text);
}

function writeTripDoc_(tripId, doc) {
  const folder = getFolder_();
  const text = JSON.stringify(doc);
  const fileName = fileNameForTrip_(tripId);
  let file = findTripFile_(tripId);
  if (file) {
    file.setContent(text);
    file.setName(fileName);
    return file;
  }
  return folder.createFile(fileName, text, MimeType.PLAIN_TEXT);
}

function findTripFile_(tripId) {
  const folder = getFolder_();
  const files = folder.getFilesByName(fileNameForTrip_(tripId));
  return files.hasNext() ? files.next() : null;
}

function getFolder_() {
  const folders = DriveApp.getFoldersByName(DRIVE_FOLDER_NAME);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(DRIVE_FOLDER_NAME);
}

function fileNameForTrip_(tripId) {
  return `${FILE_PREFIX}${tripId}${FILE_SUFFIX}`;
}

function publicMeta_(doc, file) {
  return {
    tripId: doc.tripId || doc.trip && doc.trip.id || '',
    title: doc.title || doc.trip && doc.trip.title || '',
    updatedAt: doc.updatedAt || doc.trip && doc.trip.updatedAt || '',
    updatedBy: doc.updatedBy || doc.trip && doc.trip.updatedBy || '',
    revision: doc.revision || doc.updatedAt || doc.trip && doc.trip.updatedAt || '',
    storage: doc.storage || 'google-drive-json',
    lock: publicLock_(doc.lock),
    fileId: file ? file.getId() : undefined,
    fileName: file ? file.getName() : undefined
  };
}

function makeLock_(ownerId, ownerName, now) {
  const lockedAt = now.toISOString();
  return {
    ownerId,
    ownerName: ownerName || 'anonymous',
    lockedAt,
    renewedAt: lockedAt,
    expiresAt: new Date(now.getTime() + LOCK_TTL_MS).toISOString()
  };
}

function activeLockInfo_(lock, now) {
  if (!lock || !lock.expiresAt) return { active: false };
  const expires = new Date(lock.expiresAt).getTime();
  return { active: Number.isFinite(expires) && expires > now.getTime(), expires };
}

function publicLock_(lock) {
  const info = activeLockInfo_(lock, new Date());
  if (!info.active) return null;
  return {
    ownerId: lock.ownerId || '',
    ownerName: lock.ownerName || '',
    lockedAt: lock.lockedAt || '',
    renewedAt: lock.renewedAt || '',
    expiresAt: lock.expiresAt || ''
  };
}

function cleanTripId_(value) {
  return String(value || '').trim().replace(/[^\w-]/g, '-').slice(0, 48);
}

function safeCallback_(value) {
  return /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(value) ? value : '';
}

function json_(obj, callback) {
  const text = JSON.stringify(obj);
  const cb = safeCallback_(callback || '');
  return ContentService
    .createTextOutput(cb ? `${cb}(${text});` : text)
    .setMimeType(cb ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON);
}
