/* =========================================================
   app.js · 介面與互動
   ========================================================= */

import * as Store from "./store.js";
import * as Lock from "./lock.js";
import {
  ymd, parseYmd, addDays, pad, WEEK, EV, LEAVE,
  fmtHMS, fmtClock, fmtClock12, money, hours2,
  dayStats, daySalary, payPeriod, prevPayPeriod,
  monthRange, weekRange, summarize, toCSV,
  annualLeaveDays, annualLeaveYear, monthsOfService, holidayName,
  overtimeStatus, OT_MONTHLY_CAP_HOURS
} from "./calc.js";

const $  = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

/* ---------- 狀態 ---------- */
let S = Store.getSettings();
let today = ymd(new Date());
let calY = new Date().getFullYear();
let calM = new Date().getMonth();
let tickTimer = null;

/* ---------- 鼓勵語 ---------- */
const CHEER = {
  in:         { ico: "🌅", msgs: ["上班加油!", "今天也要順順利利 ✨", "開工囉,你可以的!", "元氣滿滿的一天 ☀️", "今天也辛苦你了 💪"] },
  out:        { ico: "🌇", msgs: ["辛苦了!", "今天也很棒 👏", "好好休息一下 🌙", "做得好,先喘口氣", "先去休息,等等再回來 💛"] },
  leave:      { ico: "🏖️", msgs: ["好好休息 🌿", "放假愉快!", "今天是屬於你的一天 ☁️"] }
};
const pick = (a) => a[Math.floor(Math.random() * a.length)];

/* =========================================================
   啟動
   ========================================================= */
Store.init({
  onSync: (t) => { const el = $("#syncState"); if (el) el.textContent = t; },
  onAuth: async ({ mode, user }) => {
    if (!mode) {                                  // 未登入 → 顯示登入頁
      $("#authScreen").classList.remove("hidden");
      $("#app").classList.add("hidden");
      clearInterval(tickTimer);
      return;
    }
    S = Store.getSettings();
    $("#authScreen").classList.add("hidden");
    $("#app").classList.remove("hidden");
    $("#acctName").textContent = user ? (user.displayName || user.email) : "本機模式(未登入)";
    await bootData();
    maybeLock();
  }
});

async function bootData() {
  today = ymd(new Date());
  const p = payPeriod(S);
  const m = monthRange(calY, calM);
  const from = [p.from, m.from, today].sort()[0];
  const to   = [p.to, m.to, today].sort().reverse()[0];
  await Store.fetchRange(from, to);

  bindSettingsUI();
  renderJobUI();
  startTick();
  renderHome();
  renderTodayRecords();
  await renderQuota();
  checkMissing();
  scheduleReminder();
}

/* =========================================================
   登入 / 註冊 / 忘記密碼
   ---------------------------------------------------------
   帳號可自由命名(不用是 email),忘記密碼要靠註冊時選填的
   電子郵件才能寄重設信;沒填的話只能牢記密碼。
   ========================================================= */
function setAuthMode(m) {
  const reset = m === "reset";
  $("#authActionsNormal").classList.toggle("hidden", reset);
  $("#authActionsReset").classList.toggle("hidden", !reset);
  $("#authPassField").classList.toggle("hidden", reset);
  $("#authRecoveryField").classList.toggle("hidden", reset);
  $("#btnForgot").classList.toggle("hidden", reset);
  $("#btnBackToLogin").classList.toggle("hidden", !reset);
  authMsg("");
}
$("#btnForgot").onclick = () => setAuthMode("reset");
$("#btnBackToLogin").onclick = () => setAuthMode("normal");

$("#btnLogin").onclick = async () => {
  const acc = $("#authAccount").value.trim(), p = $("#authPass").value;
  if (!acc || !p) return authMsg("請輸入帳號與密碼");
  authMsg("登入中…");
  try { await Store.login(acc, p); } catch (err) { authMsg(friendlyErr(err)); }
};
$("#btnRegister").onclick = async () => {
  const acc = $("#authAccount").value.trim(), p = $("#authPass").value;
  const recovery = $("#authRecovery").value.trim();
  if (!/^[A-Za-z0-9_]{4,20}$/.test(acc)) return authMsg("帳號請用 4~20 碼英數字或底線");
  if (p.length < 6) return authMsg("密碼至少 6 碼");
  if (recovery && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recovery)) return authMsg("電子郵件格式不正確");
  authMsg("建立帳號中…");
  try { await Store.register(acc, p, recovery); } catch (err) { authMsg(friendlyErr(err)); }
};
$("#btnSendReset").onclick = async () => {
  const acc = $("#authAccount").value.trim();
  if (!acc) return authMsg("請輸入帳號");
  authMsg("寄送中…");
  try {
    await Store.sendReset(acc);
    authMsg("已寄出重設信,請至信箱查收(記得看一下垃圾郵件匣)");
  } catch (err) { authMsg(friendlyErr(err)); }
};
$("#btnLocalMode").onclick = () => Store.useLocal();
$("#btnLogout").onclick = async () => { if (confirm("確定要登出嗎?")) await Store.logout(); };

const authMsg = (t) => { $("#authMsg").textContent = t; };
function friendlyErr(err) {
  const m = String(err.code || err.message);
  if (m.includes("invalid-credential") || m.includes("wrong-password")) return "帳號或密碼不正確";
  if (m.includes("account/username-taken")) return "這個帳號名稱已經被使用,請換一個";
  if (m.includes("account/no-recovery-email")) return "這個帳號沒有設定電子郵件,無法寄送重設信,請牢記密碼";
  if (m.includes("account/not-found") || m.includes("user-not-found")) return "查無此帳號,請先註冊";
  if (m.includes("email-already-in-use")) return "這組電子郵件已經被使用,請直接登入或換一組";
  if (m.includes("invalid-email")) return "電子郵件格式不正確";
  if (m.includes("weak-password")) return "密碼太簡單,至少 6 碼";
  if (m.includes("network")) return "網路連線異常,請稍後再試";
  return "發生錯誤:" + m;
}

/* =========================================================
   計時器
   ========================================================= */
