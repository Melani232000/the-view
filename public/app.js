// THE VIEW: BRASPER back office on Firebase (project aibrasper).
// Reads orders and invoices live from Firestore (staff role required by the
// rules) and acts through the Cloud Functions: reviewOrder, exportOrders,
// runFact, getReceipt, createManualOrder and submitProof.
import {initializeApp} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import {
  getAuth, connectAuthEmulator, onAuthStateChanged, signInWithEmailAndPassword, signOut,
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import {
  getFirestore, connectFirestoreEmulator, collection, doc, getDoc, onSnapshot, orderBy, query, limit,
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import {
  getFunctions, connectFunctionsEmulator, httpsCallable,
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-functions.js';
import {
  getStorage, connectStorageEmulator, ref, uploadBytes, getDownloadURL,
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-storage.js';
import {FIREBASE_CONFIG, REGION, EMULATOR} from './firebase-config.js';

const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app, REGION);
const storage = getStorage(app);
if (EMULATOR) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', {disableWarnings: true});
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);
  connectStorageEmulator(storage, '127.0.0.1', 9199);
}

// ---------------------------------------------------------------- helpers
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const money = (n, c) => `${Number(n ?? 0).toFixed(2)} ${c ?? ''}`.trim();
const lima = (iso) => iso
  ? new Intl.DateTimeFormat('es-PE', {timeZone: 'America/Lima', dateStyle: 'short', timeStyle: 'short'}).format(new Date(iso))
  : '—';
const call = (name, data = {}) => httpsCallable(functions, name)(data).then((r) => r.data);

const STATUS = {
  pending: 'Pendiente', validating: 'En validación', approved: 'Aprobada',
  exported: 'Exportada', rejected: 'Rechazada', cancelled: 'Cancelada',
};
const FUNDS = {
  savings: 'Ahorros', salary: 'Sueldo', business: 'Negocio',
  asset_sale: 'Venta de un bien', donation: 'Donación', other: 'Otro',
};
const CHANNEL = {form: 'Formulario', assistant: 'Asistente', whatsapp: 'WhatsApp', human: 'Vendedor'};
// Reasons the Cloud Functions raise (error.message), in the team's words.
const REASON = {
  'sign-in-required': 'Tu sesión venció. Vuelve a entrar.',
  'staff-only': 'Tu usuario no tiene un rol de equipo.',
  'role-not-allowed': 'Tu rol no permite esta acción.',
  'reason-required': 'Escribe el motivo del rechazo.',
  'order-not-found': 'La operación no existe.',
  'order-not-pending': 'La operación ya no está pendiente.',
  'only-approved-orders': 'Solo se exportan operaciones aprobadas.',
  'invalid-input': 'Hay datos inválidos. Revisa el documento, el correo, las cuentas y los montos.',
  'commission-too-high': 'La comisión debe ser menor que el monto.',
  'operation-no-duplicate': 'Ese N° de operación ya está en otra operación activa.',
  'invalid-operation-no': 'El N° de operación debe tener 4 a 24 letras, números o guiones.',
  'proof-not-uploaded': 'La foto no se subió.',
  'receipt-not-ready': 'La factura aún no está aceptada.',
};
const explain = (e) => {
  const code = e?.message || '';
  if (REASON[code]) return REASON[code];
  if (/permission|PERMISSION/.test(code) || e?.code === 'permission-denied') return 'Sin permiso para esta acción.';
  if (e?.code === 'functions/not-found' || e?.code === 'functions/unavailable') return 'No hay conexión con el servidor.';
  return code || 'Error inesperado.';
};
const say = (text, kind = 'info') => { const m = $('msg'); m.textContent = text || ''; m.className = text ? kind : ''; };

const CAN = {
  approve: ['validator', 'admin'],
  export: ['operator', 'admin'],
  fact: ['billing', 'admin'],
  create: ['validator', 'operator', 'admin'],
};

// ------------------------------------------------------------------ state
let user = null;
let role = null;
let orders = [];
let invoices = new Map();
let filter = 'all';
let search = '';
const selected = new Set();
let unsub = [];
let config = {taxBps: 1800, commissionBps: 240, spreadBps: 200, rates: null};

const can = (action) => CAN[action].includes(role);
const invoiceOf = (o) => invoices.get(o.orderId);
const hasInvoice = (o) => invoiceOf(o) && ['accepted', 'sent'].includes(invoiceOf(o).status);

// ---------------------------------------------------------------- session
$('lf').onsubmit = async (e) => {
  e.preventDefault();
  $('lerr').textContent = '';
  $('lb').disabled = true;
  try {
    await signInWithEmailAndPassword(auth, $('le').value.trim(), $('lp').value);
  } catch (err) {
    $('lerr').textContent = /invalid|wrong|user-not-found|credential/i.test(err.code + err.message)
      ? 'Correo o clave incorrectos.' : `No se pudo entrar (${err.code || err.message}).`;
  } finally { $('lb').disabled = false; }
};
$('out').onclick = () => signOut(auth);

onAuthStateChanged(auth, async (u) => {
  unsub.forEach((f) => f());
  unsub = [];
  user = u;
  role = null;
  if (!u) { $('app').classList.add('hidden'); $('login').classList.remove('hidden'); return; }
  const token = await u.getIdTokenResult(true); // claims are baked into the token
  role = token.claims.role ?? null;
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('who').textContent = u.email;
  $('role').textContent = role ?? 'sin rol';
  $('env').classList.toggle('hidden', !EMULATOR);
  if (!role) {
    say('Tu usuario no tiene rol de equipo. Pide a un administrador que ejecute scripts/grant-staff.mjs.', 'err');
    render();
    return;
  }
  say('');
  start();
});

function start() {
  unsub.push(onSnapshot(
    query(collection(db, 'orders'), orderBy('createdAt', 'desc'), limit(300)),
    (snap) => { orders = snap.docs.map((d) => d.data()); render(); },
    (err) => say(`No se pudieron leer las operaciones: ${err.code}`, 'err'),
  ));
  unsub.push(onSnapshot(
    collection(db, 'invoices'),
    (snap) => { invoices = new Map(snap.docs.map((d) => [d.id, d.data()])); render(); },
    () => {},
  ));
  loadConfig();
}

async function loadConfig() {
  try {
    const [pub, rates] = await Promise.all([getDoc(doc(db, 'config/public')), getDoc(doc(db, 'config/rates'))]);
    const p = pub.data()?.pricing ?? {};
    config = {
      taxBps: p.taxBps ?? 1800, commissionBps: p.commissionBps ?? 240, spreadBps: p.spreadBps ?? 200,
      rates: rates.data()?.rates ?? null,
    };
  } catch { /* defaults are fine: the server recomputes everything */ }
}

// ------------------------------------------------------------------ table
const visible = () => orders.filter((o) => {
  if (filter !== 'all' && o.status !== filter) return false;
  if (!search) return true;
  const hay = `${o.orderId} ${o.clientName} ${o.docNumber} ${o.operationNo ?? ''} ${o.email}`.toLowerCase();
  return hay.includes(search);
});

function render() {
  const counts = {};
  orders.forEach((o) => { counts[o.status] = (counts[o.status] || 0) + 1; });
  $('chips').innerHTML = [['all', 'Todas', orders.length], ...Object.entries(STATUS).map(([k, v]) => [k, v, counts[k] || 0])]
    .map(([k, v, n]) => `<button class="chip ${filter === k ? 'on' : ''}" data-f="${k}">${v} ${n}</button>`).join('');
  document.querySelectorAll('[data-f]').forEach((b) => { b.onclick = () => { filter = b.dataset.f; render(); }; });

  const rows = visible();
  $('rows').innerHTML = rows.length ? rows.map((o) => {
    const inv = invoiceOf(o);
    return `<tr data-open="${esc(o.orderId)}">
 <td><input type="checkbox" data-id="${esc(o.orderId)}" ${selected.has(o.orderId) ? 'checked' : ''}></td>
 <td>${esc(o.orderId)}</td>
 <td>${esc(o.clientName)}<div class="mut small">${esc(o.docType)} ${esc(o.docNumber)}</div></td>
 <td>${money(o.sendAmount, o.sendCurrency)} → ${money(o.receiveAmount, o.receiveCurrency)}</td>
 <td>${esc(o.rate)}</td>
 <td class="num">${Number(o.commission).toFixed(2)} + ${Number(o.tax).toFixed(2)}</td>
 <td>${esc(o.operationNo ?? '—')}${o.paymentProofPath ? ' 📎' : ''}</td>
 <td><span class="b ${esc(o.status)}">${esc(STATUS[o.status] ?? o.status)}</span></td>
 <td class="small">${esc(o.validatedBy ?? '—')}</td>
 <td class="inv">${inv ? esc(inv.fullNumber) : '—'}</td></tr>`;
  }).join('') : `<tr><td colspan="10" class="mut" style="cursor:default;padding:24px">${orders.length ? 'Ninguna operación coincide con el filtro.' : 'Aún no hay operaciones.'}</td></tr>`;

  document.querySelectorAll('[data-id]').forEach((c) => {
    c.onclick = (e) => e.stopPropagation();
    c.onchange = () => { c.checked ? selected.add(c.dataset.id) : selected.delete(c.dataset.id); toolbar(); };
  });
  document.querySelectorAll('[data-open]').forEach((r) => { r.onclick = () => openDetail(r.dataset.open); });
  toolbar();
}

function toolbar() {
  const pick = orders.filter((o) => selected.has(o.orderId));
  const set = (id, enabled, title) => { $(id).disabled = !enabled; $(id).title = enabled ? '' : title; };
  const nope = 'Tu rol no permite esta acción';
  set('approve', can('approve') && pick.some((o) => o.status === 'validating'), can('approve') ? 'Selecciona operaciones En validación' : nope);
  set('reject', can('approve') && pick.some((o) => o.status === 'validating'), can('approve') ? 'Selecciona operaciones En validación' : nope);
  const approved = orders.filter((o) => o.status === 'approved');
  set('export', can('export') && approved.length > 0, can('export') ? 'No hay operaciones aprobadas' : nope);
  $('export').textContent = `Exportar aprobadas (${pick.filter((o) => o.status === 'approved').length || approved.length}) CSV`;
  const billable = orders.filter((o) => o.status === 'exported' && !hasInvoice(o));
  set('fact', can('fact') && billable.length > 0, can('fact') ? 'No hay exportadas sin factura' : nope);
  set('new', can('create'), nope);
}

// ---------------------------------------------------------- bulk actions
async function eachOrder(ids, label, fn) {
  const done = []; const failed = [];
  for (const id of ids) {
    say(`${label} ${id} (${done.length + failed.length + 1}/${ids.length})…`);
    try { await fn(id); done.push(id); } catch (e) { failed.push(`${id}: ${explain(e)}`); }
  }
  return {done, failed};
}
const report = (verb, {done, failed}) => say(
  `${verb}: ${done.length}${failed.length ? ` · con error: ${failed.join(' · ')}` : ''}`, failed.length ? 'err' : 'ok');

$('approve').onclick = async () => {
  const ids = orders.filter((o) => selected.has(o.orderId) && o.status === 'validating').map((o) => o.orderId);
  if (!ids.length) return;
  report('Aprobadas', await eachOrder(ids, 'Aprobando', (id) => call('reviewOrder', {orderId: id, decision: 'approve'})));
  selected.clear();
};

let rejectIds = [];
function askReject(ids) {
  rejectIds = ids;
  $('rejn').textContent = `Se rechazarán: ${ids.join(', ')}`;
  $('rejr').value = ''; $('rejerr').textContent = '';
  $('rejd').showModal();
}
$('reject').onclick = () => {
  const ids = orders.filter((o) => selected.has(o.orderId) && o.status === 'validating').map((o) => o.orderId);
  if (ids.length) askReject(ids);
};
$('rejno').onclick = () => $('rejd').close();
$('rejok').onclick = async () => {
  const reason = $('rejr').value.trim();
  if (!reason) { $('rejerr').textContent = 'Escribe el motivo.'; return; }
  $('rejd').close();
  report('Rechazadas', await eachOrder(rejectIds, 'Rechazando', (id) => call('reviewOrder', {orderId: id, decision: 'reject', reason})));
  selected.clear();
  closeDetail();
};

$('export').onclick = async () => {
  const chosen = orders.filter((o) => selected.has(o.orderId) && o.status === 'approved');
  const ids = (chosen.length ? chosen : orders.filter((o) => o.status === 'approved')).map((o) => o.orderId);
  if (!ids.length) return;
  if (!confirm(`Se exportarán ${ids.length} operación(es) y pasarán a "Exportada". ¿Continuar?`)) return;
  say('Exportando…');
  try {
    const r = await call('exportOrders', {orderIds: ids.slice(0, 200)});
    download(new Blob([r.csv], {type: 'text/csv;charset=utf-8'}), r.filename);
    selected.clear();
    say(`Archivo ${r.filename}: ${r.count} operación(es) exportada(s).`, 'ok');
  } catch (e) {
    const blocked = e?.details?.blocked;
    say(`No se exportó: ${explain(e)}${blocked ? ` (${blocked.join(', ')})` : ''}`, 'err');
  }
};

$('fact').onclick = async () => {
  const eligible = orders.filter((o) => o.status === 'exported' && !hasInvoice(o));
  const chosen = eligible.filter((o) => selected.has(o.orderId));
  const ids = (chosen.length ? chosen : eligible).map((o) => o.orderId).slice(0, 100);
  if (!ids.length) return;
  say('Corriendo Fact (prueba)…');
  try {
    const {results} = await call('runFact', {orderIds: ids});
    const by = (k) => results.filter((r) => r.outcome === k);
    const bad = results.filter((r) => ['set-aside', 'rejected'].includes(r.outcome));
    selected.clear();
    say(`Fact: ${by('accepted').length} facturas, ${by('skipped').length} ya existentes${bad.length ? `, ${bad.length} con problema: ${bad.map((r) => `${r.orderId} (${r.detail})`).join(' · ')}` : ''}.`,
      bad.length ? 'err' : 'ok');
  } catch (e) { say(`Fact falló: ${explain(e)}`, 'err'); }
};

$('inv').onclick = () => {
  const list = [...invoices.values()].sort((a, b) => a.fullNumber.localeCompare(b.fullNumber));
  $('invbody').innerHTML = list.length
    ? `<table style="min-width:0"><thead><tr><th>Operación</th><th>Factura</th><th>Estado</th><th class="num">Total</th><th></th></tr></thead><tbody>${list.map((i) => `<tr style="cursor:default">
 <td>${esc(i.orderId)}</td><td class="inv">${esc(i.fullNumber)}</td><td>${esc(i.status)}${i.testMode ? ' (prueba)' : ''}</td>
 <td class="num">${money(i.total, i.currency)}</td><td><button data-rc="${esc(i.orderId)}">PDF</button></td></tr>`).join('')}</tbody></table>`
    : '<p class="mut">Aún no hay facturas.</p>';
  document.querySelectorAll('[data-rc]').forEach((b) => { b.onclick = () => receipt(b.dataset.rc); });
  $('invd').showModal();
};
$('invx').onclick = () => $('invd').close();

async function receipt(orderId) {
  say('Descargando comprobante…');
  try {
    const r = await call('getReceipt', {orderId});
    const bytes = Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0));
    download(new Blob([bytes], {type: r.contentType}), r.filename);
    say(`Comprobante ${r.filename} descargado.`, 'ok');
  } catch (e) { say(`No se pudo descargar: ${explain(e)}`, 'err'); }
}

