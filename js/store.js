/* =========================================================
   store.js · 資料層
   ---------------------------------------------------------
   兩種模式自動切換:
     firebase — 已填 firebase-config.js 且已登入 → Firestore 雲端同步
     local    — 未設定或選「先不登入」→ localStorage 本機儲存
   兩種模式對外 API 完全相同,UI 不需要知道差別。

   資料結構(支援多份工作 / 多雇主):
     users/{uid}/meta/settings          全域偏好(震動、GPS、提醒、目前工作…)
     users/{uid}/jobs/{jobId}           一份工作的設定(時薪、發薪日、到職日…)
     users/{uid}/jobs/{jobId}/days/{date}   該工作的每日打卡 / 記事

   getSettings() 會把「目前工作的設定」和「全域偏好」合併成一個扁平物件,
   所以 calc.js 和大部分 UI 程式碼不需要知道多雇主的存在。
   ========================================================= */

import { firebaseConfig, isConfigured } from "./firebase-config.js";

const SDK = "https://www.gstatic.com/firebasejs/10.13.2";
/* Firestore 資料庫 ID — 在 Firebase 主控台建立資料庫時輸入的名稱(非 (default)) */
const FIRESTORE_DATABASE_ID = "clock-system";
/* 帳號可自訂(不用是 email 格式),內部合成一個假 email 給 Firebase Auth 用 */
const USERNAME_DOMAIN = "timecard.local";
const usernameToEmail = (u) => `${u.trim().toLowerCase()}@${USERNAME_DOMAIN}`;
const isSyntheticEmail = (e) => e.endsWith(`@${USERNAME_DOMAIN}`);

const LS_DAYS = "tc_days";        // 舊版單一工作的資料(保留作為備份)
const LS_SET  = "tc_settings";
const LS_MODE = "tc_mode";
const LS_JOBS = "tc_jobs";
const LS_JOBDAYS = "tc_jobdays";  // { jobId: { date: dayDoc } }

/* 每份工作各自的設定 */
export const DEFAULT_JOB = {
  name: "我的工作",
  color: "sage",
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
  hireDate: "",         // 到職日,用來算特休
  // --- 實領淨額試算 ---
  netEnabled: false,    // 是否計算勞健保扣款
  insuranceSalary: 0,   // 投保薪資(0 = 依月薪自動建議)
  dependents: 0,        // 健保眷屬人數
  pensionSelfPct: 0,    // 勞退自願提繳 %
  otherDeduct: 0        // 其他固定扣款
};

/* 跨工作共用的偏好 */
export const DEFAULT_PREFS = {
  geo: false,
  vibrate: true,
  warnMissing: true,
  otCapHours: 46,       // 勞基法每月加班上限
  remindEnabled: false, // 忘記打卡提醒
  remindTime: "18:30",  // 提醒時間
  theme: "auto",        // auto | light | dark
  activeJobId: ""
};

export const DEFAULT_SETTINGS = { ...DEFAULT_JOB, ...DEFAULT_PREFS };

const JOB_KEYS = Object.keys(DEFAULT_JOB);
const PREF_KEYS = Object.keys(DEFAULT_PREFS);

let fb = null;
let uid = null;
let mode = "local";
let prefs = { ...DEFAULT_PREFS };
let jobs = [];                // [{ id, ...DEFAULT_JOB }]
let activeJobId = "";
const cache = new Map();      // 'YYYY-MM-DD' -> dayDoc(僅目前工作)
let loadedRanges = [];
let authCb = null;
let syncCb = null;

/* ---------- 工具 ---------- */
const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const newId = () => "j" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function notifySync(txt) { if (syncCb) syncCb(txt); }

export function emptyDay(date) {
  return { date, events: [], note: "", leave: null, updatedAt: 0 };
}

function mirrorLocal() {
  const all = lsGet(LS_JOBDAYS, {});
  const obj = {};
  cache.forEach((v, k) => { obj[k] = v; });
  all[activeJobId] = obj;
  lsSet(LS_JOBDAYS, all);
  lsSet(LS_JOBS, jobs);
  lsSet(LS_SET, prefs);
}