function startTick() {
  clearInterval(tickTimer);
  tickTimer = setInterval(() => {
    const now = new Date();
    $("#liveClock").textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    $("#todayLabel").textContent = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 星期${WEEK[now.getDay()]}`;
    if (ymd(now) !== today) { today = ymd(now); renderHome(); }   // 跨日自動換日
    const d = Store.getDayCached(today);
    const st = dayStats(d, S);
    if (st.open) liveNumbers(d);
  }, 1000);
}

function liveNumbers(day) {
  const s = daySalary(day, S);
  $("#todayWorked").textContent = fmtHMS(s.workSec);
  $("#todayPay").textContent = money(s.total);
  const target = (Number(S.dailyHours) || 8) * 3600;
  $("#todayBar").style.width = Math.min(100, (s.workSec / target) * 100) + "%";
  $("#todayBreakLine").textContent =
    `休息 ${fmtHMS(s.breakSec)} ‧ ` +
    (s.open ? "工作中…" : (s.count ? "今日已下班" : "尚未打卡"));
}

/* =========================================================
   打卡動作
   ========================================================= */
async function punch(type, ripEl) {
  const day = { ...Store.getDayCached(today) };
  day.events = [...(day.events || [])];
  const st = dayStats(day, S);

  // 防呆
  if (type === "in" && st.open) return toast("已經在上班中囉");
  if (type === "out" && !st.open) return toast("還沒打上班卡,請先按上班或使用補卡");

  const ts = Date.now();
  const ev = { t: type, ts, manual: false };
  day.events.push(ev);
  day.date = today;
  Store.saveDay(day);

  if (S.vibrate && navigator.vibrate) navigator.vibrate(type === "out" ? [18, 40, 18] : 22);
  cheer(type, ts);
  refreshAll();

  if (S.geo && navigator.geolocation) {              // 位置非同步補上,不卡住打卡
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const d2 = { ...Store.getDayCached(today) };
        const target = (d2.events || []).find(x => x.ts === ts);
        if (target) {
          target.geo = { lat: +pos.coords.latitude.toFixed(5), lng: +pos.coords.longitude.toFixed(5) };
          Store.saveDay(d2);
          refreshAll();
        }
      },
      () => {}, { timeout: 8000, maximumAge: 60000 }
    );
  }
}

$("#actIn").onclick         = (e) => { ripple(e); punch("in"); };
$("#actOut").onclick        = (e) => { ripple(e); punch("out"); };
$("#actLeave").onclick      = (e) => { ripple(e); openLeave(today); };
$("#actFix").onclick        = (e) => { ripple(e); openFix(today); };

/* =========================================================
   首頁渲染
   ========================================================= */
function renderHome() {
  const day = Store.getDayCached(today);
  const s = daySalary(day, S);

  liveNumbers(day);
  if (!s.open) {
    $("#todayWorked").textContent = fmtHMS(s.workSec);
    $("#todayPay").textContent = money(s.total);
  }

  // 狀態膠囊
  const pill = $("#statusPill");
  pill.className = "status-pill";
  if (day.leave && day.leave.type && s.workSec === 0) { pill.textContent = LEAVE[day.leave.type].name; pill.classList.add("rest"); }
  else if (s.open)    { pill.textContent = "工作中"; pill.classList.add("on"); }
  else if (s.count)   { pill.textContent = "已下班"; }
  else                { pill.textContent = "未上班"; }

  // 按鈕狀態
  const set = (id, on, pulse = false) => {
    const el = $(id);
    el.disabled = !on;
    el.classList.toggle("pulse", on && pulse);
  };
  set("#actIn", !s.open, !s.open);
  set("#actOut", s.open, s.open);
}

/* 今日打卡紀錄(顯示在「紀錄」分頁最上方) */
function renderTodayRecords() {
  const day = Store.getDayCached(today);
  $("#todayCount").textContent = `${(day.events || []).length} 筆`;
  renderTimeline($("#todayTimeline"), day, false);
}

function renderTimeline(ul, day, editable) {
  const evs = [...(day.events || [])].sort((a, b) => a.ts - b.ts);
  if (!evs.length) { ul.innerHTML = `<li class="empty">還沒有打卡紀錄</li>`; return; }
  ul.innerHTML = evs.map((e, i) => {
    const c = EV[e.t] || { name: e.t, ico: "•" };
    const geo = e.geo ? ` ‧ 📍${e.geo.lat},${e.geo.lng}` : "";
    const note = e.note ? ` ‧ ${escapeHtml(e.note)}` : "";
    return `<li class="tl-item">
      <span class="tl-ico">${c.ico}</span>
      <span class="tl-main">
        <span class="tl-name">${c.name}${e.manual ? '<span class="tl-badge">補</span>' : ""}</span>
        <span class="tl-meta">${fmtClock12(e.ts)}${geo}${note}</span>
      </span>
      <span class="tl-time">${fmtClock(e.ts)}</span>
      ${editable ? `<button class="tl-del" data-del="${i}" title="刪除">✕</button>` : ""}
    </li>`;
  }).join("");

  if (editable) {
    ul.querySelectorAll("[data-del]").forEach(btn => {
      btn.onclick = () => {
        const i = +btn.dataset.del;
        const d = { ...day, events: [...day.events].sort((a, b) => a.ts - b.ts) };
        d.events.splice(i, 1);
        Store.saveDay(d);
        toast("已刪除該筆紀錄");
        openDay(day.date);
        refreshAll();
      };
    });
  }
}

/* =========================================================
   查詢紀錄(紀錄分頁 / 薪資分頁 各自獨立的查詢區間)
   ========================================================= */
const queryState = { records: null, pay: null };   // { range, summary }

function wireChipGroup(target, fromSel, toSel) {
  const chips = $$(`[data-chipgroup="${target}"] .chip`);
  chips.forEach(c => c.onclick = () => {
    chips.forEach(x => x.classList.remove("chip-on"));
    c.classList.add("chip-on");
    const r = c.dataset.range;
    $(`[data-customgroup="${target}"]`).classList.toggle("hidden", r !== "custom");
    if (r === "custom") {
      if (!$(fromSel).value) {
        const p = payPeriod(S);
        $(fromSel).value = p.from; $(toSel).value = p.to;
      }
      return;
    }
    let range;
    if (r === "period") range = payPeriod(S);
    else if (r === "prev") range = prevPayPeriod(S);
    else if (r === "month") { const n = new Date(); range = monthRange(n.getFullYear(), n.getMonth()); }
    else range = weekRange();
    runQuery(target, range);
  });
}
wireChipGroup("records", "#qFrom", "#qTo");
wireChipGroup("pay", "#qFromPay", "#qToPay");

$("#qGo").onclick = () => {
  const f = $("#qFrom").value, t = $("#qTo").value;
  if (!f || !t) return toast("請選擇起訖日期");
  if (f > t) return toast("結束日不能早於起始日");
  runQuery("records", { from: f, to: t, label: `${f} ~ ${t}` });
};
$("#qGoPay").onclick = () => {
  const f = $("#qFromPay").value, t = $("#qToPay").value;
  if (!f || !t) return toast("請選擇起訖日期");
  if (f > t) return toast("結束日不能早於起始日");
  runQuery("pay", { from: f, to: t, label: `${f} ~ ${t}` });
};

async function runQuery(target, range) {
  const days = await Store.fetchRange(range.from, range.to);
  const sum = summarize(days, S);
  queryState[target] = { range, summary: sum };

  if (target === "records") {
    $("#rCount").textContent = `${sum.rows.length} 天`;
    const ul = $("#recordList");
    if (!sum.rows.length) { ul.innerHTML = `<li class="empty">這個區間還沒有紀錄</li>`; return; }
    ul.innerHTML = sum.rows.slice().reverse().map(({ day, s }) => {
      const d = parseYmd(day.date);
      const lv = day.leave && day.leave.type ? LEAVE[day.leave.type] : null;
      const title = lv && s.workSec === 0
        ? `${lv.ico} ${lv.name}`
        : `${s.firstIn ? fmtClock(s.firstIn) : "—"} → ${s.lastOut ? fmtClock(s.lastOut) : (s.missing ? "缺卡" : "進行中")}`;
      const sub = [
        s.breakSec ? `休息 ${hours2(s.breakSec)}h` : "",
        s.otSec ? `加班 ${hours2(s.otSec)}h` : "",
        day.note ? `📝 ${day.note.replace(/\n/g, " ")}` : ""
      ].filter(Boolean).join(" ‧ ") || "—";
      return `<li class="rec-item ${s.missing ? "rec-warn" : ""}" data-date="${day.date}">
        <span class="rec-date"><span class="rec-d">${d.getDate()}</span><span class="rec-w">${WEEK[d.getDay()]}</span></span>
        <span class="rec-main"><span class="rec-title">${title}</span><span class="rec-sub">${escapeHtml(sub)}</span></span>
        <span class="rec-right"><span class="rec-h">${hours2(s.workSec)}h</span><span class="rec-p">${money(s.total)}</span></span>
      </li>`;
    }).join("");
    ul.querySelectorAll(".rec-item").forEach(li => li.onclick = () => openDay(li.dataset.date));
  } else {
    $("#rRangeTag").textContent = range.label || `${range.from} ~ ${range.to}`;
    $("#rDays").textContent = sum.workDays;
    $("#rLeave").textContent = sum.leaveDays;
    $("#rNormal").textContent = hours2(sum.normalSec);
    $("#rOt").textContent = hours2(sum.otSec);
    $("#rBreak").textContent = hours2(sum.breakSec);
    $("#rPay").textContent = money(sum.total);
    $("#rPayNormal").textContent = money(sum.normalPay);
    $("#rPayOt").textContent = money(sum.otPay);
    $("#rPayLeave").textContent = money(sum.leavePay);
  }
}

$("#btnExport").onclick = () => {
  const q = queryState.pay;
  if (!q) return toast("請先查詢一個區間");
  const csv = toCSV(q.summary, S, q.range);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `打卡紀錄_${q.range.from}_${q.range.to}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  toast("已匯出 CSV");
};

/* =========================================================
   小日曆
   ========================================================= */
function buildCalSelects() {
  const y = new Date().getFullYear();
  $("#calYear").innerHTML = Array.from({ length: 7 }, (_, i) => y - 3 + i)
    .map(v => `<option value="${v}">${v} 年</option>`).join("");
  $("#calMonth").innerHTML = Array.from({ length: 12 }, (_, i) => i)
    .map(v => `<option value="${v}">${v + 1} 月</option>`).join("");
}
buildCalSelects();

$("#calYear").onchange  = () => { calY = +$("#calYear").value; renderCalendar(); };
$("#calMonth").onchange = () => { calM = +$("#calMonth").value; renderCalendar(); };
$("#calPrev").onclick = () => { calM--; if (calM < 0) { calM = 11; calY--; } renderCalendar(); };
$("#calNext").onclick = () => { calM++; if (calM > 11) { calM = 0; calY++; } renderCalendar(); };

async function renderCalendar() {
  $("#calYear").value = calY; $("#calMonth").value = calM;
  const r = monthRange(calY, calM);
  const days = await Store.fetchRange(r.from, r.to);
  const map = new Map(days.map(d => [d.date, d]));
  const sum = summarize(days, S);

  const first = new Date(calY, calM, 1);
  const start = addDays(first, -first.getDay());
  let html = "";
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    const key = ymd(d);
    const inMonth = d.getMonth() === calM;
    const rec = map.get(key);
    const s = rec ? daySalary(rec, S) : null;
    const hol = holidayName(key);
    const cls = ["cal-cell"];
    if (!inMonth) cls.push("mute");
    if (key === ymd(new Date())) cls.push("today");
    if (s && s.missing) cls.push("has-warn");
    else if (s && s.workSec > 0) cls.push("has-work");
    else if (rec && rec.leave && rec.leave.type) cls.push("has-leave");
    else if (hol) cls.push("has-holiday");

    const dots = [];
    if (s && s.workSec > 0) dots.push("dot-work");
    if (rec && rec.leave && rec.leave.type) dots.push("dot-leave");
    if (rec && rec.note) dots.push("dot-note");
    if (s && s.missing) dots.push("dot-warn");

    html += `<div class="${cls.join(" ")}" data-date="${key}"${hol ? ` title="${hol}"` : ""}>
      <span class="cal-num">${d.getDate()}</span>
      ${s && s.workSec > 0
        ? `<span class="cal-hrs">${hours2(s.workSec)}h</span>`
        : (hol ? `<span class="cal-hol">${hol.length > 3 ? hol.slice(0, 3) : hol}</span>` : "")}
      <span class="cal-dots">${dots.map(x => `<i class="dot ${x}"></i>`).join("")}</span>
    </div>`;
  }
  $("#calGrid").innerHTML = html;
  $("#calGrid").querySelectorAll(".cal-cell").forEach(c => c.onclick = () => openDay(c.dataset.date));

  $("#calMonthTag").textContent = `${calY} / ${calM + 1}`;
  $("#cDays").textContent = sum.workDays;
  $("#cHours").textContent = hours2(sum.workSec);
  $("#cNotes").textContent = days.filter(d => d.note).length;
  $("#cPay").textContent = money(sum.total);
}

/* =========================================================
   Sheets
   ========================================================= */
const openSheet  = (id) => $(id).classList.add("open");
const closeSheet = (id) => $(id).classList.remove("open");
$$("[data-close]").forEach(el => el.onclick = () => el.closest(".sheet").classList.remove("open"));

/* ---- 補卡 ---- */
function openFix(date, type) {
  $("#fixDate").value = date || today;
  if (type) $("#fixType").value = type;
  const n = new Date();
  $("#fixH").value = pad(n.getHours());
  $("#fixM").value = pad(n.getMinutes());
  $("#fixS").value = "00";
  $("#fixNote").value = "";
  openSheet("#sheetFix");
}
$("#fixSave").onclick = async () => {
  const date = $("#fixDate").value;
  if (!date) return toast("請選擇日期");
  const h = +$("#fixH").value, m = +$("#fixM").value, s = +$("#fixS").value || 0;
  if (isNaN(h) || h < 0 || h > 23 || isNaN(m) || m < 0 || m > 59 || s < 0 || s > 59)
    return toast("時間格式不正確");

  const d0 = parseYmd(date);
  d0.setHours(h, m, s, 0);
  const day = { ...(await Store.fetchDay(date)) };
  day.date = date;
  day.events = [...(day.events || []), {
    t: $("#fixType").value, ts: d0.getTime(), manual: true, note: $("#fixNote").value.trim()
  }].sort((a, b) => a.ts - b.ts);
  Store.saveDay(day);
  closeSheet("#sheetFix");
  toast(`已補登 ${date} ${pad(h)}:${pad(m)}:${pad(s)}`);
  refreshAll(date);
};

/* ---- 請假 ---- */
function openLeave(date) {
  $("#lvDate").value = date || today;
  const d = Store.getDayCached(date || today);
  $("#lvType").value = d.leave?.type || "off";
  $("#lvHours").value = d.leave?.hours ?? (Number(S.dailyHours) || 8);
  $("#lvNote").value = d.leave?.note || "";
  openSheet("#sheetLeave");
}
$("#lvSave").onclick = async () => {
  const date = $("#lvDate").value;
  if (!date) return toast("請選擇日期");
  const day = { ...(await Store.fetchDay(date)) };
  day.date = date;
  day.leave = {
    type: $("#lvType").value,
    hours: Number($("#lvHours").value) || 0,
    note: $("#lvNote").value.trim()
  };
  Store.saveDay(day);
  closeSheet("#sheetLeave");
  cheer("leave", Date.now());
  refreshAll(date);
};
$("#lvClear").onclick = async () => {
  const date = $("#lvDate").value;
  const day = { ...(await Store.fetchDay(date)) };
  day.date = date; day.leave = null;
  Store.saveDay(day);
  closeSheet("#sheetLeave");
  toast("已清除該日假別");
  refreshAll(date);
};

/* ---- 單日詳情 ---- */
let daySheetDate = null;
async function openDay(date) {
  daySheetDate = date;
  const day = await Store.fetchDay(date);
  const s = daySalary(day, S);
  const d = parseYmd(date);
  const hol = holidayName(date);
  $("#dayTitle").textContent =
    `${d.getMonth() + 1} 月 ${d.getDate()} 日 (${WEEK[d.getDay()]})` + (hol ? ` ‧ ${hol}` : "");

  const chips = [
    hol ? `<span class="day-chip">🎌 ${hol}</span>` : "",
    `<span class="day-chip">工時 <b>${fmtHMS(s.workSec)}</b></span>`,
    `<span class="day-chip">休息 <b>${fmtHMS(s.breakSec)}</b></span>`,
    s.otSec ? `<span class="day-chip">加班 <b>${hours2(s.otSec)}h</b></span>` : "",
    `<span class="day-chip">工資 <b>${money(s.total)}</b></span>`,
    day.leave?.type ? `<span class="day-chip">${LEAVE[day.leave.type].ico} ${LEAVE[day.leave.type].name} <b>${day.leave.hours}h</b></span>` : "",
    s.missing ? `<span class="day-chip" style="color:var(--terra-deep)">⚠ 缺下班卡</span>` : ""
  ].filter(Boolean).join("");
  $("#dayStat").innerHTML = chips;

  renderTimeline($("#dayTimeline"), day, true);
  $("#dayNote").value = day.note || "";
  openSheet("#sheetDay");
}
$("#dayNoteSave").onclick = async () => {
  const day = { ...(await Store.fetchDay(daySheetDate)) };
  day.date = daySheetDate;
  day.note = $("#dayNote").value.trim();
  Store.saveDay(day);
  closeSheet("#sheetDay");
  toast("記事已儲存 📝");
  refreshAll(daySheetDate);
};
$("#dayFix").onclick   = () => { closeSheet("#sheetDay"); openFix(daySheetDate); };
$("#dayLeave").onclick = () => { closeSheet("#sheetDay"); openLeave(daySheetDate); };

async function refreshAll() {
  renderHome();
  renderTodayRecords();
  await renderQuota();
  if ($("#view-calendar").classList.contains("active")) await renderCalendar();
  if ($("#view-records").classList.contains("active")) await runQuery("records", queryState.records?.range || payPeriod(S));
  if ($("#view-pay").classList.contains("active")) {
    await runQuery("pay", queryState.pay?.range || payPeriod(S));
    await renderTrend();
  }
}

/* =========================================================
   分頁切換
   ========================================================= */
function switchView(name) {
  $$(".view").forEach(v => v.classList.remove("active"));
  $(`#view-${name}`).classList.add("active");
  $$(".tab").forEach(t => t.classList.toggle("tab-on", t.dataset.view === name));
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (name === "calendar") renderCalendar();
  if (name === "records") runQuery("records", queryState.records?.range || payPeriod(S));
  if (name === "pay") {
    runQuery("pay", queryState.pay?.range || payPeriod(S)).then(renderTrend);
  }
  if (name === "settings") { updateCyclePreview(); syncLockUI(); }
}
$$(".tab").forEach(t => t.onclick = () => switchView(t.dataset.view));

/* =========================================================
   設定
   ========================================================= */
const SET_MAP = [
  ["#setJobName", "name", "text"],
  ["#setWage", "wage", "number"], ["#setDaily", "dailyHours", "number"],
  ["#setHire", "hireDate", "text"],
  ["#setBreak", "autoBreakMin", "number"], ["#setOt", "overtime", "bool"],
  ["#setOtCap", "otCapHours", "number"],
  ["#setCycle", "cycleMode", "text"], ["#setPayday", "payday", "number"],
  ["#setCutoff", "cutoffStart", "number"],
  ["#lvAnnual", "leaveAnnual", "number"], ["#lvSick", "leaveSick", "number"],
  ["#lvPersonal", "leavePersonal", "number"],
  ["#setGeo", "geo", "bool"], ["#setVibe", "vibrate", "bool"], ["#setWarn", "warnMissing", "bool"],
  ["#setRemind", "remindEnabled", "bool"], ["#setRemindTime", "remindTime", "text"]
];

function bindSettingsUI() {
  S = Store.getSettings();
  SET_MAP.forEach(([sel, key, type]) => {
    const el = $(sel);
    if (type === "bool") el.checked = !!S[key]; else el.value = S[key];
    el.onchange = async () => {
      const v = type === "bool" ? el.checked : (type === "number" ? Number(el.value) : el.value);
      Store.saveSettings({ [key]: v });
      S = Store.getSettings();
      updateCyclePreview();
      if (key === "name") renderJobUI();
      if (key === "remindEnabled" || key === "remindTime") scheduleReminder();
      await refreshAll();
      toast("設定已儲存");
    };
  });
  updateCyclePreview();
  syncLockUI();
}

function updateCyclePreview() {
  $("#cutoffField").classList.toggle("hidden", S.cycleMode !== "custom");
  $("#remindTimeField").classList.toggle("hidden", !S.remindEnabled);
  const p = payPeriod(S), prev = prevPayPeriod(S);
  $("#cyclePreview").innerHTML =
    `<b>本期</b>:${p.from} ~ ${p.to} → ${p.payDate} 發薪<br>` +
    `<b>上期</b>:${prev.from} ~ ${prev.to} → ${prev.payDate} 發薪<br>` +
    `<span style="color:var(--ink-faint)">依勞動部指導原則,工資計算週期不得超過一個月,且應於週期屆滿後 15 日內發放。</span>`;
}

/* =========================================================
   缺卡提醒
   ========================================================= */
async function checkMissing() {
  if (!S.warnMissing) return;
  const to = ymd(addDays(new Date(), -1));
  const from = ymd(addDays(new Date(), -14));
  const days = await Store.fetchRange(from, to);
  const bad = days.filter(d => dayStats(d, S).missing);
  if (bad.length) {
    setTimeout(() => toast(`⚠ 有 ${bad.length} 天忘了打下班卡,記得補卡喔`), 1400);
  }
}

/* =========================================================
   特效
   ========================================================= */
function cheer(type, ts) {
  const c = CHEER[type] || CHEER.in;
  $("#cheerIco").textContent = c.ico;
  $("#cheerMsg").textContent = pick(c.msgs);
  $("#cheerTime").textContent = fmtClock12(ts);
  const box = $("#cheer");
  box.classList.add("show");
  spawnParticles(type === "out" || type === "leave" ? 26 : 18);
  clearTimeout(cheer._t);
  cheer._t = setTimeout(() => box.classList.remove("show"), 1900);
}

const PT_COLORS = ["#C98358", "#93A57F", "#BC9E7E", "#D6C0A6", "#B9CBD1", "#C98C8C"];
function spawnParticles(n) {
  const wrap = $("#cheerParticles");
  wrap.innerHTML = "";
  const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
  for (let i = 0; i < n; i++) {
    const el = document.createElement("i");
    el.className = "pt";
    const size = 6 + Math.random() * 12;
    const ang = Math.random() * Math.PI * 2;
    const dist = 90 + Math.random() * 190;
    el.style.cssText =
      `width:${size}px;height:${size}px;left:${cx}px;top:${cy}px;` +
      `background:${PT_COLORS[i % PT_COLORS.length]};` +
      `--dx:${Math.cos(ang) * dist}px;--dy:${Math.sin(ang) * dist - 60}px;` +
      `animation-delay:${Math.random() * 220}ms`;
    wrap.appendChild(el);
  }
  setTimeout(() => { wrap.innerHTML = ""; }, 2000);
}

function ripple(e) {
  const el = e.currentTarget;
  if (!el || el.disabled) return;
  const r = el.getBoundingClientRect();
  const size = Math.max(r.width, r.height);
  const s = document.createElement("span");
  s.className = "ripple";
  s.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
  el.appendChild(s);
  setTimeout(() => s.remove(), 650);
}

let toastTimer = null;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

/* =========================================================
   PWA
   ========================================================= */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
}

