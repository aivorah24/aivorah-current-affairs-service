// Firebase Admin — only used to verify the student's Firebase ID token.
// Same init order as aivorah-auth-service: base64 env var, JSON env var, local file.
let firebaseAdmin = null;
try {
  const admin = require('firebase-admin');
  if (admin.apps.length) {
    firebaseAdmin = admin;
  } else {
    let svcJson = null;
    if (process.env.FIREBASE_SERVICE_ACCOUNT_B64) {
      svcJson = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8'));
    } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      svcJson = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } else {
      const svcPath = require('path').join(__dirname, '../firebase-service-account.json');
      if (require('fs').existsSync(svcPath)) svcJson = require(svcPath);
    }
    if (svcJson) {
      admin.initializeApp({ credential: admin.credential.cert(svcJson) });
      firebaseAdmin = admin;
    } else {
      console.warn('[firebase-admin] no service account configured — student sign-in cannot be checked');
    }
  }
} catch (e) {
  console.warn('[firebase-admin] not available:', e.message);
}

module.exports = firebaseAdmin;
