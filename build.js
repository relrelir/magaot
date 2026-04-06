'use strict';
const fs   = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────
const INCOME_MONTHS = [
  '2025-06','2025-07','2025-08','2025-09','2025-10',
  '2025-11','2025-12','2026-01','2026-02','2026-03'
];
const TXN_MONTHS = ['2026-01','2026-02','2026-03'];
const TXN_MONTH_LABELS = { '2026-01': 'ינואר', '2026-02': 'פברואר', '2026-03': 'מרץ' };

// Category names → Hebrew labels for display
const MONTH_HE = {
  '2025-06': 'יוני 25', '2025-07': 'יולי 25', '2025-08': 'אוגוסט 25',
  '2025-09': 'ספטמבר 25', '2025-10': 'אוקטובר 25', '2025-11': 'נובמבר 25',
  '2025-12': 'דצמבר 25', '2026-01': 'ינואר 26', '2026-02': 'פברואר 26',
  '2026-03': 'מרץ 26'
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch(e) { return null; }
}

function median(arr) {
  const s = [...arr].sort((a,b) => a-b);
  const m = Math.floor(s.length/2);
  return s.length % 2 ? s[m] : (s[m-1]+s[m])/2;
}

function mad(arr, med) {
  return median(arr.map(x => Math.abs(x - med)));
}

function fmt(n) {
  return Math.round(n).toLocaleString('he-IL') + ' ₪';
}

function monthLabel(ym) {
  if (MONTH_HE[ym]) return MONTH_HE[ym];
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1, 1);
  const name = d.toLocaleDateString('he-IL', { month: 'long' });
  return `${name} ${String(y).slice(2)}`;
}

// ─── Step 1: Load & Analyse Income ───────────────────────────────────────────
const incomeMonths = [];

for (const month of INCOME_MONTHS) {
  const file = path.join(__dirname, `income_${month}.json`);
  const data = readJson(file);
  if (!data) { console.warn(`⚠️  Missing income file: income_${month}.json`); continue; }

  const total = data.reduce((s, t) => s + t.amount, 0);

  // Flag large one-off items in this month's income
  const outlierTxns = data.filter(t =>
    t.amount >= 50000 ||
    (t.amount >= 10000 && ['קצבאות','שיק','משיכת פיקדון'].includes(t.category))
  );

  incomeMonths.push({ month, total, items: data, outlierTxns });
}

// Detect outlier months using MAD
const totals = incomeMonths.map(m => m.total);
const med    = median(totals);
const madVal = mad(totals, med);
const THRESH = 2.5;

for (const m of incomeMonths) {
  m.isOutlier = Math.abs(m.total - med) > THRESH * madVal;
  m.outlierReason = m.isOutlier
    ? (m.total > med ? 'גבוה חריג — ייתכן תשלום חד-פעמי או העברה גדולה' : 'נמוך חריג')
    : null;
  // Also flag months with a single transaction ≥50k as likely anomaly regardless of MAD
  if (!m.isOutlier && m.outlierTxns.some(t => t.amount >= 50000)) {
    m.isOutlier = true;
    m.outlierReason = 'כולל העברה גדולה חד-פעמית (מעל 50,000 ₪)';
  }
}

const normalMonths  = incomeMonths.filter(m => !m.isOutlier);
const avgIncome     = normalMonths.length
  ? normalMonths.reduce((s, m) => s + m.total, 0) / normalMonths.length
  : totals.reduce((a,b) => a+b, 0) / totals.length;

// ─── Step 2: Load Transactions & Find Fixed Expenses ─────────────────────────
const txnByMonth = {};
for (const month of TXN_MONTHS) {
  const file = path.join(__dirname, `txn_${month}.json`);
  const data = readJson(file);
  if (!data) { console.warn(`⚠️  Missing transactions file: txn_${month}.json`); continue; }
  // Remove income entries
  txnByMonth[month] = data.filter(t => !t.isIncome);
}

