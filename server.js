
import express from 'express';
import Database from 'better-sqlite3';
import { customAlphabet } from 'nanoid';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ---- DB init ----
const db = new Database(path.join(__dirname, 'inventory.db'));
db.pragma('journal_mode = WAL');

// ID generators
const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/1/I
const nano6 = customAlphabet(alpha, 6);
const nano8 = customAlphabet(alpha, 8);

function nowIso(){ return new Date().toISOString(); }

// Schema
db.exec(`
CREATE TABLE IF NOT EXISTS item_types(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS items(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  type_id INTEGER NOT NULL,
  unit TEXT NOT NULL DEFAULT 'pcs',
  avg_cost REAL NOT NULL DEFAULT 0, -- moving average per unit
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(type_id) REFERENCES item_types(id)
);
CREATE TABLE IF NOT EXISTS batches(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL, -- e.g., BTCH-XXXXXX
  item_id INTEGER NOT NULL,
  supplier TEXT,
  received_at TEXT NOT NULL,
  expires_at TEXT,
  qty REAL NOT NULL,
  unit_cost REAL NOT NULL, -- cost per unit in this batch
  created_at TEXT NOT NULL,
  FOREIGN KEY(item_id) REFERENCES items(id)
);
CREATE TABLE IF NOT EXISTS stock_moves(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  batch_id INTEGER,
  qty REAL NOT NULL, -- positive for IN / ADJUST+, negative for OUT / ADJUST-
  reason TEXT NOT NULL, -- RECEIVE / ISSUE / ADJUST / WO-ISSUE / WO-RETURN
  ref TEXT, -- optional reference (workorder/product/etc)
  created_at TEXT NOT NULL,
  FOREIGN KEY(item_id) REFERENCES items(id),
  FOREIGN KEY(batch_id) REFERENCES batches(id)
);
CREATE TABLE IF NOT EXISTS products(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bom(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  qty_per REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(product_id, item_id),
  FOREIGN KEY(product_id) REFERENCES products(id),
  FOREIGN KEY(item_id) REFERENCES items(id)
);
CREATE TABLE IF NOT EXISTS work_orders(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  product_id INTEGER NOT NULL,
  quantity REAL NOT NULL,
  status TEXT NOT NULL, -- OPEN / DONE / CANCELED
  planned_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(product_id) REFERENCES products(id)
);
`);

// Seed minimal data if empty
const rowCount = db.prepare("SELECT COUNT(*) as c FROM item_types").get().c;
if(rowCount === 0){
  const tNow = nowIso();
  db.prepare("INSERT INTO item_types(code,name,created_at,updated_at) VALUES (?,?,?,?)").run('ALU','Aluminum Profiles',tNow,tNow);
  db.prepare("INSERT INTO item_types(code,name,created_at,updated_at) VALUES (?,?,?,?)").run('HDW','Hardware',tNow,tNow);
  db.prepare("INSERT INTO item_types(code,name,created_at,updated_at) VALUES (?,?,?,?)").run('GLS','Glass',tNow,tNow);
  db.prepare("INSERT INTO item_types(code,name,created_at,updated_at) VALUES (?,?,?,?)").run('GSK','Gaskets',tNow,tNow);
  db.prepare("INSERT INTO item_types(code,name,created_at,updated_at) VALUES (?,?,?,?)").run('FG','Finished Goods',tNow,tNow);

  const insItem = db.prepare("INSERT INTO items(sku,name,type_id,unit,avg_cost,created_at,updated_at) VALUES (?,?,?,?,?,?,?)");
  const type = db.prepare("SELECT id FROM item_types WHERE code=?");
  const alu = type.get('ALU').id;
  const hdw = type.get('HDW').id;
  const gls = type.get('GLS').id;
  const gsk = type.get('GSK').id;
  const fg  = type.get('FG').id;

  insItem.run('ALU-' + nano6(), 'Profile-40x40 Anodized', alu, 'm', 0, tNow, tNow);
  insItem.run('HDW-' + nano6(), 'Corner Bracket L-50', hdw, 'pcs', 0, tNow, tNow);
  insItem.run('GLS-' + nano6(), 'IGU 1000x800 LowE', gls, 'pcs', 0, tNow, tNow);
  insItem.run('GSK-' + nano6(), 'EPDM gasket 8x4', gsk, 'm', 0, tNow, tNow);
  insItem.run('FG-'  + nano6(), 'FG-Frame', fg, 'pcs', 0, tNow, tNow);

  // Product + BOM
  const pNow = tNow;
  db.prepare("INSERT INTO products(code,name,created_at,updated_at) VALUES (?,?,?,?)").run('PRD-' + nano6(),'Frame-A',pNow,pNow);
  const prodId = db.prepare("SELECT id FROM products WHERE code=?").get('PRD-' + db.prepare("SELECT code FROM products LIMIT 1").get().code.split('-')[1]).id; // quick fetch

  const items = db.prepare("SELECT id, sku, name FROM items").all();
  const findByName = (n) => items.find(x => x.name === n).id;
  const ib = db.prepare("INSERT INTO bom(product_id,item_id,qty_per,created_at,updated_at) VALUES (?,?,?,?,?)");
  ib.run(prodId, findByName('Profile-40x40 Anodized'), 6, tNow,tNow); // 6 m
  ib.run(prodId, findByName('Corner Bracket L-50'), 8, tNow,tNow); // 8 pcs
  ib.run(prodId, findByName('IGU 1000x800 LowE'), 1, tNow,tNow); // 1 pcs
  ib.run(prodId, findByName('EPDM gasket 8x4'), 7, tNow,tNow); // 7 m
}

