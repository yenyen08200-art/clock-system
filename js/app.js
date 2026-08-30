/* =========================================================
   app.js · 介面與互動
   ========================================================= */

import * as Store from "./store.js";
import {
  ymd, parseYmd, addDays, pad, WEEK, EV, LEAVE,
  fmtHMS, fmtClock, fmtClock12, money, hours2,
  dayStats, daySalary, payPeriod, prevPayPeriod,
  monthRange, weekRange, summarize, toCSV, lastDayOfMonth
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
  startTick();
  renderHome();
  renderTodayRecords();
  checkMissing();
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
    const cls = ["cal-cell"];
    if (!inMonth) cls.push("mute");
    if (key === ymd(new Date())) cls.push("today");
    if (s && s.missing) cls.push("has-warn");
    else if (s && s.workSec > 0) cls.push("has-work");
    else if (rec && rec.leave && rec.leave.type) cls.push("has-leave");

    const dots = [];
    if (s && s.workSec > 0) dots.push("dot-work");
    if (rec && rec.leave && rec.leave.type) dots.push("dot-leave");
    if (rec && rec.note) dots.push("dot-note");
    if (s && s.missing) dots.push("dot-warn");

    html += `<div class="${cls.join(" ")}" data-date="${key}">
      <span class="cal-num">${d.getDate()}</span>
      ${s && s.workSec > 0 ? `<span class="cal-hrs">${hours2(s.workSec)}h</span>` : ""}
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
  $("#dayTitle").textContent = `${d.getMonth() + 1} 月 ${d.getDate()} 日 (${WEEK[d.getDay()]})`;

  const chips = [
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
  if ($("#view-calendar").classList.contains("active")) await renderCalendar();
  if ($("#view-records").classList.contains("active")) await runQuery("records", queryState.records?.range || payPeriod(S));
  if ($("#view-pay").classList.contains("active")) await runQuery("pay", queryState.pay?.range || payPeriod(S));
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
  if (name === "pay") runQuery("pay", queryState.pay?.range || payPeriod(S));
  if (name === "settings") updateCyclePreview();
}
$$(".tab").forEach(t => t.onclick = () => switchView(t.dataset.view));

/* =========================================================
   設定
   ========================================================= */
const SET_MAP = [
  ["#setWage", "wage", "number"], ["#setDaily", "dailyHours", "number"],
  ["#setBreak", "autoBreakMin", "number"], ["#setOt", "overtime", "bool"],
  ["#setCycle", "cycleMode", "text"], ["#setPayday", "payday", "number"],
  ["#setCutoff", "cutoffStart", "number"],
  ["#lvAnnual", "leaveAnnual", "number"], ["#lvSick", "leaveSick", "number"],
  ["#lvPersonal", "leavePersonal", "number"],
  ["#setGeo", "geo", "bool"], ["#setVibe", "vibrate", "bool"], ["#setWarn", "warnMissing", "bool"]
];

function bindSettingsUI() {
  S = Store.getSettings();
  SET_MAP.forEach(([sel, key, type]) => {
    const el = $(sel);
    if (type === "bool") el.checked = !!S[key]; else el.value = S[key];
    el.onchange = () => {
      const v = type === "bool" ? el.checked : (type === "number" ? Number(el.value) : el.value);
      Store.saveSettings({ [key]: v });
      S = Store.getSettings();
      updateCyclePreview();
      refreshAll();
      toast("設定已儲存");
    };
  });
  updateCyclePreview();
}

function updateCyclePreview() {
  $("#cutoffField").classList.toggle("hidden", S.cycleMode !== "custom");
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
