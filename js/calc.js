/* =========================================================
   calc.js · 工時 / 薪資 / 計薪週期 計算核心
   ---------------------------------------------------------
   全部以「秒」為最小單位,不做四捨五入的取整,
   最後換算薪資時才用 (秒 / 3600) × 時薪。
   ========================================================= */

/* ---------- 日期工具 (全用本地時區,不用 UTC 以免跨日錯位) ---------- */
export const pad = (n) => String(n).padStart(2, "0");
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseYmd = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const addMonths = (d, n) => { const x = new Date(d.getFullYear(), d.getMonth() + n, 1); return x; };
export const lastDayOfMonth = (y, m) => new Date(y, m + 1, 0).getDate();
export const WEEK = ["日", "一", "二", "三", "四", "五", "六"];

/* 安全地取某年某月的第 day 天(2 月沒有 30 號時自動退到月底) */
export function dayOfMonth(y, m, day) {
  return new Date(y, m, Math.min(day, lastDayOfMonth(y, m)));
}

export const fmtHMS = (sec) => {
  sec = Math.max(0, Math.floor(sec));
  return `${pad(Math.floor(sec / 3600))}:${pad(Math.floor(sec / 60) % 60)}:${pad(sec % 60)}`;
};
export const fmtClock = (ts) => {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
export const fmtClock12 = (ts) => {
  const d = new Date(ts), h = d.getHours();
  const ap = h < 12 ? "上午" : "下午";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${ap} ${pad(hh)}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
export const money = (n) => "NT$ " + Math.round(n).toLocaleString("zh-TW");
export const hours2 = (sec) => (sec / 3600).toFixed(2);

/* ---------- 事件定義 ---------- */
export const EV = {
  in:         { name: "上班",     ico: "🌅" },
  out:        { name: "下班",     ico: "🌇" },
  breakStart: { name: "中午休息", ico: "🍱" },
  breakEnd:   { name: "休息結束", ico: "☕" }
};

export const LEAVE = {
  off:      { name: "例假 / 休息日", ratioKey: null,           ico: "🛌" },
  annual:   { name: "特休",          ratioKey: "leaveAnnual",  ico: "🏖️" },
  holiday:  { name: "國定假日",      ratioKey: "leaveAnnual",  ico: "🎌" },
  official: { name: "公假",          ratioKey: "fixed100",     ico: "📋" },
  sick:     { name: "病假",          ratioKey: "leaveSick",    ico: "🤒" },
  personal: { name: "事假",          ratioKey: "leavePersonal",ico: "🧳" }
};

/* =========================================================
   特休天數試算(勞基法 §38 週年制)
   ---------------------------------------------------------
   級距:滿 6 個月 3 天、滿 1 年 7 天、滿 2 年 10 天、滿 3 年 14 天、
        滿 5 年 15 天、滿 10 年起每年加 1 天,最高 30 天。
   採「週年制」:從到職日起算,是多數個人最直覺的算法。
   ========================================================= */
const ANNUAL_TIERS = [
  { months: 6,   days: 3  },
  { months: 12,  days: 7  },
  { months: 24,  days: 10 },
  { months: 36,  days: 14 },
  { months: 48,  days: 14 },
  { months: 60,  days: 15 }
];

/** 到職滿幾個月(不足月不進位) */
export function monthsOfService(hireDate, ref = new Date()) {
  if (!hireDate) return 0;
  const h = parseYmd(hireDate);
  if (isNaN(h) || h > ref) return 0;
  let m = (ref.getFullYear() - h.getFullYear()) * 12 + (ref.getMonth() - h.getMonth());
  if (ref.getDate() < h.getDate()) m--;      // 還沒到當月的到職日 → 不算滿
  return Math.max(0, m);
}

/** 依年資算出應有特休天數 */
export function annualLeaveDays(hireDate, ref = new Date()) {
  const m = monthsOfService(hireDate, ref);
  if (m < 6) return 0;
  if (m < 60) {
    let days = 0;
    for (const t of ANNUAL_TIERS) if (m >= t.months) days = t.days;
    return days;
  }
  // 滿 5 年 15 天;滿 10 年起每滿 1 年加 1 天,上限 30
  const years = Math.floor(m / 12);
  if (years < 10) return 15;
  return Math.min(30, 15 + (years - 9));
}

/** 目前這個特休年度的起訖(週年制:到職日的週年 → 隔年前一天) */
export function annualLeaveYear(hireDate, ref = new Date()) {
  if (!hireDate) return null;
  const h = parseYmd(hireDate);
  if (isNaN(h) || h > ref) return null;
  let start = new Date(ref.getFullYear(), h.getMonth(), h.getDate());
  if (start > ref) start = new Date(ref.getFullYear() - 1, h.getMonth(), h.getDate());
  const end = addDays(new Date(start.getFullYear() + 1, start.getMonth(), start.getDate()), -1);
  return { from: ymd(start), to: ymd(end) };
}

/* =========================================================
   台灣國定假日
   ---------------------------------------------------------
   固定日期的節日用規則產生;農曆節日(春節/清明/端午/中秋)
   逐年不同,只能列表,所以先放 2026~2027,之後每年補一次即可。
   ========================================================= */
const LUNAR_HOLIDAYS = {
  2026: {
    "2026-02-16": "春節(除夕)", "2026-02-17": "春節初一", "2026-02-18": "春節初二",
    "2026-02-19": "春節初三", "2026-04-05": "清明節", "2026-06-19": "端午節",
    "2026-09-25": "中秋節"
  },
  2027: {
    "2027-02-05": "春節(除夕)", "2027-02-06": "春節初一", "2027-02-07": "春節初二",
    "2027-02-08": "春節初三", "2027-04-05": "清明節", "2027-06-09": "端午節",
    "2027-09-15": "中秋節"
  }
};

const FIXED_HOLIDAYS = {
  "01-01": "開國紀念日",
  "02-28": "和平紀念日",
  "04-04": "兒童節",
  "10-10": "國慶日"
};

/** 傳入 'YYYY-MM-DD',是國定假日則回傳名稱,否則回傳 null */
export function holidayName(dateStr) {
  const y = dateStr.slice(0, 4);
  const md = dateStr.slice(5);
  if (LUNAR_HOLIDAYS[y] && LUNAR_HOLIDAYS[y][dateStr]) return LUNAR_HOLIDAYS[y][dateStr];
  if (FIXED_HOLIDAYS[md]) return FIXED_HOLIDAYS[md];
  return null;
}

/* =========================================================
   單日工時:狀態機掃過所有事件
   ========================================================= */
export function dayStats(day, settings, nowTs = Date.now()) {
  const evs = [...(day.events || [])].sort((a, b) => a.ts - b.ts);
  let working = false, resting = false, last = 0;
  let workSec = 0, breakSec = 0;
  let firstIn = null, lastOut = null;
  let pendingOut = false;   // 已打下班卡,但當天可能還會再打上班(例如去吃午餐)

  const advance = (to) => {
    if (!last || to <= last) return;
    const span = (to - last) / 1000;
    if (working && resting) breakSec += span;              // 舊版「中午休息/休息結束」事件
    else if (working) workSec += span;
    else if (pendingOut) breakSec += span;                  // 下班 → 上班 之間的空檔自動算休息
    last = to;
  };

  for (const e of evs) {
    advance(e.ts);
    last = e.ts;
    if (e.t === "in")            { working = true; resting = false; pendingOut = false; if (firstIn === null) firstIn = e.ts; }
    else if (e.t === "out")      { working = false; resting = false; pendingOut = true; lastOut = e.ts; }
    else if (e.t === "breakStart"){ resting = true; }
    else if (e.t === "breakEnd") { resting = false; }
  }

  const open = working;                       // 還在上班中(沒打下班卡)
  const isToday = day.date === ymd(new Date());
  if (open && isToday) advance(nowTs);        // 今天且還在上班 → 即時累加到現在
  // 下班後(pendingOut)是「今天已下班」還是「等等會回來的午休」無法區分,
  // 所以不即時累加休息秒數,回來再按上班時才會一次補上那段空檔。

  // 過去的日子還開著 = 缺卡
  const missing = open && !isToday;

  // 午休自動扣除:有設定、當天完全沒有打過休息(手動或自動下班上班)、且工時夠長才扣
  let autoBreak = 0;
  const auto = Number(settings.autoBreakMin) || 0;
  if (auto > 0 && breakSec === 0 && workSec > auto * 60 + 3600) {
    autoBreak = auto * 60;
    workSec -= autoBreak;
  }

  return {
    workSec: Math.max(0, workSec),
    breakSec: breakSec + autoBreak,
    autoBreak, open, resting, missing, firstIn, lastOut,
    count: evs.length
  };
}

/* =========================================================
   單日薪資
   台灣勞基法 §24:平日延長工時前 2 小時 ×1.34,第 3 小時起 ×1.67
   ========================================================= */
export function daySalary(day, settings, nowTs = Date.now()) {
  const st = dayStats(day, settings, nowTs);
  const wage = Number(settings.wage) || 0;
  const dailySec = (Number(settings.dailyHours) || 8) * 3600;

  let normalSec = st.workSec, ot1 = 0, ot2 = 0;
  if (settings.overtime && st.workSec > dailySec) {
    normalSec = dailySec;
    const otSec = st.workSec - dailySec;
    ot1 = Math.min(otSec, 2 * 3600);
    ot2 = Math.max(0, otSec - 2 * 3600);
  }

  const normalPay = (normalSec / 3600) * wage;
  const otPay = (ot1 / 3600) * wage * 1.34 + (ot2 / 3600) * wage * 1.67;

  // 請假給薪
  let leavePay = 0, leaveSec = 0;
  if (day.leave && day.leave.type) {
    const conf = LEAVE[day.leave.type];
    leaveSec = (Number(day.leave.hours) || 0) * 3600;
    let ratio = 0;
    if (conf) {
      if (conf.ratioKey === "fixed100") ratio = 100;
      else if (conf.ratioKey) ratio = Number(settings[conf.ratioKey]) || 0;
    }
    leavePay = (leaveSec / 3600) * wage * (ratio / 100);
  }

  return {
    ...st,
    normalSec, otSec: ot1 + ot2, ot1, ot2, leaveSec,
    normalPay, otPay, leavePay,
    total: normalPay + otPay + leavePay
  };
}

/* =========================================================
   計薪週期
   ---------------------------------------------------------
   payday  模式:發薪日 P → 期間 = 上月 P 號 ~ 本月 (P-1) 號
                 (例:5 號發薪,8/5 發的是 7/5~8/4)
   monthly 模式:當月 1 號 ~ 月底,次月 P 號發放
   custom  模式:自訂結算起始日 C → C 號 ~ 次月 (C-1) 號
   ========================================================= */
export function payPeriod(settings, ref = new Date()) {
  const mode = settings.cycleMode || "payday";
  const P = Math.min(28, Math.max(1, Number(settings.payday) || 5));
  const y = ref.getFullYear(), m = ref.getMonth(), d = ref.getDate();

  let from, to;
  if (mode === "monthly") {
    from = new Date(y, m, 1);
    to = new Date(y, m, lastDayOfMonth(y, m));
  } else {
    const C = mode === "custom"
      ? Math.min(28, Math.max(1, Number(settings.cutoffStart) || P))
      : P;
    if (d >= C) { from = dayOfMonth(y, m, C);     to = addDays(dayOfMonth(y, m + 1, C), -1); }
    else        { from = dayOfMonth(y, m - 1, C); to = addDays(dayOfMonth(y, m, C), -1); }
  }

  // 發薪日 = to 之後最近的一個 P 號
  let payDate = dayOfMonth(to.getFullYear(), to.getMonth(), P);
  if (payDate <= to) payDate = dayOfMonth(to.getFullYear(), to.getMonth() + 1, P);

  return {
    from: ymd(from), to: ymd(to), payDate: ymd(payDate),
    label: `${from.getMonth() + 1}/${from.getDate()} ~ ${to.getMonth() + 1}/${to.getDate()}`
  };
}

export function prevPayPeriod(settings, ref = new Date()) {
  const cur = payPeriod(settings, ref);
  return payPeriod(settings, addDays(parseYmd(cur.from), -1));
}

export function monthRange(y, m) {
  return { from: ymd(new Date(y, m, 1)), to: ymd(new Date(y, m, lastDayOfMonth(y, m))) };
}
export function weekRange(ref = new Date()) {
  const s = addDays(ref, -ref.getDay());
  return { from: ymd(s), to: ymd(addDays(s, 6)) };
}

/* =========================================================
   區間統計
   ========================================================= */
export function summarize(days, settings, nowTs = Date.now()) {
  const acc = {
    workDays: 0, leaveDays: 0, missingDays: 0,
    workSec: 0, normalSec: 0, otSec: 0, breakSec: 0, leaveSec: 0,
    normalPay: 0, otPay: 0, leavePay: 0, total: 0,
    annualUsedDays: 0,
    rows: []
  };
  for (const day of days) {
    const s = daySalary(day, settings, nowTs);
    // 缺下班卡的日子人確實有來,一樣算出勤,只是時數要補卡後才正確
    if (s.workSec > 0 || s.missing) acc.workDays++;
    if (day.leave && day.leave.type) acc.leaveDays++;
    if (day.leave && day.leave.type === "annual") {
      acc.annualUsedDays += (Number(day.leave.hours) || 0) / (Number(settings.dailyHours) || 8);
    }
    if (s.missing) acc.missingDays++;
    acc.workSec += s.workSec; acc.normalSec += s.normalSec; acc.otSec += s.otSec;
    acc.breakSec += s.breakSec; acc.leaveSec += s.leaveSec;
    acc.normalPay += s.normalPay; acc.otPay += s.otPay; acc.leavePay += s.leavePay;
    acc.total += s.total;
    acc.rows.push({ day, s });
  }
  return acc;
}

/* =========================================================
   加班工時上限預警
   勞基法 §32:延長工時連同正常工時,每月加班不得超過 46 小時。
   ========================================================= */
export const OT_MONTHLY_CAP_HOURS = 46;

export function overtimeStatus(otSec, capHours = OT_MONTHLY_CAP_HOURS) {
  const used = otSec / 3600;
  const pct = capHours > 0 ? (used / capHours) * 100 : 0;
  let level = "ok";
  if (pct >= 100) level = "over";
  else if (pct >= 80) level = "warn";
  return { used, capHours, pct: Math.min(100, pct), remain: Math.max(0, capHours - used), level };
}

/* ---------- CSV 匯出 ---------- */
export function toCSV(summary, settings, range) {
  const L = [];
  L.push(`打卡日記匯出,${range.from} ~ ${range.to}`);
  L.push(`時薪,${settings.wage},每日約定工時,${settings.dailyHours}`);
  L.push("");
  L.push("日期,星期,上班,下班,工作時數,休息時數,正常時數,加班時數,假別,請假時數,當日工資");
  for (const { day, s } of summary.rows) {
    const d = parseYmd(day.date);
    L.push([
      day.date, WEEK[d.getDay()],
      s.firstIn ? fmtClock(s.firstIn) : "",
      s.lastOut ? fmtClock(s.lastOut) : (s.missing ? "缺卡" : ""),
      hours2(s.workSec), hours2(s.breakSec), hours2(s.normalSec), hours2(s.otSec),
      day.leave ? (LEAVE[day.leave.type]?.name || "") : "",
      day.leave ? (day.leave.hours || 0) : "",
      Math.round(s.total)
    ].join(","));
  }
  L.push("");
  L.push(`合計出勤天數,${summary.workDays}`);
  L.push(`合計工時,${hours2(summary.workSec)}`);
  L.push(`加班時數,${hours2(summary.otSec)}`);
  L.push(`正常工資,${Math.round(summary.normalPay)}`);
  L.push(`加班費,${Math.round(summary.otPay)}`);
  L.push(`請假給薪,${Math.round(summary.leavePay)}`);
  L.push(`合計,${Math.round(summary.total)}`);
  return "﻿" + L.join("\n");   // BOM,Excel 開啟不亂碼
}