// Helpers
const q = {
  getItemById: db.prepare("SELECT i.*, t.code AS type_code, t.name AS type_name FROM items i JOIN item_types t ON t.id=i.type_id WHERE i.id=?"),
  getItemBySku: db.prepare("SELECT * FROM items WHERE sku=?"),
  listItems: db.prepare("SELECT i.id, i.sku, i.name, t.code as type_code, i.unit, i.avg_cost FROM items i JOIN item_types t ON t.id=i.type_id ORDER BY i.id DESC"),
  listTypes: db.prepare("SELECT * FROM item_types ORDER BY name"),
  getTypeByCode: db.prepare("SELECT * FROM item_types WHERE code=?"),
  insType: db.prepare("INSERT INTO item_types(code,name,created_at,updated_at) VALUES (?,?,?,?)"),
  insItem: db.prepare("INSERT INTO items(sku,name,type_id,unit,avg_cost,created_at,updated_at) VALUES (?,?,?,?,?,?,?)"),
  insBatch: db.prepare("INSERT INTO batches(code,item_id,supplier,received_at,expires_at,qty,unit_cost,created_at) VALUES (?,?,?,?,?,?,?,?)"),
  insMove: db.prepare("INSERT INTO stock_moves(item_id,batch_id,qty,reason,ref,created_at) VALUES (?,?,?,?,?,?)"),
  getOnHand: db.prepare("SELECT COALESCE(SUM(qty),0) as on_hand FROM stock_moves WHERE item_id=?"),
  listStock: db.prepare(`
    SELECT i.id, i.sku, i.name, t.code as type_code, i.unit,
           ROUND(COALESCE((SELECT SUM(m.qty) FROM stock_moves m WHERE m.item_id=i.id),0), 3) as on_hand,
           ROUND(i.avg_cost, 4) as avg_cost,
           ROUND(COALESCE((SELECT SUM(m.qty) FROM stock_moves m WHERE m.item_id=i.id),0) * i.avg_cost, 2) as stock_value
    FROM items i JOIN item_types t ON t.id=i.type_id
    ORDER BY i.name
  `),
  upItemAvgCost: db.prepare("UPDATE items SET avg_cost=?, updated_at=? WHERE id=?"),
  getProductByCode: db.prepare("SELECT * FROM products WHERE code=?"),
  insProduct: db.prepare("INSERT INTO products(code,name,created_at,updated_at) VALUES (?,?,?,?)"),
  addBom: db.prepare("INSERT INTO bom(product_id,item_id,qty_per,created_at,updated_at) VALUES (?,?,?,?,?)"),
  listBom: db.prepare(`
    SELECT b.id, i.sku, i.name, i.unit, b.qty_per
    FROM bom b JOIN items i ON i.id=b.item_id
    WHERE b.product_id=?
    ORDER BY i.name
  `),
  getProductById: db.prepare("SELECT * FROM products WHERE id=?"),
  getBomRows: db.prepare("SELECT * FROM bom WHERE product_id=?"),
  insWO: db.prepare("INSERT INTO work_orders(code,product_id,quantity,status,planned_at,completed_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)"),
  getWO: db.prepare("SELECT * FROM work_orders WHERE id=?"),
  setWODone: db.prepare("UPDATE work_orders SET status='DONE', completed_at=?, updated_at=? WHERE id=?"),
};

function genSku(typeCode){
  return `${typeCode}-${nano6()}`;
}
function genBatchCode(){ return `BTCH-${nano8()}`; }
function genProductCode(){ return `PRD-${nano6()}`; }
function genWOCode(){ return `WO-${nano6()}`; }

// Routes
app.get('/api/types', (req,res)=>{
  res.json(q.listTypes.all());
});
app.post('/api/types', (req,res)=>{
  const { code, name } = req.body;
  if(!code || !name) return res.status(400).json({error:'code and name required'});
  const t = nowIso();
  try{
    q.insType.run(code.toUpperCase(), name, t,t);
    res.json({ok:true});
  }catch(e){
    res.status(400).json({error: e.message});
  }
});