/* =========================================================
   工作(多雇主)
   ========================================================= */
const JOB_ICONS = ["💼", "🏪", "☕", "🍜", "🎬", "🖥️", "🎨", "📚"];
const jobIcon = (id) => {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return JOB_ICONS[h % JOB_ICONS.length];
};

function renderJobUI() {
  const jobs = Store.getJobs();
  const active = Store.getActiveJob();
  $("#jobName").textContent = active.name || "我的工作";
  // 只有一份工作時不顯示切換鈕,畫面比較乾淨
  $("#jobSwitch").classList.toggle("hidden", jobs.length < 2);
  renderJobList($("#jobList"), true);
}

function renderJobList(ul, withDelete) {
  const jobs = Store.getJobs();
  const activeId = Store.getActiveJobId();
  ul.innerHTML = jobs.map(j => `
    <li class="job-item" data-job="${j.id}">
      <span class="job-dot">${jobIcon(j.id)}</span>
      <span class="job-main">
        <span class="job-nm">${escapeHtml(j.name || "未命名")}</span>
        <span class="job-sub">時薪 ${money(j.wage)} ‧ ${j.payday} 號發薪</span>
      </span>
      ${j.id === activeId ? '<span class="job-on">使用中</span>' : ""}
      ${withDelete && jobs.length > 1 && j.id !== activeId
        ? `<button class="job-del" data-deljob="${j.id}" title="刪除">✕</button>` : ""}
    </li>`).join("");

  ul.querySelectorAll(".job-item").forEach(li => li.onclick = async (e) => {
    if (e.target.dataset.deljob) return;
    const id = li.dataset.job;
    if (id === Store.getActiveJobId()) return;
    await Store.switchJob(id);
    S = Store.getSettings();
    closeSheet("#sheetJob");
    bindSettingsUI(); renderJobUI();
    await refreshAll();
    toast(`已切換到「${Store.getActiveJob().name}」`);
  });

  ul.querySelectorAll("[data-deljob]").forEach(btn => btn.onclick = async (e) => {
    e.stopPropagation();
    const id = btn.dataset.deljob;
    const job = Store.getJobs().find(j => j.id === id);
    if (!confirm(`確定要刪除「${job.name}」嗎?\n這份工作的所有打卡紀錄都會一起刪除,無法復原。`)) return;
    try {
      await Store.deleteJob(id);
      renderJobUI();
      toast("已刪除該份工作");
    } catch (err) { toast(err.message); }
  });
}