/* ---------- 初始化 ---------- */
export async function init({ onAuth, onSync }) {
  authCb = onAuth; syncCb = onSync;

  prefs = { ...DEFAULT_PREFS, ...lsGet(LS_SET, {}) };
  jobs = lsGet(LS_JOBS, []);

  if (!isConfigured) {
    mode = "local";
    await bootLocalJobs();
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
      await pullPrefs();
      await pullJobs();
      notifySync("已連線 Firebase · 自動同步");
      authCb({ mode: "firebase", user, ready: true });
    } else {
      uid = null;
      if (lsGet(LS_MODE, "") === "local") {
        mode = "local";
        await bootLocalJobs();
        notifySync("本機模式 · 只存在這台裝置");
        authCb({ mode: "local", user: null, ready: true });
      } else {
        authCb({ mode: null, user: null, ready: true });
      }
    }
  });
}

/* 本機模式:確保至少有一份工作,並沿用舊版單一工作的資料 */
async function bootLocalJobs() {
  if (!jobs.length) {
    const legacy = lsGet(LS_SET, null);
    const job = { id: newId(), ...DEFAULT_JOB };
    if (legacy) JOB_KEYS.forEach(k => { if (legacy[k] !== undefined) job[k] = legacy[k]; });
    jobs = [job];
    // 舊版的打卡資料搬進這份工作(原資料保留不刪,當作備份)
    const legacyDays = lsGet(LS_DAYS, {});
    if (Object.keys(legacyDays).length) {
      const all = lsGet(LS_JOBDAYS, {});
      all[job.id] = { ...legacyDays };
      lsSet(LS_JOBDAYS, all);
    }
    lsSet(LS_JOBS, jobs);
  }
  activeJobId = jobs.some(j => j.id === prefs.activeJobId) ? prefs.activeJobId : jobs[0].id;
  loadActiveCacheLocal();
}

function loadActiveCacheLocal() {
  cache.clear(); loadedRanges = []; reconCache.clear();
  const all = lsGet(LS_JOBDAYS, {});
  const mine = all[activeJobId] || {};
  Object.entries(mine).forEach(([k, v]) => cache.set(k, v));
}

/* ---------- 帳號 ---------- */
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
  await fb.A.createUserWithEmailAndPassword(fb.auth, authEmail, pass);
  await fb.A.updateProfile(fb.auth.currentUser, { displayName: uLower }).catch(() => {});

  const { doc, setDoc } = fb.D;
  try {
    await setDoc(doc(fb.db, "usernames", uLower), {
      uid: fb.auth.currentUser.uid, email: authEmail, createdAt: Date.now()
    });
  } catch (e) {
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
  bootLocalJobs();
  notifySync("本機模式 · 只存在這台裝置");
  authCb({ mode: "local", user: null, ready: true });
}

export async function logout() {
  localStorage.removeItem(LS_MODE);
  cache.clear(); loadedRanges = []; reconCache.clear(); jobs = []; activeJobId = "";
  if (fb && fb.auth.currentUser) await fb.A.signOut(fb.auth);
  else authCb({ mode: null, user: null, ready: true });
}

export const currentMode = () => mode;

/* ---------- 全域偏好 ---------- */
async function pullPrefs() {
  const { doc, getDoc } = fb.D;
  const snap = await getDoc(doc(fb.db, "users", uid, "meta", "settings"));
  if (snap.exists()) prefs = { ...DEFAULT_PREFS, ...snap.data() };
  lsSet(LS_SET, prefs);
}

/* ---------- 工作(多雇主) ---------- */
async function pullJobs() {
  const { collection, getDocs, doc, setDoc, getDoc, writeBatch } = fb.D;
  const snap = await getDocs(collection(fb.db, "users", uid, "jobs"));
  jobs = [];
  snap.forEach(d => jobs.push({ id: d.id, ...DEFAULT_JOB, ...d.data() }));

  if (!jobs.length) {
    // 第一次使用,或從舊版單一工作升級上來
    const legacySnap = await getDoc(doc(fb.db, "users", uid, "meta", "settings"));
    const legacy = legacySnap.exists() ? legacySnap.data() : null;
    const job = { id: newId(), ...DEFAULT_JOB };
    if (legacy) JOB_KEYS.forEach(k => { if (legacy[k] !== undefined) job[k] = legacy[k]; });

    const { id, ...body } = job;
    await setDoc(doc(fb.db, "users", uid, "jobs", id), body);
    jobs = [job];

    // 舊版 users/{uid}/days 的資料複製一份進來(原資料保留當備份)
    try {
      const oldDays = await getDocs(collection(fb.db, "users", uid, "days"));
      if (!oldDays.empty) {
        const batch = writeBatch(fb.db);
        oldDays.forEach(d => batch.set(doc(fb.db, "users", uid, "jobs", id, "days", d.id), d.data()));
        await batch.commit();
        notifySync(`已將 ${oldDays.size} 筆舊紀錄轉入「${job.name}」`);
      }
    } catch { /* 沒有舊資料就略過 */ }
  }

  jobs.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  activeJobId = jobs.some(j => j.id === prefs.activeJobId) ? prefs.activeJobId : jobs[0].id;
  lsSet(LS_JOBS, jobs);
  await reloadActiveCache();
}

