const admin = require('firebase-admin');

let initialized = false;

/**
 * Initialize the Firebase Admin SDK.
 * Safe to call multiple times — only initializes once.
 * Returns the admin namespace, or null if not configured / failed.
 */
function initFirebaseAdmin() {
  if (initialized) return admin;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    console.warn('[firebase-admin] FIREBASE_SERVICE_ACCOUNT_JSON is not set');
    return null;
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch (err) {
    console.error('[firebase-admin] Failed to parse service account JSON:', err.message);
    return null;
  }

  try {
    // Guard against double-init (e.g. hot reload in dev)
    if (admin.apps.length === 0) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
    }
    initialized = true;
    console.log('[firebase-admin] Initialized ✅');
    return admin;
  } catch (err) {
    console.error('[firebase-admin] Init failed:', err.message);
    return null;
  }
}

/**
 * Get a Firestore instance, or null if Firebase isn't configured.
 * Callers must handle the null case (return 503 to the client).
 */
function getFirestore() {
  const app = initFirebaseAdmin();
  return app ? app.firestore() : null;
}

module.exports = { initFirebaseAdmin, getFirestore };
