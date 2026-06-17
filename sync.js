// liongard-monday-sync.js
// Syncs Liongard security alerts to Monday.com "Liongard - Security Risks" board
//
// Required env vars:
//   LIONGARD_INSTANCE     - e.g. "us10"
//   LIONGARD_KEY_ID       - Access Key ID
//   LIONGARD_KEY_SECRET   - Access Key Secret
//   MONDAY_TOKEN          - Monday.com personal API token
//   BOARD_LIONGARD        - Monday.com board ID (18418225513)

const LIONGARD_BASE = `https://${process.env.LIONGARD_INSTANCE}.app.liongard.com/api/v1`;
const MONDAY_URL    = 'https://api.monday.com/v2';
const BOARD_ID      = process.env.BOARD_LIONGARD;

// Column IDs on the board
const COL = {
  company:       'text_mm4d36s8',
  inspectorType: 'text_mm4dhjem',
  dateOpened:    'date_mm4dhx6g',
  dateRemediated:'date_mm4dwxcd',
  riskLevel:     'color_mm4d72mp',
  alertStatus:   'color_mm4d368q',
  alertId:       'text_mm4d721g',
};

const RISK_INDEX   = { 'Critical': 1, 'High': 2, 'Medium': 3, 'Low': 4 };
const STATUS_INDEX = { 'New': 1, 'Closed - Complete': 2 };

// Only sync: all open alerts + alerts closed within the last 90 days
const CUTOFF_DAYS = 90;

// ── Liongard helpers ─────────────────────────────────────────────────────────

function liongardAuth() {
  return Buffer.from(`${process.env.LIONGARD_KEY_ID}:${process.env.LIONGARD_KEY_SECRET}`).toString('base64');
}

