'use strict';
var fs = require('fs');

var MONTHS = ['2025-07','2025-08','2025-09','2025-10','2025-11','2025-12','2026-01','2026-02','2026-03'];
var LAST3  = MONTHS.slice(-3);

// ── LOAD ALL TRANSACTIONS ──────────────────────────────────────────────────
var allTxns = [], seen = {};
MONTHS.forEach(function(m) {
  var f = 'data_' + m + '.json';
  if (fs.existsSync(f)) {
    JSON.parse(fs.readFileSync(f, 'utf8')).forEach(function(t) {
      if (!seen[t.transactionId]) { seen[t.transactionId] = true; t._month = m; allTxns.push(t); }
    });
  }
});
['2026-01','2026-02','2026-03'].forEach(function(m) {
  var f = 'txn_' + m + '.json';
  if (fs.existsSync(f)) {
    JSON.parse(fs.readFileSync(f, 'utf8')).forEach(function(t) {
      if (!seen[t.transactionId]) { seen[t.transactionId] = true; t._month = m; allTxns.push(t); }
    });
  }
});

var income   = allTxns.filter(function(t) { return  t.isIncome; });
var expenses = allTxns.filter(function(t) { return !t.isIncome; });

// ── UTILS ──────────────────────────────────────────────────────────────────
function normName(s) { return String(s||'').trim().replace(/\s+/g,' '); }

function stableId(prefix, str) {
  var hash = 0;
  for (var i = 0; i < str.length; i++) {
    hash = (Math.imul(31, hash) + str.charCodeAt(i)) | 0;
  }
  return prefix + '_' + (hash >>> 0).toString(36);
}

function monthlyEquiv(monthAmounts) {
  var ms = Object.keys(monthAmounts);
  if (!ms.length) return 0;
  var total = ms.reduce(function(s, m) { return s + monthAmounts[m]; }, 0);
  return total / ms.length;
}

// ── INCOME GROUPS ──────────────────────────────────────────────────────────
var incomeByName = {};
income.forEach(function(t) {
  var key = normName(t.businessName);
  if (!incomeByName[key]) incomeByName[key] = { name: key, cat: t.category, monthAmounts: {}, transactions: [] };
  var m = t._month;
  incomeByName[key].monthAmounts[m] = (incomeByName[key].monthAmounts[m] || 0) + t.amount;
  incomeByName[key].transactions.push({ id: t.transactionId, date: t.date, amount: t.amount, month: m });
});

var INCOME_GROUPS = Object.keys(incomeByName).map(function(key) {
  var g = incomeByName[key];
  var equiv = monthlyEquiv(g.monthAmounts);
  return {
    id: stableId('ig', key),
    name: g.name,
    cat: g.cat,
    monthAmounts: g.monthAmounts,
    monthsPresent: Object.keys(g.monthAmounts).length,
    monthlyEquiv: Math.round(equiv * 100) / 100,
    transactions: g.transactions
  };
}).sort(function(a, b) { return b.monthlyEquiv - a.monthlyEquiv; });

// ── EXPENSE CLASSIFICATION ─────────────────────────────────────────────────
// Categories that are always FIXED (regardless of recurrence)
var FIXED_CAT_MAP = {
  'ביטוח לאומי':    'tashlumim',
  'ביטוח':          'shonot',       // default; health items overridden by name patterns below
  'משכנתא':         'bayit',
  'ארנונה':         'cheshbonot',
  'חשמל':           'cheshbonot',
  'מים':            'cheshbonot',
  'ועד בית':        'cheshbonot',
  'תקשורת':         'bayit',
  'דיגיטל':         'bayit',
  'השקעה וחיסכון':  'pkdonot',
  'הלוואה':         'tashlumim',
  'בריאות':         'briut',
  'פארמה':          'briut'
};

// Health-related name patterns: if cat=='ביטוח' and name matches → override to 'briut'
var HEALTH_NAME_PATTERNS = ['בריאות', 'קופת', 'מכבי', 'כללית', 'לאומית', 'רפואה'];

