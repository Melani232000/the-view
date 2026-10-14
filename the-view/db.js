// SQLite: tablas orders + invoices según el plan MVP (BRASPER)
// SQLite nativo de Node (node:sqlite, Node >= 22.13): no requiere compilar nada
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.env.DB_FILE || 'view.db');
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
// transacción atómica (misma forma que usa server.js): db.transaction(fn)()
db.transaction = fn => (...a) => {
  db.exec('BEGIN');
  try { const r = fn(...a); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
};

db.exec(`
CREATE TABLE IF NOT EXISTS orders (
  order_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),   -- UTC
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','validating','approved','exported')),
  client_name TEXT NOT NULL,
  doc_type TEXT NOT NULL, doc_number TEXT NOT NULL, email TEXT,
  destination_account TEXT,
  send_amount REAL NOT NULL, send_currency TEXT NOT NULL,
  receive_amount REAL NOT NULL, receive_currency TEXT NOT NULL,
  rate REAL NOT NULL,                      -- tasa congelada en la cotización
  commission REAL NOT NULL DEFAULT 0, tax REAL NOT NULL DEFAULT 0,
  funds_source TEXT, operation_no TEXT, payment_proof_url TEXT,
  validated_by TEXT, validated_at TEXT
);
CREATE TABLE IF NOT EXISTS invoices (
  order_id TEXT PRIMARY KEY REFERENCES orders(order_id),   -- idempotencia: 1 factura por orden
  series TEXT NOT NULL, number TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved','sent','accepted','rejected')),
  provider_message TEXT, xml_url TEXT, pdf_url TEXT, emailed_at TEXT,
  UNIQUE (series, number)
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT, action TEXT, actor TEXT,
  at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);`);

if (db.prepare('SELECT COUNT(*) c FROM orders').get().c === 0) {
  const ins = db.prepare(`INSERT INTO orders (order_id,status,client_name,doc_type,doc_number,email,destination_account,
    send_amount,send_currency,receive_amount,receive_currency,rate,commission,tax,funds_source,operation_no,payment_proof_url)
    VALUES (@order_id,@status,@client_name,@doc_type,@doc_number,@email,@destination_account,
    @send_amount,@send_currency,@receive_amount,@receive_currency,@rate,@commission,@tax,@funds_source,@operation_no,@proof)`);
  const rows = [
    ['BR-0001','pending','Cliente A','CPF','11111111111','a@example.com','Nubank (PEN)',500,'BRL',336.75,'PEN',0.6735,12.00,2.16,'Ahorros','000001'],
    ['BR-0002','validating','Cliente B','DNI','22222222','b@example.com','Nubank (BRL)',800,'PEN',1190.00,'BRL',1.4875,14.00,2.52,'Venta de bien','000002'],
    ['BR-0003','approved','Cliente C','DNI','33333333','c@example.com','Itaú (BRL)',300,'USD',1503.00,'BRL',5.01,11.98,2.16,'Ahorros','000003'],
    ['BR-0004','approved','Cliente D','CPF','44444444444','d@example.com','BCP (USD)',1000,'BRL',200.00,'USD',0.20,10.00,1.80,'Donación','000004'],
    ['BR-0005','exported','Cliente E','DNI','55555555','e@example.com','Scotiabank (PEN)',450,'BRL',303.07,'PEN',0.6735,9.50,1.71,'Ahorros','000005'],
  ];
  const keys = ['order_id','status','client_name','doc_type','doc_number','email','destination_account','send_amount','send_currency','receive_amount','receive_currency','rate','commission','tax','funds_source','operation_no'];
  db.transaction(() => rows.forEach(r => {
    const o = Object.fromEntries(keys.map((k, i) => [k, r[i]]));
    o.proof = `/proofs/${o.order_id}.jpg`;
    ins.run(o);
  }))();
}
module.exports = db;
