# מגירות App — סיכום מצב נוכחי (v4)
_עודכן: אפריל 2026_

---

## מה קיים עכשיו

### קבצים עיקריים
| קובץ | תיאור |
|---|---|
| `magaot_app.html` | **האפליקציה הפעילה** (104 KB, generated) |
| `magaot_v3_template.html` | תבנית HTML עם כל ה-JS (placeholders בתוכה) |
| `gen.js` | סקריפט build — קורא data files → מעבד → מזריק ל-template → כותב `magaot_app.html` |
| `server.js` | שרת HTTP פשוט על פורט 3456 (מגיש `magaot.html` ב-root, שאר קבצים לפי שם) |
| `data_YYYY-MM.json` | נתוני RiseUp גולמיים לכל חודש (2025-07 עד 2026-03) |
| `txn_YYYY-MM.json` | נתוני RiseUp חלופיים לחודשים 01-03/2026 |
| `.claude/launch.json` | הגדרת preview server (`magaot`, port 3456, autoPort) |

### כדי לבנות מחדש
```bash
cd "C:/Users/ariel/Documents/claude/מגירות"
node gen.js
# → מייצר magaot_app.html
```

### כדי להפעיל preview
מתוך Claude Code: השתמש ב-`preview_start` עם שם `magaot`, ואז נווט ל-`/magaot_app.html`.

---

## ארכיטקטורת הנתונים

### INCOME_GROUPS (מחושב ב-gen.js)
```js
[{
  id: "ig_XXXX",           // stableId מבוסס שם
  name: "משכורת משרד החינוך",
  cat: "משכורת",           // קטגוריה מ-RiseUp
  drawer: "salary",        // מגירת הכנסות (ראה טבלה למטה)
  monthAmounts: { "2025-07": 6338, "2025-08": 5726, ... },
  monthsPresent: 7,
  monthlyEquiv: 4164,      // ממוצע = total / months_present (לתצוגה בשורה)
  transactions: [{ id, date, amount, month }]
}]
// 60 קבוצות סה"כ
```

#### מגירות הכנסה (INCOME_DRAWERS)
| id | label | icon | n מקורות | ₪/חודש |
|---|---|---|---|---|
| `salary` | משכורות | 💼 | 3 | ₪4,683 |
| `business` | הכנסות עסקיות | 💹 | 26 | ₪34,041 |
| `benefits` | קצבאות ממשלה | 🏛️ | 2 | ₪4,875 |
| `refunds` | החזרים וזיכויים | 📄 | 13 | ₪1,590 |
| `transfers` | העברות | 🔄 | 8 | ₪1,307 |
| `other_inc` | אחר | 📦 | 8 | ₪20,675 |

**חישוב הממוצע הכולל:** `computeIncomeAvg()` = סכום הכנסות לפי חודש / מספר חודשים = **₪63,367** (שיטת v2 — נכונה).

### RECURRING_DATA (מחושב ב-gen.js)
```js
[{
  id: "r_XXXX",
  name: "ביטוח לאומי הוראות ק",
  cat: "ביטוח לאומי",
  drawer: "insurance",     // מגירת קבועות
  type: "fixed",
  freq: "חודשי",           // חודשי (n>=5) או תקופתי
  monthsPresent: 9,
  monthlyEquiv: 3396,
  isMonthly: true,
  monthAmounts: { "2025-07": 3395, "2025-08": 3397, ... }  // חדש ב-v4!
}]
// 49 פריטים, סה"כ ~₪29,339/חודש
```

**סף סיווג:** רק עסקאות שהופיעו **בפחות 2 חודשים** מוכנסות ל-RECURRING_DATA (מסנן תשלומים חד-פעמיים).

#### מגירות קבועות (FIXED_DRAWERS)
| id | label | ~₪/חודש |
|---|---|---|
| `housing` | 🏠 דיור ומיסים | ₪8,148 |
| `comms` | 📡 תקשורת | ₪1,673 |
| `insurance` | 🛡️ ביטוחים | ₪6,068 |
| `invest` | 📈 השקעות וחיסכון | ₪984 |
| `loans` | 🏦 הלוואות | ₪960 |
| `other_fixed` | 📌 קבועות אחרות | ₪11,506 |

### VAR_AVGS / VAR_TREND
```js
VAR_AVGS  = { supermarket:5632, fuel:3255, kids:2472, entertainment:2743, shopping:4502, health:1070, other_var:76 }
VAR_TREND = { ... }  // ממוצע 3 חודשים אחרונים לכל מגירה
```

---

## State Schema (v4)
```js
state = {
  v: 4,
  // הכנסות
  incomeGroupExclusions: [],    // [groupId] — מקור שלם מנוטרל
  incomeMonthExclusions: {},    // { groupId: [month, ...] }
  incomeMonthOverrides: {},     // { groupId: { month: amount } }
  incomeOverride: null,         // דריסה גלובלית
  expandedIncomeGroups: {},     // { groupId: bool }
  // קבועות
  fixedExclusions: [],
  fixedOverrides: {},           // { itemId: amount } — item-level
  fixedMonthExclusions: {},     // { itemId: { month: true } }
  fixedMonthOverrides: {},      // { itemId: { month: amount } }
  fixedOverride: null,
  expandedFixedItems: {},       // { itemId: bool }
  // משותף
  drawerOpen: {},               // keys: drawer_id, 'v_'+var_id, 'inc_'+inc_id
  varBudgets: {},
  accumGoals: {},
  goals: [],
  manualFixed: [],
  manualVar: [],
  globalMonthExclusions: []     // חודשים מנוטרלים מכל החישובים
}
// localStorage key: 'magaot_v4'
// Migration: אם קיים 'magaot_v3', שדות רלוונטיים מועברים
```

