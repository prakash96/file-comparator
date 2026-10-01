# File Comparator

A browser-only tool for comparing two data files: a DataStage extract before and after a change, a legacy job's output against its migrated replacement, or one environment against another. It shows what was **added, removed, modified, unchanged or duplicated**, down to the exact field values.

> **Files are processed locally in your browser and are not uploaded.**
> There is no backend. The production build also carries a Content-Security-Policy with `connect-src 'none'`, so the browser itself refuses any network connection from the app.

Supported formats: **CSV / delimited, fixed-width, MNT, JSON (and JSON Lines), XML, Excel (.xlsx / .xls), Avro and Parquet.** Source and target can be different formats, for example CSV against Parquet.

---

## Quick start

Requires Node.js 20 or later (developed on Node 24).

```bash
npm install
npm run dev        # http://localhost:5173
```

| Command | What it does |
|---|---|
| `npm run dev` | Development server with hot reload |
| `npm test` | Unit and end-to-end tests (Vitest, 72 tests) |
| `npm run build` | Typecheck, then production build into `dist/` |
| `npm run preview` | Serve the production build locally (with the CSP active) |
| `npm run bench` | Benchmark parse, compare and reports at 10k / 100k / 1M rows (`npm run bench -- 250000` for custom sizes) |
| `npm run samples` | Regenerate the sample files in `samples/` |
| `npm run gen-data -- 1000000` | Write large synthetic files to `samples/generated/` for manual browser testing |

### Deploying

`npm run build` produces a static site in `dist/` (an `index.html`, one JS bundle, one worker bundle and one CSS file). Asset paths are relative (`base: './'`), so it works from any web server path, S3/GCS bucket, SharePoint/intranet static host or internal CDN. No server-side code, environment variables or database are needed.

#### GitHub Pages

`.github/workflows/deploy.yml` runs the tests, builds and publishes `dist/` on every push to `main` (or on demand from the Actions tab). One-time setup: push the project to a GitHub repository, then in **Settings → Pages** set **Source** to **GitHub Actions**. The site appears at `https://<user>.github.io/<repo>/`. A failing test stops the deployment.

GitHub Pages sites are publicly reachable (except on GitHub Enterprise Cloud with private Pages). That exposes the app, not your data: files never leave the browser.

> Opening `dist/index.html` straight from disk (`file://`) is not supported: browsers do not allow module Web Workers from `file://`. Serve the folder with any static server, e.g. `npx vite preview` or `python -m http.server` in `dist/`.

---

## Using it

1. **Drop the SOURCE and TARGET files.** The format is detected from the file contents (magic bytes first, then content, with the file extension only as a tie-breaker). Each panel shows the file name, size, detected format, record count, columns, parse status and any warnings.
2. **Adjust parsing if needed** under *Format & parsing options*: delimiter (comma, pipe, tab, semicolon or custom, including multi-character delimiters like `||`), header yes/no, quote and escape character, text encoding; the fixed-width layout; the MNT record delimiter and optional column names; the JSON root path; the XML record element; the Excel worksheet and header row; flattened or nested handling of nested fields. Click **Apply & re-read file**.
3. **Review the schema comparison**: common columns, columns in only one file, data-type differences, nested-vs-flattened differences, and column order.
4. **Choose key column(s)** (composite keys are supported, in order) and the comparison rules:
   - case sensitivity
   - trimming whitespace
   - treating NULL and empty string as equal
   - numeric normalization (`007` = `7` = `7.00`, `12-` = `-12`)
   - floating-point tolerance
   - date normalization with configurable formats
   - matching columns by name or by position
   - ignored columns and compare-only columns
   - what to do with columns missing from one file: skip them, treat them as NULL, or stop with an error

   With no key, whole records are compared as a multiset.
5. **Compare.** The dashboard shows totals, a distribution chart, the most-changed columns, and a reconciliation check that proves the numbers add up:

   ```
   source = removed + modified + unchanged + duplicate-key records + empty-key records
   target = added   + modified + unchanged + duplicate-key records + empty-key records
   ```
6. **Explore the tabs**: Summary · Added · Removed · Modified · Unchanged · Duplicate Keys · Column Differences · Errors / Warnings. All tables are virtualized, searchable (by key, or across all columns) and sortable. On the Modified tab you can filter by changed column and expand a record to see each field's source and target values.
7. **Export**: Excel workbook, CSV files (`added.csv`, `removed.csv`, `modified.csv`, `unchanged.csv`, `duplicate-keys.csv`, `column-differences.csv`), a standalone HTML report, or a JSON summary.

