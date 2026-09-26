let app = null;
let auth = null;
let provider = null;
let db = null;
let analytics = null;
let initialized = false;

const firebaseConfig = {
  apiKey: "AIzaSyDmJYG-2SJ8qbb7Ukhkuw3TmIRbJwn0kA0",
  authDomain: "sayraa-19df7.firebaseapp.com",
  projectId: "sayraa-19df7",
  storageBucket: "sayraa-19df7.firebasestorage.app",
  messagingSenderId: "73455508153",
  appId: "1:73455508153:web:799955665660eb405ed968",
  measurementId: "G-NMVKJ1VMF6"
};

export async function getFirebase() {
    if (initialized && app) return { app, auth, provider, db, analytics };

    try {
        const { initializeApp } = await import("firebase/app");
        const { getAuth, GoogleAuthProvider } = await import("firebase/auth");
        const { getFirestore } = await import("firebase/firestore");

        app = initializeApp(firebaseConfig);
        auth = getAuth(app);
        provider = new GoogleAuthProvider();
        db = getFirestore(app);
        try {
            const { getAnalytics } = await import("firebase/analytics");
            analytics = getAnalytics(app);
        } catch (e) {
            console.warn("Firebase Analytics failed to initialize:", e);
        }
        initialized = true;
        
        // Add additional Google provider settings
        provider.setCustomParameters({
            prompt: 'select_account'
        });

        // Set auth language
        auth.languageCode = 'en';

        console.log("Firebase initialized successfully");
        return { app, auth, provider, db, analytics };
    } catch (error) {
        console.error("Failed to initialize Firebase:", error);
        throw error;
    }
}