app.get('/api/items', (req,res)=>{
  res.json(q.listItems.all());
});
app.post('/api/items', (req,res)=>{
  const { name, type_code, unit } = req.body;
  if(!name || !type_code) return res.status(400).json({error:'name and type_code required'});
  const type = q.getTypeByCode.get(type_code.toUpperCase());
  if(!type) return res.status(400).json({error:'unknown type_code'});
  const t = nowIso();
  const sku = genSku(type.code);
  q.insItem.run(sku, name, type.id, unit || 'pcs', 0, t,t);
  res.json({ok:true, sku});
});

// Receive stock (creates batch + move IN, updates moving average)
app.post('/api/receive', (req,res)=>{
  const { sku, qty, unit_cost, supplier, expires_at } = req.body;
  if(!sku || !qty || !unit_cost) return res.status(400).json({error:'sku, qty, unit_cost required'});
  const item = q.getItemBySku.get(sku);
  if(!item) return res.status(404).json({error:'item not found'});
  const t = nowIso();
  const code = genBatchCode();
  const info = q.insBatch.run(code, item.id, supplier || null, t, expires_at || null, qty, unit_cost, t);
  const batch_id = info.lastInsertRowid;
  q.insMove.run(item.id, batch_id, Math.abs(qty), 'RECEIVE', code, t);

  // moving average: new_avg = (old_avg*onhand_old + qty*unit_cost) / (onhand_old + qty)
  const onhandOld = q.getOnHand.get(item.id).on_hand - qty;
  const denom = onhandOld + qty;
  const newAvg = denom > 0 ? ((item.avg_cost * onhandOld) + (qty * unit_cost)) / denom : unit_cost;
  q.upItemAvgCost.run(newAvg, t, item.id);

  res.json({ok:true, batch_code: code, new_avg_cost: newAvg});
});

// Issue / Adjust move
app.post('/api/move', (req,res)=>{
  const { sku, qty, reason, ref } = req.body;
  if(!sku || !qty || !reason) return res.status(400).json({error:'sku, qty, reason required'});
  const item = q.getItemBySku.get(sku);
  if(!item) return res.status(404).json({error:'item not found'});
  const t = nowIso();
  const signedQty = (reason === 'ISSUE' || reason === 'WO-ISSUE' || reason === 'ADJUST-') ? -Math.abs(qty) : Math.abs(qty);
  q.insMove.run(item.id, null, signedQty, reason, ref || null, t);
  res.json({ok:true});
});

app.get('/api/stock', (req,res)=>{
  res.json(q.listStock.all());
});

// Products + BOM
app.post('/api/products', (req,res)=>{
  const { name } = req.body;
  if(!name) return res.status(400).json({error:'name required'});
  const code = genProductCode();
  const t = nowIso();
  q.insProduct.run(code, name, t,t);
  res.json({ok:true, code});
});
app.get('/api/products/:code/bom', (req,res)=>{
  const p = q.getProductByCode.get(req.params.code);
  if(!p) return res.status(404).json({error:'product not found'});
  res.json(q.listBom.all(p.id));
});
app.post('/api/products/:code/bom', (req,res)=>{
  const p = q.getProductByCode.get(req.params.code);
  if(!p) return res.status(404).json({error:'product not found'});
  const { sku, qty_per } = req.body;
  const item = q.getItemBySku.get(sku);
  if(!item) return res.status(404).json({error:'item not found'});
  const t = nowIso();
  try{
    q.addBom.run(p.id, item.id, qty_per, t,t);
    res.json({ok:true});
  }catch(e){
    res.status(400).json({error:e.message});
  }
});

// Work Orders
app.post('/api/workorders', (req,res)=>{
  const { product_code, quantity, planned_at } = req.body;
  const p = q.getProductByCode.get(product_code);
  if(!p) return res.status(404).json({error:'product not found'});
  const code = genWOCode();
  const t = nowIso();
  q.insWO.run(code, p.id, quantity, 'OPEN', planned_at || null, null, t,t);
  res.json({ok:true, code});
});

// Complete Work Order: consume components per BOM * qty
app.post('/api/workorders/:code/complete', (req,res)=>{
  const wo = db.prepare("SELECT * FROM work_orders WHERE code=?").get(req.params.code);
  if(!wo) return res.status(404).json({error:'work order not found'});
  if(wo.status === 'DONE') return res.status(400).json({error:'already done'});
  const bomRows = q.getBomRows.all(wo.product_id);
  const t = nowIso();
  // Issue components
  for(const row of bomRows){
    const item = q.getItemById.get(row.item_id);
    const needQty = row.qty_per * wo.quantity;
    q.insMove.run(item.id, null, -Math.abs(needQty), 'WO-ISSUE', wo.code, t);
  }
  q.setWODone.run(t,t,wo.id);
  res.json({ok:true, completed_at: t});
});

// --- Simple frontend ---
app.get('/', (req,res)=>{
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>{
  console.log(`Inventory MVP on http://localhost:${PORT}`);
});