$("#jobSwitch").onclick = () => { renderJobList($("#jobPicker"), false); openSheet("#sheetJob"); };
$("#btnAddJob").onclick = addJob;
$("#jobAddFromSheet").onclick = () => { closeSheet("#sheetJob"); addJob(); };

async function addJob() {
  const name = prompt("新工作的名稱?", "新工作");
  if (name === null) return;
  await Store.createJob({ name: name.trim() || "新工作" });
  S = Store.getSettings();
  bindSettingsUI(); renderJobUI();
  await refreshAll();
  toast(`已新增「${Store.getActiveJob().name}」,記得去設定時薪`);
}

/* =========================================================
   特休 / 加班上限
   ========================================================= */
async function renderQuota() {
  // --- 特休 ---
  const hire = S.hireDate;
  const total = annualLeaveDays(hire);
  const yr = annualLeaveYear(hire);
  if (!hire || !yr) {
    $("#annualLeft").textContent = "—";
    $("#annualSub").textContent = "設定到職日後自動計算";
  } else {
    const days = await Store.fetchRange(yr.from, yr.to);
    const used = summarize(days, S).annualUsedDays;
    const left = Math.max(0, total - used);
    $("#annualLeft").innerHTML = `${(+left.toFixed(1))}<small> / ${total} 天</small>`;
    const m = monthsOfService(hire);
    $("#annualSub").textContent = total === 0
      ? `年資 ${m} 個月,滿 6 個月才有特休`
      : `年資 ${Math.floor(m / 12)} 年 ${m % 12} 個月 ‧ 已用 ${(+used.toFixed(1))} 天`;
  }

  // --- 本月加班 ---
  const now = new Date();
  const mr = monthRange(now.getFullYear(), now.getMonth());
  const mDays = await Store.fetchRange(mr.from, mr.to);
  const otSec = summarize(mDays, S).otSec;
  const cap = Number(S.otCapHours) || OT_MONTHLY_CAP_HOURS;
  const st = overtimeStatus(otSec, cap);

  $("#otUsed").innerHTML = `${st.used.toFixed(1)}<small>h</small>`;
  $("#otSub").textContent = `上限 ${cap}h ‧ 剩 ${st.remain.toFixed(1)}h`;
  const bar = $("#otBar");
  bar.style.width = st.pct + "%";
  bar.className = "quota-bar-fill" + (st.level === "ok" ? "" : " " + st.level);

  const warn = $("#otWarn");
  if (st.level === "over") {
    warn.textContent = `⚠️ 本月加班已達 ${st.used.toFixed(1)} 小時,超過勞基法 §32 每月 ${cap} 小時上限`;
    warn.classList.remove("hidden");
  } else if (st.level === "warn") {
    warn.textContent = `注意:本月加班已用 ${st.pct.toFixed(0)}%,只剩 ${st.remain.toFixed(1)} 小時額度`;
    warn.classList.remove("hidden");
  } else {
    warn.classList.add("hidden");
  }
}