// Categories that are VARIABLE
var VAR_CAT_MAP = {
  'כלכלה':          'supermarket',
  'מזון':           'supermarket',
  'אוכל בחוץ':      'restaurants',
  'פנאי':           'piukkim',
  'תיירות':         'adventures',
  'קניות':          'other_var',
  'ביגוד והנעלה':   'bigud',
  'קוסמטיקה':       'bigud',
  'בריאות':         'other_var',
  'פארמה':          'other_var',
  'רכב':            'transport',
  'תחבורה ציבורית': 'transport',
  'ציוד משרדי':     'other_var',
  'חיות מחמד':      'other_var',
  'חוגים':          'kids',
  'ספורט':          'kids',
  'חינוך':          'kids'
};

// Ambiguous – classify as fixed only if appear in 4+ months; map to specific drawer
var AMBIG_DRAWER_MAP = {
  'כללי':    'shonot',
  'העברות':  'shonot',
  'תשלומים': 'tashlumim',
  'תרומה':   'shonot',
  'מיסים':   'tashlumim'
};

// Always skip (cash / bank-fees / tax-credits)
var SKIP_CATS = ['מזומן', 'עמלות', 'מס הכנסה', 'שיק'];

// ── GROUP EXPENSES BY businessName ─────────────────────────────────────────
var bizGroups = {};
expenses.forEach(function(t) {
  if (SKIP_CATS.indexOf(t.category) >= 0) return;
  var key = normName(t.businessName);
  if (!bizGroups[key]) bizGroups[key] = { name: key, cat: t.category, monthAmounts: {} };
  var m = t._month, amt = Math.abs(t.amount);
  bizGroups[key].monthAmounts[m] = (bizGroups[key].monthAmounts[m] || 0) + amt;
});

// ── BUILD RECURRING_DATA (fixed items only) ────────────────────────────────
var recurringItems = [];
var varTxnsByDrawer = {}; // drawer → {month → total}

Object.keys(bizGroups).forEach(function(key) {
  var g = bizGroups[key];
  var cat = g.cat;
  var nMonths = Object.keys(g.monthAmounts).length;

  if (FIXED_CAT_MAP[cat] && nMonths >= 2) {
    var drawer = FIXED_CAT_MAP[cat];
    // Override: ביטוח items whose name matches health patterns → briut
    if (cat === 'ביטוח' && drawer === 'shonot') {
      var nm = (g.name || '').toLowerCase();
      if (HEALTH_NAME_PATTERNS.some(function(p) { return nm.indexOf(p) >= 0; })) {
        drawer = 'briut';
      }
    }
    recurringItems.push({ g: g, drawer: drawer });
  } else if (AMBIG_DRAWER_MAP[cat] && nMonths >= 4) {
    recurringItems.push({ g: g, drawer: AMBIG_DRAWER_MAP[cat] });
  } else if (VAR_CAT_MAP[cat]) {
    var did = VAR_CAT_MAP[cat];
    if (!varTxnsByDrawer[did]) varTxnsByDrawer[did] = {};
    var ma = g.monthAmounts;
    Object.keys(ma).forEach(function(m) {
      varTxnsByDrawer[did][m] = (varTxnsByDrawer[did][m] || 0) + ma[m];
    });
  }
  // else: skip
});

// ── FIXED_TXN_DATA: per-transaction detail for fixed items ────────────────
var fixedNameToId = {};
recurringItems.forEach(function(item) {
  fixedNameToId[item.g.name] = stableId('r', item.g.name);
});

var fixedTxnData = {}; // itemId → { month → [{id, amt, date, src}] }
expenses.forEach(function(t) {
  if (SKIP_CATS.indexOf(t.category) >= 0) return;
  var nm = normName(t.businessName);
  var itemId = fixedNameToId[nm];
  if (!itemId) return;
  var m = t._month;
  if (!fixedTxnData[itemId]) fixedTxnData[itemId] = {};
  if (!fixedTxnData[itemId][m]) fixedTxnData[itemId][m] = [];
  fixedTxnData[itemId][m].push({ id: t.transactionId, amt: Math.round(Math.abs(t.amount)), date: t.date, src: t.source || '' });
});