export const getJobs = () => jobs.map(j => ({ ...j }));
export const getActiveJobId = () => activeJobId;
export const getActiveJob = () => ({ ...(jobs.find(j => j.id === activeJobId) || DEFAULT_JOB) });

export async function switchJob(jobId) {
  if (!jobs.some(j => j.id === jobId) || jobId === activeJobId) return;
  activeJobId = jobId;
  savePrefs({ activeJobId: jobId });
  await reloadActiveCache();
}

async function reloadActiveCache() {
  cache.clear(); loadedRanges = []; reconCache.clear();
  if (mode === "local") loadActiveCacheLocal();
}

export async function createJob(data) {
  const job = { id: newId(), ...DEFAULT_JOB, ...data, createdAt: Date.now() };
  jobs.push(job);
  lsSet(LS_JOBS, jobs);
  if (mode === "firebase") {
    const { doc, setDoc } = fb.D;
    const { id, ...body } = job;
    await setDoc(doc(fb.db, "users", uid, "jobs", id), body);
  }
  await switchJob(job.id);
  return job.id;
}

export async function deleteJob(jobId) {
  if (jobs.length <= 1) throw new Error("至少要保留一份工作");
  jobs = jobs.filter(j => j.id !== jobId);
  lsSet(LS_JOBS, jobs);

  if (mode === "firebase") {
    const { doc, deleteDoc, collection, getDocs, writeBatch } = fb.D;
    // 先刪掉底下的打卡紀錄,再刪工作本身
    const days = await getDocs(collection(fb.db, "users", uid, "jobs", jobId, "days"));
    if (!days.empty) {
      const batch = writeBatch(fb.db);
      days.forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
    await deleteDoc(doc(fb.db, "users", uid, "jobs", jobId));
  } else {
    const all = lsGet(LS_JOBDAYS, {});
    delete all[jobId];
    lsSet(LS_JOBDAYS, all);
  }

  if (activeJobId === jobId) {
    activeJobId = jobs[0].id;
    savePrefs({ activeJobId });
    await reloadActiveCache();
  }
}

/* ---------- 設定(自動分流到「工作設定」或「全域偏好」) ---------- */
export function getSettings() {
  return { ...DEFAULT_SETTINGS, ...getActiveJob(), ...prefs };
}

let jobTimer = null, prefTimer = null;

export function saveSettings(patch) {
  const jobPatch = {}, prefPatch = {};
  Object.entries(patch).forEach(([k, v]) => {
    if (PREF_KEYS.includes(k)) prefPatch[k] = v;
    else if (JOB_KEYS.includes(k)) jobPatch[k] = v;
  });
  if (Object.keys(jobPatch).length) saveJob(jobPatch);
  if (Object.keys(prefPatch).length) savePrefs(prefPatch);
}

function saveJob(patch) {
  const i = jobs.findIndex(j => j.id === activeJobId);
  if (i < 0) return;
  jobs[i] = { ...jobs[i], ...patch };
  lsSet(LS_JOBS, jobs);
  if (mode !== "firebase") return;
  clearTimeout(jobTimer);
  jobTimer = setTimeout(async () => {
    const { doc, setDoc } = fb.D;
    const { id, ...body } = jobs[i];
    try {
      await setDoc(doc(fb.db, "users", uid, "jobs", id), body, { merge: true });
      notifySync("設定已同步 " + new Date().toLocaleTimeString("zh-TW"));
    } catch (e) { notifySync("同步失敗:" + e.message); }
  }, 900);
}

function savePrefs(patch) {
  prefs = { ...prefs, ...patch };
  lsSet(LS_SET, prefs);
  if (mode !== "firebase") return;
  clearTimeout(prefTimer);
  prefTimer = setTimeout(async () => {
    const { doc, setDoc } = fb.D;
    try {
      await setDoc(doc(fb.db, "users", uid, "meta", "settings"), prefs, { merge: true });
    } catch (e) { notifySync("同步失敗:" + e.message); }
  }, 900);
}

/* ---------- 單日資料 ---------- */
const dayPath = () => ["users", uid, "jobs", activeJobId, "days"];

export function getDayCached(date) {
  return cache.get(date) || emptyDay(date);
}

export async function fetchDay(date) {
  if (cache.has(date)) return cache.get(date);
  if (mode === "firebase") {
    const { doc, getDoc } = fb.D;
    const snap = await getDoc(doc(fb.db, ...dayPath(), date));
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
  const isEmpty = !day.events.length && !day.note && !day.leave;
  if (isEmpty) cache.delete(day.date); else cache.set(day.date, day);
  mirrorLocal();
  if (mode !== "firebase") return;

  writeQueue.set(day.date, isEmpty ? null : day);
  clearTimeout(writeTimer);
  writeTimer = setTimeout(flushWrites, 700);
}

async function flushWrites() {
  if (mode !== "firebase" || !writeQueue.size) return;
  const { doc, writeBatch } = fb.D;
  const batch = writeBatch(fb.db);
  const entries = [...writeQueue.entries()];
  const jobAtWrite = activeJobId;
  writeQueue.clear();
  entries.forEach(([date, data]) => {
    const ref = doc(fb.db, "users", uid, "jobs", jobAtWrite, "days", date);
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
      collection(fb.db, ...dayPath()),
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

/* =========================================================
   薪資對帳:記錄每期「實際入帳金額」,和系統算出來的比對
   文件 id 用該期的起始日,例如 2026-08-05
   ========================================================= */
const LS_RECON = "tc_recon";        // { jobId: { periodFrom: {...} } }
const reconCache = new Map();

export async function getRecon(periodFrom) {
  if (reconCache.has(periodFrom)) return reconCache.get(periodFrom);
  if (mode === "firebase") {
    const { doc, getDoc } = fb.D;
    try {
      const snap = await getDoc(doc(fb.db, "users", uid, "jobs", activeJobId, "recon", periodFrom));
      const v = snap.exists() ? snap.data() : null;
      if (v) reconCache.set(periodFrom, v);
      return v;
    } catch { return null; }
  }
  const all = lsGet(LS_RECON, {});
  return (all[activeJobId] || {})[periodFrom] || null;
}

export async function saveRecon(periodFrom, data) {
  const rec = { ...data, periodFrom, updatedAt: Date.now() };
  reconCache.set(periodFrom, rec);
  const all = lsGet(LS_RECON, {});
  all[activeJobId] = { ...(all[activeJobId] || {}), [periodFrom]: rec };
  lsSet(LS_RECON, all);
  if (mode !== "firebase") return;
  const { doc, setDoc } = fb.D;
  try {
    await setDoc(doc(fb.db, "users", uid, "jobs", activeJobId, "recon", periodFrom), rec);
    notifySync("對帳紀錄已同步");
  } catch (e) { notifySync("同步失敗:" + e.message); }
}

export async function clearRecon(periodFrom) {
  reconCache.delete(periodFrom);
  const all = lsGet(LS_RECON, {});
  if (all[activeJobId]) { delete all[activeJobId][periodFrom]; lsSet(LS_RECON, all); }
  if (mode !== "firebase") return;
  const { doc, deleteDoc } = fb.D;
  try { await deleteDoc(doc(fb.db, "users", uid, "jobs", activeJobId, "recon", periodFrom)); } catch {}
}

/* 查詢「其他工作」的區間資料,用於跨工作的總覽,不影響目前快取 */
export async function fetchRangeForJob(jobId, from, to) {
  if (jobId === activeJobId) return fetchRange(from, to);
  if (mode === "firebase") {
    const { collection, query, where, getDocs, orderBy } = fb.D;
    const q = query(
      collection(fb.db, "users", uid, "jobs", jobId, "days"),
      where("date", ">=", from), where("date", "<=", to), orderBy("date")
    );
    try {
      const snap = await getDocs(q);
      const out = [];
      snap.forEach(d => out.push(d.data()));
      return out.sort((a, b) => a.date.localeCompare(b.date));
    } catch { return []; }
  }
  const all = lsGet(LS_JOBDAYS, {});
  const mine = all[jobId] || {};
  return Object.values(mine)
    .filter(d => d.date >= from && d.date <= to)
    .sort((a, b) => a.date.localeCompare(b.date));
}
