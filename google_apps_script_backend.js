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
    if (action !== 'save') return json_({ ok: false, error: `Unknown action: ${action}` });
    const tripId = cleanTripId_(e.parameter.tripId);
    const token = String(e.parameter.token || '');
    const actor = String(e.parameter.actor || 'anonymous').slice(0, 80);
    const baseRevision = String(e.parameter.baseRevision || '');
    const payloadText = String(e.parameter.payload || '');
    if (!tripId) return json_({ ok: false, error: 'Missing tripId' });
    if (!token) return json_({ ok: false, error: 'Missing edit token' });
    if (!payloadText) return json_({ ok: false, error: 'Missing payload' });

    const trip = JSON.parse(payloadText);
    trip.id = tripId;
    trip.updatedAt = new Date().toISOString();
    trip.updatedBy = actor;

    const existing = readTripDoc_(tripId);
    if (existing && String(existing.editToken || '') !== token) {
      throw new Error('Edit token does not match this trip');
    }
    const existingRevision = existing ? String(existing.revision || existing.updatedAt || '') : '';
    if (existingRevision && baseRevision && baseRevision !== existingRevision) {
      throw new Error(`Cloud version changed since you loaded it. Please load cloud first. current=${existingRevision}`);
    }
    if (existingRevision && !baseRevision) {
      throw new Error('Cloud version already exists, but this device has not loaded it yet. Please load cloud first.');
    }

    const log = Array.isArray(existing && existing.log) ? existing.log.slice(0, 99) : [];
    log.unshift({ time: trip.updatedAt, actor, action: existing ? 'save' : 'create' });
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
    fileId: file ? file.getId() : undefined,
    fileName: file ? file.getName() : undefined
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