// ── VAR_TXN_DETAILS: transactions grouped by business per drawer per month ───
var varBizGroups = {}; // did → month → bizName → { name, txns:[] }
expenses.forEach(function(t) {
  if (SKIP_CATS.indexOf(t.category) >= 0) return;
  var did = VAR_CAT_MAP[t.category];
  if (!did) return;
  var m = t._month, nm = normName(t.businessName);
  if (!varBizGroups[did]) varBizGroups[did] = {};
  if (!varBizGroups[did][m]) varBizGroups[did][m] = {};
  if (!varBizGroups[did][m][nm]) varBizGroups[did][m][nm] = { name: nm, txns: [] };
  varBizGroups[did][m][nm].txns.push({ id: t.transactionId, amt: Math.round(Math.abs(t.amount)), date: t.date, src: t.source || '' });
});

var varTxnDetails = {};
Object.keys(varBizGroups).forEach(function(did) {
  varTxnDetails[did] = {};
  Object.keys(varBizGroups[did]).forEach(function(m) {
    var groups = Object.keys(varBizGroups[did][m]).map(function(nm) {
      var g = varBizGroups[did][m][nm];
      var total = g.txns.reduce(function(s, t) { return s + t.amt; }, 0);
      g.txns.sort(function(a, b) { return b.amt - a.amt; });
      return { name: g.name, total: total, count: g.txns.length, txns: g.txns };
    });
    groups.sort(function(a, b) { return b.total - a.total; });
    varTxnDetails[did][m] = groups;
  });
});

// ── VAR_BIZ_MONTH_COUNT: how many months each business appears per drawer ────
var varBizMonthCount = {}; // did → bizName → nMonths
Object.keys(varBizGroups).forEach(function(did) {
  varBizMonthCount[did] = {};
  Object.keys(varBizGroups[did]).forEach(function(m) {
    Object.keys(varBizGroups[did][m]).forEach(function(nm) {
      varBizMonthCount[did][nm] = (varBizMonthCount[did][nm] || 0) + 1;
    });
  });
});

var RECURRING_DATA = recurringItems.map(function(item) {
  var g = item.g;
  var ma = g.monthAmounts;
  var ms = Object.keys(ma);
  var equiv = monthlyEquiv(ma);
  var isMonthly = ms.length >= 5;
  return {
    id:           stableId('r', g.name),
    name:         g.name,
    cat:          g.cat,
    drawer:       item.drawer,
    type:         'fixed',
    freq:         isMonthly ? 'חודשי' : 'תקופתי',
    monthsPresent: ms.length,
    monthlyEquiv: Math.round(equiv * 100) / 100,
    isMonthly:    isMonthly,
    monthAmounts: ma
  };
}).sort(function(a, b) { return b.monthlyEquiv - a.monthlyEquiv; });

// ── VAR_AVGS & VAR_TREND ───────────────────────────────────────────────────
var ALL_VAR_IDS = ['supermarket','restaurants','piukkim','bigud','adventures','transport','kids','other_var'];
var VAR_AVGS  = {};
var VAR_TREND = {};

ALL_VAR_IDS.forEach(function(did) {
  var byMonth = varTxnsByDrawer[did] || {};
  var ms = Object.keys(byMonth).filter(function(m) { return MONTHS.indexOf(m) >= 0; });
  var total = ms.reduce(function(s, m) { return s + byMonth[m]; }, 0);
  var avg = ms.length ? total / ms.length : 0;
  VAR_AVGS[did] = Math.round(avg);

  var last3ms = LAST3.filter(function(m) { return byMonth[m] !== undefined; });
  var l3total  = last3ms.reduce(function(s, m) { return s + byMonth[m]; }, 0);
  VAR_TREND[did] = last3ms.length ? Math.round(l3total / last3ms.length) : Math.round(avg);
});

