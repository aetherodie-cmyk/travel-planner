/**
 * Travel Planner Google JSON sync backend.
 *
 * Setup:
 * 1. Create a Google Sheet.
 * 2. Extensions -> Apps Script.
 * 3. Paste this file.
 * 4. Deploy -> New deployment -> Web app.
 * 5. Execute as: Me. Who has access: Anyone with the link.
 * 6. Copy the /exec URL into the travel planner.
 *
 * Data model:
 * - Trips: metadata, token, log.
 * - TripChunks: large JSON split into 45k-character chunks.
 */

const SHEET_NAME = 'Trips';
const CHUNK_SHEET_NAME = 'TripChunks';
const CHUNK_SIZE = 45000;
const HEADERS = ['tripId', 'title', 'jsonRef', 'updatedAt', 'updatedBy', 'editToken', 'logJson'];
const CHUNK_HEADERS = ['tripId', 'seq', 'chunk'];

function doGet(e) {
  const callback = String(e.parameter.callback || '').trim();
  try {
    const action = String(e.parameter.action || 'load');
    if (action === 'ping') return json_({ ok: true, now: new Date().toISOString() }, callback);
    if (action === 'list') return json_({ ok: true, trips: listTrips_() }, callback);
    if (action === 'load') {
      const tripId = cleanTripId_(e.parameter.tripId);
      if (!tripId) return json_({ ok: false, error: 'Missing tripId' }, callback);
      return json_({ ok: true, trip: readTrip_(tripId) }, callback);
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
    const payloadText = String(e.parameter.payload || '');
    if (!tripId) return json_({ ok: false, error: 'Missing tripId' });
    if (!token) return json_({ ok: false, error: 'Missing edit token' });
    if (!payloadText) return json_({ ok: false, error: 'Missing payload' });
    const payload = JSON.parse(payloadText);
    payload.id = tripId;
    payload.updatedAt = new Date().toISOString();
    payload.updatedBy = actor;
    const saved = saveTrip_(tripId, payload, token, actor);
    return json_({
      ok: true,
      tripId,
      updatedAt: saved.updatedAt,
      updatedBy: actor,
      chunks: saved.chunks,
      bytes: payloadText.length
    });
  } catch (err) {
    return json_({ ok: false, error: err.message || String(err) });
  } finally {
    lock.releaseLock();
  }
}

function listTrips_() {
  const sheet = getSheet_();
  const values = sheet.getDataRange().getValues();
  return values.slice(1).filter(row => row[0]).map(row => ({
    tripId: row[0],
    title: row[1] || row[0],
    updatedAt: row[3] || '',
    updatedBy: row[4] || ''
  })).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function readTrip_(tripId) {
  const sheet = getSheet_();
  const rowIndex = findTripRow_(sheet, tripId);
  if (!rowIndex) return null;
  const row = sheet.getRange(rowIndex, 1, 1, HEADERS.length).getValues()[0];
  const jsonRef = String(row[2] || '');
  let payloadText = '';
  if (jsonRef.indexOf('__chunked__:') === 0) {
    payloadText = readChunks_(tripId);
  } else {
    payloadText = jsonRef;
  }
  if (!payloadText) return null;
  const payload = JSON.parse(payloadText);
  payload.id = tripId;
  payload.title = payload.title || row[1] || tripId;
  payload.updatedAt = payload.updatedAt || row[3] || '';
  payload.updatedBy = payload.updatedBy || row[4] || '';
  return payload;
}

function saveTrip_(tripId, payload, token, actor) {
  const sheet = getSheet_();
  let rowIndex = findTripRow_(sheet, tripId);
  const now = payload.updatedAt || new Date().toISOString();
  const title = payload.title || tripId;
  const payloadText = JSON.stringify(payload);
  if (!rowIndex) {
    const log = [{ time: now, actor, action: 'create' }];
    rowIndex = sheet.getLastRow() + 1;
    sheet.getRange(rowIndex, 1, 1, HEADERS.length).setValues([[
      tripId, title, '', now, actor, token, JSON.stringify(log)
    ]]);
  } else {
    const tokenCell = sheet.getRange(rowIndex, 6).getValue();
    if (String(tokenCell || '') !== token) throw new Error('Edit token does not match this trip');
  }
  const oldLogText = sheet.getRange(rowIndex, 7).getValue();
  let log = [];
  try { log = JSON.parse(oldLogText || '[]'); } catch (err) { log = []; }
  log.unshift({ time: now, actor, action: 'save' });
  log = log.slice(0, 100);
  const chunks = writeChunks_(tripId, payloadText);
  sheet.getRange(rowIndex, 1, 1, HEADERS.length).setValues([[
    tripId,
    title,
    `__chunked__:${chunks}:${payloadText.length}`,
    now,
    actor,
    token,
    JSON.stringify(log)
  ]]);
  return { updatedAt: now, chunks };
}

function writeChunks_(tripId, text) {
  const sheet = getChunkSheet_();
  deleteChunks_(sheet, tripId);
  const rows = [];
  for (let start = 0, seq = 0; start < text.length; start += CHUNK_SIZE, seq++) {
    rows.push([tripId, seq, text.slice(start, start + CHUNK_SIZE)]);
  }
  if (rows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, CHUNK_HEADERS.length).setValues(rows);
  }
  return rows.length;
}

function readChunks_(tripId) {
  const sheet = getChunkSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return '';
  const values = sheet.getRange(2, 1, lastRow - 1, CHUNK_HEADERS.length).getValues();
  return values
    .filter(row => String(row[0]) === tripId)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map(row => String(row[2] || ''))
    .join('');
}

function deleteChunks_(sheet, tripId) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues().flat();
  for (let i = ids.length - 1; i >= 0; i--) {
    if (String(ids[i]) === tripId) sheet.deleteRow(i + 2);
  }
}

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  ensureHeaders_(sheet, HEADERS);
  return sheet;
}

function getChunkSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CHUNK_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(CHUNK_SHEET_NAME);
  ensureHeaders_(sheet, CHUNK_HEADERS);
  return sheet;
}

function ensureHeaders_(sheet, headers) {
  const existing = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  if (existing.join('') !== headers.join('')) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }
}

function findTripRow_(sheet, tripId) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues().flat();
  const idx = ids.findIndex(id => String(id) === tripId);
  return idx === -1 ? 0 : idx + 2;
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
