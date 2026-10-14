// Gives a Firebase Auth user a back-office role (custom claim `role`) and
// creates the user first when --password is passed.
//
//   node scripts/grant-staff.mjs <email> <admin|validator|operator|billing> [--password <pw>]
//
// Roles (what the Cloud Functions allow):
//   validator  approve / reject payments, register a seller's operation
//   operator   export approved orders to the Dashboard file, register a seller's operation
//   billing    run Fact (invoices)
//   admin      everything
//
// Against production it needs Application Default Credentials for the project:
//   gcloud auth application-default login
// Against the emulators: FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 node scripts/grant-staff.mjs ...
import {applicationDefault, initializeApp} from "firebase-admin/app";
import {getAuth} from "firebase-admin/auth";

const ROLES = ["admin", "validator", "operator", "billing"];
const [email, role, ...rest] = process.argv.slice(2);
const passwordAt = rest.indexOf("--password");
const password = passwordAt === -1 ? undefined : rest[passwordAt + 1];

if (!email || !ROLES.includes(role)) {
    console.error(`Uso: node scripts/grant-staff.mjs <email> <${ROLES.join("|")}> [--password <clave>]`);
    process.exit(1);
}

const emulator = Boolean(process.env.FIREBASE_AUTH_EMULATOR_HOST);
initializeApp({
    projectId: process.env.GCLOUD_PROJECT ?? "aibrasper",
    ...(emulator ? {} : {credential: applicationDefault()}),
});
const auth = getAuth();

let user;
try {
    user = await auth.getUserByEmail(email);
} catch {
    if (!password) {
        console.error(`No existe ${email}. Pasa --password para crearlo.`);
        process.exit(1);
    }
    user = await auth.createUser({email, password, emailVerified: true});
    console.log(`Usuario creado: ${email}`);
}

await auth.setCustomUserClaims(user.uid, {role});
console.log(`${email} ahora es ${role}${emulator ? " (emulador)" : ""}. Cierra sesión y vuelve a entrar para que el rol se aplique.`);