// ── INCOME DRAWER CLASSIFICATION ──────────────────────────────────────────
function classifyIncomeGroup(g) {
  var name = g.name, cat = g.cat;

  // Name-pattern rules (highest priority)
  if (/חותם|פרו סרוס|טרנזילה|LOVABLE|FAMOUS|הפקדת שיק/.test(name)) return 'business';
  if (/הפועלים מימון יצחק|הפועלים אבו|לאומי שבות/.test(name))       return 'business';
  if (/ביט|BIT|bit|העברה מיידית בנק|ב\.הפועלים-ביט/.test(name))     return 'transfers';
  if (/העברה בן זנו|פיקדון|אגוש|אלע"ד|בייבי|דמי כרטיס/.test(name)) return 'other_inc';
  if (/ריבית זכות|ריבית$/.test(name))                                 return 'refunds';

  // Category rules
  if (cat === 'משכורת')         return 'salary';
  if (cat === 'קצבאות')         return 'benefits';
  if (cat === 'מס הכנסה')       return 'refunds';
  if (cat === 'זיכויים')        return 'refunds';
  if (cat === 'עמלות')          return 'refunds';
  if (cat === 'קניות')          return 'refunds';
  if (cat === 'כלכלה')          return 'refunds';
  if (cat === 'תקשורת')         return 'refunds';
  if (cat === 'השקעה וחיסכון')  return 'other_inc';
  if (cat === 'משיכת פיקדון')   return 'other_inc';
  if (cat === 'תרומה')          return 'other_inc';
  if (cat === 'סליקת אשראי')    return 'business';
  if (cat === 'שיק')            return 'business';
  if (cat === 'העברות')         return 'transfers';
  if (cat === 'כללי')           return 'business';
  return 'other_inc';
}

INCOME_GROUPS.forEach(function(g) { g.drawer = classifyIncomeGroup(g); });

// ── VAR_MAX5: max of last-5 months per drawer ─────────────────────────────
var VAR_MAX5 = {};
ALL_VAR_IDS.forEach(function(did) {
  var byMonth = varTxnsByDrawer[did] || {};
  var ms = MONTHS.filter(function(m) { return byMonth[m] !== undefined; }).slice(-5);
  var vals = ms.map(function(m) { return byMonth[m]; });
  VAR_MAX5[did] = vals.length ? Math.round(Math.max.apply(null, vals)) : 0;
});

// ── INJECT INTO TEMPLATE ───────────────────────────────────────────────────
var template = fs.readFileSync('magaot_v3_template.html', 'utf8');
var out = template
  .replace('INCOME_GROUPS_PLACEHOLDER', JSON.stringify(INCOME_GROUPS))
  .replace('RECURRING_PLACEHOLDER',     JSON.stringify(RECURRING_DATA))
  .replace('VARAVGS_PLACEHOLDER',       JSON.stringify(VAR_AVGS))
  .replace('VARTREND_PLACEHOLDER',      JSON.stringify(VAR_TREND))
  .replace('VARMONTH_PLACEHOLDER',      JSON.stringify(varTxnsByDrawer))
  .replace('VARTXN_PLACEHOLDER',        JSON.stringify(varTxnDetails))
  .replace('VARBIZCOUNT_PLACEHOLDER',   JSON.stringify(varBizMonthCount))
  .replace('VARMAX5_PLACEHOLDER',       JSON.stringify(VAR_MAX5))
  .replace('FIXEDTXN_PLACEHOLDER',      JSON.stringify(fixedTxnData));

fs.writeFileSync('magaot_app.html', out, 'utf8');

// ── STATS ──────────────────────────────────────────────────────────────────
console.log('INCOME_GROUPS  :', INCOME_GROUPS.length, 'groups');
var totalIncomeAvg = INCOME_GROUPS.reduce(function(s,g){ return s + g.monthlyEquiv; }, 0);
console.log('  Total avg    : \u20aa' + Math.round(totalIncomeAvg).toLocaleString());
console.log('RECURRING_DATA :', RECURRING_DATA.length, 'items');
var totalFixed = RECURRING_DATA.reduce(function(s,r){ return s + r.monthlyEquiv; }, 0);
console.log('  Total fixed  : \u20aa' + Math.round(totalFixed).toLocaleString());
console.log('VAR_AVGS       :', JSON.stringify(VAR_AVGS));
console.log('VAR_MONTH_DATA :', JSON.stringify(Object.keys(varTxnsByDrawer)));
console.log('VAR_MAX5       :', JSON.stringify(VAR_MAX5));
console.log('Output         : magaot_app.html (' + Math.round(out.length/1024) + ' KB)');