### Sample files

`samples/` holds the same 20 customers in every format (`source.*` / `target.*`, plus `fixed-width-layout.json` for the fixed-width pair). Every pair contains the same intentional differences:

| Category | Customers |
|---|---|
| Removed | 3, 15 |
| Added | 21, 22 |
| Modified | 2 (STATUS), 5 (CREDIT_LIMIT), 9 (CITY), 12 (NAME + STATUS), 17 (CITY becomes NULL) |
| Duplicate keys | 7 twice in source, 11 twice in target |
| NULL vs empty | customer 4's EMAIL is NULL in source and `''` in target (equal while "NULL equals empty" is on) |

With key `CUSTOMER_ID` (use `@id` for the XML pair) every pair gives **added 2, removed 2, modified 5, unchanged 11, duplicate keys 2**. For the fixed-width pair, import `fixed-width-layout.json` in the layout editor. For the Excel pair, pick the `Customers` worksheet.

---

## Architecture

```
 UI thread (React)                        Web Worker (comparator.worker.ts)
 ─────────────────                        ──────────────────────────────────
 pages/ComparatorPage                     workers/session.ts  (ComparatorSession)
   └─ hooks/useComparator ──postMessage──▶   ├─ parsers/detect.ts      format detection
        (only bridge to the worker)          ├─ parsers/registry.ts    FileParser per format
   └─ hooks/useRemoteRows ◀── pages ─────    │     └─▶ Dataset (common model)
        (fetches visible rows only)          ├─ comparison/engine.ts   compareDatasets()
                                             │     └─▶ ComparisonResult (typed arrays)
                                             ├─ comparison/resultViews.ts  paging / search / sort
                                             └─ reports/registry.ts    CSV, Excel, HTML, JSON
```

The layers map to the folders:

| Layer | Folder | Depends on |
|---|---|---|
| Data model & contracts | `src/models/` | nothing |
| File adapters | `src/parsers/` | models |
| Normalization engine | `src/normalization/` | models |
| Comparison engine & result views | `src/comparison/` | models, normalization |
| Report generators | `src/reports/` | models, comparison |
| Worker host | `src/workers/` | all of the above |
| React presentation | `src/components/`, `src/pages/`, `src/hooks/` | models + the worker client only |

Key contracts:

- `FileParser` (`src/parsers/types.ts`): `parse(file: Blob, options, ctx) → { dataset, meta }`.
- `Dataset` / `NormalizedRecord` (`src/models/dataset.ts`): `fields: FieldInfo[]` plus `records: (string | null)[][]`. Every format ends up here, so nothing downstream knows or cares which format a file was.
- `ComparisonOptions`, `ComparisonSummary`, `RecordDifference` (`src/models/comparison.ts`).
- `ComparisonResult` (`src/comparison/engine.ts`): compact typed arrays of record indexes, never copies of records.
- `ReportGenerator` (`src/reports/types.ts`).
- `ExplanationProvider` (`src/ai/explanation.ts`): an optional, not-implemented hook for a future AI layer (see below).

The comparison engine is a pure function (`compareDatasets(source, target, options, onProgress)`) with no dependency on React, workers or file formats. It is unit-tested directly.

### How the comparison works

1. **Schema**: columns are paired by name (optionally ignoring case) or by position (for headerless extracts named `COL_1..n`).
2. **Column plan**: the key columns must exist in both files. The compared columns are what's left after applying ignore and compare-only, plus the missing-column rule.
3. **Index**: each record's key is normalized with the same rules as values, so `00123` and `123` match when numeric normalization is on. Keys go into `Map<string, recordIndex>`. A key that occurs more than once in either file becomes a duplicate group: all its records are reported under Duplicate Keys and none of them are classified as added, removed or modified. Records whose key columns are all empty are reported separately.
4. **Compare**: for each matched pair, every compared column goes through the value comparer. Identical raw values short-circuit, which covers most cells, so normalization only runs on cells that differ. The indexes of differing columns are stored in one flat `Int32Array`.
5. **No key**: records are matched by their full normalized signature (a multiset), which yields added, removed and unchanged records. Modified records can't be identified without a key.

---

## Large files

