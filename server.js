const express = require('express');
const db = require('./db');
const multer = require('multer'), fs = require('fs');
fs.mkdirSync('uploads', { recursive: true });
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const upload = multer({
  storage: multer.diskStorage({ destination: 'uploads',
    filename: (_r, f, cb) => cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + EXT[f.mimetype]) }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_r, f, cb) => EXT[f.mimetype] ? cb(null, true) : cb(new Error('El comprobante debe ser una foto (JPG, PNG o WEBP)')),
}).single('proof');
const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const app = express();
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

const FLOW = { pending: ['validating'], validating: ['approved', 'pending'], approved: ['exported', 'validating'], exported: [] };
const who = req => req.get('x-user') || 'validador';
const log = db.prepare('INSERT INTO audit_log (order_id,action,actor) VALUES (?,?,?)');

// Lista para la VIEW (+ estado de factura)
app.get('/api/orders', (_req, res) => {
  const orders = db.prepare(`SELECT o.*, i.series||'-'||i.number AS invoice_no, i.status AS invoice_status
    FROM orders o LEFT JOIN invoices i USING(order_id) ORDER BY o.order_id`).all();
  const counts = db.prepare('SELECT status, COUNT(*) n FROM orders GROUP BY status').all();
  res.json({ orders, counts: Object.fromEntries(counts.map(c => [c.status, c.n])) });
});

// Alta de orden (multipart: campos + foto "proof"). El servidor recalcula impuesto y monto a recibir.
app.post('/api/orders', (req, res) => upload(req, res, err => {
  const fail = (code, msg) => { if (req.file) fs.unlink(req.file.path, () => {}); return res.status(code).json({ error: msg }); };
  if (err) return fail(400, err.code === 'LIMIT_FILE_SIZE' ? 'La foto supera 5 MB' : err.message);
  const b = req.body || {};
  for (const k of ['client_name','doc_type','doc_number','email','send_currency','receive_currency','operation_no'])
    if (!String(b[k] || '').trim()) return fail(400, `Falta ${k}`);
  const send = +b.send_amount, rate = +b.rate, com = +(b.commission || 0);
  if (!(send > 0) || !(rate > 0) || com < 0 || com >= send) return fail(400, 'Monto, tasa o comisión inválidos');
  if (b.send_currency === b.receive_currency) return fail(400, 'Las monedas deben ser distintas');
  if (!req.file) return fail(400, 'Sube la foto del comprobante');
  const tax = r2(com * 0.18), receive = r2((send - com) * rate);
  const n = db.prepare("SELECT COALESCE(MAX(CAST(SUBSTR(order_id,4) AS INTEGER)),0)+1 n FROM orders").get().n;
  const id = 'BR-' + String(n).padStart(4, '0');
  db.prepare(`INSERT INTO orders (order_id,client_name,doc_type,doc_number,email,destination_account,send_amount,send_currency,
    receive_amount,receive_currency,rate,commission,tax,funds_source,operation_no,payment_proof_url)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,b.client_name.trim(),b.doc_type,b.doc_number.trim(),b.email.trim(),b.destination_account||null,
    send,b.send_currency,receive,b.receive_currency,rate,com,tax,b.funds_source||null,b.operation_no.trim(),'/uploads/' + req.file.filename);
  log.run(id, 'created', 'cliente');
  res.status(201).json({ order_id: id, tax, receive_amount: receive });
}));

// Cambiar estado (valida transiciones; registra quién/cuándo al aprobar)
app.post('/api/orders/status', (req, res) => {
  const { ids = [], status } = req.body || {};
  if (!ids.length || !FLOW[status] && !['pending','validating','approved','exported'].includes(status))
    return res.status(400).json({ error: 'Parámetros inválidos' });
  const errors = [], ok = [];
  db.transaction(() => ids.forEach(id => {
    const o = db.prepare('SELECT status FROM orders WHERE order_id=?').get(id);
    if (!o) return errors.push(`${id}: no existe`);
    if (!FLOW[o.status].includes(status)) return errors.push(`${id}: ${o.status} → ${status} no permitido`);
    if (status === 'approved')
      db.prepare("UPDATE orders SET status=?, validated_by=?, validated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE order_id=?").run(status, who(req), id);
    else db.prepare('UPDATE orders SET status=? WHERE order_id=?').run(status, id);
    log.run(id, `status:${o.status}->${status}`, who(req)); ok.push(id);
  }))();
  res.json({ updated: ok, errors });
});

// Exportar archivo de órdenes (aprobadas → CSV para el Dashboard) y marcarlas "exported"
app.get('/api/export', (req, res) => {
  const ids = (req.query.ids || '').split(',').filter(Boolean);
  const rows = ids.length
    ? db.prepare(`SELECT * FROM orders WHERE status='approved' AND order_id IN (${ids.map(() => '?').join(',')})`).all(...ids)
    : db.prepare("SELECT * FROM orders WHERE status='approved'").all();
  if (!rows.length) return res.status(409).json({ error: 'No hay órdenes aprobadas para exportar' });
  const cols = ['order_id','created_at','client_name','doc_type','doc_number','email','send_amount','send_currency','receive_amount','receive_currency','rate','commission','tax','funds_source','operation_no','destination_account'];
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
  db.transaction(() => rows.forEach(r => {
    db.prepare("UPDATE orders SET status='exported' WHERE order_id=?").run(r.order_id);
    log.run(r.order_id, 'exported', who(req));
  }))();
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="ordenes.csv"' }).send(csv);
});

// Fact (simulado, idempotente): una factura por orden exportada
app.post('/api/fact/run', (_req, res) => {
  const pend = db.prepare("SELECT * FROM orders WHERE status='exported' AND order_id NOT IN (SELECT order_id FROM invoices)").all();
  const out = { created: [], skipped: [], rejected: [] };
  db.transaction(() => pend.forEach(o => {
    if (Math.abs((o.commission + o.tax) - (o.commission + o.tax)) > 0.005 || !o.email || !o.doc_number) {
      out.rejected.push(o.order_id); return;
    }
    const series = o.send_currency === 'PEN' ? 'B001' : 'BR01';
    const n = db.prepare('SELECT COUNT(*) c FROM invoices WHERE series=?').get(series).c + 1;
    db.prepare("INSERT INTO invoices (order_id,series,number,status,provider_message,xml_url,pdf_url,emailed_at) VALUES (?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))")
      .run(o.order_id, series, String(n).padStart(8, '0'), 'accepted', 'Aceptada (modo prueba)', `/xml/${o.order_id}.xml`, `/pdf/${o.order_id}.pdf`);
    out.created.push(o.order_id);
  }))();
  res.json(out);
});

app.get('/api/invoices', (_req, res) => res.json(db.prepare('SELECT * FROM invoices ORDER BY series, number').all()));

const port = process.env.PORT || 3000;
if (require.main === module) app.listen(port, () => console.log(`THE VIEW → http://localhost:${port}`));
module.exports = app;