/* =========================================================
   趨勢圖(純 SVG,不用外部套件)
   ========================================================= */
let trendMode = "month";
$$("[data-trend]").forEach(c => c.onclick = () => {
  $$("[data-trend]").forEach(x => x.classList.remove("chip-on"));
  c.classList.add("chip-on");
  trendMode = c.dataset.trend;
  renderTrend();
});

async function renderTrend() {
  const now = new Date();
  const buckets = [];

  if (trendMode === "month") {
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const r = monthRange(d.getFullYear(), d.getMonth());
      buckets.push({ label: `${d.getMonth() + 1}月`, ...r });
    }
  } else {
    for (let i = 7; i >= 0; i--) {
      const ref = addDays(now, -i * 7);
      const r = weekRange(ref);
      const s = parseYmd(r.from);
      buckets.push({ label: `${s.getMonth() + 1}/${s.getDate()}`, ...r });
    }
  }

  for (const b of buckets) {
    const days = await Store.fetchRange(b.from, b.to);
    const sum = summarize(days, S);
    b.hours = sum.workSec / 3600;
    b.pay = sum.total;
  }

  const maxH = Math.max(1, ...buckets.map(b => b.hours));
  const maxP = Math.max(1, ...buckets.map(b => b.pay));

  const W = 100 * buckets.length, H = 190, PAD_B = 34, PAD_T = 22;
  const bw = 100, gap = 14, barW = (bw - gap * 2) / 2;

  const bars = buckets.map((b, i) => {
    const x = i * bw + gap;
    const hH = ((H - PAD_B - PAD_T) * b.hours) / maxH;
    const pH = ((H - PAD_B - PAD_T) * b.pay) / maxP;
    const hasData = b.hours > 0 || b.pay > 0;
    return `
      <g>
        <rect x="${x}" y="${H - PAD_B - hH}" width="${barW}" height="${Math.max(hH, hasData ? 2 : 0)}"
              rx="4" fill="var(--sage-deep)" opacity=".85"/>
        <rect x="${x + barW + 5}" y="${H - PAD_B - pH}" width="${barW}" height="${Math.max(pH, hasData ? 2 : 0)}"
              rx="4" fill="var(--terra)" opacity=".85"/>
        <text x="${x + barW + 2}" y="${H - PAD_B + 15}" text-anchor="middle"
              font-size="11" fill="var(--ink-soft)">${b.label}</text>
        ${b.hours > 0 ? `<text x="${x + barW + 2}" y="${H - PAD_B - Math.max(hH, pH) - 6}"
              text-anchor="middle" font-size="10" fill="var(--ink-faint)">${b.hours.toFixed(0)}h</text>` : ""}
      </g>`;
  }).join("");

  $("#trendChart").innerHTML =
    `<svg class="trend-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMinYMid meet" role="img"
          aria-label="工時與收入趨勢圖">
       <line x1="0" y1="${H - PAD_B}" x2="${W}" y2="${H - PAD_B}" stroke="rgba(122,96,71,.18)" stroke-width="1"/>
       ${bars}
     </svg>`;

  const totalPay = buckets.reduce((s, b) => s + b.pay, 0);
  const totalH = buckets.reduce((s, b) => s + b.hours, 0);
  const active = buckets.filter(b => b.hours > 0).length;
  $("#trendSummary").innerHTML = active
    ? `合計 <b>${totalH.toFixed(1)}</b> 小時 ‧ <b>${money(totalPay)}</b><br>` +
      `平均每${trendMode === "month" ? "月" : "週"} ${(totalH / active).toFixed(1)} 小時 ‧ ${money(totalPay / active)}`
    : "這段期間還沒有紀錄";
}