async function liongardFetch(path) {
  const res = await fetch(`${LIONGARD_BASE}${path}`, {
    headers: { 'X-ROAR-API-KEY': liongardAuth() },
  });
  if (!res.ok) throw new Error(`Liongard ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

// ── Monday.com helpers ───────────────────────────────────────────────────────

async function mondayQuery(query, variables = {}) {
  const res = await fetch(MONDAY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': process.env.MONDAY_TOKEN,
      'API-Version': '2024-01',
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(`Monday.com error: ${JSON.stringify(json.errors)}`);
  return json.data;
}

async function fetchExistingItems() {
  const map = new Map();
  let cursor = null;
  do {
    const query = cursor
      ? `{ next_items_page(limit: 200, cursor: "${cursor}") { cursor items { id column_values(ids: ["${COL.alertId}"]) { text } } } }`
      : `{ boards(ids: [${BOARD_ID}]) { items_page(limit: 200) { cursor items { id column_values(ids: ["${COL.alertId}"]) { text } } } } }`;
    const data = await mondayQuery(query);
    const page = cursor ? data.next_items_page : data.boards[0].items_page;
    for (const item of page.items) {
      const alertId = item.column_values[0]?.text;
      if (alertId) map.set(alertId, item.id);
    }
    cursor = page.cursor ?? null;
  } while (cursor);
  return map;
}

async function createItem(alert, columnValues) {
  const name = (alert.Name || 'Unnamed Alert').substring(0, 255);
  const query = `
    mutation($boardId: ID!, $itemName: String!, $colVals: JSON!) {
      create_item(board_id: $boardId, item_name: $itemName, column_values: $colVals) { id }
    }`;
  await mondayQuery(query, { boardId: BOARD_ID, itemName: name, colVals: JSON.stringify(columnValues) });
}

async function updateItem(itemId, columnValues) {
  const query = `
    mutation($boardId: ID!, $itemId: ID!, $colVals: JSON!) {
      change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $colVals) { id }
    }`;
  await mondayQuery(query, { boardId: BOARD_ID, itemId, colVals: JSON.stringify(columnValues) });
}

// ── Data mapping ─────────────────────────────────────────────────────────────

function parseInspectorType(alertName) {
  const parts = (alertName || '').split('|');
  return parts[0].trim();
}

function formatDate(isoString) {
  if (!isoString) return null;
  return isoString.substring(0, 10);
}

function buildColumnValues(alert) {
  const priority = alert.Priority?.Name || '';
  const status   = alert.Status?.Name   || '';
  const isClosed = status === 'Closed - Complete';

  const cols = {
    [COL.alertId]:       String(alert.ID),
    [COL.company]:       alert.Environment?.Name || '',
    [COL.inspectorType]: parseInspectorType(alert.Name),
    [COL.dateOpened]:    formatDate(alert.CreatedOn)  ? { date: formatDate(alert.CreatedOn) }  : null,
    [COL.riskLevel]:     RISK_INDEX[priority] != null  ? { index: RISK_INDEX[priority] }  : null,
    [COL.alertStatus]:   STATUS_INDEX[status] != null  ? { index: STATUS_INDEX[status] }  : null,
  };

  if (isClosed && alert.UpdatedOn) {
    cols[COL.dateRemediated] = { date: formatDate(alert.UpdatedOn) };
  }

  return Object.fromEntries(Object.entries(cols).filter(([, v]) => v !== null));
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Liongard → Monday.com Security Sync ===');

  for (const v of ['LIONGARD_INSTANCE', 'LIONGARD_KEY_ID', 'LIONGARD_KEY_SECRET', 'MONDAY_TOKEN', 'BOARD_LIONGARD']) {
    if (!process.env[v]) throw new Error(`Missing env var: ${v}`);
  }

  // Compute 90-day cutoff date for recently-closed alerts
  const cutoff = new Date(Date.now() - CUTOFF_DAYS * 86400000).toISOString().substring(0, 10);
  console.log(`\nFilter: open alerts OR closed after ${cutoff}`);

  // Build OData filter — open OR recently closed
  const filter = encodeURIComponent(
    `(Status/Name eq 'New') or (UpdatedOn gt '${cutoff}T00:00:00Z')`
  );

  // 1. Fetch existing Monday items (for upsert logic)
  console.log('\n[1/2] Fetching existing Monday.com items...');
  const existing = await fetchExistingItems();
  console.log(`  Existing items: ${existing.size}`);

  // 2. Fetch Liongard alerts (API returns all matching results in one call when filtering)
  console.log('\n[2/2] Fetching Liongard alerts → Monday.com...');
  const path = `/tasks?\$filter=${filter}`;
  const data = await liongardFetch(path);
  const alerts = data.Data ?? data.data ?? data;

  if (!Array.isArray(alerts) || alerts.length === 0) {
    console.log('  No alerts matched filter.');
    return;
  }
  console.log(`  Fetched ${alerts.length} alerts`);

  let created = 0, updated = 0, errors = 0, reqCount = 0;
  const processed = new Set(); // dedupe guard

  for (let i = 0; i < alerts.length; i++) {
    const alert = alerts[i];
    const alertIdStr = String(alert.ID);

    if (processed.has(alertIdStr)) continue;
    processed.add(alertIdStr);

    const colVals = buildColumnValues(alert);

    try {
      if (existing.has(alertIdStr)) {
        await updateItem(existing.get(alertIdStr), colVals);
        updated++;
      } else {
        await createItem(alert, colVals);
        created++;
      }
    } catch (err) {
      console.error(`  Error on alert ${alert.ID}: ${err.message}`);
      errors++;
    }

    reqCount++;
    if (reqCount % 50 === 0) {
      console.log(`  Progress: ${reqCount} synced (created: ${created}, updated: ${updated}, errors: ${errors})`);
      await sleep(2000);
    } else {
      await sleep(100);
    }
  }

  console.log(`\n✓ Done. Created: ${created}, Updated: ${updated}, Errors: ${errors}`);
}

main().catch(err => { console.error(err); process.exit(1); });