function download(blob, name) {
  const a = Object.assign(document.createElement('a'), {href: URL.createObjectURL(blob), download: name});
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ----------------------------------------------------------------- detail
const detail = $('detail');
const closeDetail = () => { if (detail.open) detail.close(); };
let openId = null;

async function openDetail(id) {
  const o = orders.find((x) => x.orderId === id);
  if (!o) return;
  openId = id;
  const inv = invoiceOf(o);
  const row = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
  $('dbody').innerHTML = `<h3>${esc(o.orderId)} <span class="b ${esc(o.status)}">${esc(STATUS[o.status] ?? o.status)}</span></h3>
<div class="sec">Cliente</div><dl class="grid">
 ${row('Nombre', esc(o.clientName))}${row('Documento', `${esc(o.docType)} ${esc(o.docNumber)}`)}${row('Correo', esc(o.email))}
 ${row('Origen de fondos', esc(FUNDS[o.fundsSource] ?? o.fundsSource))}${row('Canal', esc(CHANNEL[o.channel] ?? o.channel) + (o.createdBy ? ` (${esc(o.createdBy)})` : ''))}
 ${row('Cuenta de origen', `${esc(o.sourceBank)} · ${esc(o.sourceAccount)}`)}${row('Cuenta de destino', `${esc(o.destinationBank)} · ${esc(o.destinationAccount)}`)}</dl>
<div class="sec">Montos</div><dl class="grid">
 ${row('Envía', money(o.sendAmount, o.sendCurrency))}${row('Recibe', money(o.receiveAmount, o.receiveCurrency))}
 ${row('Tasa fijada', `${esc(o.rate)} (mercado ${esc(o.marketRate)})`)}${row('Comisión + IGV', `${Number(o.commission).toFixed(2)} + ${Number(o.tax).toFixed(2)}`)}
 ${row('Total a transferir', money(o.total, o.sendCurrency))}${row('Pagó a', `${esc(o.paymentAccount?.bank)} · ${esc(o.paymentAccount?.accountNumber)}${o.paymentAccount?.pixKey ? ' · PIX ' + esc(o.paymentAccount.pixKey) : ''}${o.paymentAccount?.demo ? ' (DEMO)' : ''}`)}</dl>
<div class="sec">Pago y verificación</div><dl class="grid">
 ${row('N° de operación', esc(o.operationNo ?? '—'))}${row('Creada', lima(o.createdAt))}${row('Comprobante enviado', lima(o.proofSubmittedAt))}
 ${row('Validó', o.validatedBy ? `${esc(o.validatedBy)} · ${lima(o.validatedAt)}` : '—')}
 ${o.rejectionReason ? row('Motivo de rechazo', esc(o.rejectionReason)) : ''}
 ${row('Exportación', o.exportedAt ? `${lima(o.exportedAt)} · lote ${esc(o.exportBatchId)}` : '—')}
 ${row('Factura', inv ? `<span class="inv">${esc(inv.fullNumber)}</span> · ${esc(inv.status)}${inv.testMode ? ' (prueba, sin validez fiscal)' : ''}` : '—')}</dl>
<div class="sec">Comprobante de pago</div><div id="proofbox" class="mut small">${o.paymentProofPath ? 'Cargando…' : 'Aún no hay foto.'}</div>
${(o.uid === user.uid && o.status === 'pending' && can('create')) ? `<div class="sec">Adjuntar comprobante</div>
 <div class="f"><label>N° de operación<input type="text" id="a_op"></label><label>Foto<input type="file" id="a_file" accept="image/jpeg,image/png,image/webp"></label></div>
 <div class="err" id="a_err"></div>` : ''}`;

  const bar = $('dbar'); bar.innerHTML = '';
  const add = (label, cls, fn) => { const b = Object.assign(document.createElement('button'), {textContent: label, className: cls}); b.onclick = fn; bar.append(b); return b; };
  if (o.status === 'validating' && can('approve')) {
    add('Aprobar', 'p', async () => { closeDetail(); report('Aprobada', await eachOrder([id], 'Aprobando', (x) => call('reviewOrder', {orderId: x, decision: 'approve'}))); });
    add('Rechazar…', 'd', () => { closeDetail(); askReject([id]); });
  }
  if (o.uid === user.uid && o.status === 'pending' && can('create')) add('Enviar comprobante', 'p', () => attachProof(o));
  if (inv && ['accepted', 'sent'].includes(inv.status)) add('Descargar factura PDF', '', () => receipt(id));
  add('Cerrar', '', closeDetail);
  detail.showModal();

  if (o.paymentProofPath) {
    try {
      const url = await getDownloadURL(ref(storage, o.paymentProofPath));
      if (openId !== id) return;
      $('proofbox').innerHTML = /\.pdf($|\?)/i.test(o.paymentProofPath)
        ? `<a href="${url}" target="_blank" rel="noopener" style="color:#79aaff">Abrir PDF</a>`
        : `<a href="${url}" target="_blank" rel="noopener"><img class="proof" alt="Comprobante" src="${url}"></a>`;
    } catch { $('proofbox').textContent = 'No se pudo cargar la foto (¿falta permiso o ya no existe?).'; }
  }
}

const EXT = {'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp'};
const checkPhoto = (f) => {
  if (!f) return 'Sube la foto del comprobante.';
  if (!EXT[f.type]) return 'Solo se permiten fotos JPG, PNG o WEBP.';
  if (f.size > 5 * 1024 * 1024) return 'La foto supera 5 MB.';
  return '';
};
async function uploadProof(order, file, operationNo) {
  const path = `proofs/${user.uid}/${order.orderId}/proof-${Date.now()}.${EXT[file.type]}`;
  await uploadBytes(ref(storage, path), file, {contentType: file.type});
  await call('submitProof', {orderId: order.orderId, operationNo, proofPath: path});
}
async function attachProof(order) {
  const err = $('a_err');
  const file = $('a_file').files[0]; const op = $('a_op').value.trim();
  const bad = checkPhoto(file) || (op ? '' : 'Escribe el N° de operación.');
  if (bad) { err.textContent = bad; return; }
  try { await uploadProof(order, file, op); closeDetail(); say(`Comprobante enviado: ${order.orderId} pasó a En validación.`, 'ok'); }
  catch (e) { err.textContent = explain(e); }
}

// ----------------------------------------------------------- new operation
const nf = $('nf');
const f = (name) => nf.elements[name];

function suggest() {
  const from = f('sendCurrency').value; const to = f('receiveCurrency').value;
  const r = config.rates;
  if (!r || from === to || !r[from] || !r[to]) { $('sug').textContent = ''; return null; }
  const rate = (r[to] / r[from]) * (1 - config.spreadBps / 10000);
  $('sug').textContent = `(sugerida ${rate.toFixed(4)})`;
  return rate;
}
function calc() {
  const amount = +f('sendAmount').value; const rate = +f('rate').value; const com = +f('commission').value || 0;
  const tax = Math.round((com * config.taxBps) / 100) / 100;
  $('c_recv').value = amount && rate ? `${(amount * rate).toFixed(2)} ${f('receiveCurrency').value}` : '';
  $('c_tax').value = `${tax.toFixed(2)} ${f('sendCurrency').value}`;
  $('c_total').value = amount ? `${(amount + com + tax).toFixed(2)} ${f('sendCurrency').value}` : '';
}
['sendAmount', 'rate', 'commission', 'sendCurrency', 'receiveCurrency'].forEach((n) => { f(n).oninput = calc; f(n).onchange = calc; });
['sendCurrency', 'receiveCurrency'].forEach((n) => { f(n).addEventListener('change', () => { const s = suggest(); if (s) { f('rate').value = s.toFixed(4); calc(); } }); });
f('sendAmount').addEventListener('change', () => {
  if (!+f('commission').value && +f('sendAmount').value) { f('commission').value = ((+f('sendAmount').value * config.commissionBps) / 10000).toFixed(2); calc(); }
});

$('new').onclick = () => {
  nf.reset(); $('nerr').textContent = '';
  const s = suggest(); if (s) f('rate').value = s.toFixed(4);
  calc(); $('nd').showModal();
};
$('ncancel').onclick = () => $('nd').close();
$('save').onclick = async () => {
  const err = $('nerr'); err.textContent = '';
  if (!nf.reportValidity()) return;
  const file = $('proof').files[0];
  const bad = checkPhoto(file);
  if (bad) { err.textContent = bad; return; }
  if (f('sendCurrency').value === f('receiveCurrency').value) { err.textContent = 'Las monedas deben ser distintas.'; return; }
  const text = (n) => f(n).value.trim();
  const body = {
    clientName: text('clientName'), docType: f('docType').value, docNumber: text('docNumber'), email: text('email'),
    fundsSource: f('fundsSource').value, sourceBank: text('sourceBank'), sourceAccount: text('sourceAccount'),
    destinationBank: text('destinationBank'), destinationAccount: text('destinationAccount'),
    sendCurrency: f('sendCurrency').value, receiveCurrency: f('receiveCurrency').value,
    sendAmount: +f('sendAmount').value, rate: +f('rate').value, commission: +f('commission').value || 0,
  };
  $('save').disabled = true;
  let order = null;
  try {
    order = await call('createManualOrder', body);
    await uploadProof(order, file, text('operationNo'));
    $('nd').close();
    say(`Operación ${order.orderId} guardada · recibe ${money(order.receiveAmount, order.receiveCurrency)} · total ${money(order.total, order.sendCurrency)} · En validación.`, 'ok');
  } catch (e) {
    if (order) {
      $('nd').close();
      say(`${order.orderId} se creó pero el comprobante no se envió (${explain(e)}). Ábrela y usa "Enviar comprobante".`, 'err');
    } else err.textContent = explain(e);
  } finally { $('save').disabled = false; }
};

$('q').oninput = (e) => { search = e.target.value.trim().toLowerCase(); render(); };
