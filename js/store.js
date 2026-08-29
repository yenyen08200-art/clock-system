/* =========================================================
   store.js · 資料層
   ---------------------------------------------------------
   兩種模式自動切換:
     firebase — 已填 firebase-config.js 且已登入 → Firestore 雲端同步
     local    — 未設定或選「先不登入」→ localStorage 本機儲存
   兩種模式對外 API 完全相同,UI 不需要知道差別。
   ========================================================= */

import { firebaseConfig, isConfigured } from "./firebase-config.js";

const SDK = "https://www.gstatic.com/firebasejs/10.13.2";
/* Firestore 資料庫 ID — 在 Firebase 主控台建立資料庫時輸入的名稱(非 (default)) */
const FIRESTORE_DATABASE_ID = "clock-system";
/* 帳號可自訂(不用是 email 格式),內部合成一個假 email 給 Firebase Auth 用 */
const USERNAME_DOMAIN = "timecard.local";
const usernameToEmail = (u) => `${u.trim().toLowerCase()}@${USERNAME_DOMAIN}`;
const isSyntheticEmail = (e) => e.endsWith(`@${USERNAME_DOMAIN}`);
const LS_DAYS = "tc_days";
const LS_SET  = "tc_settings";
const LS_MODE = "tc_mode";

export const DEFAULT_SETTINGS = {
  wage: 200,            // 時薪
  dailyHours: 8,        // 每日約定工時
  autoBreakMin: 0,      // 午休自動扣除分鐘 (0 = 只依實際打卡)
  overtime: true,       // 啟用加班倍率
  cycleMode: "payday",  // payday | monthly | custom
  payday: 5,            // 發薪日
  cutoffStart: 5,       // 自訂結算起始日
  leaveAnnual: 100,     // 特休 / 國定假日 給薪 %
  leaveSick: 50,        // 病假 給薪 %
  leavePersonal: 0,     // 事假 給薪 %
  geo: false,
  vibrate: true,
  warnMissing: true
};

let fb = null;          // { app, auth, db, fns }
let uid = null;
let mode = "local";     // local | firebase
let settings = { ...DEFAULT_SETTINGS };
const cache = new Map();      // 'YYYY-MM-DD' -> dayDoc
const loadedRanges = [];      // [from,to] 已抓過的區間,避免重複讀取
let authCb = null;
let syncCb = null;

/* ---------- 工具 ---------- */
const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

function mirrorLocal() {
  const obj = {};
  cache.forEach((v, k) => { obj[k] = v; });
  lsSet(LS_DAYS, obj);
  lsSet(LS_SET, settings);
}
function notifySync(txt) { if (syncCb) syncCb(txt); }

export function emptyDay(date) {
  return { date, events: [], note: "", leave: null, updatedAt: 0 };
}