// Detect credit-card bulk payments from bank (show with warning, don't remove)
const CC_KEYWORDS = ['כרטיסי אשראי','לאומי קארד','ישראכרט','אמריקן אקספרס','מקס','max','cal'];
function isCCBulk(t) {
  return t.source === 'YahavBank' &&
    CC_KEYWORDS.some(k => t.businessName.toLowerCase().includes(k.toLowerCase()));
}

// Normalize business name for grouping
function normName(name) {
  return name.trim().replace(/\s+/g,' ').replace(/['"]/g,'').toLowerCase();
}

// Group all expense transactions by normalized name across all 3 months
const groups = {}; // normName → { displayName, months: { '2026-01': [amounts], ... }, source, category }

for (const month of TXN_MONTHS) {
  const txns = txnByMonth[month] || [];
  for (const t of txns) {
    const key = normName(t.businessName);
    if (!groups[key]) {
      groups[key] = {
        displayName: t.businessName.trim(),
        source: t.source,
        category: t.category,
        isCCBulk: isCCBulk(t),
        months: {}
      };
    }
    if (!groups[key].months[month]) groups[key].months[month] = [];
    groups[key].months[month].push(t.amount);
  }
}

// Compute per-group monthly totals (sum installments from same vendor in same month)
const fixedExpenses = [];
const partialExpenses = []; // appears in 1-2 months

for (const [key, g] of Object.entries(groups)) {
  const monthTotals = TXN_MONTHS.map(m => {
    const amounts = g.months[m] || [];
    return amounts.length ? amounts.reduce((a,b)=>a+b, 0) : null;
  });

  const presentMonths = monthTotals.filter(v => v !== null);
  if (presentMonths.length === 0) continue;

  const avgAmount = presentMonths.reduce((a,b)=>a+b,0) / presentMonths.length;

  // Check if amounts are consistent (within 3%) — or if it's mortgage/loan/savings
  const FIXED_CATEGORIES = ['משכנתא','הלוואה','פנסיה','השקעה וחיסכון','גמל','קרן השתלמות'];
  const forceFixed = FIXED_CATEGORIES.some(c => g.category.includes(c));

  let isFixed = forceFixed;
  if (!isFixed && presentMonths.length >= 2) {
    const mn = Math.min(...presentMonths);
    const mx = Math.max(...presentMonths);
    isFixed = mx > 0 && (mx - mn) / mx <= 0.03;
  }
  // Single-amount monthly item (subscription) — also fixed if same each time
  if (!isFixed && presentMonths.length >= 2) {
    const unique = [...new Set(presentMonths.map(v => Math.round(v)))];
    isFixed = unique.length === 1;
  }

  const entry = {
    key, displayName: g.displayName, source: g.source,
    category: g.category, isCCBulk: g.isCCBulk,
    monthTotals, avgAmount, presentCount: presentMonths.length,
    isFixed, forceFixed
  };

  if (isFixed && presentMonths.length === 3) {
    fixedExpenses.push(entry);
  } else if (forceFixed && presentMonths.length >= 2) {
    // Force-fixed categories (mortgage, loan, savings) — include even if < 3 months
    fixedExpenses.push(entry);
  } else if (presentMonths.length === 3 && !isFixed) {
    // Appears every month but variable amount — include for review
    entry.isVariable3 = true;
    partialExpenses.push(entry);
  }
}

// Sort by source then amount
fixedExpenses.sort((a,b) => {
  const so = ['YahavBank','leumicard','isracard','americanexpress'].indexOf(a.source)
           - ['YahavBank','leumicard','isracard','americanexpress'].indexOf(b.source);
  if (so !== 0) return so;
  return b.avgAmount - a.avgAmount;
});

const totalFixed = fixedExpenses.reduce((s,e) => s + e.avgAmount, 0);
const bozozim   = avgIncome - totalFixed;

// ─── Step 3: Current Month Projection (Predictive Engine) ────────────────────
const today       = new Date();
const currentYM   = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}`;
const dayOfMonth  = today.getDate();
const daysInMonth = new Date(today.getFullYear(), today.getMonth()+1, 0).getDate();

// Try current month first; fallback to most recent available data month
let projMonth = currentYM;
let projData  = readJson(path.join(__dirname, `data_${currentYM}.json`));
if (!projData) {
  for (const m of ['2026-03','2026-02','2026-01','2025-12','2025-11','2025-10']) {
    projData = readJson(path.join(__dirname, `data_${m}.json`));
    if (projData) { projMonth = m; break; }
  }
}

// Variable spending = all non-income transactions minus known fixed expense vendors
const fixedKeys     = new Set(fixedExpenses.map(e => e.key));
const varTxns       = projData
  ? projData.filter(t => !t.isIncome && !fixedKeys.has(normName(t.businessName)))
  : [];

const isCurrentMonth  = projMonth === currentYM;
const projDaysCovered = isCurrentMonth ? dayOfMonth : daysInMonth;
const varSpending     = varTxns.reduce((s, t) => s + t.amount, 0);
const burnRate        = projDaysCovered > 0 ? varSpending / projDaysCovered : 0;
const daysRemaining   = isCurrentMonth ? daysInMonth - dayOfMonth : 0;
const projectedTotal  = varSpending + burnRate * daysRemaining;
const projectedBalance = bozozim - projectedTotal; // positive = surplus, negative = overrun
const monthElapsedPct  = Math.round((projDaysCovered / daysInMonth) * 100);
const budgetSpentPct   = bozozim > 0 ? Math.round((varSpending / bozozim) * 100) : 0;

// ─── Helpers for HTML rendering ──────────────────────────────────────────────
function sourceIcon(src) {
  if (src === 'YahavBank') return '🏦';
  if (src === 'leumicard') return '💳';
  if (src === 'isracard')  return '💳';
  if (src === 'americanexpress') return '💳';
  return '💰';
}

function sourceLabel(src) {
  if (src === 'YahavBank') return 'בנק יהב';
  if (src === 'leumicard') return 'לאומי קארד';
  if (src === 'isracard')  return 'ישראכרט';
  if (src === 'americanexpress') return 'אמקס';
  return src;
}

function amountCell(val) {
  if (val === null) return '<td class="no-data">—</td>';
  return `<td class="amount">${fmt(val)}</td>`;
}

// ─── Build HTML ───────────────────────────────────────────────────────────────
const generatedDate = new Date().toLocaleDateString('he-IL', {
  year:'numeric', month:'long', day:'numeric'
});

// Embed data as JSON for interactive toggles
const embedData = JSON.stringify({
  incomeMonths: incomeMonths.map(m => ({
    month: m.month, label: MONTH_HE[m.month],
    total: m.total, isOutlier: m.isOutlier, outlierReason: m.outlierReason
  })),
  fixedTotal: totalFixed,
  avgIncome,
  projection: {
    month: projMonth, monthLabel: monthLabel(projMonth),
    isCurrentMonth, dayOfMonth: projDaysCovered, daysInMonth,
    varSpending, burnRate, projectedTotal, projectedBalance,
    monthElapsedPct, budgetSpentPct, bozozim
  }
});

// Build income table rows
const incomeRows = incomeMonths.map(m => {
  const cls = m.isOutlier ? 'outlier-row' : '';
  const badge = m.isOutlier
    ? `<span class="badge badge-warn" title="${m.outlierReason}">⚠️ חריג</span>`
    : `<span class="badge badge-ok">תקין</span>`;
  const toggle = m.isOutlier
    ? `<button class="toggle-btn" data-month="${m.month}" onclick="toggleMonth(this)">כלול בממוצע</button>`
    : `<button class="toggle-btn included" data-month="${m.month}" onclick="toggleMonth(this)">הוצא מהממוצע</button>`;
  return `<tr class="${cls}" data-month="${m.month}" data-total="${m.total}" data-excluded="${m.isOutlier}">
    <td class="month-name">${MONTH_HE[m.month]}</td>
    <td class="amount">${fmt(m.total)}</td>
    <td>${badge}</td>
    <td class="reason-cell">${m.outlierReason || ''}</td>
    <td>${toggle}</td>
  </tr>`;
}).join('\n');

// Build fixed expenses table rows
const fixedRows = fixedExpenses.map(e => {
  const ccBadge = e.isCCBulk ? ' <span class="badge badge-cc" title="חיוב מרוכז — ייתכן כרטיס שאינו מחובר לרייזאפ">⚠️ מרוכז</span>' : '';
  const forceBadge = e.forceFixed ? ' <span class="badge badge-force">קבוע</span>' : '';
  return `<tr>
    <td>${sourceIcon(e.source)} ${e.displayName}${ccBadge}${forceBadge}</td>
    <td class="source-label">${sourceLabel(e.source)}</td>
    <td class="category">${e.category}</td>
    ${amountCell(e.monthTotals[0])}
    ${amountCell(e.monthTotals[1])}
    ${amountCell(e.monthTotals[2])}
    <td class="amount avg-col"><strong>${fmt(e.avgAmount)}</strong></td>
  </tr>`;
}).join('\n');

// Variable-but-recurring rows (every month, not fixed amount)
const variableRows = partialExpenses
  .sort((a,b) => b.avgAmount - a.avgAmount)
  .map(e => {
    const ccBadge = e.isCCBulk ? ' <span class="badge badge-cc">⚠️ מרוכז</span>' : '';
    return `<tr class="variable-row">
    <td>${sourceIcon(e.source)} ${e.displayName}${ccBadge}</td>
    <td class="source-label">${sourceLabel(e.source)}</td>
    <td class="category">${e.category}</td>
    ${amountCell(e.monthTotals[0])}
    ${amountCell(e.monthTotals[1])}
    ${amountCell(e.monthTotals[2])}
    <td class="amount avg-col">${fmt(e.avgAmount)}</td>
  </tr>`;
  }).join('\n');

const html = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>טבלת המגירות</title>
<style>
  :root {
    --green:  #1a7f3c; --green-bg:  #e8f5ee; --green-card: #d4edda;
    --red:    #c0392b; --red-bg:    #fdf0ee; --red-card:   #fadbd8;
    --blue:   #1a5276; --blue-bg:   #eaf0fb; --blue-card:  #d6e9f8;
    --orange: #e67e22; --orange-bg: #fef9f0;
    --gray:   #6c757d; --border: #dee2e6;
    --font: 'Segoe UI', Arial, sans-serif;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--font); background: #f4f6f9;
    color: #222; padding: 24px 16px; direction: rtl;
  }
  header { text-align: center; margin-bottom: 32px; }
  header h1 { font-size: 2rem; color: #1a1a2e; }
  header .subtitle { color: var(--gray); margin-top: 4px; }
  header .generated { font-size: 0.8rem; color: #aaa; margin-top: 8px; }

  /* ── Drawer Cards ── */
  .drawers { display: flex; gap: 20px; margin-bottom: 36px; flex-wrap: wrap; }
  .drawer {
    flex: 1; min-width: 240px; border-radius: 14px; padding: 24px 20px;
    box-shadow: 0 2px 12px rgba(0,0,0,.08); text-align: center;
  }
  .drawer h2 { font-size: 1rem; margin-bottom: 8px; opacity: .85; }
  .drawer .big-num { font-size: 2rem; font-weight: 700; }
  .drawer .sub { font-size: 0.8rem; opacity: .7; margin-top: 6px; }
  .drawer-income  { background: var(--green-card); color: var(--green); }
  .drawer-fixed   { background: var(--red-card);   color: var(--red); }
  .drawer-bozozim { background: var(--blue-card);  color: var(--blue); }

  /* ── Section ── */
  .section { background: #fff; border-radius: 12px; padding: 20px 24px;
             box-shadow: 0 1px 6px rgba(0,0,0,.06); margin-bottom: 28px; }
  .section h3 { font-size: 1.1rem; margin-bottom: 16px; color: #1a1a2e;
                border-bottom: 2px solid var(--border); padding-bottom: 10px; }

  /* ── Tables ── */
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th { background: #f0f2f5; padding: 10px 12px; font-weight: 600;
       text-align: right; color: #444; border-bottom: 2px solid var(--border); }
  td { padding: 9px 12px; border-bottom: 1px solid #f0f2f5; vertical-align: middle; }
  tr:hover td { background: #fafafa; }
  .amount { text-align: left; font-variant-numeric: tabular-nums; font-weight: 500; }
  .avg-col { background: #f8f9fa; }
  .no-data { text-align: center; color: #bbb; }
  .month-name { font-weight: 500; }
  .reason-cell { font-size: 0.78rem; color: var(--gray); }
  .source-label { font-size: 0.8rem; color: var(--gray); }
  .category { font-size: 0.82rem; }

  /* Outlier rows */
  .outlier-row td { color: #aaa; text-decoration: line-through; }
  .outlier-row .month-name, .outlier-row .amount { text-decoration: line-through; }

  /* Variable rows */
  .variable-row { background: var(--orange-bg); }
  .variable-row td { color: #7d5a1e; }

  /* Badges */
  .badge { display: inline-block; font-size: 0.72rem; padding: 2px 7px;
           border-radius: 10px; font-weight: 600; vertical-align: middle; }
  .badge-ok   { background: var(--green-bg); color: var(--green); }
  .badge-warn { background: #fff3cd; color: #856404; cursor: help; }
  .badge-cc   { background: #fff3cd; color: #856404; cursor: help; }
  .badge-force{ background: #e8d5ff; color: #5a189a; }

  /* Toggle buttons */
  .toggle-btn {
    font-size: 0.75rem; padding: 3px 10px; border-radius: 12px; border: 1px solid;
    cursor: pointer; background: transparent; border-color: var(--gray); color: var(--gray);
  }
  .toggle-btn.included { border-color: var(--green); color: var(--green); }

  /* Summary bar */
  .summary-bar {
    display: flex; gap: 16px; flex-wrap: wrap; justify-content: flex-end;
    margin-top: 14px; padding-top: 14px; border-top: 2px solid var(--border);
    font-weight: 600; font-size: 0.9rem;
  }
  .summary-bar span { color: var(--gray); font-weight: 400; margin-left: 4px; }

  /* Average display */
  #avg-display {
    background: var(--green-bg); color: var(--green);
    border-radius: 8px; padding: 8px 16px; font-weight: 700;
    font-size: 1rem; display: inline-block; margin-bottom: 12px;
  }
  #avg-note { font-size: 0.78rem; color: var(--gray); margin-bottom: 12px; }

  /* ── Forecast Banner ── */
  .forecast-banner {
    border-radius: 14px; padding: 20px 24px; margin-bottom: 28px;
    box-shadow: 0 2px 12px rgba(0,0,0,.1);
  }
  .forecast-ok   { background: linear-gradient(135deg,#d4edda,#c3e6cb); border-right: 5px solid #1a7f3c; }
  .forecast-warn { background: linear-gradient(135deg,#fadbd8,#f5b7b1); border-right: 5px solid #c0392b; }
  .forecast-banner h2 { font-size: 1.1rem; margin-bottom: 8px; }
  .forecast-main-num { font-size: 2.2rem; font-weight: 700; margin: 8px 0; }
  .forecast-ok   .forecast-main-num { color: #1a7f3c; }
  .forecast-warn .forecast-main-num { color: #c0392b; }
  .forecast-stats {
    display: flex; gap: 20px; flex-wrap: wrap;
    margin-top: 12px; font-size: 0.85rem; opacity: .85;
  }
  .forecast-note { font-size: 0.88rem; opacity: .8; margin: 4px 0 0; }

  /* ── Pacing Bar ── */
  .pacing-section {
    background: #fff; border-radius: 12px; padding: 20px 24px;
    box-shadow: 0 1px 6px rgba(0,0,0,.06); margin-bottom: 28px;
  }
  .pacing-section h3 { font-size: 1rem; margin-bottom: 8px; color: #1a1a2e; }
  .pacing-track {
    position: relative; height: 26px; background: #e9ecef;
    border-radius: 13px; overflow: hidden; margin: 10px 0;
  }
  .pacing-expected {
    position: absolute; top: 0; right: 0; height: 100%;
    background: rgba(26,127,60,.15); border-left: 2px dashed #1a7f3c;
    transition: width .5s;
  }
  .pacing-actual {
    position: absolute; top: 0; right: 0; height: 100%;
    border-radius: 13px 0 0 13px; background: #1a7f3c;
    opacity: .85; transition: width .5s;
  }
  .pacing-actual.over-budget { background: #c0392b; }
  .pacing-legend {
    display: flex; gap: 20px; font-size: 0.82rem;
    color: var(--gray); margin-top: 4px; flex-wrap: wrap;
  }
  .pacing-status { margin-top: 10px; font-weight: 600; font-size: 0.9rem; }
  .pacing-status.ok   { color: #1a7f3c; }
  .pacing-status.warn { color: #c0392b; }

  @media (max-width: 700px) {
    .drawers { flex-direction: column; }
    table { font-size: 0.8rem; }
    td, th { padding: 7px 8px; }
    .drawer .big-num { font-size: 1.5rem; }
    .forecast-main-num { font-size: 1.6rem; }
    .forecast-stats { gap: 12px; }
  }
</style>
</head>
<body>

<header>
  <h1>🗂️ טבלת המגירות</h1>
  <p class="subtitle">תשתית שיטת שלושת החשבונות</p>
  <p class="generated">עודכן: ${generatedDate}</p>
</header>

<!-- ── Monthly Forecast Banner ── -->
<div class="forecast-banner forecast-${projectedBalance >= 0 ? 'ok' : 'warn'}">
  <h2>🔭 תחזית חודש ${monthLabel(projMonth)}${isCurrentMonth ? '' : ` <span style="font-weight:400;font-size:.85rem">(חודש אחרון זמין — אין עדיין נתוני ${monthLabel(currentYM)})</span>`}</h2>
  <div class="forecast-main-num">
    ${projectedBalance >= 0
      ? `יישארו ${fmt(Math.abs(projectedBalance))}`
      : `תחריגו ב-${fmt(Math.abs(projectedBalance))}`}
  </div>
  <p class="forecast-note">
    ${isCurrentMonth
      ? `בקצב ההוצאות הנוכחי (יום ${dayOfMonth} מתוך ${daysInMonth}), בסוף ${monthLabel(projMonth)} ${projectedBalance >= 0 ? 'יישארו לכם' : 'תחרגו ב'} <strong>${fmt(Math.abs(projectedBalance))}</strong> במגירת הבזבוזים.`
      : `חודש ${monthLabel(projMonth)} הסתיים. ${projectedBalance >= 0 ? 'נשארו' : 'חרגתם ב'} <strong>${fmt(Math.abs(projectedBalance))}</strong> במגירת הבזבוזים.`}
  </p>
  <div class="forecast-stats">
    <div>💸 הוצאות משתנות ${isCurrentMonth ? 'עד היום' : 'בחודש'}: <strong>${fmt(varSpending)}</strong></div>
    <div>🔥 קצב שריפה: <strong>${Math.round(burnRate).toLocaleString('he-IL')} ₪/יום</strong></div>
    ${isCurrentMonth ? `<div>📅 תחזית לסוף חודש: <strong>${fmt(projectedTotal)}</strong></div>` : ''}
    <div>💼 תקציב מגירה ד: <strong>${fmt(bozozim)}</strong></div>
  </div>
</div>

<!-- ── Pacing Bar ── -->
<div class="pacing-section">
  <h3>📏 מד קצב ההוצאות${isCurrentMonth ? ` — יום ${dayOfMonth} מתוך ${daysInMonth}` : ` — ${monthLabel(projMonth)} (סיכום)`}</h3>
  <div style="font-size:0.85rem;color:var(--gray);margin-bottom:4px;">
    ${monthElapsedPct}% מהחודש ${isCurrentMonth ? 'עבר' : 'חלף'} — הצפי הוא להיות על כ-${monthElapsedPct}% מהתקציב
  </div>
  <div class="pacing-track">
    <div class="pacing-expected" style="width:${monthElapsedPct}%"></div>
    <div class="pacing-actual${budgetSpentPct > monthElapsedPct ? ' over-budget' : ''}"
         style="width:${Math.min(budgetSpentPct, 100)}%"></div>
  </div>
  <div class="pacing-legend">
    <span>📐 צפוי עד עכשיו: ${monthElapsedPct}% — ${fmt(bozozim * monthElapsedPct / 100)}</span>
    <span>${budgetSpentPct > monthElapsedPct ? '🔴' : '🟢'} בפועל: ${budgetSpentPct}% — ${fmt(varSpending)}</span>
  </div>
  <div class="pacing-status ${budgetSpentPct > monthElapsedPct ? 'warn' : 'ok'}">
    ${budgetSpentPct > monthElapsedPct
      ? `⚠️ מהירים מדי — הוצאתם ${budgetSpentPct - monthElapsedPct}% יותר מהצפוי ביום זה`
      : `✅ בתוך התקציב — הוצאתם ${monthElapsedPct - budgetSpentPct}% פחות מהצפוי`}
  </div>
</div>

<!-- ── Drawer Summary Cards ── -->
<div class="drawers">
  <div class="drawer drawer-income">
    <h2>💰 מגירת הכנסות</h2>
    <div class="big-num" id="card-income">${fmt(avgIncome)}</div>
    <div class="sub">ממוצע חודשי מייצג</div>
  </div>
  <div class="drawer drawer-fixed">
    <h2>📋 מגירת הוצאות קבועות</h2>
    <div class="big-num">${fmt(totalFixed)}</div>
    <div class="sub">סה"כ הוצאות קבועות מזוהות</div>
  </div>
  <div class="drawer drawer-bozozim">
    <h2>🛒 מגירת הבזבוזים</h2>
    <div class="big-num" id="card-bozozim">${fmt(bozozim)}</div>
    <div class="sub">= הכנסות פחות קבועות</div>
  </div>
</div>

<!-- ── Income Section ── -->
<div class="section">
  <h3>📊 פירוט הכנסות לפי חודש</h3>
  <div id="avg-display">ממוצע מחושב: <span id="avg-val">${fmt(avgIncome)}</span></div>
  <div id="avg-note">מחושב מ-<span id="avg-count">${normalMonths.length}</span> חודשים רגילים (חריגים מסומנים ⚠️). ניתן להפעיל/לכבות חודשים ידנית.</div>
  <table>
    <thead>
      <tr>
        <th>חודש</th>
        <th>סה"כ הכנסות</th>
        <th>סטטוס</th>
        <th>הערה</th>
        <th>פעולה</th>
      </tr>
    </thead>
    <tbody>
${incomeRows}
    </tbody>
  </table>
</div>

<!-- ── Fixed Expenses Section ── -->
<div class="section">
  <h3>🔒 הוצאות קבועות מזוהות — 3 חודשים רצופים (ינ׳–מרץ 26)</h3>
  <p style="font-size:0.82rem;color:var(--gray);margin-bottom:12px;">
    כל הפריטים המופיעים בסכום קבוע (±3%) בשלושת החודשים. 🏦 = בנק (הו"ק), 💳 = כרטיס אשראי, 💰 = חיסכון.<br>
    <strong>⚠️ מרוכז</strong> = חיוב מרוכז מהבנק — ייתכן שכולל כרטיס שאינו מחובר לרייזאפ, יש לבדוק ידנית.
  </p>
  <table>
    <thead>
      <tr>
        <th>שם</th>
        <th>מקור</th>
        <th>קטגוריה</th>
        <th>ינואר</th>
        <th>פברואר</th>
        <th>מרץ</th>
        <th>ממוצע</th>
      </tr>
    </thead>
    <tbody>
${fixedRows}
    </tbody>
  </table>
  <div class="summary-bar">
    <div><span>סה"כ הוצאות קבועות:</span> ${fmt(totalFixed)}</div>
  </div>
</div>

<!-- ── Variable-but-Recurring Section ── -->
${variableRows ? `
<div class="section">
  <h3>🔄 הוצאות חוזרות בסכום משתנה (כל 3 חודשים — לבחינה)</h3>
  <p style="font-size:0.82rem;color:var(--gray);margin-bottom:12px;">
    פריטים שמופיעים בכל 3 חודשים אך הסכום משתנה ביותר מ-3%. לא נכללו בקבועות אוטומטית.
  </p>
  <table>
    <thead>
      <tr>
        <th>שם</th><th>מקור</th><th>קטגוריה</th>
        <th>ינואר</th><th>פברואר</th><th>מרץ</th><th>ממוצע</th>
      </tr>
    </thead>
    <tbody>
${variableRows}
    </tbody>
  </table>
</div>
` : ''}

<script>
const DATA = ${embedData};

function recalc() {
  const rows = document.querySelectorAll('tbody tr[data-month]');
  let sum = 0, count = 0;
  rows.forEach(r => {
    const excluded = r.dataset.excluded === 'true';
    if (!excluded) { sum += parseFloat(r.dataset.total); count++; }
  });
  const avg = count ? sum / count : 0;
  const fixed = ${totalFixed};
  document.getElementById('avg-val').textContent = formatIL(avg);
  document.getElementById('avg-count').textContent = count;
  document.getElementById('card-income').textContent = formatIL(avg);
  document.getElementById('card-bozozim').textContent = formatIL(avg - fixed);
}

function toggleMonth(btn) {
  const row = btn.closest('tr');
  const excluded = row.dataset.excluded === 'true';
  row.dataset.excluded = excluded ? 'false' : 'true';
  if (excluded) {
    row.classList.remove('outlier-row');
    btn.textContent = 'הוצא מהממוצע';
    btn.classList.add('included');
  } else {
    row.classList.add('outlier-row');
    btn.textContent = 'כלול בממוצע';
    btn.classList.remove('included');
  }
  recalc();
}

function formatIL(n) {
  return Math.round(n).toLocaleString('he-IL') + ' ₪';
}
</script>

</body>
</html>`;

// ─── Write output ─────────────────────────────────────────────────────────────
const outFile = path.join(__dirname, 'magaot.html');
fs.writeFileSync(outFile, html, 'utf8');

// ─── Console Summary ──────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════');
console.log('  טבלת המגירות — סיכום');
console.log('══════════════════════════════════════════');
console.log(`  חודשים שנותחו:      ${incomeMonths.length}`);
console.log(`  חודשים חריגים:      ${incomeMonths.filter(m=>m.isOutlier).map(m=>MONTH_HE[m.month]).join(', ') || 'אין'}`);
console.log(`  ממוצע הכנסות:       ${fmt(avgIncome)}`);
console.log(`  הוצאות קבועות:      ${fmt(totalFixed)}  (${fixedExpenses.length} פריטים)`);
console.log(`  מגירת בזבוזים:      ${fmt(bozozim)}`);
console.log('──────────────────────────────────────────');
console.log(`\n✅  נוצר: magaot.html`);
console.log('   הרץ: node server.js  ←  http://localhost:3456\n');
