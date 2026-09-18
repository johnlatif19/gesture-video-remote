(function (global) {
  'use strict';

  const FIREBASE_VERSION = '10.12.2';
  const APP_URL = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-app.js`;
  const FIRESTORE_URL = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-firestore.js`;

  let configPromise = null;
  let appPromise = null;
  let dbPromise = null;

  async function getConfig() {
    if (configPromise) return configPromise;
    configPromise = fetch('/api/config')
      .then((r) => r.json())
      .then((data) => data.firebase || null)
      .catch(() => null);
    return configPromise;
  }

  async function getApp() {
    if (appPromise) return appPromise;
    appPromise = (async () => {
      const config = await getConfig();
      if (!config || !config.apiKey) return null;

      const { initializeApp } = await import(/* @vite-ignore */ APP_URL);
      return initializeApp(config);
    })();
    return appPromise;
  }

  async function getDb() {
    if (dbPromise) return dbPromise;
    dbPromise = (async () => {
      const app = await getApp();
      if (!app) return null;
      const { getFirestore } = await import(/* @vite-ignore */ FIRESTORE_URL);
      return getFirestore(app);
    })();
    return dbPromise;
  }

  global.FirebaseClient = { getConfig, getApp, getDb };
})(window);