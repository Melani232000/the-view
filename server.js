// Local static server for the VIEW. All data and rules live in Firebase
// (project aibrasper): the browser talks to Auth, Firestore, Storage and the
// Cloud Functions directly, so there is nothing to proxy here except the web
// config, which comes from `.env` so that it is never committed.
const express = require('express');
const fs = require('node:fs');

if (fs.existsSync('.env')) process.loadEnvFile('.env'); // Node >= 22

const KEYS = {
  apiKey: 'FIREBASE_API_KEY',
  authDomain: 'FIREBASE_AUTH_DOMAIN',
  projectId: 'FIREBASE_PROJECT_ID',
  storageBucket: 'FIREBASE_STORAGE_BUCKET',
  messagingSenderId: 'FIREBASE_MESSAGING_SENDER_ID',
  appId: 'FIREBASE_APP_ID',
};

const app = express();
app.disable('x-powered-by');

// Same path and shape as Firebase Hosting's reserved /__/firebase/init.json.
app.get('/__/firebase/init.json', (_req, res) => {
  const config = Object.fromEntries(Object.entries(KEYS).map(([k, env]) => [k, process.env[env]]));
  const missing = Object.entries(KEYS).filter(([, env]) => !process.env[env]).map(([, env]) => env);
  if (missing.length) return res.status(500).json({ error: `Faltan en .env: ${missing.join(', ')}` });
  res.set('Cache-Control', 'no-store').json(config);
});

app.use(express.static('public', { etag: false, maxAge: 0 }));

const port = process.env.PORT || 3000;
if (require.main === module) app.listen(port, () => console.log(`THE VIEW → http://localhost:${port}`));
module.exports = app;
