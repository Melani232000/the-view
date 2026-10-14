// The Firebase web config is NOT stored in this repository.
//
// - On Firebase Hosting it is served by the platform at /__/firebase/init.json
//   (the Hosting site must be linked to a web app, see README).
// - With `npm start`, server.js serves the same path from the values in `.env`
//   (git-ignored; copy `.env.example`).
//
// This keeps the key out of git and out of secret scanners. The key is not a
// password, but it should still be restricted in Google Cloud (see README).
const res = await fetch('/__/firebase/init.json');
if (!res.ok) {
  document.body.innerHTML = '<p style="font:16px system-ui;padding:32px;color:#fff">Falta la configuración de Firebase. Copia <code>.env.example</code> a <code>.env</code> y completa los valores (ver README).</p>';
  throw new Error(`firebase init.json ${res.status}`);
}
export const FIREBASE_CONFIG = await res.json();

export const REGION = 'southamerica-east1';

// http://localhost:3000/?emulator talks to the local Firebase emulators
// (run `bun run emulators` in the iathon_fintech repo) instead of production.
export const EMULATOR =
  new URLSearchParams(location.search).has('emulator') &&
  ['localhost', '127.0.0.1'].includes(location.hostname);