/* =========================================================
   薪資單(列印 / 存成 PDF)
   ========================================================= */
$("#btnPayslip").onclick = () => {
  const q = queryState.pay;
  if (!q || !q.summary.rows.length) return toast("請先查詢一個有紀錄的區間");
  buildPayslip(q.range, q.summary);
  $("#payslip").classList.add("open");
};
$("#psClose").onclick = () => $("#payslip").classList.remove("open");
$("#psPrint").onclick = () => window.print();

function buildPayslip(range, sum) {
  const job = Store.getActiveJob();
  $("#psJob").textContent = `${job.name} ‧ 時薪 ${money(job.wage)}`;
  $("#psPeriod").textContent = `計薪期間 ${range.from} ~ ${range.to}`;
  const p = payPeriod(S);
  $("#psPayDate").textContent = range.from === p.from ? `預計發薪日 ${p.payDate}` : "";

  const cap = Number(S.otCapHours) || OT_MONTHLY_CAP_HOURS;
  const rows = [
    ["出勤天數", `${sum.workDays} 天`],
    ["請假天數", `${sum.leaveDays} 天`],
    ["正常工時", `${hours2(sum.normalSec)} 小時`],
    ["加班工時", `${hours2(sum.otSec)} 小時${sum.otSec / 3600 > cap ? "(超過每月上限)" : ""}`],
    ["休息扣除", `${hours2(sum.breakSec)} 小時`],
    ["正常工資", money(sum.normalPay)],
    ["加班費", money(sum.otPay)],
    ["假日 / 特休給薪", money(sum.leavePay)]
  ];
  $("#psSummary").innerHTML = rows
    .map(([k, v]) => `<tr><td class="ps-k">${k}</td><td class="ps-v">${v}</td></tr>`).join("");

  $("#psRows").innerHTML = sum.rows.map(({ day, s }) => {
    const d = parseYmd(day.date);
    const lv = day.leave && day.leave.type ? LEAVE[day.leave.type] : null;
    return `<tr>
      <td>${day.date.slice(5)}</td>
      <td>${WEEK[d.getDay()]}</td>
      <td>${s.firstIn ? fmtClock(s.firstIn) : "—"}</td>
      <td>${s.lastOut ? fmtClock(s.lastOut) : (s.missing ? "缺卡" : "—")}</td>
      <td>${hours2(s.workSec)}</td>
      <td>${s.otSec ? hours2(s.otSec) : "—"}</td>
      <td>${lv ? lv.name : "—"}</td>
      <td>${Math.round(s.total).toLocaleString("zh-TW")}</td>
    </tr>`;
  }).join("");

  $("#psTotal").textContent = `合計應領 ${money(sum.total)}`;
}

