import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyDsYFFtEJ96yg0Rqw7EfCZFoiLIaeDk6zY",
  authDomain: "gaac-registration-2026.firebaseapp.com",
  projectId: "gaac-registration-2026",
  storageBucket: "gaac-registration-2026.firebasestorage.app",
  messagingSenderId: "542838311094",
  appId: "1:542838311094:web:6104e2ed0d1cafa976be17",
  measurementId: "G-CEB6Z0RF5E"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

export { auth, db, storage };
