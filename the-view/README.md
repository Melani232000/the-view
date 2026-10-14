# Team: the VIEW (BRASPER MVP)
Node >= 22.13 + Express + SQLite nativo (node:sqlite), frontend en HTML/JS puro.

    Windows: doble clic en iniciar.bat   |   o: npm install && npm start  (http://localhost:3000)

Tablas: `orders`, `invoices`, `audit_log`. Fotos de comprobante (solo JPG/PNG/WEBP, máx. 5 MB) en `uploads/`.
Flujo: pending → validating → approved → exported → (Fact) factura.
API: GET /api/orders · POST /api/orders · POST /api/orders/status · GET /api/export · POST /api/fact/run · GET /api/invoices