---

## פיצ'רים שמומשו ב-v4

| פיצ'ר | מיקום | תיאור |
|---|---|---|
| **טאב הכנסות — מגירות** | `renderIncomeDrawers()` | 6 קטגוריות accordion (כמו הוצאות) |
| **פירוט חודשי — הכנסות** | `toggleIncomeExpand(id)` | לחיצה על מקור → שורות חודשיות |
| **צ'קבוקס + דריסה לחודש — הכנסות** | `toggleIncomeMonth()`, `onIncomeMonthOv()` | לכל חודש בכל מקור |
| **פירוט חודשי — קבועות** | `toggleFixedExpand(id)` | לחיצה על שם פריט → שורות חודשיות |
| **צ'קבוקס + דריסה לחודש — קבועות** | `toggleFixedMonth()`, `onFixedMonthOv()` | לכל חודש בכל פריט |
| **פילטר חודשים גלובלי** | `toggleGlobalMonth(m)` | שורת צ'יפים בכותרת → מוציא חודש מכל החישובים |
| **אינדיקטור מגמה** | `trendFrac()`, `trendHtmlInc/Exp()` | ↑↓→ ליד כל ממוצע |
| **סימון חריגים אוטומטי** | `autoFlagOutliers()` | ±1.5σ על חודשי כל מקור הכנסה |
| **לוח בקרה לחיץ** | `goToTab(name)` | כל מספר ב-dashboard ניווט לטאב |
| **State v4 + migration** | `loadState()` | העברה אוטומטית מ-v3 |

---

## פונקציות מפתח ב-JS

```
computeIncomeAvg()         — ממוצע הכנסות (לפי-חודש, כולל exclusions/overrides)
computeGroupEffective(g)   — ממוצע מקור בודד (לתצוגה בשורה)
computeDrawerIncomeAvg(gs) — ממוצע מגירת הכנסות
computeFixedItemEffective(g)— ממוצע פריט קבוע (מכבד month overrides)
getIncomeValue()           — הכנסה לדאשבורד (incomeOverride ?? avg)
getFixedValue()            — קבועות לדאשבורד (fixedOverride ?? breakdown)
renderIncomeDrawers()      — מרנדר טאב הכנסות
renderFixedDrawers()       — מרנדר טאב קבועות (כולל month rows)
renderVariableDrawers()    — טאב משתנות (ללא שינוי)
renderMonthChips()         — שורת פילטר חודשים
refreshDashboard()         — עדכון לוח בקרה
toggleGlobalMonth(m)       — toggle חודש גלובלי
toggleIncomeExpand(id)     — פתיחת/סגירת פירוט חודשי להכנסה
toggleFixedExpand(id)      — פתיחת/סגירת פירוט חודשי לקבוע
autoFlagOutliers()         — סימון חריגים ב-incomeMonthExclusions
goToTab(name)              — ניווט מ-dashboard לטאב
```

---

## מה עדיין ניתן לשפר (רעיונות לשיחה הבאה)

1. **מגירת "הכנסות עסקיות"** — 26 מקורות, רובם חד-פעמיים מחברת חותם הנדסה ופרו-סרוס עם ווריאציות בשם. ניתן לאחד אותם ל-"חותם הנדסה" ו-"פרו סרוס" אחד בכל אחד ב-gen.js (normalizeBusinessName).
2. **normalizeBusinessName** — "בינלאומי חותם ד.ד הנד ( (הערת X)" כולם מאותה חברה → לאחד לשם נקי.
3. **Push לגיטהאב** — גרסת v2 נדחפה (הופסקה באמצע), v4 עוד לא.
4. **מגירת "אחר"** כוללת העברה חד-פעמית של ₪160k — כדאי לסמן אותה אוטומטית כחריג.
5. **UI/UX** — הוסף tooltip לכל שם מקור קצוץ (title attribute קיים, אבל mobile).

---

## פקודות שימושיות

```bash
# בניה מחדש
cd "C:/Users/ariel/Documents/claude/מגירות" && node gen.js

# בדיקת syntax JS
node -e "var fs=require('fs'); fs.writeFileSync('chk.js', require('fs').readFileSync('magaot_app.html','utf8').match(/<script>([\s\S]*?)<\/script>/)[1])" && node --check chk.js

# בדיקת נתוני הכנסות
node -e "var g=JSON.parse(require('fs').readFileSync('magaot_app.html','utf8').match(/var INCOME_GROUPS\s*=\s*(\[[\s\S]*?\]);[\r\n]/)[1]); g.forEach(function(x){console.log(x.drawer.padEnd(12)+' '+Math.round(x.monthlyEquiv)+'\t'+x.name.slice(0,40))})"

# git push (אם צריך)
cd "C:/Users/ariel/Documents/claude/מגירות" && git add magaot_app.html magaot_v3_template.html gen.js && git commit -m "v4: income drawers, per-month drill-down, global month filter"
git push origin main
```
