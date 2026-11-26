# المالية — قسم المالية (للمالك فقط) · Finance section (owners only)

قسم «المالية» يحل محل ملفات Excel الثلاثة (الفرع 1، الفرع 2، الملف الرئيسي). يشمل قائمة الدخل لكل فرع، وقائمة الدخل المجمعة، ومقارنة الفروع، وتحليل المبيعات، ودوران المخزون، والمصروفات، والتوالف، والأصول والإهلاك، وتكلفة المرتبات، واختبارات المطابقة، وسجل التعديلات.

**يظهر للمالك فقط.** لا يظهر للمشرف أو الموظف أو شاشة الحضور، **حتى لو عُلّمت له كل الصفحات** في الإعدادات. قاعدة البيانات نفسها ترفض أي سطر مالي لأي حساب ليس دوره `owner`.

## التثبيت (مرة واحدة)

1. افتح Supabase → SQL Editor → الصق محتوى `supabase-finance.sql` كاملًا → Run. يمكن تشغيله أكثر من مرة بأمان. يضيف جداول `fin_*` ودوالها فقط، ولا يغيّر أي شيء موجود.
2. ادخل للموقع بحساب المالك → «المالية (للمالك فقط)» → «إعدادات المالية» → «استيراد حزمة البيانات». اختر معًا: `settings.json` وكل ملفات CSV. تُقرأ الملفات في المتصفح وتُحفظ في قاعدة البيانات المحمية.
3. في «الفروع والربط مع فروع التطبيق» تأكد أن كل فرع مالي مربوط بفرع التطبيق الصحيح (`b1`، `b2`…).

> ⚠️ هذا المستودع **عام** (public). لا تضع أبدًا ملفات CSV أو Excel أو JSON بها أرقام مالية داخله. ملف `.gitignore` يمنع `finance/data/` و `*.csv` و `*.xlsx`.

## الربط مع باقي التطبيق

| من التطبيق | في المالية |
|---|---|
| «الإدخال الشهري» (المبيعات، إجمالي الربح، صافي الربح) | يُعرض بجانب صافي المبيعات ومجمل الربح من البرنامج (ERP)، مع الفرق، في لوحة المالية وفي «تحليل المبيعات» و«المدخلات الشهرية». |
| «كشف الرواتب» (الراتب بالساعات + العمولة + المكافآت − الجزاءات − المسحوبات) | **قرار المالك:** من شهر نوفمبر 2026 تأتي المرتبات في قائمة الدخل من كشف الرواتب في التطبيق مباشرةً، مع إضافة مرتبات الملاك الثابتة من قسم المالية. من يناير إلى أكتوبر تبقى كما في ملفات Excel، وهي مطابقة للنتائج المرجعية. يمكن تغيير الشهر أو إيقاف الربط من «إعدادات المالية». |
| الموظفون (أكواد EK…) | قائمة موظفي المالية تحفظ كود الموظف في التطبيق عند تطابق الاسم. |

حساب المرتبات يتم بنفس الدالة التي تعرض صفحة «كشف الرواتب» (`payrollRows` في `index.html`)، فلا يمكن أن يختلف الرقمان.

## الملفات

| الملف | الوظيفة |
|---|---|
| `finance.js` | واجهة القسم. مُضاف مثل `crm.js`، ولا يعمل إلا لحساب المالك. |
| `finance-engine.js` | محرك الحسابات. مبني من `finance/src` ويُحمّل فقط عند دخول المالك للقسم. |
| `supabase-finance.sql` | جداول `fin_*` وقواعد الحماية (للمالك فقط) وسجل التعديلات وإغلاق الشهور. |
| `finance/` | الكود المصدري للمحرك (TypeScript) والاختبارات. |

## للمطوّر (Developer notes)

```bash
cd finance && npm install
```

```bash
npm test
```

`npm test` runs the golden tests: every month, line and branch of `expected_results.json`, plus payroll lines, units, behaviour and the app-payroll link. They need the private seed package copied to `finance/data/`; without it the data-based tests are skipped.

```bash
npm run build
```

`npm run build` rebuilds `../finance-engine.js` (esbuild, IIFE, global `ElkFin`). Run it after changing `finance/src`.

```bash
PGHOST=/tmp PGPORT=54322 PGUSER=postgres ./sql-tests/run.sh
```

This runs `supabase-finance.sql` on a **local** PostgreSQL. It checks that the owner can read and write; that a supervisor (even with every page ticked), an employee, the kiosk and anonymous users read 0 rows and cannot insert or reset; that writes are audited; and that closed months are locked.

### End-to-end harness (local only, never deployed)

`finance/e2e/` serves the real `index.html`, `crm.js` and `finance.js` against a local PostgreSQL, with a minimal stand-in for the app's own tables. `server.mjs` implements the small part of Supabase that supabase-js uses: password login with JWTs, and a PostgREST-compatible REST/RPC adapter that runs every request as the signed-in user, so the real RLS policies apply.

`run.cjs` (Playwright) covers these flows:
- The owner imports the data package and sees the expected YTD net sales and net result (read from the private `finance/data/expected_extra.json`). Checks show ✔ with 2 warnings.
- November payroll is read from the app.
- An expense added through the UI appears in the audit log.
- The consolidated P&L exports to `.xlsx`.
- The supervisor and the employee see no finance menu, see only the lock when a finance page is forced, and get 0 rows or refusals when querying `fin_*` directly from the browser console.

To run the harness, set up a local database (with `app_schema.sql`, then `supabase-finance.sql`), then start the server in one terminal and run the scenario in another:

```bash
DATABASE_URL=postgres://… node finance/e2e/server.mjs
```

```bash
node finance/e2e/run.cjs <screenshots-dir>
```

### Rules implemented (same as the Excel workbooks)

- Fiscal month 26 → 25.
- Expense classes `OPEX` / `STAFF` / `DEP`. Manual depreciation is excluded from the month the asset register starts.
- Straight-line asset register; it never uses "today".
- Stock adjustments: manual amount, or qty × unit cost.
- Finance payroll: `rate/26 × hours`, commission tiers with the 96% rule, lateness from the log from the configured month, and owners on separate lines.
- P&L: ratios in total columns are recomputed from totals.
- Sales YTD counts only months with sales. Turnover uses COGS ÷ average inventory.
- Consolidated = branches + shared column (shared costs are never allocated).
- Reconciliation checks: overall ✔ only when there is no ✖; warnings don't block.
