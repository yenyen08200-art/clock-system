/* =========================================================
   Firebase 設定
   ---------------------------------------------------------
   1. 到 https://console.firebase.google.com 建立專案 (免費 Spark 方案)
   2. 專案設定 → 一般 → 你的應用程式 → 網頁應用程式 → 註冊
   3. 把它給你的 firebaseConfig 貼到下面覆蓋
   4. Authentication → 登入方式 → 啟用「電子郵件/密碼」
   5. Firestore Database → 建立資料庫 → 選「正式版」→ 貼上 firestore.rules
   ========================================================= */

export const firebaseConfig = {
  apiKey:            "AIzaSyANNLGshk3gAM5UjjPCdHtimSkp8UX2d08",
  authDomain:        "clock-system-e6ca3.firebaseapp.com",
  projectId:         "clock-system-e6ca3",
  storageBucket:     "clock-system-e6ca3.firebasestorage.app",
  messagingSenderId: "806047673048",
  appId:             "1:806047673048:web:ee7cb0eec0dc1a5cf685ad"
};

/* 尚未填寫時自動退回「本機模式」,資料存在瀏覽器,不會壞掉 */
export const isConfigured = !firebaseConfig.apiKey.startsWith("PASTE_");