/* ---------- 初始化 ---------- */
export async function init({ onAuth, onSync }) {
  authCb = onAuth; syncCb = onSync;

  // 先把本機資料讀進快取(離線也能立刻看到東西)
  const localDays = lsGet(LS_DAYS, {});
  Object.entries(localDays).forEach(([k, v]) => cache.set(k, v));
  settings = { ...DEFAULT_SETTINGS, ...lsGet(LS_SET, {}) };

  if (!isConfigured) {
    mode = "local";
    notifySync("本機模式 · 尚未設定 Firebase");
    authCb({ mode: "local", user: null, ready: true });
    return;
  }

  const [{ initializeApp }, authMod, dbMod] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`)
  ]);

  const app = initializeApp(firebaseConfig);
  let db;
  try {
    db = dbMod.initializeFirestore(app, {
      localCache: dbMod.persistentLocalCache({ tabManager: dbMod.persistentMultipleTabManager() })
    }, FIRESTORE_DATABASE_ID);
  } catch {
    db = dbMod.getFirestore(app, FIRESTORE_DATABASE_ID);
  }
  fb = { app, auth: authMod.getAuth(app), db, A: authMod, D: dbMod };

  authMod.onAuthStateChanged(fb.auth, async (user) => {
    if (user) {
      uid = user.uid; mode = "firebase";
      notifySync("雲端同步中…");
      await pullSettings();
      notifySync("已連線 Firebase · 自動同步");
      authCb({ mode: "firebase", user, ready: true });
    } else {
      uid = null;
      if (lsGet(LS_MODE, "") === "local") {
        mode = "local";
        notifySync("本機模式 · 只存在這台裝置");
        authCb({ mode: "local", user: null, ready: true });
      } else {
        authCb({ mode: null, user: null, ready: true });
      }
    }
  });
}

/* ---------- 帳號 ----------
   帳號可自訂(不用是 email 格式):
   - 有填「電子郵件」→ 那組真實 email 就是 Firebase Auth 的登入 email(忘記密碼可用)
   - 沒填 → 用 usernameToEmail() 合成一個假 email,帳號一樣能自由取,但不能寄重設信
   帳號 → email 的對應存在公開可讀的 usernames/{帳號} 文件,登入 / 忘記密碼時查詢用。
*/
export async function login(account, pass) {
  if (!fb) throw new Error("尚未設定 Firebase,請先使用本機模式");
  localStorage.removeItem(LS_MODE);
  const email = account.includes("@") ? account.trim() : await resolveEmail(account);
  await fb.A.signInWithEmailAndPassword(fb.auth, email, pass);
}

export async function register(account, pass, recoveryEmail) {
  if (!fb) throw new Error("尚未設定 Firebase,請先使用本機模式");
  const uLower = account.trim().toLowerCase();
  const authEmail = recoveryEmail && recoveryEmail.trim() ? recoveryEmail.trim() : usernameToEmail(uLower);

  localStorage.removeItem(LS_MODE);
  await fb.A.createUserWithEmailAndPassword(fb.auth, authEmail, pass);   // 建好後自動登入
  await fb.A.updateProfile(fb.auth.currentUser, { displayName: uLower }).catch(() => {});

  const { doc, setDoc } = fb.D;
  try {
    await setDoc(doc(fb.db, "usernames", uLower), {
      uid: fb.auth.currentUser.uid, email: authEmail, createdAt: Date.now()
    });
  } catch (e) {
    // 帳號名稱已被別人用真實 email 佔用 → 規則會擋下這次寫入,回滾剛建立的帳號
    await fb.A.deleteUser(fb.auth.currentUser).catch(() => {});
    const err = new Error("這個帳號名稱已經被使用,請換一個");
    err.code = "account/username-taken";
    throw err;
  }
}

export async function sendReset(account) {
  if (!fb) throw new Error("尚未設定 Firebase,請先使用本機模式");
  const email = account.includes("@") ? account.trim() : await resolveEmail(account);
  if (isSyntheticEmail(email)) {
    const err = new Error("這個帳號沒有設定電子郵件,無法寄送重設信");
    err.code = "account/no-recovery-email";
    throw err;
  }
  await fb.A.sendPasswordResetEmail(fb.auth, email);
}

async function resolveEmail(account) {
  const { doc, getDoc } = fb.D;
  const uLower = account.trim().toLowerCase();
  const snap = await getDoc(doc(fb.db, "usernames", uLower));
  if (!snap.exists()) {
    const err = new Error("查無此帳號");
    err.code = "account/not-found";
    throw err;
  }
  return snap.data().email;
}
export function useLocal() {
  lsSet(LS_MODE, "local");
  mode = "local"; uid = null;
  notifySync("本機模式 · 只存在這台裝置");
  authCb({ mode: "local", user: null, ready: true });
}
export async function logout() {
  localStorage.removeItem(LS_MODE);
  cache.clear(); loadedRanges.length = 0;
  if (fb && fb.auth.currentUser) await fb.A.signOut(fb.auth);
  else authCb({ mode: null, user: null, ready: true });
}
export const currentMode = () => mode;

/* ---------- 設定 ---------- */
export const getSettings = () => settings;

async function pullSettings() {
  if (mode !== "firebase") return;
  const { doc, getDoc } = fb.D;
  const snap = await getDoc(doc(fb.db, "users", uid, "meta", "settings"));
  if (snap.exists()) settings = { ...DEFAULT_SETTINGS, ...snap.data() };
  lsSet(LS_SET, settings);
}

let setTimer = null;
export function saveSettings(patch) {
  settings = { ...settings, ...patch };
  lsSet(LS_SET, settings);
  if (mode !== "firebase") return;
  clearTimeout(setTimer);
  setTimer = setTimeout(async () => {          // 防抖,省寫入次數
    const { doc, setDoc } = fb.D;
    try {
      await setDoc(doc(fb.db, "users", uid, "meta", "settings"), settings, { merge: true });
      notifySync("設定已同步 " + new Date().toLocaleTimeString("zh-TW"));
    } catch (e) { notifySync("同步失敗:" + e.message); }
  }, 900);
}

/* ---------- 單日資料 ---------- */
export function getDayCached(date) {
  return cache.get(date) || emptyDay(date);
}

export async function fetchDay(date) {
  if (cache.has(date)) return cache.get(date);
  if (mode === "firebase") {
    const { doc, getDoc } = fb.D;
    const snap = await getDoc(doc(fb.db, "users", uid, "days", date));
    const d = snap.exists() ? snap.data() : emptyDay(date);
    cache.set(date, d);
    return d;
  }
  return emptyDay(date);
}

const writeQueue = new Map();
let writeTimer = null;

export function saveDay(day) {
  day.updatedAt = Date.now();
  // 全空的日子直接刪掉,不留垃圾
  const isEmpty = !day.events.length && !day.note && !day.leave;
  if (isEmpty) cache.delete(day.date); else cache.set(day.date, day);
  mirrorLocal();
  if (mode !== "firebase") return;

  writeQueue.set(day.date, isEmpty ? null : day);
  clearTimeout(writeTimer);
  writeTimer = setTimeout(flushWrites, 700);   // 合併連續操作,省寫入次數
}

async function flushWrites() {
  if (mode !== "firebase" || !writeQueue.size) return;
  const { doc, writeBatch } = fb.D;
  const batch = writeBatch(fb.db);
  const entries = [...writeQueue.entries()];
  writeQueue.clear();
  entries.forEach(([date, data]) => {
    const ref = doc(fb.db, "users", uid, "days", date);
    if (data) batch.set(ref, data, { merge: false });
    else batch.delete(ref);
  });
  try {
    await batch.commit();
    notifySync(`已同步 ${entries.length} 筆 · ${new Date().toLocaleTimeString("zh-TW")}`);
  } catch (e) {
    notifySync("同步失敗(離線暫存):" + e.message);
  }
}

/* ---------- 區間查詢 ---------- */
function rangeLoaded(from, to) {
  return loadedRanges.some(r => r[0] <= from && r[1] >= to);
}

export async function fetchRange(from, to) {
  if (mode === "firebase" && !rangeLoaded(from, to)) {
    const { collection, query, where, getDocs, orderBy } = fb.D;
    const q = query(
      collection(fb.db, "users", uid, "days"),
      where("date", ">=", from), where("date", "<=", to), orderBy("date")
    );
    try {
      const snap = await getDocs(q);
      snap.forEach(d => cache.set(d.id, d.data()));
      loadedRanges.push([from, to]);
      mirrorLocal();
    } catch (e) { notifySync("讀取失敗(改用本機快取):" + e.message); }
  }
  const out = [];
  cache.forEach((v, k) => { if (k >= from && k <= to) out.push(v); });
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}