- **Nothing heavy runs on the UI thread.** Parsing, indexing, comparison, search, sort and report generation all happen in one Web Worker. The UI receives a file summary with a 100-row preview, the comparison summary, and pages of 200 rows as you scroll. In a 1M-row browser test the longest main-thread stall was 11 ms, and the page's own heap stayed at 8 MB.
- **Streaming reads.** Delimited, fixed-width, JSON Lines and Avro files are read in 4–8 MB slices (`Blob.slice`) and decoded incrementally. Parquet reads only the byte ranges hyparquet asks for, row group by row group.
- **Compact storage.** Each record is one array of strings, and low-cardinality columns (codes, flags, dates) are interned per column, which cut 1M-row heap by about 35%. Results are typed arrays of record indexes; no record is copied.
- **Virtualized tables.** Only the visible rows are in the DOM (about 40), whatever the result size.
- **Memory is released** when a file is removed (the worker drops that dataset and any result) and on **Reset** or **Cancel**, which terminate the worker entirely.

### Benchmark

Node 24 on the development machine, 10-column pipe-delimited extracts, key `CUSTOMER_ID`, numeric normalization on (`npm run bench`):

| Rows per file | Text size | Parse both | Compare | Heap after compare | Correct |
|---|---|---|---|---|---|
| 10,000 | 2 MB | 0.06 s | 0.04 s | 51 MB | ✓ |
| 100,000 | 19 MB | 0.28 s | 0.22 s | 150 MB | ✓ |
| 1,000,000 | 197 MB | 3.8 s | 3.6 s | 952 MB | ✓ |

Report generation for 1M rows: CSV and HTML well under 0.1 s. The Excel workbook is the slowest (about 5 s for 100k rows), so the benchmark skips it above 200k rows.

In Microsoft Edge (headless, same machine), the same 1M-row pair loads in 4.6 s and compares in 1.2 s.

**Practical limits.** A browser tab can usually hold 2–4 GB. Expect about 0.5 GB per million 10-column records (952 MB for two 1M-row files in the benchmark), so two files of roughly 3–4M rows each is a practical ceiling. JSON documents and XML are parsed as a whole string, so they are limited to about 500 MB each; for bigger JSON use JSON Lines. Excel sheets are capped at 1,048,576 rows by Excel itself, so the Excel export truncates longer lists and says so; use CSV for complete lists.

---

## Privacy and security model

- No backend, no API calls, no analytics, no cloud storage, no LLM calls.
- **Enforced, not just promised:** the production build includes `Content-Security-Policy: connect-src 'none'`, so fetch, XHR, WebSocket and beacon requests are blocked by the browser. The only requests the page makes are for its own static assets, which was verified in a real browser.
- File contents are never logged to the console and never written to `localStorage` or IndexedDB. Browser storage holds only the light/dark theme choice and any fixed-width layouts you explicitly save (column names and positions only).
- Error messages are written for people. Exception text and parser state appear only behind a **Technical details** toggle, and never include record values.
- The JSON summary export contains counts, configuration and schema only: no record values.
- **Reset** terminates the worker, which frees every byte of loaded data.

---

## Engineering decisions (and deviations from the original brief)

