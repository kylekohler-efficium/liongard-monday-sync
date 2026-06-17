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

function liongardAuth() {
  return 'Basic ' + Buffer.from(`${process.env.LIONGARD_KEY_ID}:${process.env.LIONGARD_KEY_SECRET}`).toString('base64');
}
async function liongardFetch(path) {
  const res = await fetch(`${LIONGARD_BASE}${path}`, { headers: { 'X-ROAR-API-KEY': liongardAuth() } });
  if (!res.ok) throw new Error(`Liongard ${path} -> ${res.status}`);
  return res.json();
}
async function fetchAllAlerts() {
  const alerts = []; let skip = 0;
  while (true) {
    const data = await liongardFetch(`/tasks?\$top=100&\$skip=${skip}`);
    const items = data.Data ?? data.data ?? data;
    if (!Array.isArray(items) || !items.length) break;
    alerts.push(...items);
    console.log(`  Fetched ${alerts.length}...`);
    if (items.length < 100) break;
    skip += 100;
  }
  return alerts;
}
async function mondayQuery(query, variables = {}) {
  const res = await fetch(MONDAY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': process.env.MONDAY_TOKEN, 'API-Version': '2024-01' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}
async function fetchExistingItems() {
  const map = new Map(); let cursor = null;
  do {
    const q = cursor
      ? `{ next_items_page(limit:200, cursor:"${cursor}") { cursor items { id column_values(ids:["${COL.alertId}"]) { text } } } }`
      : `{ boards(ids:[${BOARD_ID}]) { items_page(limit:200) { cursor items { id column_values(ids:["${COL.alertId}"]) { text } } } } }`;
    const d = await mondayQuery(q);
    const page = cursor ? d.next_items_page : d.boards[0].items_page;
    for (const item of page.items) { const id = item.column_values[0]?.text; if (id) map.set(id, item.id); }
    cursor = page.cursor ?? null;
  } while (cursor);
  return map;
}
function buildColumnValues(alert) {
  const priority = alert.Priority?.Name || '', status = alert.Status?.Name || '';
  const cols = {
    [COL.alertId]:       String(alert.ID),
    [COL.company]:       alert.Environment?.Name || '',
    [COL.inspectorType]: (alert.Name || '').split('|')[0].trim(),
    [COL.riskLevel]:     RISK_INDEX[priority]  != null ? { index: RISK_INDEX[priority] }  : null,
    [COL.alertStatus]:   STATUS_INDEX[status]  != null ? { index: STATUS_INDEX[status] }  : null,
    [COL.dateOpened]:    alert.CreatedOn ? { date: alert.CreatedOn.substring(0,10) } : null,
  };
  if (status === 'Closed - Complete' && alert.UpdatedOn)
    cols[COL.dateRemediated] = { date: alert.UpdatedOn.substring(0,10) };
  return Object.fromEntries(Object.entries(cols).filter(([,v]) => v !== null));
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function main() {
  console.log('=== Liongard -> Monday.com Sync ===');
  for (const v of ['LIONGARD_INSTANCE','LIONGARD_KEY_ID','LIONGARD_KEY_SECRET','MONDAY_TOKEN','BOARD_LIONGARD'])
    if (!process.env[v]) throw new Error(`Missing: ${v}`);
  console.log('\n[1/3] Fetching Liongard alerts...');
  const alerts = await fetchAllAlerts();
  console.log(`  Total: ${alerts.length}`);
  console.log('\n[2/3] Fetching existing board items...');
  const existing = await fetchExistingItems();
  console.log(`  Existing: ${existing.size}`);
  console.log('\n[3/3] Syncing...');
  let created = 0, updated = 0, errors = 0;
  for (let i = 0; i < alerts.length; i++) {
    const a = alerts[i], id = String(a.ID), vals = buildColumnValues(a);
    try {
      if (existing.has(id)) {
        await mondayQuery(`mutation($b:ID!,$i:ID!,$v:JSON!){change_multiple_column_values(board_id:$b,item_id:$i,column_values:$v){id}}`,
          {b:BOARD_ID,i:existing.get(id),v:JSON.stringify(vals)});
        updated++;
      } else {
        await mondayQuery(`mutation($b:ID!,$n:String!,$v:JSON!){create_item(board_id:$b,item_name:$n,column_values:$v){id}}`,
          {b:BOARD_ID,n:(a.Name||'Alert').substring(0,255),v:JSON.stringify(vals)});
        created++;
      }
    } catch(e) { console.error(`  Alert ${a.ID}: ${e.message}`); errors++; }
    if ((i+1)%50===0) { console.log(`  ${i+1}/${alerts.length} c:${created} u:${updated} e:${errors}`); await sleep(2000); }
    else await sleep(100);
  }
  console.log(`\nDone. Created:${created} Updated:${updated} Errors:${errors}`);
}
main().catch(e => { console.error(e); process.exit(1); });
