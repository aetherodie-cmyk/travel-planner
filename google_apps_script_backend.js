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
 */

const SHEET_NAME = 'Trips';
const HEADERS = ['tripId', 'title', 'json', 'updatedAt', 'updatedBy', 'editToken', 'logJson'];

function doGet(e) {
  try {
    const action = String(e.parameter.action || 'load');
    if (action === 'ping') return json_({ ok: true, now: new Date().toISOString() });
    if (action === 'list') return json_({ ok: true, trips: listTrips_() });
    if (action === 'load') {
      const tripId = cleanTripId_(e.parameter.tripId);
      if (!tripId) return json_({ ok: false, error: 'Missing tripId' });
      return json_({ ok: true, trip: readTrip_(tripId) });
    }
    return json_({ ok: false, error: `Unknown action: ${action}` });
  } catch (err) {
    return json_({ ok: false, error: err.message || String(err) });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(8000);
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
    return json_({ ok: true, tripId, updatedAt: saved.updatedAt, updatedBy: actor });
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
  if (!row[2]) return null;
  const payload = JSON.parse(row[2]);
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
  if (!rowIndex) {
    const log = [{ time: now, actor, action: 'create' }];
    sheet.appendRow([tripId, title, JSON.stringify(payload), now, actor, token, JSON.stringify(log)]);
    return { updatedAt: now };
  }
  const tokenCell = sheet.getRange(rowIndex, 6).getValue();
  if (String(tokenCell || '') !== token) throw new Error('Edit token does not match this trip');
  const oldLogText = sheet.getRange(rowIndex, 7).getValue();
  let log = [];
  try { log = JSON.parse(oldLogText || '[]'); } catch (err) { log = []; }
  log.unshift({ time: now, actor, action: 'save' });
  log = log.slice(0, 100);
  sheet.getRange(rowIndex, 1, 1, HEADERS.length).setValues([[
    tripId,
    title,
    JSON.stringify(payload),
    now,
    actor,
    token,
    JSON.stringify(log)
  ]]);
  return { updatedAt: now };
}

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  const existing = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  if (existing.join('') !== HEADERS.join('')) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
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

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