| Decision | Why |
|---|---|
| **Own streaming CSV tokenizer instead of Papa Parse** | Papa Parse streams a `File` through `FileReader` and can't be fed arbitrary chunks. The tokenizer here reads `Blob.slice()` chunks identically in the browser worker and in Node tests. It also supports a separate escape character, multi-character delimiters, and exact line numbers for DataStage-style messages like "Record 1,204 (line 1,206) has 10 fields; the header has 5". It is tested for chunk-boundary correctness (the same result for every chunk size from 1 byte up). |
| **Own XML scanner instead of `DOMParser`** | `DOMParser` doesn't exist inside Web Workers, and a DOM for a large extract would double memory. The scanner emits events in one pass, checks well-formedness (tag matching, single root, unclosed comments/CDATA), and reports the failing line. |
| **Own Avro reader instead of `avsc`** | `avsc` depends on Node `Buffer` and streams. The reader here (`src/parsers/avro/`) supports the full Avro 1.11 type system and logical types (decimal, date, time-*, timestamp-* including micros/nanos, uuid). Codecs: null, deflate (the browser's built-in `DecompressionStream`), snappy and zstandard (from hyparquet). |
| **hyparquet + hyparquet-compressors for Parquet** | Pure JS, no WASM, no dependencies, and it reads byte ranges on demand. DECIMAL values are re-rendered at their declared scale, and timestamps keep micro/nanosecond precision. |
| **SheetJS 0.20.3 from the SheetJS CDN** | The `xlsx` package on npm is frozen at 0.18.5 and has published advisories. SheetJS distributes maintained releases from `cdn.sheetjs.com`, which is where `package.json` points. |
| **All values held as canonical strings** | This is lossless: numbers are compared by their decimal text, so DECIMAL(38,x) values don't lose digits to floating point. Dates, booleans and nested values are rendered once to a canonical form. |
| **No virtualization, chart or state library** | The virtual list, bar charts and state hook are small and specific. Runtime dependencies are just React, SheetJS, hyparquet and hyparquet-compressors. |
| **Whole-record (multiset) mode when no key is chosen** | This gives a meaningful answer for keyless DataStage outputs instead of an error. |
| **Duplicate keys are excluded from the other categories** | Records with an ambiguous key are reported once, under Duplicate Keys, so the reconciliation always balances. |
| **Composite key with every part empty = "missing key"** | A key with some parts empty is still a valid key (many composite keys have optional parts). |
| **Dates** | Recognized only when date normalization is on. ISO-8601 is always recognized, and zone offsets are converted to UTC. A midnight time is dropped (`2024-01-31 00:00:00` equals `2024-01-31`), and 2-digit years pivot at 50. |

Other behaviour to know:

- CSV rows with extra fields keep the extra values in `COL_n` columns instead of dropping them.
- Nested data can be **flattened** (`address.city`) or kept **nested**, where objects are compared as canonical JSON with sorted keys.
- Arrays are always compared as a whole (canonical JSON).
- XML attributes become `@name` fields. Repeated child elements become an array.

---

### MNT files

An `.mnt` file has one XML-style header element on the first line, followed by headerless delimited records:

```
<Header line_count="732" download_id="Price_Update_2_839_20260623200819.mnt" target_org_node="STORE:839" .../>
INSERT|PRICE_UPDATE_2|347014989|REGULAR_PRICE|STORE|839|109.01|2026-06-27 00:00:00||1|15692773|RPM||REGULAR
```

The header attributes appear in the file details, and `line_count` is checked against the number of records. The records are compared like any headerless delimited file: pipe by default, no quote handling, and columns named `COL_1…COL_n` unless you enter column names under *Format & parsing options*.

## FFD tools

The **FFD tools** page (`#/ffd`) works with Flat File Definitions: the MuleSoft / DataWeave flat file schema in YAML (see `samples/ffdschema.ffd`). It supports `form: FLATFILE` (several record types told apart by a `tagValue`, grouped by `structures`) and `form: FIXEDWIDTH` (one record type).

- **Generate FFD from text.** Paste or open sample fixed-width text. The generator:
  - finds the record-type tag, either a length prefix such as ` 0630` (the record length after the prefix) or a short code such as `HDR` / `DTL`, or you set its position and length yourself;
  - splits each record type into fields at blank columns;
  - builds a structure from the order records appear in, so record types that repeat become a `count: '>1'` group.

  The result opens in the **layout editor**. You can also open an existing `.ffd` there, or start from a blank layout. In the editor:
  - **Ruler:** the sample records appear under a column ruler, one tab per record type.
    - Click the ruler (or Shift+click a record) to start a field at that column.
    - Drag a ▼ marker to move a boundary; double-click it to remove the boundary.
    - With the ruler focused, arrow keys move the selected boundary and Alt+arrow keys select fields.
  - **Field table:** name, start, length, type, tag value, justification, implied decimals and date pattern for each field, with the value in the selected record, plus *Merge ↓* and *Delete*.
  - **Shared header:** *Share 1–N* copies fields 1–N to every other record type. Each record type keeps its own tag value and total length.
  - **Record types:** rename, duplicate or delete them (structure references follow), and *Fit to N* when the record length differs from the sample.
  - **History and checks:** undo and redo (Ctrl+Z / Ctrl+Y). Duplicate field names, duplicate tags and tag-length mismatches are flagged.
  - **FFD output:** the FFD YAML updates live. It can also be edited directly, then copied, downloaded, or applied to the sample.
- **Apply FFD → JSON.** Paste or open an FFD and sample text. You can choose:
  - how records are separated (one per line, or back to back with no line breaks);
  - which structure to group by, or a plain list of records;
  - whether padding is trimmed.

  The JSON updates as you edit. Records that don't fit the structure are listed under `_unmatched`, with a warning. Integer and Decimal fields (including `format: { implicit: n }`) become JSON numbers when they fit without losing precision.

The code is in `src/ffd/` (`ffdYaml.ts` reads and writes schemas, `applyFfd.ts`, `inferFfd.ts`, `layoutOps.ts` for the editor's operations) and has no UI dependencies. The page is `src/pages/FfdPage.tsx`, and the editor is `src/components/ffd/LayoutEditor.tsx`.

## Extending

### Add a file format

1. Add the format id to `FileFormat` and `FILE_FORMAT_LABELS` in `src/models/dataset.ts`.
2. Implement `FileParser` in `src/parsers/<format>/`. Produce a `Dataset`, using `ObjectRecordBuilder` if your records are JS objects. Report problems through `ctx.issues`, check `ctx.checkCancelled()` in loops, and call `ctx.progress()`.
3. Register it in `src/parsers/registry.ts`.
4. Teach `src/parsers/detect.ts` to recognize it (magic bytes or content).
5. If it has options, add them to `ParseOptions` (`src/models/parseOptions.ts`) and a form section in `src/components/FormatOptions.tsx`.
6. Add tests in `tests/parsers.test.ts`.

Nothing in `comparison/`, `reports/` or the result views needs to change.

### Add a normalization rule

1. Implement `NormalizationRule` in `src/normalization/rules.ts`:

   ```ts
   export const stripLeadingZerosRule: NormalizationRule = {
     id: 'strip-zeros',
     description: 'Remove leading zeros from codes',
     isEnabled: (o) => o.stripLeadingZeros,
     apply: (v) => v.replace(/^0+(?=.)/, ''),
   };
   ```

2. Insert it at the right position in `NORMALIZATION_RULES`. Rules run in order, and a rule returning `null` makes the value NULL.
3. Add the switch to `NormalizationOptions` and `ComparisonOptions` (with a default in `defaultComparisonOptions()`), a `Toggle` in `src/components/ComparisonConfig.tsx`, and a line in `optionRows()` (`src/reports/summaryData.ts`) so reports show it.
4. Add tests in `tests/normalization.test.ts`.

### Add a report format

1. Implement `ReportGenerator` (`src/reports/types.ts`). Read rows through `ctx.views.rows(view)` and `ctx.views.columns(view)`, and the summary through `ctx.result.summary`.
2. Add its id to `ReportKind` (`src/models/session.ts`) and register it in `src/reports/registry.ts`.
3. Add a button in `src/components/ExportBar.tsx`.

### Optional AI explanation layer (not implemented)

`src/ai/explanation.ts` defines `ExplanationProvider` and `buildExplanationInput()`. The input holds only the compact summary: counts, schema differences, per-column statistics, and a few sample changes whose values are **masked by default** (`AB-12` becomes `xx-99`). Raw files are never included. Wiring a provider in later needs no change to parsing or comparison.

---

## Tests

`npm test` runs 72 tests (Vitest, Node environment):

| File | Covers |
|---|---|
| `tests/engine.test.ts` | identical files, added, removed, modified, duplicate keys, composite keys, NULLs, empty strings, column order, different column sets (skip / NULL / error), numeric values and tolerance, dates, case sensitivity, whitespace, ignore and compare-only, whole-record mode, and a 200k-row dataset |
| `tests/normalization.test.ts` | trim, case, NULL/empty, canonical numbers (including 30-digit decimals and trailing signs), date patterns, ISO with zone offsets, tolerance |
| `tests/parsers.test.ts` | CSV (quotes, escapes, multi-character delimiters, every chunk size, encodings, field-count warnings), fixed-width, JSON / JSON Lines / root paths / malformed JSON, XML (attributes, CDATA, entities, malformed), Excel (sheets, dates, float noise), Avro (null + deflate codecs, logical types, truncation), Parquet, format detection |
| `tests/session.test.ts` | the worker host end to end: detection, compare, paging, search, sort, changed-column filter, every report format, cancellation, reset, masked AI input |
| `tests/ffd.test.ts` | FFD schema parsing (the sample FFD, validation messages, round trip), applying it (lines and back-to-back records, structures, unmatched records, numeric types) and generating FFDs from text (length-prefix and code tags, groups, single record type) |
| `tests/layoutOps.test.ts` | layout editor operations: split, move boundary (clamped), merge, delete, resize, fit length, rename, duplicate and delete record types, shared header, layout checks |
| `tests/samples.test.ts` | every sample pair in every format gives the documented counts, plus cross-format pairs (CSV vs Parquet, CSV vs JSON) |

The UI was also driven in Microsoft Edge (headless, with the production CSP) for the CSV, XML, Avro and Parquet sample pairs, the 1M-row pair, and every export. There were no console errors and no requests beyond the app's own assets.