/* =========================================================
   App 鎖
   ========================================================= */
let pinBuf = "", pinStage = "", pinFirst = "";

function buildPad(padEl, onDigit) {
  padEl.innerHTML = [1, 2, 3, 4, 5, 6, 7, 8, 9, "clear", 0, "back"].map(k => {
    if (k === "clear") return `<button class="pin-key fn" data-k="clear">清除</button>`;
    if (k === "back")  return `<button class="pin-key fn" data-k="back">⌫</button>`;
    return `<button class="pin-key" data-k="${k}">${k}</button>`;
  }).join("");
  padEl.querySelectorAll("[data-k]").forEach(b => b.onclick = () => onDigit(b.dataset.k));
}

function drawDots(el, n) {
  el.innerHTML = Array.from({ length: 6 }, (_, i) =>
    `<span class="pin-dot ${i < n ? "on" : ""}"></span>`).join("");
}

/* --- 解鎖畫面 --- */
function maybeLock() {
  if (Lock.isEnabled()) showLock();
}

function showLock() {
  pinBuf = "";
  $("#lockScreen").classList.remove("hidden");
  $("#app").classList.add("hidden");
  $("#lockMsg").textContent = "";
  drawDots($("#pinDots"), 0);
  buildPad($("#pinPad"), onLockKey);
  $("#btnBioUnlock").classList.toggle("hidden", !Lock.hasBiometric());
  if (Lock.hasBiometric()) setTimeout(tryBio, 350);   // 自動叫出 Face ID
}

async function onLockKey(k) {
  if (k === "clear") pinBuf = "";
  else if (k === "back") pinBuf = pinBuf.slice(0, -1);
  else if (pinBuf.length < 6) pinBuf += k;
  drawDots($("#pinDots"), pinBuf.length);

  if (pinBuf.length === 6) {
    if (await Lock.verifyPin(pinBuf)) unlock();
    else {
      $("#lockMsg").textContent = "PIN 碼不正確";
      $("#pinDots").classList.add("pin-shake");
      setTimeout(() => {
        $("#pinDots").classList.remove("pin-shake");
        pinBuf = ""; drawDots($("#pinDots"), 0);
      }, 440);
      if (navigator.vibrate) navigator.vibrate([30, 60, 30]);
    }
  }
}

async function tryBio() {
  try { if (await Lock.verifyBiometric()) unlock(); }
  catch { /* 使用者取消就留在 PIN 畫面 */ }
}
$("#btnBioUnlock").onclick = tryBio;

function unlock() {
  $("#lockScreen").classList.add("hidden");
  $("#app").classList.remove("hidden");
}

/* --- 設定 PIN --- */
function openPinSetup() {
  pinBuf = ""; pinFirst = ""; pinStage = "first";
  $("#pinStepDesc").textContent = "請輸入 6 位數字";
  $("#setPinMsg").textContent = "";
  drawDots($("#setPinDots"), 0);
  buildPad($("#setPinPad"), onSetPinKey);
  openSheet("#sheetPin");
}

async function onSetPinKey(k) {
  if (k === "clear") pinBuf = "";
  else if (k === "back") pinBuf = pinBuf.slice(0, -1);
  else if (pinBuf.length < 6) pinBuf += k;
  drawDots($("#setPinDots"), pinBuf.length);
  if (pinBuf.length < 6) return;

  if (pinStage === "first") {
    pinFirst = pinBuf; pinBuf = ""; pinStage = "confirm";
    $("#pinStepDesc").textContent = "請再輸入一次確認";
    setTimeout(() => drawDots($("#setPinDots"), 0), 180);
  } else {
    if (pinBuf === pinFirst) {
      await Lock.enable(pinFirst);
      closeSheet("#sheetPin");
      syncLockUI();
      toast("已啟用 App 鎖 🔒");
    } else {
      $("#setPinMsg").textContent = "兩次輸入不一致,請重新設定";
      pinBuf = ""; pinFirst = ""; pinStage = "first";
      $("#pinStepDesc").textContent = "請輸入 6 位數字";
      $("#setPinDots").classList.add("pin-shake");
      setTimeout(() => {
        $("#setPinDots").classList.remove("pin-shake");
        drawDots($("#setPinDots"), 0);
      }, 440);
    }
  }
}

async function syncLockUI() {
  const on = Lock.isEnabled();
  $("#setLock").checked = on;
  $("#btnChangePin").classList.toggle("hidden", !on);
  const bioOk = on && await Lock.biometricAvailable();
  $("#bioRow").classList.toggle("hidden", !bioOk);
  $("#setBio").checked = Lock.hasBiometric();
}

$("#setLock").onchange = () => {
  if ($("#setLock").checked) { $("#setLock").checked = false; openPinSetup(); }
  else { Lock.disable(); syncLockUI(); toast("已關閉 App 鎖"); }
};
$("#btnChangePin").onclick = openPinSetup;
$("#setBio").onchange = async () => {
  if ($("#setBio").checked) {
    try {
      await Lock.registerBiometric(Store.getActiveJob().name || "timecard");
      toast("已啟用生物辨識解鎖");
    } catch {
      $("#setBio").checked = false;
      toast("設定失敗,可能是裝置不支援或你取消了");
    }
  } else { Lock.removeBiometric(); toast("已關閉生物辨識"); }
  syncLockUI();
};

/* 回到前景超過 2 分鐘就重新上鎖 */
let hiddenAt = 0;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) hiddenAt = Date.now();
  else if (Lock.isEnabled() && hiddenAt && Date.now() - hiddenAt > 120000) showLock();
});

/* =========================================================
   忘記打卡提醒
   ---------------------------------------------------------
   純前端沒有推播伺服器,所以只能在 App 開著(或剛用過、分頁
   還活著)的時候發本機通知。完全關掉瀏覽器就不會跳 —— 這點
   在設定頁有明講,不給使用者錯誤期待。
   ========================================================= */
let remindTimer = null;

async function scheduleReminder() {
  clearTimeout(remindTimer);
  if (!S.remindEnabled || !("Notification" in window)) return;
  if (Notification.permission === "default") {
    try { await Notification.requestPermission(); } catch { return; }
  }
  if (Notification.permission !== "granted") return;

  const [h, m] = (S.remindTime || "18:30").split(":").map(Number);
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0);
  if (target <= now) target.setDate(target.getDate() + 1);

  remindTimer = setTimeout(() => {
    const st = dayStats(Store.getDayCached(ymd(new Date())), S);
    if (st.open) fireNotify("該打下班卡囉 🌇", "今天還在上班中,別忘了打卡下班。");
    scheduleReminder();                       // 排下一天
  }, target - now);
}

function fireNotify(title, body) {
  try {
    if (navigator.serviceWorker && navigator.serviceWorker.ready) {
      navigator.serviceWorker.ready
        .then(reg => reg.showNotification(title, { body, icon: "icons/icon-192.png", tag: "tc-remind" }))
        .catch(() => new Notification(title, { body }));
    } else new Notification(title, { body });
  } catch { toast(title); }
}
