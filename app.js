/* ==========================================================================
 * app.js — DAC Dashboard application entry point
 *
 * Phase 3 scope:
 *   - Single bundle: router, payload loader, formatters, chart primitives,
 *     table renderer, source-tables tab UI
 *   - Year-agnostic: every reference to "2024" / "2023" derives from
 *     payload.meta.years and the current selected year
 *   - Public API exposed at window.Dash so future phases can migrate
 *     gradually
 *
 * Future phases will fill in the Executive (Phase 4) and Section (Phase 5)
 * renderers, replacing the placeholders below.
 * ========================================================================== */

(function () {
  'use strict';

  // ============================================================
  // GLOBAL STATE
  // ============================================================
  const state = {
    payload: null,
    year: null,              // currently selected year (string, e.g. "2024")
    route: null,             // { name: 'executive' | 'section' | 'ingest', sectionId?: 'A' }
    perTableYearView: {},    // per-table "current" vs "both" toggle state
    activeTableId: null,     // currently selected source-table tab
  };

  // ============================================================
  // STORAGE LAYER (Phase 6)
  // ============================================================
  // Abstraction over the persistence backend. Today it reads/writes to
  // localStorage; tomorrow swap the implementation to talk to Dataverse
  // and the rest of the app stays untouched.
  //
  // Two buckets:
  //   dac:overrides   { 'B2:2025': [[...rows...]], ... }
  //   dac:history     [ { ts, user, tableId, year, changes: [{rowIdx, colIdx, oldVal, newVal}] }, ... ]
  //
  // applyOverrides(payload) — at boot, merge any saved overrides into the
  //   payload so charts and tables reflect user edits.
  // saveTable(tableId, year, rows, user) — write rows and append a history entry.
  // getHistoryFor(tableId, year) — return entries (newest first).
  // resetTable(tableId, year) — drop the override; chart goes back to the payload.json baseline.
  // ============================================================

  const Storage = (function () {
    const OVERRIDES_KEY = 'dac:overrides';
    const HISTORY_KEY = 'dac:history';
    const YEARS_KEY = 'dac:years';

    function readJSON(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (e) {
        console.warn('Storage read failed for ' + key, e);
        return fallback;
      }
    }

    function writeJSON(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (e) {
        console.error('Storage write failed for ' + key, e);
        return false;
      }
    }

    function overrideKey(tableId, year) {
      return tableId + ':' + year;
    }

    return {
      /**
       * Apply all saved overrides on top of the payload object. The payload
       * is mutated in place. Safe to call multiple times.
       */
      applyOverrides(payload) {
        if (!payload || !payload.tables) return payload;
        const overrides = readJSON(OVERRIDES_KEY, {});
        Object.entries(overrides).forEach(([key, rows]) => {
          const sepIdx = key.indexOf(':');
          if (sepIdx < 0) return;
          const tableId = key.slice(0, sepIdx);
          const year = key.slice(sepIdx + 1);
          const t = payload.tables[tableId];
          if (!t) return;
          t.data = t.data || {};
          t.data[year] = rows;
        });
        return payload;
      },

      /**
       * Get the override for a specific table/year (or null if none).
       */
      getOverride(tableId, year) {
        const overrides = readJSON(OVERRIDES_KEY, {});
        return overrides[overrideKey(tableId, year)] || null;
      },

      /**
       * Persist a full set of rows for a table/year and record one history
       * entry describing the changes vs the previous state.
       *
       * History entry shape:
       *   {
       *     ts, user, email, tableId, year,
       *     changes: [
       *       { kind: 'cell',    rowIdx, colIdx, colLabel, rowLabel, oldVal, newVal },
       *       { kind: 'added',   rowIdx, newRow: [...] },
       *       { kind: 'deleted', rowIdx, oldRow: [...] }
       *     ]
       *   }
       *
       * @param {string} tableId
       * @param {string} year
       * @param {Array<Array>} newRows
       * @param {{name, email, oldRows, schema}} ctx
       */
      saveTable(tableId, year, newRows, ctx) {
        ctx = ctx || {};
        const overrides = readJSON(OVERRIDES_KEY, {});
        const oldRows = ctx.oldRows || overrides[overrideKey(tableId, year)] || [];
        const schema = ctx.schema || [];

        // ---- Detect row-level adds/deletes -----------------------------
        // Heuristic: pair rows by their first-cell label. If a label exists
        // in only one side, it's an add or delete.
        const oldLabels = oldRows.map(r => (r && r[0] != null) ? String(r[0]) : '');
        const newLabels = newRows.map(r => (r && r[0] != null) ? String(r[0]) : '');

        const oldByLabel = {};
        oldLabels.forEach((lbl, i) => {
          if (lbl) (oldByLabel[lbl] = oldByLabel[lbl] || []).push(i);
        });
        const newByLabel = {};
        newLabels.forEach((lbl, i) => {
          if (lbl) (newByLabel[lbl] = newByLabel[lbl] || []).push(i);
        });

        const changes = [];

        // Deleted rows: in oldByLabel but not in newByLabel (or fewer instances)
        Object.keys(oldByLabel).forEach(lbl => {
          const oldIdxs = oldByLabel[lbl] || [];
          const newIdxs = newByLabel[lbl] || [];
          for (let k = newIdxs.length; k < oldIdxs.length; k++) {
            changes.push({ kind: 'deleted', rowIdx: oldIdxs[k], oldRow: oldRows[oldIdxs[k]] });
          }
        });

        // Added rows: in newByLabel but not in oldByLabel (or more instances)
        Object.keys(newByLabel).forEach(lbl => {
          const oldIdxs = oldByLabel[lbl] || [];
          const newIdxs = newByLabel[lbl] || [];
          for (let k = oldIdxs.length; k < newIdxs.length; k++) {
            changes.push({ kind: 'added', rowIdx: newIdxs[k], newRow: newRows[newIdxs[k]] });
          }
        });

        // Cell-level diff for rows that exist in BOTH old and new (by label).
        // Pair them up in encounter order.
        const pairedOld = new Set();
        const pairedNew = new Set();
        Object.keys(oldByLabel).forEach(lbl => {
          const oIdxs = oldByLabel[lbl] || [];
          const nIdxs = newByLabel[lbl] || [];
          const n = Math.min(oIdxs.length, nIdxs.length);
          for (let i = 0; i < n; i++) {
            const oi = oIdxs[i], ni = nIdxs[i];
            pairedOld.add(oi);
            pairedNew.add(ni);
            const oRow = oldRows[oi] || [];
            const nRow = newRows[ni] || [];
            const colCount = Math.max(oRow.length, nRow.length);
            for (let c = 1; c < colCount; c++) {   // skip col 0 (label) — covered by pairing
              const oVal = oRow[c];
              const nVal = nRow[c];
              if (oVal !== nVal) {
                changes.push({
                  kind: 'cell',
                  rowIdx: ni,
                  colIdx: c,
                  rowLabel: lbl,
                  colLabel: schema[c] != null ? String(schema[c]) : '',
                  oldVal: oVal,
                  newVal: nVal
                });
              }
            }
          }
        });

        // Rows whose label is empty/blank — fall back to positional diff
        for (let r = 0; r < Math.max(oldRows.length, newRows.length); r++) {
          if (pairedOld.has(r) || pairedNew.has(r)) continue;
          const oRow = oldRows[r] || [];
          const nRow = newRows[r] || [];
          const oLabel = oRow[0];
          const nLabel = nRow[0];
          if (!oLabel && !nLabel) {
            // Both blank-labeled — positional cell diff
            const colCount = Math.max(oRow.length, nRow.length);
            for (let c = 0; c < colCount; c++) {
              if (oRow[c] !== nRow[c]) {
                changes.push({
                  kind: 'cell',
                  rowIdx: r,
                  colIdx: c,
                  rowLabel: '(unlabeled)',
                  colLabel: schema[c] != null ? String(schema[c]) : '',
                  oldVal: oRow[c],
                  newVal: nRow[c]
                });
              }
            }
          }
        }

        // Persist the new rows.
        overrides[overrideKey(tableId, year)] = newRows;
        writeJSON(OVERRIDES_KEY, overrides);

        // Append a history entry.
        const entry = {
          ts: Date.now(),
          user: ctx.name || 'anonymous',
          email: ctx.email || '',
          tableId,
          year,
          changes,
        };
        const history = readJSON(HISTORY_KEY, []);
        history.push(entry);
        writeJSON(HISTORY_KEY, history);

        return entry;
      },

      /**
       * Return history entries for a specific table+year (newest first).
       */
      getHistoryFor(tableId, year) {
        const history = readJSON(HISTORY_KEY, []);
        return history
          .filter(e => e.tableId === tableId && (!year || e.year === year))
          .sort((a, b) => b.ts - a.ts);
      },

      /**
       * Return ALL history entries (newest first). Used for a global activity log.
       */
      getAllHistory() {
        return readJSON(HISTORY_KEY, []).sort((a, b) => b.ts - a.ts);
      },

      /**
       * Drop the override for a table/year. Does NOT touch history.
       */
      resetTable(tableId, year) {
        const overrides = readJSON(OVERRIDES_KEY, {});
        delete overrides[overrideKey(tableId, year)];
        writeJSON(OVERRIDES_KEY, overrides);
      },

      /**
       * For debugging: list all override keys currently in localStorage.
       */
      listOverrides() {
        return Object.keys(readJSON(OVERRIDES_KEY, {}));
      },

      /**
       * Year management (Phase 6c)
       * --------------------------------
       * Users can extend the dashboard with new reporting years (e.g. 2026)
       * without redeploying the payload. Added years are persisted under
       * 'dac:years' and merged into meta.years at boot.
       */

      /**
       * Add a new year. Returns true if added, false if it already existed.
       */
      addYear(year) {
        const y = String(year);
        const years = readJSON(YEARS_KEY, []);
        if (years.includes(y)) return false;
        years.push(y);
        writeJSON(YEARS_KEY, years);
        return true;
      },

      /**
       * Remove a user-added year (does NOT touch baseline payload.meta.years).
       * Returns true if removed, false if it wasn't a user-added year.
       */
      removeYear(year) {
        const y = String(year);
        const years = readJSON(YEARS_KEY, []);
        const idx = years.indexOf(y);
        if (idx < 0) return false;
        years.splice(idx, 1);
        writeJSON(YEARS_KEY, years);
        // Also drop any overrides scoped to that year
        const overrides = readJSON(OVERRIDES_KEY, {});
        Object.keys(overrides).forEach(k => {
          if (k.endsWith(':' + y)) delete overrides[k];
        });
        writeJSON(OVERRIDES_KEY, overrides);
        return true;
      },

      /** Return the list of user-added years (oldest first). */
      getAddedYears() {
        return readJSON(YEARS_KEY, []);
      },

      /**
       * Merge user-added years into the payload's meta.years (sorted desc).
       * Returns the resulting array.
       */
      applyAddedYears(payload) {
        if (!payload || !payload.meta) return [];
        const added = readJSON(YEARS_KEY, []);
        if (added.length === 0) return payload.meta.years;
        const base = payload.meta.years || [];
        const all = Array.from(new Set([...base, ...added]));
        // Sort newest first
        all.sort((a, b) => parseInt(b) - parseInt(a));
        payload.meta.years = all;
        return all;
      },

      /**
       * Hard reset — drop ALL overrides, history, and added years.
       * Useful during development.
       */
      clearAll() {
        localStorage.removeItem(OVERRIDES_KEY);
        localStorage.removeItem(HISTORY_KEY);
        localStorage.removeItem(YEARS_KEY);
      },
    };
  })();

  // ============================================================
  // CONSTANTS
  // ============================================================

  // Short display titles for each table (used in the source-tables tab bar).
  // Kept as a simple lookup; the data team controls the long titles via the
  // payload (table.title_by_year).
  const SHORT_TITLES = {
    'A1': 'Incentive $', 'A2': 'Energy Savings', 'A3': 'Participants', 'A4': 'DAC Participants',
    'A5': 'Commercial Install', 'A6': 'Multifamily Install', 'A7': 'Multisector Install',
    'A8': 'Residential Install', 'A9': 'Comparison Summary', 'A10': 'Install Compare',
    'B1': 'Funding Spent', 'B2': 'Plugs Completed',
    'C1': 'DR Programs', 'C2': 'All Customers', 'C3': 'DAC Customers',
    'C4': 'Low-Income', 'C5': 'Total Program',
    'D1': 'Compensation Types', 'D2': 'DER Projects', 'D3': 'CDG & RC', 'D4': 'Net Metering',
    'E1': 'Capital Investments',
    'F1': 'Key Terms', 'F2': 'System Outages', 'F3': 'Interruption Rate',
    'F4': 'Non-Network', 'F5': 'Network', 'F6': 'Mixed Areas',
    'F7': 'DAC Outages', 'F8': 'Customers by Type', 'F9': 'Interrupted',
    'G1': 'Pipe Replaced', 'G2': 'Bronx Replaced', 'G3': 'Bronx Abandoned',
    'G4': 'Manhattan Replaced', 'G5': 'Manhattan Abandoned',
    'G6': 'Queens Replaced', 'G7': 'Queens Abandoned',
    'G8': 'Westchester Replaced', 'G9': 'Westchester Abandoned', 'G10': 'Emissions',
    'H1': 'Leaks Repaired',
    'I1': 'Year Totals',
    'J1': 'Electric Usage', 'J2': 'Gas Usage', 'J3': '60-90 Days Overdue',
    'J4': '90+ Days Overdue', 'J5': 'Disconnects', 'J6': 'DPAs',
    'J7': 'EAP Enrolled', 'J8': 'EAP Spending', 'J9': 'Residential Total'
  };

  // ============================================================
  // FORMATTERS
  // ============================================================

  /**
   * Format a number according to a "kind" hint.
   *   kind options: 'currency', 'currency_decimal', 'pct', 'ratio',
   *                 'decimal', 'int' (default: locale string)
   * Returns '—' for null/undefined/N/A.
   */
  function fmtNum(v, kind) {
    if (v === null || v === undefined || v === '' || v === 'N/A') return '—';
    if (typeof v === 'string') {
      const n = parseFloat(v.replace(/[, $%]/g, ''));
      if (isNaN(n)) return v;
      v = n;
    }
    if (kind === 'currency') {
      if (Math.abs(v) >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
      if (Math.abs(v) >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
      if (Math.abs(v) >= 1e3) return '$' + (v / 1e3).toFixed(0) + 'K';
      return '$' + v.toFixed(0);
    }
    if (kind === 'currency_decimal') return '$' + v.toFixed(2);
    if (kind === 'pct') return (Math.abs(v) <= 1 ? v * 100 : v).toFixed(1) + '%';
    if (kind === 'ratio') return v.toFixed(2) + 'x';
    if (kind === 'decimal') {
      return Math.abs(v) >= 1000
        ? v.toLocaleString(undefined, { maximumFractionDigits: 1 })
        : v.toFixed(2);
    }
    if (kind === 'int') return Math.round(v).toLocaleString();
    return v.toLocaleString();
  }

  /** Compact short form: 1.2B, 350M, 12K. */
  function fmtCompact(v) {
    if (v === null || v === undefined) return '—';
    if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(0) + 'K';
    return Math.round(v).toLocaleString();
  }

  /** Compact currency: $1.2B, $350M, $12K. */
  function fmtMoney(v) {
    if (v === null || v === undefined) return '—';
    if (Math.abs(v) >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (Math.abs(v) >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
    if (Math.abs(v) >= 1e3) return '$' + (v / 1e3).toFixed(0) + 'K';
    return '$' + Math.round(v).toLocaleString();
  }

  /** True if value parses as a number (string or number). */
  function isNumeric(v) {
    if (typeof v === 'number') return true;
    if (typeof v !== 'string') return false;
    const cleaned = v.replace(/[, $%]/g, '');
    return cleaned !== '' && !isNaN(parseFloat(cleaned)) && isFinite(parseFloat(cleaned));
  }

  /** Year-over-year delta as a fraction (0.05 = +5%). Returns null if invalid. */
  function deltaPct(curr, prev) {
    if (curr === null || prev === null || prev === 0 ||
        prev === undefined || curr === undefined) return null;
    return (curr - prev) / Math.abs(prev);
  }

  /** HTML-escape a string for safe insertion into innerHTML. */
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ============================================================
  // EMPTY-STATE HELPERS
  // ============================================================
  // Used when a chart or section has no data for the currently selected year
  // (e.g. 2025 placeholder rows or a table that hasn't been populated yet).
  // ============================================================

  /**
   * Detect whether a per-year data structure is effectively empty.
   * Treats null, undefined, empty arrays/objects, and all-null/all-zero rows
   * as empty. Cheap to call.
   */
  function isEmptyYearData(data) {
    if (data == null) return true;
    if (Array.isArray(data)) {
      if (data.length === 0) return true;
      // Rows of tables: skip the first column (label) and check the rest
      const allBlank = data.every(row => {
        if (!Array.isArray(row)) {
          // Object-shaped (charts like B2_plugs)
          if (row && typeof row === 'object') {
            return Object.values(row).every(v => v == null || v === 0 || v === '');
          }
          return row == null || row === '' || row === 0;
        }
        return row.slice(1).every(v => v == null || v === '' || v === 0);
      });
      return allBlank;
    }
    if (typeof data === 'object') {
      const values = Object.values(data);
      if (values.length === 0) return true;
      return values.every(v => v == null || v === 0 || v === '' || isEmptyYearData(v));
    }
    return data === '' || data === 0;
  }

  /**
   * Render a friendly "no data" placeholder for a year that hasn't been
   * populated. Used inline inside chart-card bodies.
   */
  function emptyYearPane(year, opts) {
    opts = opts || {};
    const msg = opts.message || `No data has been entered for ${year} yet.`;
    const hint = opts.hint || `Use the Data Ingestion page to add values for this year.`;
    return `
      <div class="empty-year-pane">
        <div class="empty-year-icon">∅</div>
        <div class="empty-year-msg">${escapeHtml(msg)}</div>
        <div class="empty-year-hint">${escapeHtml(hint)}</div>
      </div>`;
  }

  /**
   * Render an empty chart-card (head + empty body) — used when an entire
   * card needs an "no data" placeholder.
   */
  function emptyChartCard(title, subtitle, year) {
    return `
      <div class="chart-card">
        <div class="chart-card-head">
          <div><h3>${escapeHtml(title)}</h3><p class="chart-sub">${escapeHtml(subtitle || '')}</p></div>
        </div>
        ${emptyYearPane(year)}
      </div>`;
  }

  // ============================================================
  // YEAR HELPERS (year-agnostic)
  // ============================================================

  /** All available years sorted newest first (from payload.meta.years). */
  function allYears() {
    return state.payload ? state.payload.meta.years : [];
  }

  /** Year immediately before `year`, or null if none. */
  function prevYearOf(year) {
    const years = allYears();
    const i = years.indexOf(year);
    if (i < 0 || i + 1 >= years.length) return null;
    return years[i + 1];
  }

  // ============================================================
  // CHART PRIMITIVES (SVG / HTML builders)
  // ============================================================

  /**
   * Horizontal stacked bar chart: each item is split DAC vs non-DAC.
   * items: [{ name, dac, nondac, total }, ...]
   */
  function stackedBar(items, opts) {
    opts = opts || {};
    const max = opts.max || Math.max(...items.map(i => i.total));
    const labelW = opts.labelW || 140;
    const showYoy = typeof opts.yoyFor === 'function';
    return `<div class="bar-chart">${items.map(item => {
      const totalPct = max > 0 ? (item.total / max) : 0;
      const trackWidth = `${(totalPct * 100).toFixed(2)}%`;
      const dacPct = item.total > 0 ? item.dac / item.total : 0;
      const nondacPct = 1 - dacPct;
      const subVal = opts.showDacSplit !== false
        ? `<span class="bar-value-sub">${(dacPct * 100).toFixed(0)}% DAC</span>`
        : '';
      // Optionally emit data-* attrs so tooltips can read them (used by Section A)
      const dataAttrs = opts.dataAttrs
        ? Object.entries(opts.dataAttrs(item)).map(([k, v]) => `data-${k}="${escapeHtml(String(v))}"`).join(' ')
        : '';
      const rowClass = opts.rowClass ? ` ${opts.rowClass}` : '';

      // YoY pill (optional). yoyFor(item) returns a number (percent) or null.
      let yoyHtml = '';
      let gridCols = `${labelW}px 1fr auto`;
      if (showYoy) {
        const yoy = opts.yoyFor(item);
        gridCols = `${labelW}px 1fr auto 70px`;
        if (yoy === null || yoy === undefined) {
          yoyHtml = `<div class="bar-yoy"><span class="bar-yoy-pill bar-yoy-neutral">n/a</span></div>`;
        } else if (yoy === 0) {
          yoyHtml = `<div class="bar-yoy"><span class="bar-yoy-pill bar-yoy-neutral">→ 0%</span></div>`;
        } else if (yoy > 0) {
          yoyHtml = `<div class="bar-yoy"><span class="bar-yoy-pill bar-yoy-up">↑ +${yoy}%</span></div>`;
        } else {
          yoyHtml = `<div class="bar-yoy"><span class="bar-yoy-pill bar-yoy-down">↓ ${Math.abs(yoy)}%</span></div>`;
        }
      }

      return `
        <div class="bar-row${rowClass}" ${dataAttrs} style="grid-template-columns: ${gridCols};">
          <div class="bar-label" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
          <div class="bar-track" style="width:100%; background:transparent;">
            <div style="width:${trackWidth}; display:flex; height:100%; background:var(--white-smoke); border-radius:3px; overflow:hidden;">
              <div class="seg seg-dac" style="width:${(dacPct * 100).toFixed(2)}%"></div>
              <div class="seg seg-nondac" style="width:${(nondacPct * 100).toFixed(2)}%"></div>
            </div>
          </div>
          <div class="bar-value">${opts.fmt ? opts.fmt(item.total) : fmtCompact(item.total)}${subVal}</div>
          ${yoyHtml}
        </div>`;
    }).join('')}</div>`;
  }

  /**
   * Current-year vs previous-year comparison rows.
   * items: [{ name, curr, prev }, ...]
   * opts: { yearLabel, prevLabel, lower_is_better, fmt }
   */
  function compareRows(items, opts) {
    opts = opts || {};
    const max = Math.max(...items.flatMap(i => [i.curr, i.prev]).filter(v => v != null));
    const labelW = opts.labelW || 100;
    const yearLabel = opts.yearLabel || state.year;
    const prevLabel = opts.prevLabel || prevYearOf(state.year) || '';
    const fmt = opts.fmt || fmtCompact;
    return `<div>${items.map(item => {
      const cPct = max > 0 ? (item.curr / max * 100) : 0;
      const pPct = max > 0 ? (item.prev / max * 100) : 0;
      const d = deltaPct(item.curr, item.prev);
      const dCls = d == null ? '' : (d > 0.005 ? 'up' : d < -0.005 ? 'down' : '');
      const dArrow = d == null ? '' : (d > 0.005 ? '↑' : d < -0.005 ? '↓' : '·');
      const dLabel = d == null ? '—' : `${dArrow} ${(Math.abs(d) * 100).toFixed(1)}%`;
      const inv = opts.lower_is_better ? ' invert' : '';
      return `
        <div class="comp-row" style="grid-template-columns: ${labelW}px 1fr auto;">
          <div class="comp-label">${escapeHtml(item.name)}</div>
          <div class="comp-bars">
            <div class="comp-bar-line"><span class="yr">${yearLabel}</span><div class="bar-fill"><div style="width:${cPct.toFixed(1)}%"></div></div><span class="bar-num">${fmt(item.curr)}</span></div>
            <div class="comp-bar-line prev"><span class="yr">${prevLabel}</span><div class="bar-fill"><div style="width:${pPct.toFixed(1)}%"></div></div><span class="bar-num">${fmt(item.prev)}</span></div>
          </div>
          <div class="comp-delta ${dCls}${inv}">${dLabel}</div>
        </div>`;
    }).join('')}</div>`;
  }

  /**
   * Grouped vertical bars chart: current vs previous side-by-side per group.
   * items: [{ name, curr, prev }, ...]
   */
  function groupedBars(items, opts) {
    opts = opts || {};
    const w = 600, h = 180;
    const padL = 50, padR = 16, padT = 16, padB = 38;
    const innerW = w - padL - padR;
    const innerH = h - padT - padB;
    const max = Math.max(...items.flatMap(i => [i.curr, i.prev]).filter(v => v != null));
    const niceMax = Math.ceil(max / Math.pow(10, Math.floor(Math.log10(max))))
                    * Math.pow(10, Math.floor(Math.log10(max)));
    const groupW = innerW / items.length;
    const barW = Math.min(20, groupW * 0.32);
    const gap = 3;
    let bars = '', labels = '', yticks = '';
    const tickCount = 4;
    for (let i = 0; i <= tickCount; i++) {
      const v = (niceMax / tickCount) * i;
      const y = padT + innerH - (v / niceMax) * innerH;
      yticks += `<line x1="${padL}" x2="${w - padR}" y1="${y}" y2="${y}" stroke="var(--line)" stroke-width="0.5"/>`;
      yticks += `<text x="${padL - 6}" y="${y + 3}" font-size="9" fill="var(--text-3)" text-anchor="end" font-family="var(--font)">${fmtCompact(v)}</text>`;
    }
    items.forEach((item, i) => {
      const groupX = padL + i * groupW + (groupW - 2 * barW - gap) / 2;
      if (item.curr != null) {
        const ch = (item.curr / niceMax) * innerH;
        const cy = padT + innerH - ch;
        bars += `<rect x="${groupX}" y="${cy}" width="${barW}" height="${ch}" fill="var(--dusk)" rx="1"/>`;
      }
      if (item.prev != null) {
        const ph = (item.prev / niceMax) * innerH;
        const py = padT + innerH - ph;
        bars += `<rect x="${groupX + barW + gap}" y="${py}" width="${barW}" height="${ph}" fill="var(--pale-sky)" rx="1"/>`;
      }
      const labelX = padL + i * groupW + groupW / 2;
      labels += `<text x="${labelX}" y="${h - 18}" font-size="10" fill="var(--text-2)" text-anchor="middle" font-weight="600">${escapeHtml(item.name)}</text>`;
    });
    return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="xMinYMid meet">${yticks}${bars}${labels}</svg>`;
  }

  /**
   * Quadrant scatter plot: each item plotted by total (X) vs dac_pct (Y).
   * Reference lines at 50% on both axes split the chart into four quadrants.
   * items: [{ name, total, dac_pct }, ...]
   */
  function quadrant(items, opts) {
    opts = opts || {};
    const xLabel = opts.xLabel || 'Total Incentive Funding ($)';
    const xUnit = opts.xUnit || '';
    const w = 540, h = 280;
    const padL = 44, padR = 12, padT = 16, padB = 36;
    const innerW = w - padL - padR;
    const innerH = h - padT - padB;
    const xmax = Math.max(...items.map(i => i.total));
    const niceXmax = (function () {
      if (xmax <= 0) return 1;
      const pow = Math.pow(10, Math.floor(Math.log10(xmax)));
      const n = xmax / pow;
      let nice;
      if (n <= 1) nice = 1;
      else if (n <= 2) nice = 2;
      else if (n <= 2.5) nice = 2.5;
      else if (n <= 5) nice = 5;
      else nice = 10;
      return nice * pow;
    })();
    let dots = '', xticks = '', yticks = '';
    for (let i = 0; i <= 4; i++) {
      const v = (niceXmax / 4) * i;
      const x = padL + (v / niceXmax) * innerW;
      xticks += `<line x1="${x}" x2="${x}" y1="${padT}" y2="${padT + innerH}" stroke="var(--line)" stroke-width="0.5"/>`;
      xticks += `<text x="${x}" y="${h - 16}" font-size="9" fill="var(--text-3)" text-anchor="middle" font-family="var(--font)">${fmtCompact(v)}${xUnit ? ' ' + xUnit : ''}</text>`;
    }
    for (let i = 0; i <= 4; i++) {
      const v = i * 25;
      const y = padT + innerH - (v / 100) * innerH;
      yticks += `<line x1="${padL}" x2="${w - padR}" y1="${y}" y2="${y}" stroke="var(--line)" stroke-width="0.5"/>`;
      yticks += `<text x="${padL - 6}" y="${y + 3}" font-size="9" fill="var(--text-3)" text-anchor="end" font-family="var(--font)">${v}%</text>`;
    }
    // Horizontal reference at 50% parity
    const refY = padT + innerH - 0.5 * innerH;
    yticks += `<line x1="${padL}" x2="${w - padR}" y1="${refY}" y2="${refY}" stroke="var(--dusk)" stroke-width="0.8" stroke-dasharray="3 2"/>`;
    yticks += `<text x="${w - padR - 4}" y="${refY - 4}" font-size="8" fill="var(--pale-sky)" text-anchor="end" font-weight="600">50% parity</text>`;
    // Vertical reference at 50% of X axis
    const refX = padL + innerW * 0.5;
    yticks += `<line x1="${refX}" x2="${refX}" y1="${padT}" y2="${padT + innerH}" stroke="var(--dusk)" stroke-width="0.8" stroke-dasharray="3 2" opacity="0.6"/>`;
    items.forEach(item => {
      const x = padL + (item.total / niceXmax) * innerW;
      const dacPct = item.dac_pct;
      const y = padT + innerH - dacPct * innerH;
      const r = 3 + Math.sqrt(item.total) * (opts.dotScale || 0.0007);
      const above = dacPct >= 0.5;
      const color = above ? 'var(--dusk)' : 'var(--pale-sky)';
      const totalFmt = fmtCompact(item.total) + (xUnit ? ' ' + xUnit : '');
      dots += `<circle cx="${x}" cy="${y}" r="${Math.min(r, 18)}" fill="${color}" opacity="0.75" style="cursor:pointer" data-name="${escapeHtml(item.name).replace(/"/g, '&quot;')}" data-total="${totalFmt}" data-dac="${(dacPct * 100).toFixed(1)}%"></circle>`;
    });
    const xlabelText = `<text x="${padL + innerW / 2}" y="${h - 4}" font-size="10" fill="var(--text-3)" text-anchor="middle">${escapeHtml(xLabel)}</text>`;
    const ylabel = `<text x="14" y="${padT + innerH / 2}" font-size="10" fill="var(--text-3)" text-anchor="middle" transform="rotate(-90 14 ${padT + innerH / 2})">DAC Share</text>`;
    return `<svg class="scatter-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">${xticks}${yticks}${dots}${xlabelText}${ylabel}</svg>`;
  }

  // ============================================================
  // TABLE RENDERING (private helpers + public renderTable)
  // ============================================================

  /** True if row[0] is a "Total" / "Grand Total" / "Subtotal" / "X Total" label. */
  function isTotalRow(row) {
    if (!row || !row[0]) return false;
    const s = String(row[0]).trim().toLowerCase();
    return s === 'total' || s === 'grand total' || s === 'county total' ||
           s === 'subtotal' ||
           /\btotals?$/i.test(s) ||
           /\btotal\s+installations?$/i.test(s);
  }

  /** Returns an array of booleans: which columns are percentage columns. */
  function detectPctColumns(headerRow) {
    return headerRow.map(h => {
      if (h == null) return false;
      const s = String(h).toLowerCase().trim();
      return /(^|[\s\(])%/.test(s) || /%\s*(in\s+)?dac/.test(s) || /%\s*change/.test(s) ||
             /\bpct\b/.test(s) || /^percent(age)?\b/.test(s);
    });
  }

  function detectCurrencyColumns(headerRow) {
    return headerRow.map(h => {
      if (h == null) return false;
      const s = String(h).toLowerCase().trim();
      return /\$/.test(s) ||
             /amount/.test(s) ||
             /expended/.test(s) ||
             /funding/.test(s) ||
             /incentive/.test(s) ||
             /discount/.test(s) ||
             /electric\s*$/.test(s) ||
             /^gas\s*$/.test(s) ||
             /balance/.test(s) ||
             /investment/.test(s) ||
             /^20\d\d$/.test(s.trim());
    });
  }

  /** True if a row has text in column 0 and empty/null in the rest (a sub-header). */
  function isSubheaderRow(row) {
    if (!row || !row[0] || typeof row[0] !== 'string') return false;
    if (isTotalRow(row)) return false;
    for (let i = 1; i < row.length; i++) {
      const c = row[i];
      if (c !== null && c !== undefined && c !== '') return false;
    }
    return true;
  }

  /**
   * Render a 2D array of rows as an HTML table.
   * Supports 1-level or 2-level headers (opts.headerLevels = 1|2|0).
   */
  function renderTable(rows, opts) {
    opts = opts || {};
    const headerLevels = opts.headerLevels || 1;
    if (!rows || rows.length === 0) {
      return '<div class="empty-pane">No data available for this view.</div>';
    }

    const pctHeader = rows[headerLevels - 1] || rows[0];
    const pctCols = detectPctColumns(pctHeader);
    const tableCurrCols = opts.tableId && state.payload && state.payload.tables[opts.tableId]
      ? (state.payload.tables[opts.tableId].currency_cols || [])
      : [];
    const currCols = detectCurrencyColumns(pctHeader).map((v, i) => v || tableCurrCols.includes(i));

    function formatCell(c, colIdx, rowLabel) {
      if (c == null || c === '') return '';
      if (typeof c === 'string') return c;
      if (typeof c === 'number') {
        const isPctRow = rowLabel && /^percentage|^%/i.test(String(rowLabel).trim());
        if (pctCols[colIdx] || isPctRow) {
          return (Math.abs(c) <= 1 ? c * 100 : c).toFixed(1) + '%';
        }
        if (currCols[colIdx]) {
          if (Math.abs(c) >= 1e9) return '$' + (c / 1e9).toFixed(2) + 'B';
          if (Math.abs(c) >= 1e6) return '$' + (c / 1e6).toFixed(1) + 'M';
          if (Math.abs(c) >= 1e3) return '$' + (c / 1e3).toFixed(0) + 'K';
          return '$' + c.toLocaleString();
        }
        if (Number.isInteger(c) || Math.abs(c) >= 100) return c.toLocaleString();
        return c.toLocaleString(undefined, { maximumFractionDigits: 2 });
      }
      return String(c);
    }

    // Build header (0, 1, or 2 levels)
    let headerHtml = '';
    if (headerLevels === 0) {
      headerHtml = '';
    } else if (headerLevels === 1) {
      const headerRow = rows[0];
      const cells = headerRow.map(c => `<th>${c == null ? '' : escapeHtml(String(c))}</th>`).join('');
      headerHtml = `<thead><tr>${cells}</tr></thead>`;
    } else {
      // 2-level header support:
      //  - lvl1 with `null` after a value means "extend previous cell as colspan"
      //  - Also handles the legacy "consecutive identical values" pattern
      //  - lvl2 cells that are null/empty under a non-null lvl1 cell collapse:
      //    that lvl1 gets rowspan=2
      const lvl1 = rows[0];
      const lvl2 = rows[1];

      // Pass 1: compute colspan for each lvl1 cell.
      const spans = new Array(lvl1.length).fill(0);
      let i = 0;
      while (i < lvl1.length) {
        const v = lvl1[i];
        let span = 1;
        while (i + span < lvl1.length) {
          const nxt = lvl1[i + span];
          if (nxt === null || nxt === undefined || nxt === '' || nxt === v) {
            span++;
          } else {
            break;
          }
        }
        spans[i] = span;
        i += span;
      }

      // Pass 2: which lvl1 cells get rowspan=2 (their lvl2 slots are all empty)
      const rowspans = new Array(lvl1.length).fill(1);
      for (let idx = 0; idx < lvl1.length; idx++) {
        if (spans[idx] === 0) continue;
        const span = spans[idx];
        let allEmpty = true;
        for (let j = idx; j < idx + span; j++) {
          const c = lvl2 ? lvl2[j] : null;
          if (c !== null && c !== undefined && c !== '') { allEmpty = false; break; }
        }
        if (allEmpty) rowspans[idx] = 2;
      }

      // Build lvl1 row
      let lvl1Cells = '';
      for (let idx = 0; idx < lvl1.length; idx++) {
        if (spans[idx] === 0) continue;
        const v = lvl1[idx];
        const text = (v == null || v === '') ? '' : escapeHtml(String(v));
        const colspanAttr = spans[idx] > 1 ? ` colspan="${spans[idx]}"` : '';
        const rowspanAttr = rowspans[idx] === 2 ? ' rowspan="2"' : '';
        const cls = (text === '') ? '' : ' class="th-group"';
        lvl1Cells += `<th${colspanAttr}${rowspanAttr}${cls}>${text}</th>`;
      }

      // Build lvl2 row, skipping cells already covered by rowspan=2
      let lvl2Cells = '';
      for (let idx = 0; idx < lvl1.length; idx++) {
        if (spans[idx] === 0) continue;
        if (rowspans[idx] === 2) continue;
        const span = spans[idx];
        for (let j = idx; j < idx + span; j++) {
          const c = lvl2 ? lvl2[j] : null;
          const text = (c == null || c === '') ? '' : escapeHtml(String(c));
          lvl2Cells += `<th class="th-detail">${text}</th>`;
        }
      }

      headerHtml = `<thead><tr>${lvl1Cells}</tr><tr>${lvl2Cells}</tr></thead>`;
    }

    // Build body
    const body = rows.slice(headerLevels);
    const bodyRows = body.map((row, idx) => {
      let cls = '';
      if (isTotalRow(row)) {
        const isLastRow = idx === body.length - 1;
        cls = isLastRow ? ' class="is-total"' : ' class="is-subtotal"';
      } else if (isSubheaderRow(row)) {
        cls = ' class="is-subhead"';
      } else if (headerLevels === 2) {
        // In multilevel-header tables, every regular body row is a "row head"
        cls = ' class="is-rowhead"';
      }
      const cells = row.map((c, i) => {
        if (c == null || c === '') return '<td></td>';
        const isNAish = typeof c === 'string' && /^(n\/a|na|—|-)$/i.test(c.trim());
        const isNum = (typeof c === 'number' || (isNumeric(c) && i > 0) || (isNAish && i > 0));
        const numCls = isNum ? ' class="num"' : (c === 'Yes' && i > 0) ? ' class="dac-yes"' : '';
        return `<td${numCls}>${formatCell(c, i, row[0])}</td>`;
      }).join('');
      return `<tr${cls}>${cells}</tr>`;
    }).join('');

    return `<table class="data-table"${opts.tableId ? ` data-table-id="${opts.tableId}"` : ''}>${headerHtml}<tbody>${bodyRows}</tbody></table>`;
  }

  // ============================================================
  // SOURCE TABLES UI (tabs + current/both toggle, year-agnostic)
  // ============================================================

  /**
   * Render the source-tables tab bar + the active table card.
   *
   * tables: array of payload.table objects, each with
   *   - id, section, short_title (string)
   *   - data: { "2024": [...], "2023": [...] }  (some years may be absent)
   *   - title_by_year: { "2024": "...", "2023": "..." }
   *   - mapping: { status, comparable, notes }
   *   - header_levels?: 0 | 1 | 2
   *
   * year: currently selected year (string)
   * perTableView: { [tableId]: 'current' | 'both' }
   * activeTabId: which tab is currently selected
   */
  function renderSourceTables(tables, year, perTableView, activeTabId) {
    if (!tables || tables.length === 0) return '';

    const activeId = activeTabId || tables[0].id;

    // -- Tab bar -------------------------------------------------
    const tabsHtml = tables.map(t => {
      const tabNum = t.id.replace(/^([A-Z])(\d+)$/, '$1.$2');
      const shortTitle = t.short_title || SHORT_TITLES[t.id] || '';
      const isActive = t.id === activeId;
      return `<button class="src-tab${isActive ? ' active' : ''}" data-table-id="${t.id}" type="button">
        <span class="src-tab-num">${tabNum}</span>
        ${shortTitle ? `<span class="src-tab-title">${escapeHtml(shortTitle)}</span>` : ''}
      </button>`;
    }).join('');

    // -- Active table card ---------------------------------------
    const t = tables.find(x => x.id === activeId) || tables[0];
    const yearView = (perTableView && perTableView[t.id]) || 'current';
    const headerLevels = t.header_levels !== undefined ? t.header_levels : 1;
    const renderOpts = { headerLevels: headerLevels, tableId: t.id };
    const mapping = t.mapping || {};

    // Year-agnostic: compute prev year from payload
    const prevYear = prevYearOf(year);

    // All tables now use the unified schema_by_year format:
    //   schema_by_year[year]  → column header for that year
    //   data[year]            → body rows only (no header)
    // We synthesize the rendered table by prepending the header.
    const resolveRows = (yr) => {
      const raw = yr ? (t.data || {})[yr] : null;
      if (!raw || raw.length === 0) return raw;
      const schema = (t.schema_by_year || {})[yr];
      return schema ? [schema, ...raw] : raw;
    };

    const dataCurrent = resolveRows(year);
    const dataPrev = prevYear ? resolveRows(prevYear) : null;
    const titleCurrent = (t.title_by_year || {})[year] || ('Table ' + t.id);

    // Empty check on body rows only (no header to skip)
    const bodyRowsCurrent = (t.data || {})[year] || [];
    const bodyRowsPrev = prevYear ? ((t.data || {})[prevYear] || []) : [];
    const hasPrevData = bodyRowsPrev.length > 0 && bodyRowsPrev.some(r => r && r.slice(1).some(v => v != null && v !== ''));

    // -- Body: either current-only or side-by-side
    let bodyHtml = '';
    if (yearView === 'both') {
      const priorContent = hasPrevData
        ? renderTable(dataPrev, renderOpts)
        : `<div class="empty-pane">No data available for this view.</div>`;
      const priorLabel = prevYear ? `${prevYear} (prior)` : '(no prior year)';
      bodyHtml = `<div class="year-cols">
          <div class="year-col current"><div class="year-col-header">${year} (current)</div>${renderTable(dataCurrent, renderOpts)}</div>
          <div class="year-col"><div class="year-col-header">${priorLabel}</div>${priorContent}</div>
        </div>`;
    } else {
      bodyHtml = renderTable(dataCurrent, renderOpts);
    }

    // -- Badges (year-agnostic) ----------------------------------
    const cleanTitle = (titleCurrent || ('Table ' + t.id)).split('|')[0].trim();
    const partialBadge = (mapping.notes && /partial year/i.test(mapping.notes))
      ? `<span class="badge partial">PARTIAL YEAR ${prevYear || ''}</span>`
      : '';
    const isNew = !hasPrevData || (mapping.status || '') === 'NEW';
    const noPrevBadge = (prevYear && isNew)
      ? `<span class="badge no-2023">NO ${prevYear} BASELINE</span>`
      : '';
    const noteHtml = (mapping.notes && mapping.notes.trim())
      ? `<div class="mapping-note"><strong>Comparability:</strong> ${escapeHtml(mapping.notes)}</div>`
      : '';

    const yearToggleHtml = `
      <div class="year-toggle" data-table="${t.id}">
        <button data-year="current" class="${yearView === 'current' ? 'active' : ''}">Current Year</button>
        <button data-year="both" class="${yearView === 'both' ? 'active' : ''}">Compare with previous</button>
      </div>`;

    return `
      <div class="src-tabs-row">${tabsHtml}</div>
      <div class="table-card">
        <div class="table-card-header">
          <h3>${escapeHtml(cleanTitle)}</h3>
          <div class="table-meta-row">${noPrevBadge}${partialBadge}${yearToggleHtml}</div>
          ${noteHtml}
        </div>
        <div class="table-card-body">${bodyHtml}</div>
      </div>`;
  }

  /**
   * Wire click handlers for the year-toggle buttons and source-table tabs.
   * stateObj: object with mutable .perTableYearView and .activeTableId
   * rerenderFn: callback that re-renders the tables area
   */
  function wireYearToggles(stateObj, rerenderFn) {
    document.querySelectorAll('.year-toggle').forEach(tg => {
      const tableId = tg.getAttribute('data-table');
      tg.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          stateObj.perTableYearView[tableId] = btn.getAttribute('data-year');
          rerenderFn();
        });
      });
    });
    document.querySelectorAll('.src-tab').forEach(tab => {
      tab.addEventListener('click', e => {
        e.stopPropagation();
        stateObj.activeTableId = tab.getAttribute('data-table-id');
        rerenderFn();
      });
    });
  }

  // ============================================================
  // EXECUTIVE SUMMARY · DAC equity charts + analytical KPI cards
  // ============================================================

  // Baseline equity goal (35% = NY Climate Act 2019, 40% = Justice40)
  const BASELINE_KEY = 'coned_dac_baseline_pct';
  const BASELINE_DEFAULT = 35;

  function getBaseline() {
    const v = parseInt(localStorage.getItem(BASELINE_KEY), 10);
    return (v === 35 || v === 40) ? v : BASELINE_DEFAULT;
  }

  function setBaseline(n) {
    localStorage.setItem(BASELINE_KEY, String(n));
    document.dispatchEvent(new CustomEvent('baseline:changed', { detail: n }));
  }

  /**
   * Build the per-section DAC equity dataset for ALL years available in the
   * payload, year-agnostic. Used by all three equity charts.
   *
   * Returns: array of { id, name, radarName, pctByYear: { [year]: number|null },
   *                    invert, primaryKpi }
   */
  function buildSectionDAC() {
    const p = state.payload;
    const years = allYears();
    const sectionInfo = p.sections;
    const sectionLetters = Object.keys(sectionInfo);

    // Index reported KPIs by section, picking the one with the most useful
    // primary metric (currency-formatted takes priority, like the legacy code).
    const primaryBySec = {};
    p.kpis.reported.forEach(k => {
      if (!k.section) return;
      const sec = k.section;
      const prev = primaryBySec[sec];
      const isCurrency = k.format === 'currency';
      if (!prev || (isCurrency && prev.format !== 'currency')) {
        primaryBySec[sec] = k;
      }
    });

    return sectionLetters.map(s => {
      const kpi = primaryBySec[s];
      const pctByYear = {};
      years.forEach(y => {
        const v = kpi && kpi.values && kpi.values[y];
        pctByYear[y] = (v && v.dac_pct != null) ? v.dac_pct : null;
      });
      return {
        id: s,
        name: sectionInfo[s].short_name || sectionInfo[s].name,
        radarName: sectionInfo[s].short_name || sectionInfo[s].name,
        pctByYear: pctByYear,
        invert: !!sectionInfo[s].invert_metric,
        primaryKpi: kpi || null,
      };
    });
  }

  /** Format a primary-KPI value using the KPI's format hint (with B/M/K). */
  function fmtKpiVal(v, kpi) {
    if (v == null) return 'n/a';
    const f = kpi ? kpi.format : 'int';
    if (f === 'currency') {
      if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
      if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
      return '$' + Math.round(v / 1e3) + 'K';
    }
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
    return Math.round(v).toLocaleString();
  }

  function renderToggleBar() {
    const baseline = getBaseline();
    const baselineLabel = baseline === 40 ? 'Justice40 Initiative' : 'NY Climate Act';
    const goalWord = baseline === 40 ? 'goal' : 'mandate';
    return `
      <div class="rkpi-toggle-bar exec-toggle-bar">
        <span class="rkpi-toggle-label">DAC EQUITY BASELINE</span>
        <div class="rkpi-toggle-group" role="tablist">
          <button class="rkpi-toggle-btn ${baseline === 35 ? 'active' : ''}" data-baseline="35">35%<span class="toggle-sub">· NY Climate Act</span></button>
          <button class="rkpi-toggle-btn ${baseline === 40 ? 'active' : ''}" data-baseline="40">40%<span class="toggle-sub">· Justice40</span></button>
        </div>
        <span class="rkpi-toggle-help">DAC % shown vs the ${baseline}% ${baselineLabel} ${goalWord}</span>
      </div>
    `;
  }

  /** Strip chart: each section gets a horizontal DAC-share bar vs baseline. */
  function renderStripWithGap(baseline, year, sections) {
    const goal = baseline / 100;
    const data = sections.slice().sort((a, b) => a.id.localeCompare(b.id));

    function statusPill(s) {
      const pct = s.pctByYear[year];
      if (pct == null) return `<span class="sg-pill sg-pill-na">—</span>`;
      const gap = (pct - goal) * 100;
      if (s.invert) {
        if (gap > 5) return `<span class="sg-pill sg-pill-below">Critical</span>`;
        if (gap > 0) return `<span class="sg-pill sg-pill-near">Monitor</span>`;
        return `<span class="sg-pill sg-pill-above">OK</span>`;
      }
      if (gap > 5) return `<span class="sg-pill sg-pill-above">Above</span>`;
      if (Math.abs(gap) <= 0.5) return `<span class="sg-pill sg-pill-above">At goal</span>`;
      if (gap > -5) return `<span class="sg-pill sg-pill-near">Near</span>`;
      return `<span class="sg-pill sg-pill-below">Below</span>`;
    }

    const rows = data.map(s => {
      const pct = s.pctByYear[year];
      const has = pct != null;
      const pctNum = has ? pct * 100 : 0;
      const pctText = has ? pctNum.toFixed(1) + '%' : '—';
      const dacWidth = has ? pctNum : 0;
      const gap = has ? +((pct - goal) * 100).toFixed(1) : null;
      let gapText, gapColor;
      if (gap === null) { gapText = '—'; gapColor = 'var(--text-4)'; }
      else if (Math.abs(gap) < 0.5) { gapText = 'at goal'; gapColor = 'var(--green)'; }
      else if (gap > 0) { gapText = '+' + gap + 'pp'; gapColor = 'var(--dusk)'; }
      else { gapText = gap + 'pp'; gapColor = 'var(--red)'; }

      const kpi = s.primaryKpi;
      const v = kpi && kpi.values && kpi.values[year];
      const dacVal = v ? v.dac : null;
      const totalVal = v ? v.total : null;
      const kpiLabel = kpi ? kpi.label : '';
      const kpiUnit = kpi ? kpi.unit : '';
      const tt = `data-section="${s.id}" data-name="${escapeHtml(s.name)}" data-pct="${pctText}" data-baseline="${baseline}%" data-gap="${gapText}" data-kpi-label="${escapeHtml(kpiLabel).replace(/"/g, '&quot;')}" data-dac-val="${fmtKpiVal(dacVal, kpi)}" data-total-val="${fmtKpiVal(totalVal, kpi)}" data-unit="${escapeHtml(kpiUnit)}"`;

      return `
        <div class="strip-row" ${tt}>
          <div class="strip-label">${escapeHtml(s.name)}</div>
          <div class="strip-pct">${pctText}</div>
          <div class="strip-bar">
            <div class="strip-fill" style="width:${dacWidth}%;"></div>
            <div class="strip-tick" style="left:${baseline}%;"></div>
            ${!has ? '<span class="strip-empty-label">N/A</span>' : ''}
          </div>
          ${statusPill(s)}
          <div class="strip-gap" style="color:${gapColor}">${gapText}</div>
        </div>
      `;
    }).join('');

    return `
      <div class="exec-card sg-card">
        <div class="chart-card-head">
          <div>
            <h3>DAC Equity by Section</h3>
            <p class="chart-sub">Each bar = DAC share · Tick = ${baseline}% goal · ${year}</p>
          </div>
          <div class="chart-head-right">
            <div class="chart-legend">
              <div class="legend-item"><span class="legend-swatch" style="background:var(--dusk)"></span>DAC</div>
              <div class="legend-item"><span class="legend-swatch" style="background:var(--pale-sky)"></span>Non-DAC</div>
              <div class="legend-item"><span class="legend-swatch" style="background:#2873BA;width:2px;"></span>${baseline}% goal</div>
              <div class="legend-item"><span class="legend-swatch" style="background:rgba(42,119,85,0.55)"></span>Above</div>
              <div class="legend-item"><span class="legend-swatch" style="background:rgba(178,59,42,0.55)"></span>Below</div>
            </div>
          </div>
        </div>
        <div class="chart-body">
          <div class="sg-col-header">
            <span class="sg-ch-section">Section</span>
            <span class="sg-ch-pct">DAC %</span>
            <span class="sg-ch-bar">Share vs ${baseline}% goal</span>
            <span class="sg-ch-status">Status</span>
            <span class="sg-ch-gap">Gap</span>
          </div>
          <div class="strip-body">${rows}</div>
        </div>
      </div>
    `;
  }

  /** Dumbbell chart: each section shows YoY movement (prev → current). */
  function renderDumbbell(baseline, year, sections) {
    const prev = prevYearOf(year);
    const hasPrevYear = prev !== null;
    const data = sections.slice().sort((a, b) => a.id.localeCompare(b.id));

    const rows = data.map(s => {
      const curr = s.pctByYear[year];
      const prevPct = prev ? s.pctByYear[prev] : null;
      const hasCurr = curr != null;
      const hasPrev = prevPct != null;
      const hasBoth = hasCurr && hasPrev;

      let pillCls = 'dumb-pill-neutral';
      let pillText = '—';
      if (!hasBoth) {
        pillText = hasPrevYear ? '—' : 'no ' + (prev || 'prior');
      } else {
        const dpp = (curr - prevPct) * 100;
        if (s.invert) {
          if (dpp < -0.5) { pillCls = 'dumb-pill-up'; pillText = '↓ ' + Math.abs(dpp).toFixed(1) + 'pp'; }
          else if (dpp > 0.5) { pillCls = 'dumb-pill-down'; pillText = '↑ +' + dpp.toFixed(1) + 'pp'; }
          else { pillCls = 'dumb-pill-neutral'; pillText = '→ ' + Math.abs(dpp).toFixed(1) + 'pp'; }
        } else {
          if (dpp > 0.5) { pillCls = 'dumb-pill-up'; pillText = '↑ +' + dpp.toFixed(1) + 'pp'; }
          else if (dpp < -0.5) { pillCls = 'dumb-pill-down'; pillText = '↓ ' + dpp.toFixed(1) + 'pp'; }
          else { pillCls = 'dumb-pill-neutral'; pillText = '→ ' + Math.abs(dpp).toFixed(1) + 'pp'; }
        }
      }

      let barInner;
      if (!hasCurr) {
        barInner = `<div class="dumb-tick" style="left:${baseline}%;"></div>`;
      } else if (!hasBoth) {
        const pctNum = curr * 100;
        barInner = `
          <div class="dumb-tick" style="left:${baseline}%;"></div>
          <div class="dumb-dot dumb-dot-curr" style="left:${pctNum}%;"></div>`;
      } else {
        const currNum = curr * 100;
        const prevNum = prevPct * 100;
        const left = Math.min(currNum, prevNum);
        const width = Math.abs(currNum - prevNum);
        barInner = `
          <div class="dumb-tick" style="left:${baseline}%;"></div>
          <div class="dumb-connector" style="left:${left}%;width:${width}%;"></div>
          <div class="dumb-dot dumb-dot-prev" style="left:${prevNum}%;"></div>
          <div class="dumb-dot dumb-dot-curr" style="left:${currNum}%;"></div>`;
      }

      const currTxt = hasCurr ? (curr * 100).toFixed(1) + '%' : '—';
      const prevTxt = hasPrev ? (prevPct * 100).toFixed(1) + '%' : 'n/a';
      const kpi = s.primaryKpi;
      const v = kpi && kpi.values && kpi.values[year];
      const dacVal = v ? v.dac : null;
      const totalVal = v ? v.total : null;
      const kpiLabel = kpi ? kpi.label : '';
      const kpiUnit = kpi ? kpi.unit : '';
      const tt = `data-section="${s.id}" data-name="${escapeHtml(s.name)}" data-pct="${currTxt}" data-baseline="${baseline}%" data-gap="${pillText}" data-prev-pct="${prevTxt}" data-kpi-label="${escapeHtml(kpiLabel).replace(/"/g, '&quot;')}" data-dac-val="${fmtKpiVal(dacVal, kpi)}" data-total-val="${fmtKpiVal(totalVal, kpi)}" data-unit="${escapeHtml(kpiUnit)}"`;

      return `
        <div class="dumb-row ${!hasCurr ? 'is-na' : ''}" ${tt}>
          <div class="dumb-label">${escapeHtml(s.name)}</div>
          <div class="dumb-bar">${barInner}</div>
          <div class="dumb-pill ${pillCls}">${pillText}</div>
        </div>
      `;
    }).join('');

    const axisHtml = `
      <div class="dumb-axis">
        <div class="dumb-axis-inner">
          <span class="dumb-axis-tick">0%</span>
          <span class="dumb-axis-tick">25%</span>
          <span class="dumb-axis-tick dumb-axis-goal">${baseline}% goal</span>
          <span class="dumb-axis-tick">50%</span>
          <span class="dumb-axis-tick">75%</span>
          <span class="dumb-axis-tick">100%</span>
        </div>
      </div>
    `;

    const subText = hasPrevYear
      ? `Each row shows ${prev} → ${year} year-over-year movement per section`
      : `Showing ${year} only · No prior-year baseline available`;

    return `
      <div class="exec-card">
        <div class="chart-card-head">
          <div>
            <h3>DAC Equity · YoY Movement</h3>
            <p class="chart-sub">${subText}</p>
          </div>
          <div class="chart-head-right">
            <div class="chart-legend">
              <div class="legend-item"><span class="legend-swatch" style="background:#B0BCC9;border-radius:50%;width:11px;height:11px;"></span>${prev || 'prior'}</div>
              <div class="legend-item"><span class="legend-swatch" style="background:var(--dusk);border-radius:50%;width:11px;height:11px;"></span>${year}</div>
              <div class="legend-item"><span class="legend-swatch" style="background:#2873BA;width:2px;"></span>${baseline}% goal</div>
            </div>
          </div>
        </div>
        <div class="chart-body">
          <div class="dumb-body">${rows}</div>
          ${axisHtml}
        </div>
      </div>
    `;
  }

// ============================================================
  // DAC MAP · Replaces the Equity Radar chart in Executive Summary
  // v2 — fixes: title, subtitle, tooltip position, zoom, county bar
  // ============================================================

  let _mapGeoCache = null;
  let _leafletMapInstance = null;
  let _mapGeoLayer = null;

  async function getMapGeo() {
    if (_mapGeoCache) return _mapGeoCache;
    const res = await fetch('./map_payload.json');
    if (!res.ok) throw new Error('map_payload.json not found (' + res.status + ')');
    _mapGeoCache = await res.json();
    return _mapGeoCache;
  }

  function dacMapColor(score, isDAC) {
    // Non-DAC tracts: uniform light gray (no score-based coloring)
    if (isDAC === false) return '#a8a8a8';
    if (score == null || score === '') return '#b8b8b8';
    const s = parseFloat(score);
    if (isNaN(s))  return '#b8b8b8';
    if (s >= 120)  return '#0a2540';
    if (s >= 110)  return '#1e4d80';
    if (s >= 100)  return '#2f5496';
    if (s >= 90)   return '#6fa0d6';
    return '#d4e3f2';
  }

  const _mapState = { county: null };
// Compute and render KPI overlay for the DAC map
  function renderMapKPI(geo, county) {
    if (!geo || !geo.features) return;
    const panel = document.getElementById('dac-map-kpi');
    if (!panel) return;

    // Filter features by county if one is selected
    const feats = county
      ? geo.features.filter(f => f.properties.County === county)
      : geo.features;

    // Aggregate counts
    let dacN = 0, ndacN = 0;
    let dacElecAcc = 0, ndacElecAcc = 0;
    let dacGasAcc  = 0, ndacGasAcc  = 0;
    let dacElecEap = 0, ndacElecEap = 0;
    let dacGasEap  = 0, ndacGasEap  = 0;

    feats.forEach(f => {
      const p = f.properties;
      const isDAC = p.DAC_Desig === 'Designated as DAC';
      if (isDAC) {
        dacN++;
        dacElecAcc += (p.elec_accts || 0);
        dacGasAcc  += (p.gas_accts  || 0);
        dacElecEap += (p.elec_eap   || 0);
        dacGasEap  += (p.gas_eap    || 0);
      } else {
        ndacN++;
        ndacElecAcc += (p.elec_accts || 0);
        ndacGasAcc  += (p.gas_accts  || 0);
        ndacElecEap += (p.elec_eap   || 0);
        ndacGasEap  += (p.gas_eap    || 0);
      }
    });

    const fmtBig = v => {
      if (v == null || !isFinite(v)) return '—';
      if (v >= 1e6) return (v/1e6).toFixed(2) + 'M';
      if (v >= 1e3) return (v/1e3).toFixed(0) + 'K';
      return String(Math.round(v));
    };
    const pct = (num, den) => {
      if (!den || den <= 0) return '—';
      return (num/den*100).toFixed(1) + '%';
    };

    const scopeLabel = county
      ? (county === 'Kings' ? 'Brooklyn'
        : county === 'New York' ? 'Manhattan'
        : county === 'Richmond' ? 'Staten Is.'
        : county)
      : 'All boroughs';

    panel.innerHTML =
      '<div class="dac-kpi-head">' +
        '<span class="dac-kpi-eyebrow">Service area</span>' +
        '<span class="dac-kpi-scope">' + scopeLabel + '</span>' +
      '</div>' +
      '<div class="dac-kpi-card dac-kpi-card-dac">' +
        '<p class="dac-kpi-label">DAC tracts</p>' +
        '<p class="dac-kpi-value">' + dacN.toLocaleString() + '</p>' +
        '<p class="dac-kpi-sub">' + fmtBig(dacElecAcc) + ' elec · ' + fmtBig(dacGasAcc) + ' gas</p>' +
      '</div>' +
      '<div class="dac-kpi-card dac-kpi-card-ndac">' +
        '<p class="dac-kpi-label">Non-DAC tracts</p>' +
        '<p class="dac-kpi-value">' + ndacN.toLocaleString() + '</p>' +
        '<p class="dac-kpi-sub">' + fmtBig(ndacElecAcc) + ' elec · ' + fmtBig(ndacGasAcc) + ' gas</p>' +
      '</div>' +
      '<div class="dac-kpi-card">' +
        '<p class="dac-kpi-label">EAP enrolled (electric)</p>' +
        '<div class="dac-kpi-row"><span class="dac-kpi-row-k dac-kpi-row-dac">DAC</span><span class="dac-kpi-row-v">' + pct(dacElecEap, dacElecAcc) + '</span></div>' +
        '<div class="dac-kpi-row"><span class="dac-kpi-row-k dac-kpi-row-ndac">Non-DAC</span><span class="dac-kpi-row-v">' + pct(ndacElecEap, ndacElecAcc) + '</span></div>' +
      '</div>';
  }
  function renderDACMap(baseline, year, sections) {
    const mapId = 'dac-leaflet-map-' + Date.now();
    window._dacMapContainerId = mapId;

    const countyButtons = [
      { key: null,          label: 'All' },
      { key: 'Kings',       label: 'Brooklyn' },
      { key: 'Bronx',       label: 'Bronx' },
      { key: 'Queens',      label: 'Queens' },
      { key: 'New York',    label: 'Manhattan' },
      { key: 'Richmond',    label: 'Staten Is.' },
      { key: 'Westchester', label: 'Westchester' },
    ];

    const btnHtml = countyButtons.map(b =>
      `<button class="dac-map-county-btn${_mapState.county === b.key ? ' active' : ''}"
        data-county="${b.key === null ? '' : b.key}" type="button">${b.label}</button>`
    ).join('');

    return `
      <div class="exec-card dac-map-card">
        <div class="chart-card-head">
          <div>
            <h3>DAC Tracts · Combined Burden Score</h3>
            <p class="chart-sub">Census tracts colored by equity score · ${year}</p>
          </div>
        </div>
        <div class="dac-map-legend" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:10px;margin-bottom:4px">
          <span class="dac-map-legend-label">Score:</span>
          <span class="dac-map-leg-swatch" style="background:#d4e3f2"></span><span class="dac-map-leg-text">&lt;90</span>
          <span class="dac-map-leg-swatch" style="background:#6fa0d6"></span><span class="dac-map-leg-text">90–99</span>
          <span class="dac-map-leg-swatch" style="background:#2f5496"></span><span class="dac-map-leg-text">100–109</span>
          <span class="dac-map-leg-swatch" style="background:#1e4d80"></span><span class="dac-map-leg-text">110–119</span>
          <span class="dac-map-leg-swatch" style="background:#0a2540"></span><span class="dac-map-leg-text">120+</span>
          <span class="dac-map-leg-swatch" style="background:#e8e8e8"></span><span class="dac-map-leg-text">Non-DAC</span>
<span class="dac-map-leg-swatch" style="background:#b8b8b8"></span><span class="dac-map-leg-text">N/A</span>
        </div>
        <div class="dac-map-county-bar" style="flex-wrap:nowrap;gap:4px">${btnHtml}</div>
        <div style="position:relative;flex:1">
          <div id="${mapId}" class="dac-map-container"></div>
          <div id="dac-map-kpi" class="dac-map-kpi-panel"></div>
          <div id="dac-map-tooltip" class="dac-map-tooltip" style="opacity:0;position:absolute;z-index:9999;pointer-events:none;transition:opacity .12s"></div>
        </div>
      </div>
    `;
  }

  async function mountDACMap() {
    const containerId = window._dacMapContainerId;
    const container = document.getElementById(containerId);
    if (!container) return;

    if (_leafletMapInstance) {
      try { _leafletMapInstance.remove(); } catch(e) {}
      _leafletMapInstance = null;
      _mapGeoLayer = null;
    }

    container.innerHTML = '<div class="dac-map-loading">Loading tract data…</div>';

    let geo;
    try {
      geo = await getMapGeo();
    } catch(err) {
      container.innerHTML = '<div class="dac-map-loading dac-map-error">⚠ Could not load map_payload.json.</div>';
      return;
    }

    container.innerHTML = '';

    const map = L.map(containerId, {
      zoomControl: false,
      attributionControl: false,
    });
    _leafletMapInstance = map;

    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
    }).addTo(map);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png', {
      maxZoom: 19, pane: 'shadowPane',
    }).addTo(map);

    L.control.zoom({ position: 'bottomright' }).addTo(map);
    map.on('mouseout', function() {
      if (_hoveredLayer) {
        geoLayer.resetStyle(_hoveredLayer);
        _hoveredLayer = null;
      }
      if (tooltip) tooltip.style.opacity = '0';
    });

    function styleFeature(feature) {
      const active = _mapState.county;
      const fCounty = feature.properties.County;
      const dimmed = active && fCounty !== active;
      const isDAC = feature.properties.DAC_Desig === 'Designated as DAC';
      return {
        fillColor: dacMapColor(feature.properties.Comb_Sc, isDAC),
        fillOpacity: dimmed ? 0.12 : (isDAC ? 0.78 : 0.55),
        color: '#ffffff',
        weight: 0.6,
        opacity: dimmed ? 0.2 : 1,
      };
    }

    // Tooltip is now a sibling of the map container, inside the relative wrapper
    const tooltipWrapper = container.parentElement;
    const tooltip = tooltipWrapper ? tooltipWrapper.querySelector('#dac-map-tooltip') : null;

    let _hoveredLayer = null;

    function onEach(feature, layer) {
      const p = feature.properties;
      layer.on('mouseover', function() {
        // Clear any previously hovered layer that didn't get mouseout
        if (_hoveredLayer && _hoveredLayer !== this) {
          geoLayer.resetStyle(_hoveredLayer);
        }
        _hoveredLayer = this;
        this.setStyle({ weight: 2, color: '#e87722', fillOpacity: 0.92 });
        this.bringToFront();
        if (!tooltip) return;

        const fmtInt = v => v != null && isFinite(v) ? Math.round(v).toLocaleString() : null;
        const fmtMon = v => {
          if (v == null || !isFinite(v)) return null;
          const n = parseFloat(v);
          const sign = n < 0 ? '-' : '';
          const abs = Math.abs(n);
          if (abs >= 1e6) return sign + '$' + (abs / 1e6).toFixed(2) + 'M';
          if (abs >= 1e3) return sign + '$' + (abs / 1e3).toFixed(1) + 'K';
          return sign + '$' + abs.toFixed(2);
        };

        const dacDesig = p.DAC_Desig || '';
        const isDAC = dacDesig === 'Designated as DAC';
        const subline = [p.County, dacDesig].filter(Boolean).join(' · ');

        // Score/Rank/Pop line: only for DAC tracts (Non-DAC don't have these)
        let metaLine = '';
        if (isDAC && p.Comb_Sc != null) {
          const score  = parseFloat(p.Comb_Sc).toFixed(1);
          const rankSt = p.Rank_State != null ? parseFloat(p.Rank_State).toFixed(1) + '%' : '—';
          const pop    = fmtInt(p.Pop_Cnt) || '—';
          metaLine = '<div class="dac-tt-meta">Score ' + score + ' · State rank ' + rankSt + ' · pop ' + pop + '</div>';
        } else if (p.Pop_Cnt != null) {
          metaLine = '<div class="dac-tt-meta">pop ' + (fmtInt(p.Pop_Cnt) || '—') + '</div>';
        }

        

        // Helper to render a utility block, or a "no data" pane
        function utilityBlock(label, accts, eap) {
          let html = '<div class="dac-tt-section">' + label + '</div>';
          const acctsF = fmtInt(accts);
          const eapF   = fmtInt(eap);

          if (acctsF == null && eapF == null) {
            html += '<div class="dac-tt-empty">Outside ConEd ' + label.toLowerCase() + ' service area</div>';
            return html;
          }

          if (acctsF != null) html += '<div class="dac-tt-row"><span>Accounts</span><span class="dac-tt-v">' + acctsF + '</span></div>';
          if (eapF   != null) html += '<div class="dac-tt-row"><span>EAP enrolled</span><span class="dac-tt-v">' + eapF + '</span></div>';
          return html;
        }

        tooltip.innerHTML =
          '<div class="dac-tt-geoid">' + (p.GEOID || '') + '</div>' +
          '<div class="dac-tt-county">' + subline + '</div>' +
          metaLine +
          utilityBlock('Electric', p.elec_accts, p.elec_eap) +
          utilityBlock('Gas',      p.gas_accts,  p.gas_eap);

        tooltip.style.opacity = '1';
      });
      layer.on('mousemove', function(e) {
        if (!tooltip || !tooltipWrapper) return;
        const rect = tooltipWrapper.getBoundingClientRect();
        let x = e.originalEvent.clientX - rect.left + 12;
        let y = e.originalEvent.clientY - rect.top  - 8;
        const tw = tooltip.offsetWidth  || 210;
        const th = tooltip.offsetHeight || 180;
        if (x + tw > rect.width  - 4) x = x - tw - 20;
        if (y + th > rect.height - 4) y = y - th;
        if (x < 4) x = 4;
        if (y < 4) y = 4;
        tooltip.style.left = x + 'px';
        tooltip.style.top  = y + 'px';
      });
      layer.on('mouseout', function() {
        geoLayer.resetStyle(this);
        if (_hoveredLayer === this) _hoveredLayer = null;
        if (tooltip) tooltip.style.opacity = '0';
      });
    }

    const geoLayer = L.geoJSON(geo, {
      style: styleFeature,
      onEachFeature: onEach,
    }).addTo(map);
    _mapGeoLayer = geoLayer;
    // Initial KPI render
    renderMapKPI(geo, _mapState.county);

    // Use fixed initial view so "All" returns here (geoLayer bounds extend too far north into Westchester)
    const initialCenter = [40.93, -73.9];
    const initialZoom = 9.7;
    map.setView(initialCenter, initialZoom);
    const defaultBounds = geoLayer.getBounds();  // kept for reference but not used as the "All" target

    // County filter
    const bar = document.querySelector('.dac-map-county-bar');
    if (bar) {
      bar.addEventListener('click', function(e) {
        const btn = e.target.closest('.dac-map-county-btn');
        if (!btn) return;
        const county = btn.dataset.county || null;
        _mapState.county = county;
        bar.querySelectorAll('.dac-map-county-btn').forEach(b => {
          b.classList.toggle('active', (b.dataset.county || null) === county);
        });
        geoLayer.setStyle(styleFeature);
        renderMapKPI(geo, county);
        if (county) {
          const filtered = [];
          geoLayer.eachLayer(l => {
            if (l.feature.properties.County === county) filtered.push(l);
          });
          if (filtered.length) {
            const group = L.featureGroup(filtered);
            map.flyToBounds(group.getBounds(), { padding: [5, 5], duration: 0.5 });
          }
        } else {
          map.flyTo(initialCenter, initialZoom, { duration: 0.5 });
        }
      });
    }
  }



  /**
   * Compute the data for the 3 executive header cards (top of the page).
   * Returns array of card descriptors that renderHeaderCards consumes.
   */
  function computeHeaderCards() {
    const p = state.payload;
    const year = state.year;
    const prevYear = prevYearOf(year);

    // ---- Card 1: Strategic Capital Investments (Section E) ----
    const eCats = (p.charts.E1_categories && p.charts.E1_categories.values[year]) || [];
    const eCatsPrev = prevYear
      ? ((p.charts.E1_categories && p.charts.E1_categories.values[prevYear]) || [])
      : [];
    const eTotal = eCats.reduce((s, c) => s + (c.total || 0), 0);
    const eDacTotal = eCats.reduce((s, c) => s + (c.total || 0) * (c.dac_pct || 0), 0);
    const eDacPct = eTotal > 0 ? (eDacTotal / eTotal * 100) : null;
    const eDacPrev = eCatsPrev.length
      ? eCatsPrev.reduce((s, c) => s + (c.total || 0) * (c.dac_pct || 0), 0)
      : null;
    const eGrow = (eDacPrev && eDacPrev > 0)
      ? Math.round((eDacTotal - eDacPrev) / eDacPrev * 100)
      : null;

    // ---- Card 2: Clean Energy Incentive Spend (Section A) ----
    const ces = p.kpis.reported.find(k => k.id === 'clean_energy_spend');
    const cesCurr = ces && ces.values[year];
    const cesPrev = ces && prevYear && ces.values[prevYear];
    const cesDac = cesCurr ? cesCurr.dac : null;
    const cesDacPrev = cesPrev ? cesPrev.dac : null;
    const cesGrow = (cesDacPrev && cesDacPrev > 0 && cesDac != null)
      ? Math.round((cesDac - cesDacPrev) / cesDacPrev * 100)
      : null;

    // ---- Card 3: Unpaid Residential Accounts 90+ days (Section J) ----
    // Read from J4 table data: rows like ['Total in DAC', accounts, %, amount, %]
    const j4 = p.tables.J4;
    const j4Curr = j4 && j4.data && j4.data[year];
    const j4Prev = j4 && prevYear && j4.data && j4.data[prevYear];
    const j4Read = (rows) => {
      if (!rows) return null;
      let dacAmt = 0, nondacAmt = 0;
      rows.forEach(r => {
        if (!r || typeof r[0] !== 'string') return;
        const label = r[0].toLowerCase();
        // The "Total Amount" column is index 3 in both 2024 and 2023 schemas
        const amount = typeof r[3] === 'number' ? r[3] : 0;
        if (label.includes('total in dac')) dacAmt = amount;
        else if (label.includes('total in non-dac')) nondacAmt = amount;
      });
      const total = dacAmt + nondacAmt;
      return { dac: dacAmt, total: total, pct: total > 0 ? dacAmt / total * 100 : null };
    };
    const j4Now = j4Read(j4Curr);
    const j4Then = j4Read(j4Prev);
    const j4Grow = (j4Then && j4Then.dac > 0 && j4Now)
      ? Math.round((j4Now.dac - j4Then.dac) / j4Then.dac * 100)
      : null;

    // Helper to format big dollar values
    const fmtBig = v => {
      if (v == null) return '—';
      if (Math.abs(v) >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
      if (Math.abs(v) >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
      if (Math.abs(v) >= 1e3) return '$' + Math.round(v / 1e3) + 'K';
      return '$' + Math.round(v).toLocaleString();
    };

    return [
      {
        tag: 'Strategic Capital Investments',
        hero: fmtBig(eDacTotal),
        heroSub: 'DAC-exposed $',
        delta: eGrow !== null
          ? (eGrow >= 0 ? '↑ +' : '↓ ') + eGrow + '%'
          : (eDacPct !== null ? eDacPct.toFixed(1) + '%' : null),
        deltaSub: eGrow !== null ? 'YoY' : 'of total',
        deltaColor: eGrow !== null
          ? (eGrow >= 0 ? 'var(--green)' : 'var(--red)')
          : 'var(--green)',
        detail: eDacPrev !== null
          ? fmtBig(eDacPrev) + ' → ' + fmtBig(eDacTotal)
          : 'Weighted across ' + eCats.length + ' categories',
        href: '#/section/E',
        tooltip: {
          title: 'Strategic Electric Capital Investments',
          rows: [
            { label: 'Source', value: 'Section E · Capital tables' },
            { label: 'Categories', value: eCats.length + ' investment areas' },
            { label: 'Total invested ' + year, value: fmtBig(eTotal) },
            { label: 'DAC share', value: eDacPct !== null ? eDacPct.toFixed(1) + '%' : '—' },
            { label: 'DAC invested ' + year, value: fmtBig(eDacTotal) },
            { label: 'DAC invested ' + (prevYear || 'prior'), value: eDacPrev !== null ? fmtBig(eDacPrev) : 'n/a' },
          ],
          note: 'Dollar-weighted DAC % across Environmental, Risk Reduction, Safety & Security, and System Expansion capital investments.'
        },
      },
      {
        tag: 'Clean Energy Incentive Spend',
        hero: fmtBig(cesDac),
        heroSub: 'DAC incentive $',
        delta: cesGrow !== null
          ? (cesGrow >= 0 ? '↑ +' : '↓ ') + cesGrow + '%'
          : null,
        deltaSub: 'YoY',
        deltaColor: cesGrow !== null && cesGrow < 0 ? 'var(--red)' : 'var(--green)',
        detail: cesDacPrev
          ? fmtBig(cesDacPrev) + ' → ' + fmtBig(cesDac)
          : (cesDac != null ? fmtBig(cesDac) + ' total DAC' : '—'),
        href: '#/section/A',
        tooltip: {
          title: 'Incentive Growth · Incentive Dollars Spent',
          rows: [
            { label: 'Source', value: 'Section A · Clean Energy' },
            { label: 'Metric', value: 'DAC incentive $ paid' },
            { label: prevYear || 'Prior year', value: cesDacPrev ? fmtBig(cesDacPrev) : 'n/a' },
            { label: year, value: cesDac != null ? fmtBig(cesDac) : '—' },
            { label: 'YoY change', value: cesGrow !== null ? (cesGrow >= 0 ? '+' : '') + cesGrow + '%' : '—' },
            { label: 'DAC share', value: cesCurr && cesCurr.dac_pct != null ? (cesCurr.dac_pct * 100).toFixed(1) + '%' : '—' },
          ],
          note: 'Total dollars disbursed as DAC incentives across all Clean Energy programs. From Section A · Table A1 totals.'
        },
      },
      {
        tag: 'Customer Arrears (90+ Days Past Due)',
        hero: j4Now ? fmtBig(j4Now.dac) : '—',
        heroSub: 'DAC unpaid $',
        delta: j4Grow !== null
          ? (j4Grow >= 0 ? '↑ +' : '↓ ') + j4Grow + '%'
          : (j4Now && j4Now.pct !== null ? j4Now.pct.toFixed(1) + '%' : null),
        deltaSub: j4Grow !== null ? 'YoY' : 'of total',
        // For arrears, growth is BAD (red), shrinkage is GOOD (green)
        deltaColor: j4Grow !== null
          ? (j4Grow >= 0 ? 'var(--red)' : 'var(--green)')
          : 'var(--green)',
        detail: j4Then
          ? fmtBig(j4Then.dac) + ' → ' + fmtBig(j4Now.dac)
          : (j4Now ? fmtBig(j4Now.total) + ' total unpaid' : '—'),
        href: '#/section/J',
        tooltip: {
          title: 'Past-Due 90+ days · Customer Operations',
          rows: [
            { label: 'Source', value: 'Section J · Table J4' },
            { label: 'Metric', value: '90+ day past-due $' },
            { label: 'Total unpaid ' + year, value: j4Now ? fmtBig(j4Now.total) : '—' },
            { label: 'DAC unpaid ' + year, value: j4Now ? fmtBig(j4Now.dac) : '—' },
            { label: 'DAC unpaid ' + (prevYear || 'prior'), value: j4Then ? fmtBig(j4Then.dac) : 'n/a' },
            { label: 'YoY change', value: j4Grow !== null ? (j4Grow >= 0 ? '+' : '') + j4Grow + '%' : '—' },
          ],
          note: 'Residential accounts 90+ days past due. DAC accounts carry a disproportionate share of unpaid debt.'
        },
      },
    ];
  }

  // Cache of the last computed header cards so the tooltip wiring can read
  // their tooltip data after the HTML is mounted.
  let _lastHeaderCards = [];

  /** Render the 3 executive header cards (Strategic / Clean Energy / Arrears). */
  function renderHeaderCards() {
    const cards = computeHeaderCards();
    _lastHeaderCards = cards;
    return `<div class="exec-header-cards" id="exec-header-cards">${
      cards.map((c, idx) => `
        <a class="ai-kpi-mini ai-header-card" href="${c.href}" data-card-idx="${idx}" style="text-decoration:none;color:inherit;cursor:pointer">
          <span class="ai-kpi-mini-tag">${escapeHtml(c.tag)}</span>
          <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:10px;margin:4px 0 2px">
            <div>
              <div style="font-size:26px;font-weight:700;color:var(--dusk);letter-spacing:-.02em;line-height:1">${c.hero}</div>
              ${c.heroSub ? `<div style="font-size:10px;color:var(--text-3);margin-top:3px">${c.heroSub}</div>` : ''}
            </div>
            ${c.delta ? `
              <div style="text-align:right">
                <div style="font-size:14px;font-weight:700;color:${c.deltaColor};line-height:1">${c.delta}</div>
                ${c.deltaSub ? `<div style="font-size:9px;color:var(--text-4);margin-top:2px">${c.deltaSub}</div>` : ''}
              </div>` : ''}
          </div>
          <span class="ai-kpi-mini-detail">${c.detail}</span>
        </a>
      `).join('')
    }</div>`;
  }

  /** Wire hover tooltips for the 3 executive header cards. */
  function wireHeaderCardsTooltips() {
    const tip = ensureTooltip();
    document.querySelectorAll('#exec-header-cards .ai-header-card').forEach(card => {
      const idx = parseInt(card.getAttribute('data-card-idx'), 10);
      const cfg = _lastHeaderCards[idx];
      if (!cfg || !cfg.tooltip) return;
      card.addEventListener('mouseenter', () => {
        const rowsHtml = cfg.tooltip.rows.map(r =>
          `<div class="tt-row"><span>${escapeHtml(r.label)}</span><span class="v">${escapeHtml(r.value)}</span></div>`
        ).join('');
        tip.innerHTML =
          `<div class="tt-name">${escapeHtml(cfg.tooltip.title)}</div>` +
          rowsHtml +
          `<div class="tt-row" style="margin-top:6px;padding-top:6px;border-top:1px solid var(--line)">` +
            `<span style="font-size:9.5px;color:var(--text-3);line-height:1.4">${escapeHtml(cfg.tooltip.note)}</span>` +
          `</div>`;
        tip.style.opacity = '1';
      });
      card.addEventListener('mousemove', e => {
        tip.style.left = (e.pageX + 14) + 'px';
        tip.style.top = (e.pageY - 8) + 'px';
      });
      card.addEventListener('mouseleave', () => { tip.style.opacity = '0'; });
    });
  }

  /** The full Executive Summary view. */
  function renderExecutiveSummary() {
    const p = state.payload;
    const sections = buildSectionDAC();
    const baseline = getBaseline();
    const year = state.year;

    // Check if the selected year has any data across the dashboard at all.
    // If not, the exec summary becomes a single "no data" banner.
    const anyData = (
      // Some section has a non-null pct for this year
      sections.some(s => s.pctByYear[year] != null) ||
      // Or some reported KPI has values for this year
      p.kpis.reported.some(k => k.values && k.values[year])
    );

    const header = `
      <div class="page-header" style="display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <h1>Executive Summary</h1>
          <p class="page-sub">Reported KPIs and analytical metrics with cross-year comparisons.</p>
        </div>
        <dl class="page-header-meta"><div><dt>Year</dt><dd>${year}</dd></div></dl>
      </div>`;

    if (!anyData) {
      return header + `
        <div class="chart-card" style="min-height:320px">
          ${emptyYearPane(year, {
            message: `No data has been entered for ${year} yet.`,
            hint: 'Switch to a populated year using the selector above, or use Data Ingestion to add values for this year.'
          })}
        </div>`;
    }

    return `
      ${header}

      ${renderHeaderCards()}

      <div class="kpi-group">
        <div class="kpi-group-header">
          <h2>DAC Shares <span class="group-tag">Equity Distribution</span></h2>
          <span class="group-desc">Per-section DAC shares benchmarked against the Climate Act goal</span>
        </div>
        <div id="exec-toggle-mount">${renderToggleBar()}</div>
        <div class="exec-shares-grid" id="exec-shares-grid">
          ${renderDumbbell(baseline, year, sections)}
          ${renderStripWithGap(baseline, year, sections)}
          ${renderDACMap(baseline, year, sections)}
        </div>
      </div>
    `;
  }

  /** Wire baseline toggle clicks. */
  function wireBaselineToggle() {
    document.querySelectorAll('.exec-toggle-bar .rkpi-toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const newBase = parseInt(btn.dataset.baseline, 10);
        if (newBase !== getBaseline()) {
          setBaseline(newBase);
          // Full re-render of Executive Summary view
          rerenderCurrentView();
        }
      });
    });
  }

  /** Ensure a single tooltip element exists in <body>. */
  function ensureTooltip() {
    let tip = document.querySelector('.exec-tooltip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'exec-tooltip';
      document.body.appendChild(tip);
    }
    return tip;
  }

  /** Wire hover tooltips for the three equity charts. */
  function wireExecutiveTooltips() {
    const tip = ensureTooltip();
    const targets = document.querySelectorAll(
      '.strip-row[data-section], .dumb-row[data-section], .radar-dot[data-section]'
    );
    targets.forEach(el => {
      el.addEventListener('mouseenter', () => {
        const id = el.getAttribute('data-section');
        const name = el.getAttribute('data-name');
        const pct = el.getAttribute('data-pct');
        const bl = el.getAttribute('data-baseline');
        const gap = el.getAttribute('data-gap');
        const prevPct = el.getAttribute('data-prev-pct');
        const kpiLabel = el.getAttribute('data-kpi-label');
        const dacVal = el.getAttribute('data-dac-val');
        const totalVal = el.getAttribute('data-total-val');
        const unit = el.getAttribute('data-unit');

        let html = `<div class="tt-name">Section ${id} · ${name}</div>`;
        if (kpiLabel) {
          html += `<div class="tt-row" style="color:var(--text-3);font-size:9.5px;margin-bottom:4px"><span>Primary KPI: ${kpiLabel}</span></div>`;
        }
        html += `<div class="tt-row"><span>DAC share · ${state.year}</span><span class="v">${pct}</span></div>`;
        if (prevPct && prevPct !== 'n/a') {
          html += `<div class="tt-row"><span>Prior year</span><span class="v">${prevPct}</span></div>`;
        }
        if (dacVal && dacVal !== 'n/a') {
          html += `<div class="tt-row"><span>DAC ${unit ? '(' + unit + ')' : 'value'}</span><span class="v">${dacVal}</span></div>`;
        }
        if (totalVal && totalVal !== 'n/a') {
          html += `<div class="tt-row"><span>Total ${unit ? '(' + unit + ')' : 'value'}</span><span class="v">${totalVal}</span></div>`;
        }
        html += `<div class="tt-row"><span>Equity baseline</span><span class="v">${bl}</span></div>`;
        if (gap && gap !== '—') {
          html += `<div class="tt-row"><span>Gap vs goal</span><span class="v">${gap}</span></div>`;
        }
        html += `<div class="tt-row" style="margin-top:6px;padding-top:6px;border-top:1px solid var(--line)">` +
                `<span style="font-size:9.5px;color:var(--text-3);line-height:1.4">Source: filed DAC report. DAC % = DAC value ÷ total value for the primary metric of Section ${id}.</span>` +
                `</div>`;
        tip.innerHTML = html;
        tip.style.opacity = '1';
      });
      el.addEventListener('mousemove', e => {
        tip.style.left = (e.pageX + 14) + 'px';
        tip.style.top = (e.pageY - 8) + 'px';
      });
      el.addEventListener('mouseleave', () => { tip.style.opacity = '0'; });
    });
  }

  /** Called after Executive view is rendered to wire interactive parts. */
  function wireExecutiveInteractions() {
    wireBaselineToggle();
    wireExecutiveTooltips();
    wireHeaderCardsTooltips();
    mountDACMap();   // async – mounts Leaflet after HTML is in DOM
  }

  // ============================================================
  // SECTIONS A-J · Per-section views (charts + tables)
  // ============================================================
  //
  // Each section returns its own chart HTML via renderSectionCharts(letter).
  // Section state (per-table view, active table, rank toggles, etc.) lives
  // in the global `state` object created at the top of app.js.
  //
  // All renderers are year-agnostic:
  //   - `yr`       = state.year                     (current selected year)
  //   - `prevYr`   = prevYearOf(state.year) | null  (immediately prior year)
  //   - `hasPrev`  = !!prevYr
  //   - Chart data lookup: payload.charts.X.values[year]
  //   - Table data lookup: table.data[year]
  // ============================================================

  // Initialize per-section state defaults
  state.rankBy = state.rankBy || 'total';
  state.quadrantMetric = state.quadrantMetric || 'dollars';

  /** Compute the per-section header stats row. */
  function fillSectionStats(letter) {
    const p = state.payload;
    const sec = p.sections[letter];
    if (!sec) return '';
    const yr = state.year;
    const tablesForSec = Object.values(p.tables).filter(t => t.section === letter);
    const groups = [];

    // Group 1: tables count
    groups.push([{ label: 'Tables', value: tablesForSec.length }]);

    // Groups 2..N: each reported KPI for this section
    const reportedForSec = p.kpis.reported.filter(k => k.section === letter);
    reportedForSec.forEach(k => {
      const v = k.values && k.values[yr];
      if (!v) return;
      const group = [];
      const shortLabel = k.label
        .replace(/^Clean Energy\s+/i, '')
        .replace(/^Lifetime\s+/i, '');
      const unit = (k.unit && k.unit !== '$' && k.format !== 'currency') ? ' ' + k.unit : '';
      group.push({ label: shortLabel, value: fmtNum(v.total, k.format) + unit });
      if (v.dac_pct !== null && v.dac_pct !== undefined) {
        group.push({ label: 'DAC Share', value: (v.dac_pct * 100).toFixed(1) + '%' });
      }
      groups.push(group);
    });

    return groups.map((g, i) => {
      const sep = i < groups.length - 1 ? '<span class="section-stats-sep">|</span>' : '';
      return g.map(s =>
        `<div class="section-stat"><dt>${escapeHtml(s.label)}</dt><dd>${s.value}</dd></div>`
      ).join('') + sep;
    }).join('');
  }

  /** Dispatch to the per-section renderer. */
  function renderSectionCharts(letter) {
    switch (letter) {
      case 'A': return renderSectionA();
      case 'B': return renderSectionB();
      case 'C': return renderSectionC();
      case 'D': return renderSectionD();
      case 'E': return renderSectionE();
      case 'F': return renderSectionF();
      case 'G': return renderSectionG();
      case 'H': return renderSectionH();
      case 'I': return renderSectionI();
      case 'J': return renderSectionJ();
      default:  return '';
    }
  }

  // ------------------------------------------------------------
  // SECTION A · Clean Energy
  // ------------------------------------------------------------
  function renderSectionA() {
    const p = state.payload;
    const yr = state.year;
    const prevYr = prevYearOf(yr);
    const hasPrev = !!prevYr;
    const yearLabel = yr;
    const prevYearLabel = prevYr || '';

    // ----- A1 chart data (top 12 programs by funding) -----
    const a1Chart = (p.charts.A1_programs && p.charts.A1_programs.values[yr]) || [];
    const rankBy = state.rankBy || 'total';
    const sorted = [...a1Chart].sort((a, b) => rankBy === 'dac' ? b.dac - a.dac : b.total - a.total);
    const top10 = sorted.slice(0, 8).map(prog => ({
      name: prog.name,
      dac: prog.dac,
      nondac: prog.total - prog.dac,
      total: rankBy === 'dac' ? prog.dac : prog.total
    }));
    const subLabel = rankBy === 'dac' ? 'Sorted by DAC' : 'Sorted by total';

    // ----- A2 (Energy Savings) parsed from the source table -----
    const a2Table = p.tables.A2;
    const a2Raw = (a2Table && a2Table.data && a2Table.data[yr]) || [];
    const a2Programs = [];
    a2Raw.forEach(row => {
      if (!row || !row[0]) return;
      const name = String(row[0]).trim();
      if (!name || /total|grand total/i.test(name)) return;
      const total = Number(row[1]);
      const dac = Number(row[2]);
      if (!isFinite(total) || total <= 0) return;
      a2Programs.push({ name, total, dac: isFinite(dac) ? dac : 0 });
    });
    const a2Sorted = [...a2Programs].sort((a, b) => rankBy === 'dac' ? b.dac - a.dac : b.total - a.total);
    const a2Top10 = a2Sorted.slice(0, 8).map(p2 => ({
      name: p2.name,
      dac: p2.dac,
      nondac: p2.total - p2.dac,
      total: rankBy === 'dac' ? p2.dac : p2.total
    }));

    // ----- A1 FULL table parsed for the quadrant -----
    const a1Table = p.tables.A1;
    const a1Raw = (a1Table && a1Table.data && a1Table.data[yr]) || [];
    const a1Programs = [];
    a1Raw.forEach(row => {
      if (!row || !row[0]) return;
      const name = String(row[0]).trim();
      if (!name || /total|grand total|program name/i.test(name)) return;
      const total = Number(row[1]);
      const dac = Number(row[2]);
      if (!isFinite(total) || total <= 0) return;
      a1Programs.push({
        name, total,
        dac: isFinite(dac) ? dac : 0,
        dac_pct: total > 0 ? (isFinite(dac) ? dac / total : 0) : 0
      });
    });

    const quadrantMetric = state.quadrantMetric || 'dollars';
    let quadrantItems, quadrantXLabel, quadrantXUnit, quadrantSubLabel;
    if (quadrantMetric === 'mmbtu') {
      quadrantItems = a2Programs.map(p2 => ({
        name: p2.name,
        total: p2.total,
        dac: p2.dac,
        dac_pct: p2.total > 0 ? p2.dac / p2.total : 0
      }));
      quadrantXLabel = 'Total Energy Savings (MMBtu)';
      quadrantXUnit = 'MMBtu';
      quadrantSubLabel = 'DAC % vs total MMBtu saved';
    } else {
      quadrantItems = a1Programs;
      quadrantXLabel = 'Total Incentive Funding ($)';
      quadrantXUnit = '';
      quadrantSubLabel = 'DAC % vs total $';
    }

    // ----- Prior-year lookups (for tooltips) -----
    const a1ChartPrev = hasPrev ? ((p.charts.A1_programs && p.charts.A1_programs.values[prevYr]) || []) : [];
    const a2RawPrev = (a2Table && hasPrev && a2Table.data && a2Table.data[prevYr]) || [];
    const a1PrevByName = {};
    a1ChartPrev.forEach(prog => { a1PrevByName[prog.name] = prog; });
    const a2PrevByName = {};
    a2RawPrev.forEach(row => {
      if (!row || !row[0]) return;
      const name = String(row[0]).trim();
      if (!name || /total|grand total/i.test(name)) return;
      const total = Number(row[1]);
      const dac = Number(row[2]);
      if (!isFinite(total) || total <= 0) return;
      a2PrevByName[name] = { name, total, dac: isFinite(dac) ? dac : 0 };
    });

    // Build tooltip data factories for each chart
    const a1DataAttrs = (item) => {
      // item.total/.dac come from top10 (already swapped if rankBy='dac')
      // We need the *original* program from a1Chart by name
      const orig = a1Chart.find(x => x.name === item.name) || { total: 0, dac: 0 };
      const prev = a1PrevByName[item.name];
      const dacPct = orig.total > 0 ? (orig.dac / orig.total * 100) : 0;
      const yoyTotal = (prev && prev.total > 0)
        ? Math.round((orig.total - prev.total) / prev.total * 100) : null;
      const yoyDac = (prev && prev.dac > 0)
        ? Math.round((orig.dac - prev.dac) / prev.dac * 100) : null;
      return {
        'a-name': item.name,
        'a-source': 'Section A · Table A1',
        'a-metric': 'Incentive Spend ($)',
        'a-curr-total': '$' + Math.round(orig.total).toLocaleString(),
        'a-curr-dac': '$' + Math.round(orig.dac).toLocaleString(),
        'a-curr-non': '$' + Math.round(orig.total - orig.dac).toLocaleString(),
        'a-dac-pct': dacPct.toFixed(1) + '%',
        'a-prev-total': prev ? '$' + Math.round(prev.total).toLocaleString() : 'n/a',
        'a-prev-dac': prev ? '$' + Math.round(prev.dac).toLocaleString() : 'n/a',
        'a-yoy-total': yoyTotal !== null ? (yoyTotal >= 0 ? '+' : '') + yoyTotal + '%' : 'n/a',
        'a-yoy-dac': yoyDac !== null ? (yoyDac >= 0 ? '+' : '') + yoyDac + '%' : 'n/a',
      };
    };
    const a2DataAttrs = (item) => {
      const orig = a2Programs.find(x => x.name === item.name) || { total: 0, dac: 0 };
      const prev = a2PrevByName[item.name];
      const dacPct = orig.total > 0 ? (orig.dac / orig.total * 100) : 0;
      const yoyTotal = (prev && prev.total > 0)
        ? Math.round((orig.total - prev.total) / prev.total * 100) : null;
      const yoyDac = (prev && prev.dac > 0)
        ? Math.round((orig.dac - prev.dac) / prev.dac * 100) : null;
      const fmtMmbtu = v => Math.round(v).toLocaleString() + ' MMBtu';
      return {
        'a-name': item.name,
        'a-source': 'Section A · Table A2',
        'a-metric': 'Energy Savings (MMBtu)',
        'a-curr-total': fmtMmbtu(orig.total),
        'a-curr-dac': fmtMmbtu(orig.dac),
        'a-curr-non': fmtMmbtu(orig.total - orig.dac),
        'a-dac-pct': dacPct.toFixed(1) + '%',
        'a-prev-total': prev ? fmtMmbtu(prev.total) : 'n/a',
        'a-prev-dac': prev ? fmtMmbtu(prev.dac) : 'n/a',
        'a-yoy-total': yoyTotal !== null ? (yoyTotal >= 0 ? '+' : '') + yoyTotal + '%' : 'n/a',
        'a-yoy-dac': yoyDac !== null ? (yoyDac >= 0 ? '+' : '') + yoyDac + '%' : 'n/a',
      };
    };

    return `
      <div class="chart-row cols-3">
        <div class="chart-card">
          <div class="chart-card-head">
            <div><h3>Programs Ranked by Incentive Spend</h3><p class="chart-sub">${yearLabel} · Top 8 of 30+ programs · ${subLabel}</p></div>
            <div class="chart-head-controls">
              <div class="rank-toggle">
                <button data-rank="total" class="${rankBy === 'total' ? 'active' : ''}">Total</button>
                <button data-rank="dac" class="${rankBy === 'dac' ? 'active' : ''}">DAC</button>
              </div>
              <div class="chart-legend" style="margin-bottom:0;justify-content:flex-end;gap:10px">
                <div class="legend-item"><span class="legend-swatch" style="background:var(--dusk)"></span>DAC</div>
                <div class="legend-item"><span class="legend-swatch" style="background:var(--pale-sky)"></span>Non-DAC</div>
              </div>
            </div>
          </div>
          <div class="chart-body">
            ${stackedBar(top10, {
              labelW: 200,
              fmt: fmtMoney,
              dataAttrs: a1DataAttrs,
              rowClass: 'a-stacked-row',
              yoyFor: item => {
                const orig = a1Chart.find(x => x.name === item.name);
                const prev = a1PrevByName[item.name];
                if (!orig || !prev || !prev.dac || prev.dac === 0) return null;
                return Math.round((orig.dac - prev.dac) / prev.dac * 100);
              }
            })}
          </div>
        </div>
        <div class="chart-card">
          <div class="chart-card-head">
            <div><h3>Programs Ranked by Energy Savings</h3><p class="chart-sub">${yearLabel} · Top 8 of 30+ programs · ${subLabel}</p></div>
            <div class="chart-head-controls">
              <div class="rank-toggle">
                <button data-rank="total" class="${rankBy === 'total' ? 'active' : ''}">Total</button>
                <button data-rank="dac" class="${rankBy === 'dac' ? 'active' : ''}">DAC</button>
              </div>
              <div class="chart-legend" style="margin-bottom:0;justify-content:flex-end;gap:10px">
                <div class="legend-item"><span class="legend-swatch" style="background:var(--dusk)"></span>DAC</div>
                <div class="legend-item"><span class="legend-swatch" style="background:var(--pale-sky)"></span>Non-DAC</div>
              </div>
            </div>
          </div>
          <div class="chart-body">
            ${stackedBar(a2Top10, {
              labelW: 200,
              fmt: v => fmtCompact(v) + ' MMBtu',
              dataAttrs: a2DataAttrs,
              rowClass: 'a-stacked-row',
              yoyFor: item => {
                const orig = a2Programs.find(x => x.name === item.name);
                const prev = a2PrevByName[item.name];
                if (!orig || !prev || !prev.dac || prev.dac === 0) return null;
                return Math.round((orig.dac - prev.dac) / prev.dac * 100);
              }
            })}
          </div>
        </div>
        <div class="chart-card analytical">
          <div class="chart-card-head">
            <div><h3>Equity Quadrant <span class="title-mode">· ${quadrantMetric === 'mmbtu' ? 'Energy Savings' : 'Incentive Spend'}</span></h3><p class="chart-sub">${quadrantSubLabel} · Hover any dot for details</p></div>
            <div class="chart-head-controls">
              <div class="quadrant-metric-toggle">
                <button data-metric="dollars" class="${quadrantMetric === 'dollars' ? 'active' : ''}">$</button>
                <button data-metric="mmbtu" class="${quadrantMetric === 'mmbtu' ? 'active' : ''}">MMBtu</button>
              </div>
            </div>
          </div>
          <div class="chart-body" style="margin-top:-14px">
           ${quadrant(quadrantItems, { xLabel: quadrantXLabel, xUnit: quadrantXUnit, dotScale: quadrantMetric === 'mmbtu' ? 0.005 : 0.0007 })}
            <div class="quadrant-help-trigger">
              <button class="help-btn" data-help="quadrant" type="button">
                <span class="help-icon">?</span> How to read this chart
              </button>
            </div>
          </div>
        </div>
      </div>`;
  }

  // ------------------------------------------------------------
  // SECTION B · EV Make-Ready Program
  // ------------------------------------------------------------
  function renderSectionB() {
    const p = state.payload;
    const yr = state.year;
    const prevYr = prevYearOf(yr);
    const hasPrev = !!prevYr;
    const yearLabel = yr;
    const prevYearLabel = prevYr || '';

    // ---- Local formatters ----
    const fmtCurrency = v => '$' + v.toLocaleString();
    const fmtCurrencyShort = v => {
      if (v >= 1e9) return '$' + (v / 1e9).toFixed(0) + 'B';
      if (v >= 1e6) return '$' + (v / 1e6).toFixed(0) + 'M';
      if (v >= 1e3) return '$' + (v / 1e3).toFixed(0) + 'K';
      return '$' + v;
    };
    const fmtBig = v => {
      if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
      if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
      if (v >= 1e3) return '$' + (v / 1e3).toFixed(0) + 'K';
      return '$' + v.toFixed(0);
    };
    const fmtInt = v => v.toLocaleString();

    // ---- B1: Funding parsed from source table ----
    const b1Table = p.tables.B1;
    const b1Data = (b1Table && b1Table.data && b1Table.data[yr]) || [];
    const b1Prev = (b1Table && hasPrev && b1Table.data && b1Table.data[prevYr]) || null;

    let dacFunding = 0, nondacFunding = 0, totalFunding = 0;
    b1Data.forEach(row => {
      if (!row || !row[0]) return;
      const label = String(row[0]).toLowerCase();
      const val = Number(row[1]) || Number(row[2]) || 0;
      if (label.includes('dac') && !label.includes('non')) dacFunding = val;
      else if (label.includes('non-dac') || label.includes('non dac')) nondacFunding = val;
      else if (label.includes('total')) totalFunding = val;
    });
    if (totalFunding === 0) totalFunding = dacFunding + nondacFunding;
    if (nondacFunding === 0 && totalFunding > 0) nondacFunding = totalFunding - dacFunding;

    // ---- Prior year for YoY ----
    let b1DacPrev = null, b1TotalPrev = null;
    if (b1Prev) {
      b1Prev.forEach(row => {
        if (!row || !row[0]) return;
        const label = String(row[0]).toLowerCase();
        const val = Number(row[1]) || 0;
        if (label.includes('dac') && !label.includes('non')) b1DacPrev = val;
        else if (label.includes('total')) b1TotalPrev = val;
      });
    }
    const b1NonPrev = (b1TotalPrev !== null && b1DacPrev !== null) ? b1TotalPrev - b1DacPrev : null;
    const b1DacYoy = (b1DacPrev !== null && b1DacPrev > 0)
      ? Math.round((dacFunding - b1DacPrev) / b1DacPrev * 100) : null;
    const b1NonYoy = (b1NonPrev !== null && b1NonPrev > 0)
      ? Math.round((nondacFunding - b1NonPrev) / b1NonPrev * 100) : null;
    const b1TotalYoy = (b1TotalPrev !== null && b1TotalPrev > 0)
      ? Math.round((totalFunding - b1TotalPrev) / b1TotalPrev * 100) : null;

    const niceMaxOf = m => {
      if (m <= 0) return 1;
      const pow = Math.pow(10, Math.floor(Math.log10(m)));
      const candidates = [pow, 1.5 * pow, 2 * pow, 2.5 * pow, 3 * pow, 4 * pow, 5 * pow, 7.5 * pow, 10 * pow];
      for (const c of candidates) { if (c >= m) return c; }
      return 10 * pow;
    };
    const niceMaxFunding = niceMaxOf(Math.max(dacFunding, nondacFunding, totalFunding));

    const fundingBar = (label, value, prev, fillClass, yoy) => {
      const pct = (value / niceMaxFunding) * 100;
      const yoyHtml = yoy !== null && yoy !== undefined
        ? `<span class="b-bar-yoy-pill ${yoy >= 0 ? 'up' : 'down'}">${yoy >= 0 ? '↑ +' : '↓ '}${Math.abs(yoy)}%</span>`
        : `<span class="b-bar-yoy-pill na">—</span>`;
      const prevStr = prev !== null && prev !== undefined ? fmtCurrency(prev) : 'n/a';
      const yoyStr = yoy !== null && yoy !== undefined ? (yoy >= 0 ? '+' : '') + yoy + '%' : 'n/a';
      const pctOfTotal = totalFunding > 0 ? (value / totalFunding * 100).toFixed(1) + '%' : '—';
      return `
        <div class="b-bar-row b-fund-row" data-label="${label}"
          data-curr="${fmtCurrency(value)}"
          data-prev="${prevStr}"
          data-yoy="${yoyStr}"
          data-pct="${pctOfTotal}"
          data-yoy-sign="${yoy !== null && yoy !== undefined ? (yoy >= 0 ? 'up' : 'down') : 'na'}"
          style="cursor:default">
          <div class="b-bar-label">${label}</div>
          <div class="b-bar-track">
            <div class="b-bar-fill ${fillClass}" style="width:${pct.toFixed(2)}%;">
              <span class="b-bar-value-inside">${fmtCurrency(value)}</span>
            </div>
          </div>
          ${yoyHtml}
        </div>`;
    };

    const fundingAxis = (() => {
      let ticks = '';
      for (let i = 0; i <= 10; i++) {
        const v = (niceMaxFunding / 10) * i;
        ticks += `<span class="b-axis-tick">${fmtCurrencyShort(v)}</span>`;
      }
      return `<div class="b-axis-row"><div class="b-axis-spacer"></div><div class="b-axis-ticks">${ticks}</div><div class="b-axis-yoy-spacer"></div></div>`;
    })();

    // ---- B2: Plugs data for tornado ----
    const cur = (p.charts.B2_plugs && p.charts.B2_plugs.values[yr]) || {};
    const b2DacL2   = (cur.DAC || {}).L2 || 0;
    const b2DacDCFC = (cur.DAC || {}).DCFC || 0;
    const b2DacTot  = (cur.DAC || {}).Total || 0;
    const b2NonL2   = (cur['Non-DAC'] || {}).L2 || 0;
    const b2NonDCFC = (cur['Non-DAC'] || {}).DCFC || 0;
    const b2NonTot  = (cur['Non-DAC'] || {}).Total || 0;

    const b2Prev = hasPrev ? (p.charts.B2_plugs && p.charts.B2_plugs.values[prevYr]) : null;
    const b2DacTotPrev = b2Prev ? (b2Prev.DAC || {}).Total || null : null;
    const b2NonTotPrev = b2Prev ? (b2Prev['Non-DAC'] || {}).Total || null : null;
    const b2DacYoy = (b2DacTotPrev && b2DacTotPrev > 0)
      ? Math.round((b2DacTot - b2DacTotPrev) / b2DacTotPrev * 100) : null;
    const b2NonYoy = (b2NonTotPrev && b2NonTotPrev > 0)
      ? Math.round((b2NonTot - b2NonTotPrev) / b2NonTotPrev * 100) : null;

    // ---- Tornado rows ----
    const maxFund = Math.max(dacFunding, nondacFunding);
    const maxL2   = Math.max(b2DacL2, b2NonL2);
    const maxDCFC = Math.max(b2DacDCFC, b2NonDCFC);
    const maxGrowFund = Math.max(Math.abs(b1DacYoy || 0), Math.abs(b1TotalYoy || 0)) || 1;
    const maxGrowPlug = Math.max(Math.abs(b2DacYoy || 0), Math.abs(b2NonYoy || 0)) || 1;

    const b1DacPrevTorn = b1DacPrev !== null ? fmtBig(b1DacPrev) : 'n/a';
    const b1NonPrevTorn = b1NonPrev !== null ? fmtBig(b1NonPrev) : 'n/a';
    const b2DacL2Prev   = b2Prev ? (b2Prev.DAC || {}).L2 || null : null;
    const b2DacDCFCPrev = b2Prev ? (b2Prev.DAC || {}).DCFC || null : null;
    const b2NonL2Prev   = b2Prev ? (b2Prev['Non-DAC'] || {}).L2 || null : null;
    const b2NonDCFCPrev = b2Prev ? (b2Prev['Non-DAC'] || {}).DCFC || null : null;
    const b1DacYoyTorn = b1DacYoy !== null ? (b1DacYoy >= 0 ? '+' : '') + b1DacYoy + '%' : 'n/a';
    const b1NonYoyTorn = b1NonYoy !== null ? (b1NonYoy >= 0 ? '+' : '') + b1NonYoy + '%' : 'n/a';
    const b2DacL2Yoy = (b2DacL2Prev && b2DacL2Prev > 0) ? Math.round((b2DacL2 - b2DacL2Prev) / b2DacL2Prev * 100) : null;
    const b2DacDCFCYoy = (b2DacDCFCPrev && b2DacDCFCPrev > 0) ? Math.round((b2DacDCFC - b2DacDCFCPrev) / b2DacDCFCPrev * 100) : null;
    const b2NonL2Yoy = (b2NonL2Prev && b2NonL2Prev > 0) ? Math.round((b2NonL2 - b2NonL2Prev) / b2NonL2Prev * 100) : null;
    const b2NonDCFCYoy = (b2NonDCFCPrev && b2NonDCFCPrev > 0) ? Math.round((b2NonDCFC - b2NonDCFCPrev) / b2NonDCFCPrev * 100) : null;

    const tornadoRows = [
      { metric: 'Funding', source: 'Table B1',
        lPct: maxFund ? (dacFunding / maxFund) * 100 : 0, lLabel: fmtBig(dacFunding), lPrev: b1DacPrevTorn, lYoy: b1DacYoyTorn,
        rPct: maxFund ? (nondacFunding / maxFund) * 100 : 0, rLabel: fmtBig(nondacFunding), rPrev: b1NonPrevTorn, rYoy: b1NonYoyTorn,
        dacWins: dacFunding > nondacFunding,
        interp: dacFunding > nondacFunding ? 'DAC received more funding than Non-DAC.' : 'Non-DAC received more total funding, but DAC growth rate is higher.' },
      { metric: 'L2 plugs', source: 'Table B2',
        lPct: maxL2 ? (b2DacL2 / maxL2) * 100 : 0, lLabel: fmtInt(b2DacL2), lPrev: b2DacL2Prev !== null ? fmtInt(b2DacL2Prev) : 'n/a', lYoy: b2DacL2Yoy !== null ? (b2DacL2Yoy >= 0 ? '+' : '') + b2DacL2Yoy + '%' : 'n/a',
        rPct: maxL2 ? (b2NonL2 / maxL2) * 100 : 0, rLabel: fmtInt(b2NonL2), rPrev: b2NonL2Prev !== null ? fmtInt(b2NonL2Prev) : 'n/a', rYoy: b2NonL2Yoy !== null ? (b2NonL2Yoy >= 0 ? '+' : '') + b2NonL2Yoy + '%' : 'n/a',
        dacWins: b2DacL2 > b2NonL2,
        interp: 'Level-2 chargers are the bulk of the program. Volume is higher in Non-DAC neighborhoods.' },
      { metric: 'DCFC', source: 'Table B2',
        lPct: maxDCFC ? (b2DacDCFC / maxDCFC) * 100 : 0, lLabel: fmtInt(b2DacDCFC), lPrev: b2DacDCFCPrev !== null ? fmtInt(b2DacDCFCPrev) : 'n/a', lYoy: b2DacDCFCYoy !== null ? (b2DacDCFCYoy >= 0 ? '+' : '') + b2DacDCFCYoy + '%' : 'n/a',
        rPct: maxDCFC ? (b2NonDCFC / maxDCFC) * 100 : 0, rLabel: fmtInt(b2NonDCFC), rPrev: b2NonDCFCPrev !== null ? fmtInt(b2NonDCFCPrev) : 'n/a', rYoy: b2NonDCFCYoy !== null ? (b2NonDCFCYoy >= 0 ? '+' : '') + b2NonDCFCYoy + '%' : 'n/a',
        dacWins: b2DacDCFC > b2NonDCFC,
        interp: 'Fast chargers are scarce program-wide. DAC has a notably higher share of these.' }
    ];
    if (b1DacYoy !== null && b1TotalYoy !== null) {
      tornadoRows.push({ metric: '$ growth', source: 'Table B1',
        lPct: (Math.abs(b1DacYoy) / maxGrowFund) * 100, lLabel: (b1DacYoy >= 0 ? '+' : '') + b1DacYoy + '%', lPrev: b1DacPrevTorn, lYoy: b1DacYoyTorn,
        rPct: (Math.abs(b1TotalYoy) / maxGrowFund) * 100, rLabel: (b1TotalYoy >= 0 ? '+' : '') + b1TotalYoy + '%', rPrev: b1TotalPrev !== null ? fmtBig(b1TotalPrev) : 'n/a', rYoy: (b1TotalYoy >= 0 ? '+' : '') + b1TotalYoy + '%',
        dacWins: b1DacYoy > b1TotalYoy,
        interp: 'YoY growth in dollars. DAC funding pace exceeds the overall program pace.' });
    }
    if (b2DacYoy !== null && b2NonYoy !== null) {
      tornadoRows.push({ metric: 'plug growth', source: 'Table B2',
        lPct: (Math.abs(b2DacYoy) / maxGrowPlug) * 100, lLabel: (b2DacYoy >= 0 ? '+' : '') + b2DacYoy + '%', lPrev: b2DacTotPrev !== null ? fmtInt(b2DacTotPrev) : 'n/a', lYoy: (b2DacYoy >= 0 ? '+' : '') + b2DacYoy + '%',
        rPct: (Math.abs(b2NonYoy) / maxGrowPlug) * 100, rLabel: (b2NonYoy >= 0 ? '+' : '') + b2NonYoy + '%', rPrev: b2NonTotPrev !== null ? fmtInt(b2NonTotPrev) : 'n/a', rYoy: (b2NonYoy >= 0 ? '+' : '') + b2NonYoy + '%',
        dacWins: b2DacYoy > b2NonYoy,
        interp: 'YoY plug deployment pace. DAC roll-out far outpaces Non-DAC.' });
    }

    return `
      <div class="chart-row cols-2">
        <div class="chart-card">
          <div class="chart-card-head">
            <div><h3>Total Make-Ready Incentive Funding Spent</h3>
            <p class="chart-sub">${yearLabel} · DAC vs Non-DAC · YoY vs ${prevYearLabel || 'prior'}</p></div>
          </div>
          <div class="chart-body">
            ${fundingBar('DAC', dacFunding, b1DacPrev, 'b-fill-dac', b1DacYoy)}
            ${fundingBar('Non-DAC', nondacFunding, b1NonPrev, 'b-fill-nondac', b1NonYoy)}
            ${fundingBar('Total', totalFunding, b1TotalPrev, 'b-fill-total', b1TotalYoy)}
            ${fundingAxis}
          </div>
        </div>

        <div class="chart-card">
          <div class="chart-card-head">
            <div>
              <h3>DAC vs Non-DAC · By Metric</h3>
              <p class="chart-sub">${yearLabel} · Each row compares the two groups</p>
            </div>
            <div class="chart-head-controls">
              <div class="chart-legend" style="margin-bottom:0;justify-content:flex-end;gap:10px">
                <div class="legend-item"><span class="legend-swatch" style="background:var(--dusk)"></span>DAC</div>
                <div class="legend-item"><span class="legend-swatch" style="background:var(--text-3)"></span>Non-DAC</div>
              </div>
            </div>
          </div>
          <div class="chart-body" style="margin-top:-4px">
            ${tornadoRows.map(row => `
              <div class="tornado-row b-torn-row"
                data-metric="${row.metric}"
                data-source="${row.source}"
                data-dac-curr="${row.lLabel}"
                data-dac-prev="${row.lPrev}"
                data-dac-yoy="${row.lYoy}"
                data-non-curr="${row.rLabel}"
                data-non-prev="${row.rPrev}"
                data-non-yoy="${row.rYoy}"
                data-dac-wins="${row.dacWins}"
                data-interp="${row.interp.replace(/"/g, '&quot;')}"
                style="cursor:default">
                <div class="tornado-bar-l"><div class="tornado-fill-l" style="width:${row.lPct.toFixed(1)}%">${row.lLabel}</div></div>
                <div class="tornado-label">${row.metric}</div>
                <div class="tornado-bar-r"><div class="tornado-fill-r" style="width:${row.rPct.toFixed(1)}%">${row.rLabel}</div></div>
              </div>`).join('')}
          </div>
        </div>
      </div>`;
  }


// ------------------------------------------------------------
// SECTION C · Demand Response
// ------------------------------------------------------------
function renderSectionC() {

    const p = state.payload;
    const yr = state.year;
    const prevYr = prevYearOf(yr);
    const hasPrev = !!prevYr;
    const hasPrevData = hasPrev;
    const showCurrent = (yr === p.meta.current_year);
    const yearLabel = yr;
    const prevYearLabel = prevYr || '';
      // ===== Source data =====
      const c5 = (p.charts.C5_programs && p.charts.C5_programs.values[yr]) || [];
      const c3 = (p.charts.C3_programs && p.charts.C3_programs.values[yr]) || [];

      // Parse C4 (Low-Income) from Object.values(p.tables)
      const c4Table = p.tables.C4;
      const c4Raw = c4Table ? (c4Table.data[yr] || []) : [];
      const c4 = [];
      c4Raw.forEach(row => {
        if (!row || !row[0]) return;
        const name = String(row[0]).trim();
        if (!name || /program name|^total$/i.test(name)) return;
        const nums = row.slice(1).filter(v => v !== null && v !== undefined && v !== '');
        if (nums.length < 3) return;
        c4.push({
          name: name,
          participants: Number(nums[0]) || 0,
          committed: Number(nums[1]) || 0,
          delivered: Number(nums[2]) || 0
        });
      });

      // Prior year data for tooltips
      const c5Prev = hasPrevData ? ((p.charts.C5_programs && p.charts.C5_programs.values[prevYr]) || []) : [];
      const c3Prev = hasPrevData ? ((p.charts.C3_programs && p.charts.C3_programs.values[prevYr]) || []) : [];
      const c4PrevRaw = c4Table && hasPrevData ? c4Table.data[prevYr] : [];
      const c4Prev = [];
      c4PrevRaw.forEach(row => {
        if (!row || !row[0]) return;
        const name = String(row[0]).trim();
        if (!name || /program name|^total$/i.test(name)) return;
        const nums = row.slice(1).filter(v => v !== null && v !== undefined && v !== '');
        if (nums.length < 3) return;
        c4Prev.push({
          name: name,
          participants: Number(nums[0]) || 0,
          committed: Number(nums[1]) || 0,
          delivered: Number(nums[2]) || 0
        });
      });

      // ===== Totals per segment =====
      const sumKey = (arr, key) => arr.reduce((a, x) => a + (Number(x[key]) || 0), 0);
      const dacTotals  = { participants: sumKey(c3, 'participants'), committed: sumKey(c3, 'committed'), delivered: sumKey(c3, 'delivered') };
      const liTotals   = { participants: sumKey(c4, 'participants'), committed: sumKey(c4, 'committed'), delivered: sumKey(c4, 'delivered') };
      const totTotals  = { participants: sumKey(c5, 'participants'), committed: sumKey(c5, 'committed'), delivered: sumKey(c5, 'delivered') };

      const dacPrevTotals = { participants: sumKey(c3Prev, 'participants'), committed: sumKey(c3Prev, 'committed'), delivered: sumKey(c3Prev, 'delivered') };
      const liPrevTotals  = { participants: sumKey(c4Prev, 'participants'), committed: sumKey(c4Prev, 'committed'), delivered: sumKey(c4Prev, 'delivered') };
      const totPrevTotals = { participants: sumKey(c5Prev, 'participants'), committed: sumKey(c5Prev, 'committed'), delivered: sumKey(c5Prev, 'delivered') };

      // ===== Format helpers =====
      const fmtCompact = v => {
        if (v >= 1e6) return (v/1e6).toFixed(1) + 'M';
        if (v >= 1e3) return Math.round(v/1e3) + 'K';
        return Math.round(v).toLocaleString();
      };
      const fmtInt = v => Math.round(v).toLocaleString();
      const fmtMW = v => {
        if (v >= 100) return v.toFixed(0);
        if (v >= 10)  return v.toFixed(1);
        return v.toFixed(2);
      };
      const pctOf = (part, tot) => tot > 0 ? (part / tot * 100).toFixed(1) + '%' : '—';
      const yoyCalc = (curr, prev) => {
        if (prev === null || prev === undefined || prev === 0) return null;
        return Math.round((curr - prev) / prev * 100);
      };
      const yoyPill = (yoy) => {
        if (yoy === null || yoy === undefined) return '<span class="c1-tt-pill na" style="background:var(--white-smoke);color:var(--text-3)">n/a</span>';
        if (yoy >= 0) return '<span class="c1-tt-pill up">↑ +' + yoy + '%</span>';
        return '<span class="c1-tt-pill down">↓ ' + yoy + '%</span>';
      };

      // ===== CARD 1 · Vertical bar group renderer =====
      const c1BarGroup = (groupTitle, key, unit, fmtFn) => {
        const dacVal = dacTotals[key];
        const liVal  = liTotals[key];
        const totVal = totTotals[key];
        const dacPrev = dacPrevTotals[key];
        const liPrev  = liPrevTotals[key];
        const totPrev = totPrevTotals[key];

        // Total is always 100% (tallest bar in the group)
        const dacH = totVal > 0 ? (dacVal / totVal * 100) : 0;
        const liH  = totVal > 0 ? (liVal  / totVal * 100) : 0;
        const totH = 100;

        const dacYoy = yoyCalc(dacVal, dacPrev);
        const liYoy  = yoyCalc(liVal,  liPrev);
        const totYoy = yoyCalc(totVal, totPrev);

        const unitSuffix = unit ? ' ' + unit : '';

        return `
          <div class="c1-group">
            <div class="c1-bars">
              <div class="c1-bar-wrap">
                <div class="c1-bar">
                  ${dacH > 8
                    ? `<div class="c1-bar-fill c1-dac" style="height:${dacH.toFixed(2)}%"><span class="c1-bar-num">${fmtFn(dacVal)}</span></div>`
                    : `<div class="c1-bar-fill c1-dac" style="height:${dacH.toFixed(2)}%"></div><span class="c1-bar-num-outside" style="bottom:calc(${dacH.toFixed(2)}% + 2px)">${fmtFn(dacVal)}</span>`}
                </div>
                <div class="c1-tt">
                  <div class="c1-tt-name">DAC · ${groupTitle}</div>
                  <div class="c1-tt-row"><span>${yearLabel}</span><span class="v">${fmtFn(dacVal)}${unitSuffix}</span></div>
                  <div class="c1-tt-row"><span>${prevYearLabel}</span><span class="v">${dacPrev !== null && dacPrev !== undefined && dacPrev > 0 ? fmtFn(dacPrev) + unitSuffix : 'n/a'}</span></div>
                  <div class="c1-tt-row"><span>YoY</span>${yoyPill(dacYoy)}</div>
                  <div class="c1-tt-row"><span>Share</span><span class="v">${pctOf(dacVal, totVal)}</span></div>
                </div>
              </div>
              <div class="c1-bar-wrap">
                <div class="c1-bar">
                  ${liH > 8
                    ? `<div class="c1-bar-fill c1-li" style="height:${liH.toFixed(2)}%"><span class="c1-bar-num">${fmtFn(liVal)}</span></div>`
                    : `<div class="c1-bar-fill c1-li" style="height:${liH.toFixed(2)}%"></div><span class="c1-bar-num-outside" style="bottom:calc(${liH.toFixed(2)}% + 2px)">${fmtFn(liVal)}</span>`}
                </div>
                <div class="c1-tt">
                  <div class="c1-tt-name">Low-Income · ${groupTitle}</div>
                  <div class="c1-tt-row"><span>${yearLabel}</span><span class="v">${fmtFn(liVal)}${unitSuffix}</span></div>
                  <div class="c1-tt-row"><span>${prevYearLabel}</span><span class="v">${liPrev !== null && liPrev !== undefined && liPrev > 0 ? fmtFn(liPrev) + unitSuffix : 'n/a'}</span></div>
                  <div class="c1-tt-row"><span>YoY</span>${yoyPill(liYoy)}</div>
                  <div class="c1-tt-row"><span>Share</span><span class="v">${pctOf(liVal, totVal)}</span></div>
                </div>
              </div>
              <div class="c1-bar-wrap">
                <div class="c1-bar">
                  ${totH > 8
                    ? `<div class="c1-bar-fill c1-tot" style="height:${totH.toFixed(2)}%"><span class="c1-bar-num">${fmtFn(totVal)}</span></div>`
                    : `<div class="c1-bar-fill c1-tot" style="height:${totH.toFixed(2)}%"></div><span class="c1-bar-num-outside" style="bottom:calc(${totH.toFixed(2)}% + 2px)">${fmtFn(totVal)}</span>`}
                </div>
                <div class="c1-tt">
                  <div class="c1-tt-name">Total · ${groupTitle}</div>
                  <div class="c1-tt-row"><span>${yearLabel}</span><span class="v">${fmtFn(totVal)}${unitSuffix}</span></div>
                  <div class="c1-tt-row"><span>${prevYearLabel}</span><span class="v">${totPrev !== null && totPrev !== undefined && totPrev > 0 ? fmtFn(totPrev) + unitSuffix : 'n/a'}</span></div>
                  <div class="c1-tt-row"><span>YoY</span>${yoyPill(totYoy)}</div>
                </div>
              </div>
            </div>
            <div class="c1-group-label">${groupTitle}</div>
          </div>`;
      };

      const card1 = `
        <div class="chart-card">
          <div class="chart-card-head">
            <div>
              <h3>Participation Summary by Customer Group</h3>
              <p class="chart-sub">${yearLabel} · hover for YoY vs ${prevYearLabel}</p>
            </div>
            <div class="chart-legend">
              <div class="legend-item"><span class="legend-swatch" style="background:var(--dusk)"></span>DAC</div>
              <div class="legend-item"><span class="legend-swatch" style="background:#5B7BB0"></span>Low-Inc.</div>
              <div class="legend-item"><span class="legend-swatch" style="background:#1E3A6B"></span>Total</div>
            </div>
          </div>
          <div class="c1-chart">
            ${c1BarGroup('Participants',            'participants', '',   fmtCompact)}
            ${c1BarGroup('Committed Load Relief',   'committed',    'MW', fmtMW)}
            ${c1BarGroup('Delivered Load Relief',   'delivered',    'MW', fmtMW)}
          </div>
        </div>`;

      // ===== CARD 2 · Program performance table =====
      const PROG_CATEGORIES = {
        'CSRP': 'Peak Shaving',
        'DLRP': 'Contingency',
        'Term-DLM': 'Peak Shaving',
        'Auto-DLM': 'Multi-purpose',
        'BYOT': 'Mass-market'
      };

      // Build per-program rows: lookup committed & delivered for each segment
      const programs = c5.map(p => {
        const dac = c3.find(x => x.name === p.name) || { committed: 0, delivered: 0, participants: 0 };
        const li  = c4.find(x => x.name === p.name) || { committed: 0, delivered: 0, participants: 0 };
        return { name: p.name, dac, li, total: { committed: p.committed, delivered: p.delivered, participants: p.participants } };
      });

      // Panel maxes (each panel scales independently)
      const dacPanelMax = Math.max(...programs.map(p => p.dac.committed));
      const liPanelMax  = Math.max(...programs.map(p => p.li.committed));
      const totPanelMax = Math.max(...programs.map(p => p.total.committed));

      const ratioClass = (committed, delivered) => {
        if (committed === 0) return 'c2-na';
        const r = (delivered / committed) * 100;
        if (r < 50)        return 'c2-bad';
        if (r < 100)       return 'c2-under';
        if (r <= 150)      return 'c2-over';
        return 'c2-excellent';
      };

      const renderC2Cell = (progName, segData, segPrevData, panelMax, segCls) => {
        const segLabel = segCls === 'c2-dac' ? 'DAC' : segCls === 'c2-li' ? 'Low-Income' : 'Total';
        const prevComm = segPrevData ? (segPrevData.committed || 0) : 0;
        const prevDelv = segPrevData ? (segPrevData.delivered || 0) : 0;
        const prevRatio = prevComm > 0 ? (prevDelv / prevComm) * 100 : null;
        const commYoy = yoyCalc(segData.committed, prevComm);
        const delvYoy = yoyCalc(segData.delivered, prevDelv);
        const ratioYoy = (prevRatio !== null && prevRatio > 0)
          ? Math.round(((segData.committed > 0 ? (segData.delivered / segData.committed) * 100 : 0) - prevRatio))
          : null;

        if (panelMax === 0 || segData.committed === 0) {
          return `
            <div class="c2-prog-cell">
              <div class="c2-prog-empty">No data</div>
              <div class="c2-tt">
                <div class="c2-tt-name">${progName} · ${segLabel}</div>
                <div class="c2-tt-row"><span>Committed</span><span class="v">0 MW</span></div>
                <div class="c2-tt-row"><span>Delivered</span><span class="v">0 MW</span></div>
                <div class="c2-tt-row"><span>Participants</span><span class="v">${fmtInt(segData.participants)}</span></div>
              </div>
            </div>`;
        }

        const commPct = (segData.committed / panelMax) * 100;
        const delvPct = (segData.delivered / panelMax) * 100;
        const ratio = (segData.delivered / segData.committed) * 100;
        const rCls = ratioClass(segData.committed, segData.delivered);
        const segModifier = segCls === 'c2-dac' ? '' : (segCls === 'c2-li' ? ' c2-li' : ' c2-tot');

        const showInsideLabel = delvPct > 12;
        const deliveredLabel = showInsideLabel ? fmtMW(segData.delivered) + ' MW' : '';

        const labelPosStyle = commPct > 70
          ? `right:6px`
          : `left:calc(${commPct.toFixed(2)}% + 4px)`;

        // YoY pills (small inline)
        const commYoyPill = yoyPill(commYoy);
        const delvYoyPill = yoyPill(delvYoy);
        const ratioYoyPill = ratioYoy === null
          ? '<span class="c1-tt-pill na" style="background:var(--white-smoke);color:var(--text-3)">n/a</span>'
          : (ratioYoy >= 0
              ? '<span class="c1-tt-pill up">↑ +' + ratioYoy + 'pp</span>'
              : '<span class="c1-tt-pill down">↓ ' + ratioYoy + 'pp</span>');

        const prevCommStr = prevComm > 0 ? fmtMW(prevComm) + ' MW' : 'n/a';
        const prevDelvStr = prevDelv > 0 ? fmtMW(prevDelv) + ' MW' : 'n/a';
        const prevRatioStr = prevRatio !== null ? prevRatio.toFixed(1) + '%' : 'n/a';

        return `
          <div class="c2-prog-cell">
            <div class="c2-prog-bar">
              <div class="c2-prog-comm${segModifier}" style="width:${commPct.toFixed(2)}%"></div>
              <div class="c2-prog-deliv${segModifier}" style="width:${delvPct.toFixed(2)}%">${deliveredLabel}</div>
              <div class="c2-prog-comm-label" style="${labelPosStyle}">${fmtMW(segData.committed)} committed</div>
            </div>
            <div class="c2-prog-ratio ${rCls}">${ratio.toFixed(1)}%</div>
            <div class="c2-tt">
              <div class="c2-tt-name">${progName} · ${segLabel}</div>
              <div class="c2-tt-row"><span>Committed ${yearLabel}</span><span class="v">${fmtMW(segData.committed)} MW</span></div>
              <div class="c2-tt-row"><span>Committed ${prevYearLabel}</span><span class="v">${prevCommStr}</span></div>
              <div class="c2-tt-row"><span>Committed YoY</span>${commYoyPill}</div>
              <div class="c2-tt-row" style="margin-top:4px;padding-top:4px;border-top:1px dashed var(--line)"><span>Delivered ${yearLabel}</span><span class="v">${fmtMW(segData.delivered)} MW</span></div>
              <div class="c2-tt-row"><span>Delivered ${prevYearLabel}</span><span class="v">${prevDelvStr}</span></div>
              <div class="c2-tt-row"><span>Delivered YoY</span>${delvYoyPill}</div>
              <div class="c2-tt-row" style="margin-top:4px;padding-top:4px;border-top:1px dashed var(--line)"><span>Ratio ${yearLabel}</span><span class="v">${ratio.toFixed(1)}%</span></div>
              <div class="c2-tt-row"><span>Ratio ${prevYearLabel}</span><span class="v">${prevRatioStr}</span></div>
              <div class="c2-tt-row"><span>Ratio YoY</span>${ratioYoyPill}</div>
              <div class="c2-tt-row" style="margin-top:4px;padding-top:4px;border-top:1px solid var(--line)"><span>Participants</span><span class="v">${fmtInt(segData.participants)}</span></div>
            </div>
          </div>`;
      };

      const c2Rows = programs.map(p => {
        const category = PROG_CATEGORIES[p.name] || '';
        const dacPrev = c3Prev.find(x => x.name === p.name) || null;
        const liPrev  = c4Prev.find(x => x.name === p.name) || null;
        const totPrev = c5Prev.find(x => x.name === p.name) || null;
        return `
          <div class="c2-prog-info">
            <div class="c2-prog-info-name">${p.name}</div>
            <div class="c2-prog-info-cat">${category}</div>
          </div>
          ${renderC2Cell(p.name, p.dac,   dacPrev, dacPanelMax, 'c2-dac')}
          ${renderC2Cell(p.name, p.li,    liPrev,  liPanelMax,  'c2-li')}
          ${renderC2Cell(p.name, p.total, totPrev, totPanelMax, 'c2-tot')}
        `;
      }).join('');

      const card2 = `
        <div class="chart-card">
          <div class="chart-card-head">
            <div>
              <h3>Program Performance · Delivered vs Committed</h3>
              <p class="chart-sub">${yearLabel} · MW delivered vs committed · ratio</p>
            </div>
            <div class="chart-legend">
              <div class="legend-item"><span class="legend-swatch" style="background:var(--dusk-tint);border:1px solid var(--dusk)"></span>Committed</div>
              <div class="legend-item"><span class="legend-swatch" style="background:var(--dusk)"></span>Delivered</div>
            </div>
          </div>
          <div class="c2-table">
            <div></div>
            <div class="c2-grid-head c2-h-dac">DAC</div>
            <div class="c2-grid-head c2-h-li">Low-Income</div>
            <div class="c2-grid-head c2-h-tot">Total</div>
            ${c2Rows}
          </div>
          <div class="c2-foot">
            <span><span class="c2-foot-pill c2-bad">&lt; 50%</span>Critical</span>
            <span><span class="c2-foot-pill c2-under">50–99%</span>Under</span>
            <span><span class="c2-foot-pill c2-over">100–150%</span>Over</span>
            <span><span class="c2-foot-pill c2-excellent">&gt; 150%</span>Excellent</span>
            <span style="margin-left:auto;font-style:italic">Each panel scaled to its own committed maximum</span>
          </div>
        </div>`;

      return `<div class="c-row">${card1}${card2}</div>`;
    }

// ------------------------------------------------------------
// SECTION D · Distributed Energy Resources
// ------------------------------------------------------------
function renderSectionD() {

    const p = state.payload;
    const yr = state.year;
    const prevYr = prevYearOf(yr);
    const hasPrev = !!prevYr;
    const hasPrevData = hasPrev;
    const showCurrent = (yr === p.meta.current_year);
    const yearLabel = yr;
    const prevYearLabel = prevYr || '';
      // ===== Helper: read a row from a D table by metric name (fuzzy match) =====
      const getDRow = (tableId, metricMatch) => {
        const t = p.tables[tableId];
        if (!t) return { upTo: null, inYear: null, prevCum: null };

        const findRow = (data) => {
          if (!data || !data.length) return null;
          return data.find(row => {
            if (!row || !row[0]) return false;
            const label = String(row[0]).toLowerCase();
            return metricMatch.every(term => label.includes(term.toLowerCase()));
          });
        };

        const currData = (t.data && t.data[yr]) || null;
        const prevData = prevYr ? ((t.data && t.data[prevYr]) || null) : null;

        const currRow = findRow(currData);
        const prevRow = findRow(prevData);

        return {
          upTo:   currRow && typeof currRow[1] === 'number' ? currRow[1] : null,
          inYear: currRow && typeof currRow[2] === 'number' ? currRow[2] : null,
          prevCum: prevRow && typeof prevRow[1] === 'number' ? prevRow[1] : null
        };
      };

      // ===== Format helpers =====
      const fmtCompact = v => {
        if (v == null) return '—';
        if (v >= 1e6) return (v/1e6).toFixed(1) + 'M';
        if (v >= 1e3) return (v/1e3).toFixed(1) + 'k';
        return Math.round(v).toLocaleString();
      };
      const fmtMW = v => {
        if (v == null) return '—';
        if (v >= 1000) return v.toFixed(0);
        if (v >= 100) return v.toFixed(0);
        if (v >= 10) return v.toFixed(1);
        return v.toFixed(2);
      };
      const fmtPct = v => v == null ? '—' : (v * 100).toFixed(1) + '%';
      const yoyCalc = (curr, prev) => {
        if (curr == null || prev == null || prev === 0) return null;
        return Math.round((curr - prev) / prev * 100);
      };
      const yoyPill = (yoy) => {
        if (yoy === null) return '<span class="d-yoy-pill na">n/a</span>';
        if (yoy >= 0) return '<span class="d-yoy-pill up">↑ +' + yoy + '%</span>';
        return '<span class="d-yoy-pill down">↓ ' + yoy + '%</span>';
      };

      // ===== Build a horizontal bar metric (Total / DAC + Non-DAC split, both years) =====
      const dBarMetric = (label, fmtFn, total, dac, prevTotal, prevDac, tableId, isLmi) => {
        const yoy = yoyCalc(total, prevTotal);
        const nonDac = (total != null && dac != null) ? total - dac : null;
        const prevNonDac = (prevTotal != null && prevDac != null) ? prevTotal - prevDac : null;

        // Scale: max for both years' totals so bars are comparable
        const maxTotal = Math.max(total || 0, prevTotal || 0) || 1;

        const dacPct      = total      ? (dac      / total)     * 100 : 0;
        const prevDacPct  = prevTotal  ? (prevDac  / prevTotal) * 100 : 0;
        const currBarW    = total      ? (total    / maxTotal)  * 100 : 0;
        const prevBarW    = prevTotal  ? (prevTotal/ maxTotal)  * 100 : 0;

        const dacShare   = total     ? (dac     / total)     : null;
        const prevDacShare = prevTotal ? (prevDac / prevTotal) : null;

        if (isLmi) {
          // LMI: single-color bar (no Non-DAC split), green
          const lmiPct = total ? Math.max(2, currBarW) : 0;
          const prevLmiPct = prevTotal ? Math.max(2, prevBarW) : 0;

          return `
            <div class="d-bar-metric"
              data-table="${tableId}"
              data-label="${label}"
              data-curr="${fmtFn(total)}"
              data-prev="${prevTotal != null ? fmtFn(prevTotal) : 'n/a'}"
              data-yoy="${yoy !== null ? (yoy >= 0 ? '+' : '') + yoy + '%' : 'n/a'}"
              data-is-lmi="true">
              <div class="d-bar-head">
                <span class="d-bar-label">${label}</span>
              </div>
              <div class="d-bar-row">
                <span class="d-bar-yr">${yearLabel}</span>
                <div class="d-bar-track d-bar-track-lmi">
                  <div class="d-bar-seg d-bar-seg-lmi" style="width:${lmiPct}%">
                    <span class="d-bar-num">${fmtFn(total)}</span>
                  </div>
                </div>
                <span class="d-bar-total">${total != null ? fmtPct(dacShare) : '—'}</span>
                <span class="d-bar-yoy-slot">${yoyPill(yoy)}</span>
              </div>
              <div class="d-bar-row d-bar-row-prev">
                <span class="d-bar-yr">${prevYearLabel}</span>
                <div class="d-bar-track d-bar-track-lmi">
                  <div class="d-bar-seg d-bar-seg-lmi" style="width:${prevLmiPct}%">
                    <span class="d-bar-num">${prevTotal != null ? fmtFn(prevTotal) : '—'}</span>
                  </div>
                </div>
                <span class="d-bar-total">${prevTotal != null ? fmtPct(prevDacShare) : '—'}</span>
                <span class="d-bar-yoy-slot"></span>
              </div>
            </div>`;
        }

        return `
          <div class="d-bar-metric"
            data-table="${tableId}"
            data-label="${label}"
            data-curr-total="${fmtFn(total)}"
            data-curr-dac="${fmtFn(dac)}"
            data-curr-non="${fmtFn(nonDac)}"
            data-curr-dac-pct="${dacShare != null ? fmtPct(dacShare) : 'n/a'}"
            data-prev-total="${prevTotal != null ? fmtFn(prevTotal) : 'n/a'}"
            data-prev-dac="${prevDac != null ? fmtFn(prevDac) : 'n/a'}"
            data-prev-non="${prevNonDac != null ? fmtFn(prevNonDac) : 'n/a'}"
            data-prev-dac-pct="${prevDacShare != null ? fmtPct(prevDacShare) : 'n/a'}"
            data-yoy="${yoy !== null ? (yoy >= 0 ? '+' : '') + yoy + '%' : 'n/a'}">
            <div class="d-bar-head">
              <span class="d-bar-label">${label}</span>
            </div>
            <div class="d-bar-row">
              <span class="d-bar-yr">${yearLabel}</span>
              <div class="d-bar-track" style="width:${currBarW}%">
                <div class="d-bar-seg d-bar-seg-dac" style="width:${dacPct}%">
                  <span class="d-bar-num">${fmtFn(dac)}</span>
                </div>
                <div class="d-bar-seg d-bar-seg-non" style="width:${100-dacPct}%">
                  <span class="d-bar-num">${fmtFn(nonDac)}</span>
                </div>
              </div>
              <span class="d-bar-total">${fmtFn(total)}</span>
              <span class="d-bar-yoy-slot">${yoyPill(yoy)}</span>
            </div>
            <div class="d-bar-row d-bar-row-prev">
              <span class="d-bar-yr">${prevYearLabel}</span>
              <div class="d-bar-track" style="width:${prevBarW}%">
                ${prevTotal != null ? `
                  <div class="d-bar-seg d-bar-seg-dac" style="width:${prevDacPct}%">
                    <span class="d-bar-num">${fmtFn(prevDac)}</span>
                  </div>
                  <div class="d-bar-seg d-bar-seg-non" style="width:${100-prevDacPct}%">
                    <span class="d-bar-num">${fmtFn(prevNonDac)}</span>
                  </div>
                ` : ''}
              </div>
              <span class="d-bar-total">${prevTotal != null ? fmtFn(prevTotal) : '—'}</span>
              <span class="d-bar-yoy-slot"></span>
            </div>
          </div>`;
      };

      // ===== Pull data from tables (all from payload) =====
      const d2Proj    = getDRow('D2', ['total', '# of projects']);
      const d2ProjDac = getDRow('D2', ['# of projects', 'dac']);
      const d2Mw      = getDRow('D2', ['total mw installed (all']);
      const d2MwDac   = getDRow('D2', ['total mw installed in dac']);

      const d3Subs    = getDRow('D3', ['total', '# of subscribers']);
      const d3SubsDac = getDRow('D3', ['# of subscribers in dac']);
      const d3Lmi     = getDRow('D3', ['low-income', 'energy affordability']);

      const d4Proj    = getDRow('D4', ['total', '# of projects']);
      const d4ProjDac = getDRow('D4', ['# of projects in dac']);
      const d4Mw      = getDRow('D4', ['total mw installed']);
      const d4MwDac   = getDRow('D4', ['total mw installed in dac']);

      // ===== CARD 1 · D2 — All DERs =====
      const card1 = `
        <div class="chart-card d-card">
          <div class="chart-card-head">
            <div>
              <h3>All DERs · Projects &amp; MW</h3>
              <p class="chart-sub">CDG + RC + NM · cumulative through ${yearLabel}</p>
            </div>
            <div class="chart-legend">
              <div class="legend-item"><span class="legend-swatch" style="background:var(--dusk)"></span>DAC</div>
              <div class="legend-item"><span class="legend-swatch" style="background:var(--pale-sky)"></span>Non-DAC</div>
            </div>
          </div>
          <div class="d-card-body">
            ${dBarMetric('Projects',    fmtCompact, d2Proj.upTo,  d2ProjDac.upTo,  d2Proj.prevCum,  d2ProjDac.prevCum,  'D2', false)}
            ${dBarMetric('MW installed', fmtMW,     d2Mw.upTo,    d2MwDac.upTo,    d2Mw.prevCum,    d2MwDac.prevCum,    'D2', false)}
          </div>
        </div>`;

      // ===== CARD 2 · D3 — Community Solar + RC =====
      const card2 = `
        <div class="chart-card d-card">
          <div class="chart-card-head">
            <div>
              <h3>Community Solar &amp; RC · Subscribers</h3>
              <p class="chart-sub">CDG + RC · cumulative through ${yearLabel}</p>
            </div>
            <div class="chart-legend">
              <div class="legend-item"><span class="legend-swatch" style="background:var(--dusk)"></span>DAC</div>
              <div class="legend-item"><span class="legend-swatch" style="background:var(--pale-sky)"></span>Non-DAC</div>
              <div class="legend-item"><span class="legend-swatch" style="background:var(--green)"></span>LMI</div>
            </div>
          </div>
          <div class="d-card-body">
            ${dBarMetric('Subscribers',         fmtCompact, d3Subs.upTo, d3SubsDac.upTo, d3Subs.prevCum, d3SubsDac.prevCum, 'D3', false)}
            ${dBarMetric('LMI subscribers (EAP)', fmtCompact, d3Lmi.upTo, null,           d3Lmi.prevCum,  null,             'D3', true)}
          </div>
        </div>`;

      // ===== CARD 3 · D4 — Net Metering =====
      const card3 = `
        <div class="chart-card d-card">
          <div class="chart-card-head">
            <div>
              <h3>Net Metering · Residential Solar</h3>
              <p class="chart-sub">NM only · cumulative through ${yearLabel}</p>
            </div>
            <div class="chart-legend">
              <div class="legend-item"><span class="legend-swatch" style="background:var(--dusk)"></span>DAC</div>
              <div class="legend-item"><span class="legend-swatch" style="background:var(--pale-sky)"></span>Non-DAC</div>
            </div>
          </div>
          <div class="d-card-body">
            ${dBarMetric('Projects',    fmtCompact, d4Proj.upTo, d4ProjDac.upTo, d4Proj.prevCum, d4ProjDac.prevCum, 'D4', false)}
            ${dBarMetric('MW installed', fmtMW,     d4Mw.upTo,   d4MwDac.upTo,   d4Mw.prevCum,   d4MwDac.prevCum,   'D4', false)}
          </div>
        </div>`;

      const placeholder = `
        <div class="chart-card f-card f-card-empty">
          <div class="f-empty-content">
            <div class="f-empty-icon">+</div>
            <div class="f-empty-text">Coming soon</div>
            <div class="f-empty-sub">Additional analysis in progress</div>
          </div>
        </div>`;

      return `<div class="chart-row cols-3">${card1}${card2}${card3}</div>`;
    }

// ------------------------------------------------------------
// SECTION E · Strategic Capital Investments
// ------------------------------------------------------------
function renderSectionE() {

    const p = state.payload;
    const yr = state.year;
    const prevYr = prevYearOf(yr);
    const hasPrev = !!prevYr;
    const hasPrevData = hasPrev;
    const showCurrent = (yr === p.meta.current_year);
    const yearLabel = yr;
    const prevYearLabel = prevYr || '';
      // ===== Source data from payload =====
      // Read directly from the selected year and the prior year (if exists).
      // Variable names kept as e2024/e2023 only for backward compatibility
      // with the original code; semantically they are "current" and "prev".
      const eCurr = (p.charts.E1_categories && p.charts.E1_categories.values[yr]) || [];
      const ePrev = prevYr ? ((p.charts.E1_categories && p.charts.E1_categories.values[prevYr]) || []) : [];

      // Normalize names (2023 has "Safety and Security", 2024 has "Safety And Security")
      const normalize = s => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
      const findPrev = (name) => ePrev.find(x => normalize(x.name) === normalize(name));

      // Build unified category list per the selected year as "current".
      // total24 / total23 are kept as legacy field names that the chart
      // template downstream still references (renamed semantically below
      // would require touching ~40 references).
      const cats = eCurr.map(c => {
        const prev = findPrev(c.name);
        return {
          name: c.name,
          total24: c.total || 0,                // "current year total" (legacy name)
          total23: prev ? (prev.total || 0) : 0, // "prev year total" (legacy name)
          curr: c.dac_pct != null ? c.dac_pct : 0,
          prev: prev && prev.dac_pct != null ? prev.dac_pct : null
        };
      });
      // (No swap needed — cats already represents the selected year.)

      // ===== Identify biggest gain =====
      let maxGain = -999, biggestIdx = -1;
      cats.forEach((c, i) => {
        if (c.prev === null) return;
        const g = c.curr - c.prev;
        if (g > maxGain) { maxGain = g; biggestIdx = i; }
      });

      // ===== Format helper =====
      const fmtBig = v => {
        if (v >= 1e9) return '$' + (v/1e9).toFixed(2) + 'B';
        if (v >= 1e6) return '$' + (v/1e6).toFixed(1) + 'M';
        if (v >= 1e3) return '$' + (v/1e3).toFixed(0) + 'K';
        return '$' + v.toLocaleString();
      };

      // ===== Card 1 · Arc chart (canvas) =====
      const card1 = `
        <div class="chart-card">
          <div class="chart-card-head">
            <div>
              <h3>Strategic Capital · DAC Exposure Before &amp; After</h3>
              <p class="chart-sub">DAC exposure % by investment category · ${hasPrev ? (prevYearLabel + ' → ' + yearLabel) : yearLabel}</p>
            </div>
            <div class="chart-legend">
              <div class="legend-item"><span class="legend-swatch" style="background:var(--pale-sky)"></span>${hasPrev ? prevYearLabel : 'baseline'}</div>
              <div class="legend-item"><span class="legend-swatch" style="background:var(--dusk)"></span>${yearLabel}</div>
              <div class="legend-item"><span class="legend-swatch" style="background:var(--green)"></span>Biggest gain</div>
            </div>
          </div>
          <canvas id="e-arc-canvas-section" class="e-arc-canvas"></canvas>
        </div>`;

      // ===== Card 2 · YoY bars =====
      const sortedYoY = cats.slice().sort((a, b) => b.total24 - a.total24);
      const maxAmt = Math.max(...sortedYoY.map(c => Math.max(c.total24, c.total23)));

      const yoyRows = sortedYoY.map(cat => {
        const w24 = maxAmt > 0 ? (cat.total24 / maxAmt) * 100 : 0;
        const w23 = maxAmt > 0 ? (cat.total23 / maxAmt) * 100 : 0;
        const showPrev = cat.prev !== null || cat.total23 > 0;

        // YoY $ change vs prior year
        let yoyAmt = null;
        if (cat.total23 > 0) {
          yoyAmt = Math.round((cat.total24 - cat.total23) / cat.total23 * 100);
        }
        let yoyHtml = '';
        if (yoyAmt === null) {
          yoyHtml = `<span class="e-yoy-pill e-yoy-neutral">n/a</span>`;
        } else if (yoyAmt === 0) {
          yoyHtml = `<span class="e-yoy-pill e-yoy-neutral">→ 0%</span>`;
        } else if (yoyAmt > 0) {
          yoyHtml = `<span class="e-yoy-pill e-yoy-up">↑ +${yoyAmt}%</span>`;
        } else {
          yoyHtml = `<span class="e-yoy-pill e-yoy-down">↓ ${Math.abs(yoyAmt)}%</span>`;
        }

        return `
          <div class="e-yoy-row"
            data-name="${cat.name}"
            data-total24="${fmtBig(cat.total24)}"
            data-total23="${fmtBig(cat.total23)}"
            data-curr="${(cat.curr*100).toFixed(0)}%"
            data-prev="${cat.prev !== null ? (cat.prev*100).toFixed(0)+'%' : 'n/a'}"
            data-yoy="${yoyAmt !== null ? (yoyAmt >= 0 ? '+' : '') + yoyAmt + '%' : 'n/a'}">
            <div class="e-yoy-label">${cat.name}</div>
            <div class="e-yoy-bars">
              <div class="e-yoy-bar-line">
                <span class="e-yoy-yr">${yearLabel}</span>
                <div class="e-yoy-track"><div class="e-yoy-fill" style="width:${w24}%;background:var(--dusk)"></div></div>
                <span class="e-yoy-amt">${fmtBig(cat.total24)}</span>
              </div>
              ${showPrev ? `
              <div class="e-yoy-bar-line">
                <span class="e-yoy-yr">${prevYearLabel}</span>
                <div class="e-yoy-track"><div class="e-yoy-fill" style="width:${w23}%;background:var(--pale-sky)"></div></div>
                <span class="e-yoy-amt">${fmtBig(cat.total23)}</span>
              </div>` : ''}
            </div>
            <div class="e-yoy-change">${yoyHtml}</div>
          </div>`;
      }).join('');

      const card2 = `
        <div class="chart-card">
          <div class="chart-card-head">
            <div>
              <h3>Capital Investment YoY · by Category</h3>
              <p class="chart-sub">${yearLabel} vs ${prevYearLabel} per investment category</p>
            </div>
            <div class="chart-legend">
              <div class="legend-item"><span class="legend-swatch" style="background:var(--dusk)"></span>${yearLabel}</div>
              <div class="legend-item"><span class="legend-swatch" style="background:var(--pale-sky)"></span>${prevYearLabel}</div>
            </div>
          </div>
          <div class="e-yoy-list">${yoyRows}</div>
        </div>`;

      // Store cats globally so the arc-drawing function can access it after innerHTML
      window.__sectionE_cats = cats;
      window.__sectionE_biggestIdx = biggestIdx;
      window.__sectionE_yr = yearLabel;
      window.__sectionE_prevYr = prevYearLabel;

      return `<div class="chart-row cols-2">${card1}${card2}</div>`;
    }

// ------------------------------------------------------------
// SECTION F · Customer Outages
// ------------------------------------------------------------
function renderSectionF() {
    const p = state.payload;
    const yr = state.year;
    const prevYr = prevYearOf(yr);
    const hasPrev = !!prevYr;
    const yearLabel = yr;
    const prevYearLabel = prevYr || '';

    const fmtCompact = v => {
      if (v == null) return '—';
      if (v >= 1e6) return (v/1e6).toFixed(1) + 'M';
      if (v >= 1e3) return (v/1e3).toFixed(1) + 'k';
      return Math.round(v).toLocaleString();
    };
    const fmtNumF3 = v => {
      if (v == null) return '—';
      if (Number.isInteger(v)) return v.toLocaleString();
      return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
    };
    const yoyCalc = (curr, prev) => {
      if (curr == null || prev == null || prev === 0) return null;
      return Math.round((curr - prev) / prev * 100);
    };

    // ===== CARD 1 · F3 Interruption Rate (tiles) =====
    const f3 = p.tables.F3;
    const f3Curr = f3 && f3.data[yr] ? f3.data[yr] : [];
    const f3Prev = f3 && f3.data[prevYr] ? f3.data[prevYr] : [];
    const f3MetricLabel = (f3 && f3.schema_by_year && f3.schema_by_year[yr] && f3.schema_by_year[yr][1])
      ? f3.schema_by_year[yr][1]
      : 'Customers interrupted per 1,000 served';

    let f3Rows = f3Curr.filter(r =>
      r && r[0] && typeof r[1] === 'number' &&
      !/grand total/i.test(String(r[0])) &&
      !/^category$/i.test(String(r[0]))
    );

    // Reorder: move the "Overall" row (if present) to the end so it spans full width via :last-child
    const overallIdx = f3Rows.findIndex(r => /\boverall\b/i.test(String(r[0])));
    if (overallIdx >= 0 && overallIdx !== f3Rows.length - 1) {
      const [overall] = f3Rows.splice(overallIdx, 1);
      f3Rows.push(overall);
    }

    // Strip any "(YYYY)" suffix so labels match across years
    const stripYear = (s) => String(s).replace(/\s*\(\d{4}\)\s*/g, '').trim();

    const f3PrevFor = (label) => {
      const key = stripYear(label);
      const found = f3Prev.find(pr => pr && pr[0] && stripYear(pr[0]) === key);
      return found && typeof found[1] === 'number' ? found[1] : null;
    };

    const f3Tiles = f3Rows.map(r => {
      const label = String(r[0]);
      const val = r[1];
      const prevVal = f3PrevFor(label);
      const yoy = yoyCalc(val, prevVal);
      const isConEd = /^con\s*edison/i.test(label);
      let yoyHtml = '';
      if (yoy === null) {
        yoyHtml = `<span class="f3-yoy-pill f3-yoy-neutral">n/a</span>`;
      } else if (yoy === 0) {
        yoyHtml = `<span class="f3-yoy-pill f3-yoy-neutral">→ 0%</span>`;
      } else if (yoy > 0) {
        yoyHtml = `<span class="f3-yoy-pill f3-yoy-bad">↑ +${yoy}%</span>`;
      } else {
        yoyHtml = `<span class="f3-yoy-pill f3-yoy-good">↓ ${Math.abs(yoy)}%</span>`;
      }
      return `
        <div class="f3-tile ${isConEd ? 'f3-tile-coned' : ''}"
          data-tt-label="${label}"
          data-tt-curr="${fmtNumF3(val)}"
          data-tt-prev="${prevVal != null ? fmtNumF3(prevVal) : 'missing'}"
          data-tt-yoy="${yoy !== null ? (yoy >= 0 ? '+' : '') + yoy + '%' : 'missing'}">
          <div class="f3-tile-label">${label}</div>
          <div class="f3-tile-value">${fmtNumF3(val)}</div>
          <div class="f3-tile-yoy">${yoyHtml}</div>
        </div>`;
    }).join('');

    const card1 = `
      <div class="chart-card f-card">
        <div class="chart-card-head">
          <div>
            <h3>Interruption Rate</h3>
            <p class="chart-sub">${f3MetricLabel}</p>
          </div>
        </div>
        <div class="f3-tiles-grid">
          ${f3Tiles}
        </div>
      </div>`;

    // ===== Helper for F8/F9 borough cards =====
    const buildBoroughCard = (tableId, title, subtitle, sourceLabel) => {
      const t = p.tables[tableId];
      const curr = t && t.data[yr]    ? t.data[yr]    : [];
      const prev = t && t.data[prevYr] ? t.data[prevYr] : [];
      const rows = curr.filter(r =>
        r && r[0] &&
        !/grand total/i.test(String(r[0])) &&
        String(r[0]) !== 'Borough / County' &&
        String(r[0]) !== 'County'
      );
      const boroughs = rows.map(r => {
        const name = r[0];
        const dac = typeof r[1] === 'number' ? r[1] : 0;
        const nondac = typeof r[3] === 'number' ? r[3] : 0;
        const prevRow = prev.find(pr => pr && pr[0] === name);
        const prevDac = prevRow && typeof prevRow[1] === 'number' ? prevRow[1] : null;
        const prevNon = prevRow && typeof prevRow[3] === 'number' ? prevRow[3] : null;
        const total = dac + nondac;
        const dacPct = total > 0 ? (dac / total) * 100 : 0;
        const nonPct = total > 0 ? (nondac / total) * 100 : 0;
        return { name, dac, nondac, prevDac, prevNon, total, dacPct, nonPct };
      }).sort((a, b) => a.name.localeCompare(b.name));

      const rowsHtml = boroughs.map(b => {
        const dacYoy = yoyCalc(b.dac, b.prevDac);
        const nonYoy = yoyCalc(b.nondac, b.prevNon);
        return `
          <div class="f3-borough"
            data-name="${b.name}"
            data-curr-dac="${fmtCompact(b.dac)}"
            data-curr-non="${fmtCompact(b.nondac)}"
            data-curr-total="${fmtCompact(b.total)}"
            data-dac-pct="${b.dacPct.toFixed(1)}%"
            data-non-pct="${b.nonPct.toFixed(1)}%"
            data-prev-dac="${b.prevDac != null ? fmtCompact(b.prevDac) : 'n/a'}"
            data-prev-non="${b.prevNon != null ? fmtCompact(b.prevNon) : 'n/a'}"
            data-dac-yoy="${dacYoy !== null ? (dacYoy >= 0 ? '+' : '') + dacYoy + '%' : 'n/a'}"
            data-non-yoy="${nonYoy !== null ? (nonYoy >= 0 ? '+' : '') + nonYoy + '%' : 'n/a'}"
            data-source="${sourceLabel}">
            <div class="f3-borough-name">${b.name}</div>
            <div class="f3-borough-stacked">
              <div class="f3-borough-track">
                <div class="f3-borough-fill f3-borough-fill-dac" style="width:${b.dacPct.toFixed(1)}%">
                  <span class="f3-borough-num">${b.dacPct.toFixed(1)}%</span>
                </div>
                <div class="f3-borough-fill f3-borough-fill-non" style="width:${b.nonPct.toFixed(1)}%">
                  <span class="f3-borough-num">${b.nonPct.toFixed(1)}%</span>
                </div>
              </div>
              <span class="f3-borough-total">${fmtCompact(b.total)}</span>
            </div>
          </div>`;
      }).join('');

      return `
        <div class="chart-card f-card">
          <div class="chart-card-head">
            <div>
              <h3>${title}</h3>
              <p class="chart-sub">${subtitle}</p>
            </div>
            <div class="chart-legend">
              <div class="legend-item"><span class="legend-swatch" style="background:var(--dusk)"></span>DAC</div>
              <div class="legend-item"><span class="legend-swatch" style="background:var(--pale-sky)"></span>Non-DAC</div>
            </div>
          </div>
          <div class="f3-card-body">
            ${rowsHtml}
          </div>
        </div>`;
    };

    const card2 = buildBoroughCard(
      'F8',
      'Customers by Borough',
      'DAC vs Non-DAC customer base per borough',
      'F8 · Customers by type'
    );

    const card3 = buildBoroughCard(
      'F9',
      'Customers Interrupted by Borough',
      'DAC vs Non-DAC per borough · YoY change shown for DAC',
      'F9 · Customers interrupted'
    );

    return `<div class="chart-row cols-3">${card1}${card2}${card3}</div>`;
  }

// ------------------------------------------------------------
// SECTION G · Main Replacement Program
// ------------------------------------------------------------
function renderSectionG() {
    const p = state.payload;
    const yr = state.year;
    const prevYr = prevYearOf(yr);
    const hasPrev = !!prevYr;
    const yearLabel = yr;
    const prevYearLabel = prevYr || '';

    const fmtCompact = v => {
      if (v == null) return '—';
      if (v >= 1e6) return (v/1e6).toFixed(1) + 'M';
      if (v >= 1e3) return (v/1e3).toFixed(1) + 'k';
      return Math.round(v).toLocaleString();
    };

    // ===== Read a (dac, total) pair for a given (tableId, year) =====
    // G1 = systemwide replaced; G2/G4/G6/G8 = borough replaced
    // G3/G5/G7/G9 = borough abandoned
    // Schema: row 0 = DAC, row 1 = Non-DAC; col 1 = feet, col 2 = %
    const readPair = (tableId, year) => {
      const t = p.tables[tableId];
      if (!t || !t.data || !t.data[year]) {
        return { dac: null, nondac: null, total: null, dacPct: null };
      }
      const rows = t.data[year];
      let dacFeet = null, nondacFeet = null;
      let dacPctRaw = null, nondacPctRaw = null;

      rows.forEach(r => {
        if (!r || !r[0]) return;
        const label = String(r[0]).toLowerCase();
        const feet = typeof r[1] === 'number' ? r[1] : null;
        const pct  = typeof r[2] === 'number' ? r[2] : null;

        // Skip pure total rows (Systemwide Total, County Total, Grand Total)
        // but keep "Total mT CH4 in DACs / in Non-DACs" rows (G10)
        if (/total/i.test(label) && !/(in (a |non-?)?dacs?|within (a )?dacs?)/i.test(label)) return;

        // Order matters: check Non-DAC first because "not in a dac" contains "dac"
        if (/not in (a )?dacs?/i.test(label) || /non-?dacs?/i.test(label)) {
          nondacFeet = feet;
          nondacPctRaw = pct;
        } else if (/(within|in) (a )?dacs?/i.test(label)) {
          dacFeet = feet;
          dacPctRaw = pct;
        }
      });

      // Total feet: only if both feet values are present
      const total = (dacFeet != null && nondacFeet != null) ? dacFeet + nondacFeet : null;

      // DAC %: prefer the explicit % from the table; fall back to computing from feet
      let dacPct = null;
      if (dacPctRaw != null) {
        dacPct = dacPctRaw;
      } else if (dacFeet != null && total != null && total > 0) {
        dacPct = dacFeet / total;
      }

      return {
        dac: dacFeet,
        nondac: nondacFeet,
        total: total,
        dacPct: dacPct
      };
    };

    // ===== Borough config: { label, replacedTable, abandonedTable } =====
    const BOROUGHS = [
      { label: 'Bronx',       repl: 'G2', aban: 'G3' },
      { label: 'Manhattan',   repl: 'G4', aban: 'G5' },
      { label: 'Queens',      repl: 'G6', aban: 'G7' },
      { label: 'Westchester', repl: 'G8', aban: 'G9' },
    ];

    // ===== Build row data for cards 1 & 2 =====
    const replacedRows = BOROUGHS.map(b => ({
      label: b.label,
      ...readPair(b.repl, yr),
      prev: readPair(b.repl, prevYr),
    }));
    const abandonedRows = BOROUGHS.map(b => ({
      label: b.label,
      ...readPair(b.aban, yr),
      prev: readPair(b.aban, prevYr),
    }));

    // ===== YoY pp pill (good = up, bad = down) for DAC share =====
    const ppPill = (curr, prev) => {
      if (curr == null || prev == null) return '';
      const delta = Math.round((curr - prev) * 100);
      if (delta === 0) return `<span class="g-yoy-pill g-yoy-neutral">→ 0pp</span>`;
      const cls = delta > 0 ? 'g-yoy-up' : 'g-yoy-down';
      const sign = delta > 0 ? '+' : '';
      return `<span class="g-yoy-pill ${cls}">${sign}${delta}pp</span>`;
    };

    // ===== Row renderer (used by both card 1 and card 2) =====
    const renderRow = (r, sourceLabel) => {
      const pctNum = r.dacPct != null ? r.dacPct * 100 : 0;
      const prevPctNum = r.prev && r.prev.dacPct != null ? r.prev.dacPct * 100 : null;
      const pill = r.prev ? ppPill(r.dacPct, r.prev.dacPct) : '';
      return `
        <div class="g-row"
          data-tt-label="${r.label}"
          data-tt-source="${sourceLabel}"
          data-tt-curr-feet="${r.total != null ? fmtCompact(r.total) + ' ft' : 'missing'}"
          data-tt-prev-feet="${r.prev && r.prev.total != null && r.prev.total > 0 ? fmtCompact(r.prev.total) + ' ft' : 'missing'}"
          data-tt-curr-pct="${r.dacPct != null ? pctNum.toFixed(0) + '%' : 'missing'}"
          data-tt-prev-pct="${r.prev && r.prev.dacPct != null ? Math.round(r.prev.dacPct * 100) + '%' : 'missing'}"
          data-tt-yoy="${r.prev && r.prev.dacPct != null && r.dacPct != null ? (Math.round((r.dacPct - r.prev.dacPct) * 100) >= 0 ? '+' : '') + Math.round((r.dacPct - r.prev.dacPct) * 100) + 'pp' : 'missing'}">
          <div class="g-row-label">${r.label}</div>
          <div class="g-row-bar">
            ${prevPctNum !== null ? `<div class="g-dot g-dot-prev" style="left:${prevPctNum}%"></div>` : ''}
            <div class="g-dot g-dot-curr" style="left:${pctNum}%"></div>
            <span class="g-dot-pct" style="left:${pctNum}%">${r.dacPct != null ? pctNum.toFixed(0) + '%' : '—'}</span>
          </div>
          <div class="g-row-pill">${pill}</div>
        </div>`;
    };

    // ===== Card 1 · Pipe Retired & Replaced =====
    const c1Total = null;
    const card1 = `
      <div class="chart-card">
        <div class="chart-card-head">
          <div>
            <h3>Pipe Retired &amp; Replaced</h3>
            <p class="chart-sub">Feet Replaced within DAC</p>
          </div>
          <div class="chart-legend">
            <div class="legend-item"><span class="legend-swatch" style="background:var(--dusk)"></span>${yearLabel}</div>
            ${hasPrev ? `<div class="legend-item"><span class="legend-swatch" style="background:var(--pale-sky)"></span>${prevYearLabel}</div>` : ''}
          </div>
        </div>
        <div class="g-rows">${replacedRows.map(r => renderRow(r, 'G · Pipe replaced')).join('')}</div>
        </div>`;

    // ===== Card 2 · Pipe Abandoned =====
    const c2Total = abandonedRows[0].total;
    const card2 = `
      <div class="chart-card">
        <div class="chart-card-head">
          <div>
            <h3>Pipe Abandoned</h3>
            <p class="chart-sub">Feet Abandoned within DAC</p>
          </div>
          <div class="chart-legend">
            <div class="legend-item"><span class="legend-swatch" style="background:var(--dusk)"></span>${yearLabel}</div>
            ${hasPrev ? `<div class="legend-item"><span class="legend-swatch" style="background:var(--pale-sky)"></span>${prevYearLabel}</div>` : ''}
          </div>
        </div>
        <div class="g-rows">${abandonedRows.map(r => renderRow(r, 'G · Pipe abandoned')).join('')}</div>
        </div>`;

    // ===== Card 3 · Methane Emissions Avoided (G10) =====
    const g10Curr = readPair('G10', yr);
    const g10Prev = readPair('G10', prevYr);

    // % live in column 2 of each row — read literally, no calc
    const readPctFor = (tableId, year, which) => {
      const t = p.tables[tableId];
      if (!t || !t.data || !t.data[year]) return null;
      for (const r of t.data[year]) {
        if (!r || !r[0]) continue;
        const label = String(r[0]).toLowerCase();
        if (/total/i.test(label) && !/(in (a |non-?)?dacs?|within (a )?dacs?)/i.test(label)) continue;
        const isNonDac = /not in (a )?dacs?/i.test(label) || /non-?dacs?/i.test(label);
        const isDac    = /(within|in) (a )?dacs?/i.test(label) && !isNonDac;
        if (which === 'dac'    && isDac)    return typeof r[2] === 'number' ? r[2] : null;
        if (which === 'nondac' && isNonDac) return typeof r[2] === 'number' ? r[2] : null;
      }
      return null;
    };

    const dacPctCurr  = readPctFor('G10', yr,     'dac');
    const nonPctCurr  = readPctFor('G10', yr,     'nondac');
    const dacPctPrev  = readPctFor('G10', prevYr, 'dac');
    const nonPctPrev  = readPctFor('G10', prevYr, 'nondac');

    const fmtMt = v => v == null ? null : v.toFixed(2);
    const fmtPct = v => v == null ? null : Math.round(v * 100) + '%';

    // Display values (or 'missing')
    const dacCurrStr     = g10Curr.dac    != null ? fmtMt(g10Curr.dac)    + ' mT CH4' : 'missing';
    const dacPrevStr     = g10Prev.dac    != null ? fmtMt(g10Prev.dac)    + ' mT CH4' : 'missing';
    const nonCurrStr     = g10Curr.nondac != null ? fmtMt(g10Curr.nondac) + ' mT CH4' : 'missing';
    const nonPrevStr     = g10Prev.nondac != null ? fmtMt(g10Prev.nondac) + ' mT CH4' : 'missing';
    const totalCurrStr   = g10Curr.total  != null ? fmtMt(g10Curr.total)  + ' mT CH4' : 'missing';
    const totalPrevStr   = g10Prev.total  != null ? fmtMt(g10Prev.total)  + ' mT CH4' : 'missing';
    const dacPctCurrStr  = fmtPct(dacPctCurr) || 'missing';
    const dacPctPrevStr  = fmtPct(dacPctPrev) || 'missing';
    const nonPctCurrStr  = fmtPct(nonPctCurr) || 'missing';
    const nonPctPrevStr  = fmtPct(nonPctPrev) || 'missing';
    // YoY pills (mT CH4 % change)
    const yoyPillMt = (curr, prev) => {
      if (curr == null || prev == null || prev === 0) return '';
      const pct = Math.round((curr - prev) / Math.abs(prev) * 100);
      if (pct === 0) return `<span class="g-yoy-pill g-yoy-neutral">→ 0%</span>`;
      const cls = pct > 0 ? 'g-yoy-up' : 'g-yoy-down';
      const arrow = pct > 0 ? '↑ +' : '↓ ';
      return `<span class="g-yoy-pill ${cls}">${arrow}${Math.abs(pct)}%</span>`;
    };
    const dacYoyPill   = yoyPillMt(g10Curr.dac,    g10Prev.dac);
    const nonYoyPill   = yoyPillMt(g10Curr.nondac, g10Prev.nondac);
    const totalYoyPill = yoyPillMt(g10Curr.total,  g10Prev.total);

    // YoY raw strings for tooltips
    const dacYoyStr   = (g10Curr.dac    != null && g10Prev.dac    != null && g10Prev.dac    !== 0) ? ((g10Curr.dac    - g10Prev.dac)    / Math.abs(g10Prev.dac)    * 100 >= 0 ? '+' : '') + Math.round((g10Curr.dac    - g10Prev.dac)    / Math.abs(g10Prev.dac)    * 100) + '%' : 'missing';
    const nonYoyStr   = (g10Curr.nondac != null && g10Prev.nondac != null && g10Prev.nondac !== 0) ? ((g10Curr.nondac - g10Prev.nondac) / Math.abs(g10Prev.nondac) * 100 >= 0 ? '+' : '') + Math.round((g10Curr.nondac - g10Prev.nondac) / Math.abs(g10Prev.nondac) * 100) + '%' : 'missing';
    const totalYoyStr = (g10Curr.total  != null && g10Prev.total  != null && g10Prev.total  !== 0) ? ((g10Curr.total  - g10Prev.total)  / Math.abs(g10Prev.total)  * 100 >= 0 ? '+' : '') + Math.round((g10Curr.total  - g10Prev.total)  / Math.abs(g10Prev.total)  * 100) + '%' : 'missing';

    // Donut math
    const circumference = 2 * Math.PI * 70;
    const dacDash = (dacPctCurr != null) ? dacPctCurr * circumference : 0;
    const nonDash = (nonPctCurr != null) ? nonPctCurr * circumference : 0;

    const g10HasData = (g10Curr.dac != null || g10Curr.nondac != null);

    const card3 = !g10HasData ? `
      <div class="chart-card">
        <div class="chart-card-head">
          <div>
            <h3>Methane Emissions Avoided</h3>
            <p class="chart-sub">DAC share · mT CH4</p>
          </div>
        </div>
        <div class="empty-pane">No data available for ${yearLabel}</div>
      </div>` : `
      <div class="chart-card">
        <div class="chart-card-head">
          <div>
            <h3>Methane Emissions Avoided</h3>
            <p class="chart-sub">DAC share · mT CH4</p>
          </div>
        </div>
        <div class="g-methane-body">
          <svg viewBox="0 0 200 200" class="g-methane-donut"
            data-tt-total-curr="${totalCurrStr}"
            data-tt-total-prev="${totalPrevStr}"
            data-tt-total-yoy="${totalYoyStr}"
            data-tt-dac-curr="${dacCurrStr}"
            data-tt-dac-prev="${dacPrevStr}"
            data-tt-dac-pct-curr="${dacPctCurrStr}"
            data-tt-dac-pct-prev="${dacPctPrevStr}"
            data-tt-dac-yoy="${dacYoyStr}"
            data-tt-non-curr="${nonCurrStr}"
            data-tt-non-prev="${nonPrevStr}"
            data-tt-non-pct-curr="${nonPctCurrStr}"
            data-tt-non-pct-prev="${nonPctPrevStr}"
            data-tt-non-yoy="${nonYoyStr}">
            <circle cx="100" cy="100" r="70" fill="none" stroke="var(--white-smoke)" stroke-width="40"></circle>
            <circle cx="100" cy="100" r="70" fill="none" stroke="var(--pale-sky)" stroke-width="40"
              stroke-dasharray="${nonDash.toFixed(2)} ${circumference.toFixed(2)}"
              stroke-dashoffset="0" transform="rotate(-90 100 100)"></circle>
            <circle cx="100" cy="100" r="70" fill="none" stroke="var(--dusk)" stroke-width="40"
              stroke-dasharray="${dacDash.toFixed(2)} ${circumference.toFixed(2)}"
              stroke-dashoffset="${(-nonDash).toFixed(2)}" transform="rotate(-90 100 100)"></circle>
            <text x="100" y="92" text-anchor="middle" font-size="22" font-weight="700" fill="var(--text)">${g10Curr.total != null ? fmtMt(g10Curr.total) : '—'}</text>
            <text x="100" y="108" text-anchor="middle" font-size="8" fill="var(--text-3)" font-weight="600" letter-spacing="0.06em">MT CH4 TOTAL</text>
          </svg>
          <div class="g-methane-blocks">
            <div class="g-methane-block g-methane-dac"
              data-tt-label="DAC"
              data-tt-curr="${dacCurrStr}"
              data-tt-prev="${dacPrevStr}"
              data-tt-pct-curr="${dacPctCurrStr}"
              data-tt-pct-prev="${dacPctPrevStr}"
              data-tt-yoy="${dacYoyStr}">
              <div class="g-methane-row">
                <span class="g-methane-label">DAC</span>
                ${dacYoyPill}
              </div>
              <div class="g-methane-num">${g10Curr.dac != null ? fmtMt(g10Curr.dac) : '—'}</div>
              <div class="g-methane-sub">${dacPctCurr != null ? Math.round(dacPctCurr * 100) + '% · mT CH4' : 'mT CH4'}</div>
            </div>
            <div class="g-methane-block g-methane-non"
              data-tt-label="Non-DAC"
              data-tt-curr="${nonCurrStr}"
              data-tt-prev="${nonPrevStr}"
              data-tt-pct-curr="${nonPctCurrStr}"
              data-tt-pct-prev="${nonPctPrevStr}"
              data-tt-yoy="${nonYoyStr}">
              <div class="g-methane-row">
                <span class="g-methane-label">Non-DAC</span>
                ${nonYoyPill}
              </div>
              <div class="g-methane-num">${g10Curr.nondac != null ? fmtMt(g10Curr.nondac) : '—'}</div>
              <div class="g-methane-sub">${nonPctCurr != null ? Math.round(nonPctCurr * 100) + '% · mT CH4' : 'mT CH4'}</div>
            </div>
          </div>
        </div>
      </div>`;

    return `<div class="chart-row g-row-1-1-2">${card1}${card2}${card3}</div>`;
  }
  function wireFSectionTooltips() {
    let tip = document.querySelector('.exec-tooltip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'exec-tooltip';
      document.body.appendChild(tip);
    }
    const yr = state.year;
    const prevYr = prevYearOf(yr) || '';
    const renderVal = (v) => (v === 'missing' || v == null || v === '')
      ? '<span style="color:var(--text-4);font-style:italic">missing</span>'
      : v;
    const yoyColor = (v) => {
      if (!v || v === 'missing' || v === '0%') return 'var(--text-3)';
      return v.startsWith('-') ? 'var(--green)' : 'var(--red)';
    };

    document.querySelectorAll('.f3-tile[data-tt-label]').forEach(el => {
      el.addEventListener('mouseenter', () => {
        const d = el.dataset;
         tip.innerHTML =
          `<div class="tt-name">${d.ttLabel}</div>` +
          `<div class="tt-row"><span>Source</span><span class="v">F3 · Interruption rate</span></div>` +
          `<div class="tt-row"><span>Rate ${yr}</span><span class="v">${renderVal(d.ttCurr)}</span></div>` +
          `<div class="tt-row"><span>Rate ${prevYr}</span><span class="v">${renderVal(d.ttPrev)}</span></div>` +
          `<div class="tt-row"><span>YoY change</span><span class="v" style="color:${yoyColor(d.ttYoy)}">${renderVal(d.ttYoy)}</span></div>`;
        tip.style.opacity = '1';
      });
      el.addEventListener('mousemove', e => {
        tip.style.left = (e.pageX + 14) + 'px';
        tip.style.top  = (e.pageY - 10) + 'px';
      });
      el.addEventListener('mouseleave', () => { tip.style.opacity = '0'; });
    });
  }
  function wireGSectionTooltips() {
    let tip = document.querySelector('.exec-tooltip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'exec-tooltip';
      document.body.appendChild(tip);
    }

    const yr = state.year;
    const prevYr = prevYearOf(yr) || '';

    const renderVal = (v) => (v === 'missing' || v == null || v === '')
      ? '<span style="color:var(--text-4);font-style:italic">missing</span>'
      : v;

    const yoyColor = (v) => {
      if (!v || v === 'missing' || v === '0%' || v === '0pp') return 'var(--text-3)';
      return v.startsWith('-') ? 'var(--red)' : 'var(--green)';
    };

    // Card 1 & 2 · borough rows
    document.querySelectorAll('.g-row[data-tt-label]').forEach(el => {
      el.addEventListener('mouseenter', () => {
        const d = el.dataset;
        tip.innerHTML =
          `<div class="tt-name">${d.ttLabel}</div>` +
          `<div class="tt-row"><span>Source</span><span class="v">${d.ttSource || 'G · Main replacement'}</span></div>` +
          `<div class="tt-row"><span>Feet ${yr}</span><span class="v">${renderVal(d.ttCurrFeet)}</span></div>` +
          `<div class="tt-row"><span>Feet ${prevYr}</span><span class="v">${renderVal(d.ttPrevFeet)}</span></div>` +
          `<div class="tt-row"><span>DAC % ${yr}</span><span class="v">${renderVal(d.ttCurrPct)}</span></div>` +
          `<div class="tt-row"><span>DAC % ${prevYr}</span><span class="v">${renderVal(d.ttPrevPct)}</span></div>` +
          `<div class="tt-row"><span>YoY change</span><span class="v" style="color:${yoyColor(d.ttYoy)}">${renderVal(d.ttYoy)}</span></div>`;
        tip.style.opacity = '1';
      });
      el.addEventListener('mousemove', e => {
        tip.style.left = (e.pageX + 14) + 'px';
        tip.style.top  = (e.pageY - 10) + 'px';
      });
      el.addEventListener('mouseleave', () => { tip.style.opacity = '0'; });
    });

    // Card 3 · Methane DAC / Non-DAC blocks
    document.querySelectorAll('.g-methane-block[data-tt-label]').forEach(el => {
      el.addEventListener('mouseenter', () => {
        const d = el.dataset;
        tip.innerHTML =
          `<div class="tt-name">${d.ttLabel}</div>` +
          `<div class="tt-row"><span>Source</span><span class="v">G10 · Methane emissions</span></div>` +
          `<div class="tt-row"><span>mT CH4 ${yr}</span><span class="v">${renderVal(d.ttCurr)}</span></div>` +
          `<div class="tt-row"><span>mT CH4 ${prevYr}</span><span class="v">${renderVal(d.ttPrev)}</span></div>` +
          `<div class="tt-row"><span>Share ${yr}</span><span class="v">${renderVal(d.ttPctCurr)}</span></div>` +
          `<div class="tt-row"><span>Share ${prevYr}</span><span class="v">${renderVal(d.ttPctPrev)}</span></div>` +
          `<div class="tt-row"><span>YoY change</span><span class="v" style="color:${yoyColor(d.ttYoy)}">${renderVal(d.ttYoy)}</span></div>`;
        tip.style.opacity = '1';
      });
      el.addEventListener('mousemove', e => {
        tip.style.left = (e.pageX + 14) + 'px';
        tip.style.top  = (e.pageY - 10) + 'px';
      });
      el.addEventListener('mouseleave', () => { tip.style.opacity = '0'; });
    });

    // Card 3 · Methane donut (overall)
    document.querySelectorAll('.g-methane-donut').forEach(el => {
      el.addEventListener('mouseenter', () => {
        const d = el.dataset;
        tip.innerHTML =
          `<div class="tt-name">Methane Emissions Avoided</div>` +
          `<div class="tt-row"><span>Source</span><span class="v">G10 · Methane emissions</span></div>` +
          `<div class="tt-row"><span>Total ${yr}</span><span class="v">${renderVal(d.ttTotalCurr)}</span></div>` +
          `<div class="tt-row"><span>Total ${prevYr}</span><span class="v">${renderVal(d.ttTotalPrev)}</span></div>` +
          `<div class="tt-row"><span>Total YoY</span><span class="v" style="color:${yoyColor(d.ttTotalYoy)}">${renderVal(d.ttTotalYoy)}</span></div>` +
          `<div class="tt-row" style="margin-top:6px;padding-top:6px;border-top:1px solid var(--line)"><span>DAC ${yr}</span><span class="v">${renderVal(d.ttDacCurr)} · ${renderVal(d.ttDacPctCurr)}</span></div>` +
          `<div class="tt-row"><span>DAC ${prevYr}</span><span class="v">${renderVal(d.ttDacPrev)} · ${renderVal(d.ttDacPctPrev)}</span></div>` +
          `<div class="tt-row"><span>DAC YoY</span><span class="v" style="color:${yoyColor(d.ttDacYoy)}">${renderVal(d.ttDacYoy)}</span></div>` +
          `<div class="tt-row" style="margin-top:4px;padding-top:4px;border-top:1px dashed var(--line)"><span>Non-DAC ${yr}</span><span class="v">${renderVal(d.ttNonCurr)} · ${renderVal(d.ttNonPctCurr)}</span></div>` +
          `<div class="tt-row"><span>Non-DAC ${prevYr}</span><span class="v">${renderVal(d.ttNonPrev)} · ${renderVal(d.ttNonPctPrev)}</span></div>` +
          `<div class="tt-row"><span>Non-DAC YoY</span><span class="v" style="color:${yoyColor(d.ttNonYoy)}">${renderVal(d.ttNonYoy)}</span></div>`;
        tip.style.opacity = '1';
      });
      el.addEventListener('mousemove', e => {
        tip.style.left = (e.pageX + 14) + 'px';
        tip.style.top  = (e.pageY - 10) + 'px';
      });
      el.addEventListener('mouseleave', () => { tip.style.opacity = '0'; });
    });
  }

// ------------------------------------------------------------
// SECTION H · Leak Repairs
// ------------------------------------------------------------
function renderSectionH() {

    const p = state.payload;
    const yr = state.year;
    const prevYr = prevYearOf(yr);
    const hasPrev = !!prevYr;
    const hasPrevData = hasPrev;
    const showCurrent = (yr === p.meta.current_year);
    const yearLabel = yr;
    const prevYearLabel = prevYr || '';
      const fmtCompact = v => {
        if (v == null) return '—';
        if (v >= 1e6) return (v/1e6).toFixed(1) + 'M';
        if (v >= 1e3) return (v/1e3).toFixed(1) + 'k';
        return Math.round(v).toLocaleString();
      };
      const yoyCalc = (curr, prev) => {
        if (curr == null || prev == null || prev === 0) return null;
        return Math.round((curr - prev) / prev * 100);
      };

      // ===== Read H1 from Object.values(p.tables) dynamically =====
      const h1 = p.tables.H1;
      const h1CurrData = h1 && h1.data[yr] ? h1.data[yr] : [];
      const h1PrevData = h1 && h1.data[prevYr] ? h1.data[prevYr] : [];

      // H1 cols: [Borough, Non-DAC Repairs, DAC Repairs, Grand Total]
      const h1Boroughs = h1CurrData.filter(r => r[0] && !String(r[0]).toLowerCase().includes('grand total') && r[0] !== 'Borough / County' && r[0] !== 'Area');
      const boroughRows = h1Boroughs.map(r => {
        const name = r[0];
        const nondac = typeof r[1] === 'number' ? r[1] : 0;
        const dac = typeof r[2] === 'number' ? r[2] : 0;
        const prevRow = h1PrevData.find(pr => pr[0] === name);
        const prevNon = prevRow && typeof prevRow[1] === 'number' ? prevRow[1] : null;
        const prevDac = prevRow && typeof prevRow[2] === 'number' ? prevRow[2] : null;
        const total = dac + nondac;
        const dacPct = total > 0 ? (dac / total) * 100 : 0;
        const nonPct = total > 0 ? (nondac / total) * 100 : 0;
        return { name, dac, nondac, prevDac, prevNon, total, dacPct, nonPct };
      }).sort((a, b) => a.name.localeCompare(b.name));

      // ===== CARD 2 · Leak Repairs by Borough =====
      const card2Rows = boroughRows.map(b => {
        const dacYoy = yoyCalc(b.dac, b.prevDac);
        const nonYoy = yoyCalc(b.nondac, b.prevNon);
        const dacYoyPill = dacYoy === null
          ? ''
          : (dacYoy === 0
            ? `<span class="h-yoy-pill h-yoy-neutral">→ 0%</span>`
            : (dacYoy > 0
              ? `<span class="h-yoy-pill h-yoy-down">↑ +${dacYoy}%</span>`
              : `<span class="h-yoy-pill h-yoy-up">↓ ${Math.abs(dacYoy)}%</span>`));
        return `
          <div class="f3-borough"
            data-name="${b.name}"
            data-curr-dac="${fmtCompact(b.dac)}"
            data-curr-non="${fmtCompact(b.nondac)}"
            data-curr-total="${fmtCompact(b.total)}"
            data-dac-pct="${b.dacPct.toFixed(1)}%"
            data-non-pct="${b.nonPct.toFixed(1)}%"
            data-prev-dac="${b.prevDac != null ? fmtCompact(b.prevDac) : 'n/a'}"
            data-prev-non="${b.prevNon != null ? fmtCompact(b.prevNon) : 'n/a'}"
            data-dac-yoy="${dacYoy !== null ? (dacYoy >= 0 ? '+' : '') + dacYoy + '%' : 'n/a'}"
            data-non-yoy="${nonYoy !== null ? (nonYoy >= 0 ? '+' : '') + nonYoy + '%' : 'n/a'}"
            data-source="H1 · Leak repairs">
            <div class="f3-borough-name">${b.name}</div>
            <div class="f3-borough-stacked">
              <div class="f3-borough-track">
                <div class="f3-borough-fill f3-borough-fill-dac" style="width:${b.dacPct.toFixed(1)}%">
                  <span class="f3-borough-num">${b.dacPct.toFixed(1)}%</span>
                </div>
                <div class="f3-borough-fill f3-borough-fill-non" style="width:${b.nonPct.toFixed(1)}%">
                  <span class="f3-borough-num">${b.nonPct.toFixed(1)}%</span>
                </div>
              </div>
              <span class="f3-borough-total">${fmtCompact(b.total)}</span>
              ${dacYoyPill}
            </div>
          </div>`;
      }).join('');

      const card2 = `
        <div class="chart-card f-card">
          <div class="chart-card-head">
            <div>
              <h3>Leak Repairs by Borough</h3>
              <p class="chart-sub">DAC vs Non-DAC per borough · YoY change shown for DAC repairs</p>
            </div>
            <div class="chart-legend">
              <div class="legend-item"><span class="legend-swatch" style="background:var(--dusk)"></span>DAC</div>
              <div class="legend-item"><span class="legend-swatch" style="background:var(--pale-sky)"></span>Non-DAC</div>
            </div>
          </div>
          <div class="f3-card-body">
            ${card2Rows}
          </div>
        </div>`;

      // ===== CARD 3 · Two Pie Charts (unified borough colors, hover for details) =====
      // Same palette for both pies — boroughs identified by color
      const boroughPalette = ['#185FA5', '#3D7BBE', '#6FA0D6', '#A6C5E5'];

      // Build a borough color map (consistent across both pies)
      const boroughColors = {};
      boroughRows.forEach((b, i) => {
        boroughColors[b.name] = boroughPalette[i % boroughPalette.length];
      });

      const totalDac = boroughRows.reduce((s, b) => s + b.dac, 0);
      const totalNon = boroughRows.reduce((s, b) => s + b.nondac, 0);

      const buildPie = (data, total, label) => {
        const cx = 100, cy = 100, r = 70, sw = 50;
        const circumference = 2 * Math.PI * r;
        let offset = 0;
        const segments = data.map(b => {
          const val = b.value;
          const pct = total > 0 ? (val / total) : 0;
          const dash = pct * circumference;
          const color = boroughColors[b.name] || '#999';
          const seg = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none"
            stroke="${color}" stroke-width="${sw}"
            stroke-dasharray="${dash.toFixed(2)} ${circumference.toFixed(2)}"
            stroke-dashoffset="${(-offset).toFixed(2)}"
            transform="rotate(-90 ${cx} ${cy})"
            data-name="${b.name}"
            data-value="${fmtCompact(b.value)}"
            data-prev-value="${b.prevValue != null ? fmtCompact(b.prevValue) : 'n/a'}"
            data-yoy="${b.yoy !== null ? (b.yoy >= 0 ? '+' : '') + b.yoy + '%' : 'n/a'}"
            data-pct="${(pct*100).toFixed(1)}%"
            data-label="${label}"
            class="h-pie-slice"></circle>`;
          offset += dash;
          return seg;
        }).join('');

        return `
          <div class="h-pie-block">
            <div class="h-pie-title">${label}</div>
            <svg viewBox="0 0 200 200" class="h-pie-svg">
              <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--white-smoke)" stroke-width="${sw}"></circle>
              ${segments}
            </svg>
          </div>`;
      };

      const dacData = boroughRows.map(b => ({
        name: b.name,
        value: b.dac,
        prevValue: b.prevDac,
        yoy: yoyCalc(b.dac, b.prevDac)
      }));
      const nonData = boroughRows.map(b => ({
        name: b.name,
        value: b.nondac,
        prevValue: b.prevNon,
        yoy: yoyCalc(b.nondac, b.prevNon)
      }));

      // Legend = boroughs (top right of card head)
      const legendHtml = boroughRows.map(b => `
        <div class="legend-item">
          <span class="legend-swatch" style="background:${boroughColors[b.name]}"></span>${b.name}
        </div>`).join('');

      const card3 = `
        <div class="chart-card f-card">
          <div class="chart-card-head">
            <div>
              <h3>Repairs Distribution Across Boroughs</h3>
              <p class="chart-sub">DAC vs Non-DAC repair split</p>
            </div>
            <div class="chart-legend">${legendHtml}</div>
          </div>
          <div class="h-pies-body">
            ${buildPie(dacData, totalDac, 'DAC Repairs')}
            ${buildPie(nonData, totalNon, 'Non-DAC Repairs')}
          </div>
        </div>`;

      return `<div class="chart-row h-row-3-2">${card2}${card3}</div>`;
    }

// ------------------------------------------------------------
// SECTION I · Clean Energy Jobs
// ------------------------------------------------------------
function renderSectionI() {
    const p = state.payload;
    const yr = state.year;
    const prevYr = prevYearOf(yr);
    const hasPrev = !!prevYr;

    const getVal = (year, rowIdx) => {
      const t = p.tables['I1'];
      if (!t || !t.data || !t.data[year] || !t.data[year][rowIdx]) return null;
      const v = t.data[year][rowIdx][1];
      return typeof v === 'number' ? v : null;
    };

    const enrolled  = getVal(yr, 3);
    const graduates = getVal(yr, 4);
    const placed    = getVal(yr, 5);
    const pEnrolled  = hasPrev ? getVal(prevYr, 3) : null;
    const pGraduates = hasPrev ? getVal(prevYr, 4) : null;
    const pPlaced    = hasPrev ? getVal(prevYr, 5) : null;

    const gradRate   = enrolled  > 0 ? Math.round(graduates / enrolled  * 100) : 0;
    const placeRate  = graduates > 0 ? Math.round(placed    / graduates * 100) : 0;
    const pGradRate  = (pEnrolled  && pGraduates) ? Math.round(pGraduates / pEnrolled  * 100) : null;
    const pPlaceRate = (pGraduates && pPlaced)    ? Math.round(pPlaced    / pGraduates * 100) : null;

    const yoyPct = (curr, prev) => {
      if (curr == null || prev == null || prev === 0) return '';
      const pct = Math.round((curr - prev) / Math.abs(prev) * 100);
      if (pct === 0) return `<span class="i-pill i-pill-neutral">→ 0% YoY</span>`;
      const cls = pct > 0 ? 'up' : 'down';
      const arrow = pct > 0 ? '↑ +' : '↓ ';
      return `<span class="i-pill i-pill-${cls}">${arrow}${Math.abs(pct)}%</span>`;
    };

    const ppPill = (curr, prev, lowerBetter) => {
      if (curr == null || prev == null) return '';
      const delta = curr - prev;
      if (delta === 0) return `<span class="i-pill i-pill-neutral">→ 0pp YoY</span>`;
      const isGood = lowerBetter ? delta < 0 : delta > 0;
      const cls = isGood ? 'up' : 'down';
      const sign = delta > 0 ? '+' : '';
      return `<span class="i-pill i-pill-${cls}">${sign}${delta}pp YoY</span>`;
    };

    const maxVal = Math.max(enrolled || 0, pEnrolled || 0);
    const bw = v => v != null && maxVal > 0 ? (v / maxVal * 100).toFixed(1) : 0;
    const prevYrLabel = prevYr || '';

    const funnelBar = (curr, prev) => {
      const wCurr = bw(curr);
      const wPrev = bw(prev);
      // Barra más corta va al frente para que su label sea visible.
      // Las barras son semitransparentes para que ambas se vean.
      const currShorter = curr != null && prev != null ? curr <= prev : true;
      const currZ = currShorter ? 3 : 2;
      const prevZ = currShorter ? 2 : 3;
      const currLabel = curr != null ? curr.toLocaleString() : '—';
      const prevLabel = prev != null ? prev.toLocaleString() : '';
      return `
        ${prev != null ? `<div class="i-fbar" style="width:${wPrev}%;background:var(--pale-sky);z-index:${prevZ};display:flex;align-items:center;justify-content:flex-end;padding-right:4px"><span style="font-size:12px;font-weight:700;color:var(--ink);white-space:nowrap">${prevLabel}</span></div>` : ''}
        <div class="i-fbar" style="width:${wCurr}%;background:var(--dusk);z-index:${currZ};display:flex;align-items:center;justify-content:flex-end;padding-right:4px"><span style="font-size:12px;font-weight:700;color:var(--white);white-space:nowrap">${currLabel}</span></div>`;
    };

    // ===== CARD 1 · Funnel =====
    const card1 = `
      <div class="chart-card">
        <div class="chart-card-head">
          <div>
            <h3>Clean Energy Academy · Funnel</h3>
            <p class="chart-sub">Student pipeline</p>
          </div>
          <div class="chart-legend" style="font-size:9.5px;gap:8px">
            <div class="legend-item"><span class="legend-swatch" style="background:var(--dusk);width:7px;height:7px;border-radius:50%"></span>${yr}</div>
            ${hasPrev ? `<div class="legend-item"><span class="legend-swatch" style="background:var(--pale-sky);width:7px;height:7px;border-radius:50%"></span>${prevYrLabel}</div>` : ''}
          </div>
        </div>

        <div class="i-funnel">

          <div class="i-funnel-stage"
            data-tt-label="Enrolled"
            data-tt-curr="${yr}: ${enrolled != null ? enrolled.toLocaleString() : '—'} students"
            data-tt-prev="${hasPrev ? prevYrLabel + ': ' + (pEnrolled != null ? pEnrolled.toLocaleString() : '—') + ' students' : ''}"
            data-tt-delta="${enrolled != null && pEnrolled != null ? 'Change: ' + (enrolled - pEnrolled > 0 ? '+' : '') + (enrolled - pEnrolled) + ' (' + Math.round((enrolled - pEnrolled)/pEnrolled*100) + '% YoY)' : ''}">
            <div class="i-funnel-label">Enrolled</div>
            <div class="i-funnel-bar-wrap">${funnelBar(enrolled, pEnrolled)}</div>
            <div class="i-funnel-pill-col">${yoyPct(enrolled, pEnrolled)}</div>
          </div>

          <div class="i-funnel-stage"
            data-tt-label="Graduates"
            data-tt-curr="${yr}: ${graduates != null ? graduates.toLocaleString() : '—'} graduates"
            data-tt-prev="${hasPrev ? prevYrLabel + ': ' + (pGraduates != null ? pGraduates.toLocaleString() : '—') + ' graduates' : ''}"
            data-tt-delta="${graduates != null && pGraduates != null ? 'Change: ' + (graduates - pGraduates > 0 ? '+' : '') + (graduates - pGraduates) + ' (' + Math.round((graduates - pGraduates)/pGraduates*100) + '% YoY)' : ''}"
            data-tt-rate="${yr} graduation rate: ${gradRate}%">
            <div class="i-funnel-label">Graduates</div>
            <div class="i-funnel-bar-wrap">${funnelBar(graduates, pGraduates)}</div>
            <div class="i-funnel-pill-col">${yoyPct(graduates, pGraduates)}</div>
          </div>

          <div class="i-funnel-stage"
            data-tt-label="Job Placements"
            data-tt-curr="${yr}: ${placed != null ? placed.toLocaleString() : '—'} placements"
            data-tt-prev="${hasPrev ? prevYrLabel + ': ' + (pPlaced != null ? pPlaced.toLocaleString() : '—') + ' placements' : ''}"
            data-tt-delta="${placed != null && pPlaced != null ? 'Change: ' + (placed - pPlaced > 0 ? '+' : '') + (placed - pPlaced) + ' (' + Math.round((placed - pPlaced)/pPlaced*100) + '% YoY)' : ''}"
            data-tt-rate="${yr} placement rate: ${placeRate}% of graduates">
            <div class="i-funnel-label">Placed</div>
            <div class="i-funnel-bar-wrap">${funnelBar(placed, pPlaced)}</div>
            <div class="i-funnel-pill-col">${yoyPct(placed, pPlaced)}</div>
          </div>

        </div>
      </div>`;

    // ===== CARD 2 · Rates =====
    const card2 = `
      <div class="chart-card">
        <div class="chart-card-head">
          <div>
            <h3>Graduation & Placement Rates</h3>
            <p class="chart-sub">Share of students advancing to the next stage</p>
          </div>
        </div>

        <div class="i-rates">

          <div class="i-rate-section">
            <div class="i-rate-section-label">Graduation rate</div>
            <div class="i-rate-bar-row"
              data-tt-label="Graduation rate ${yr}"
              data-tt-curr="${graduates != null && enrolled != null ? graduates.toLocaleString() + ' graduates / ' + enrolled.toLocaleString() + ' enrolled = ' + gradRate + '%' : ''}"
              data-tt-delta="${pGradRate != null ? 'vs ' + pGradRate + '% in ' + prevYrLabel + ' (' + (gradRate - pGradRate > 0 ? '+' : '') + (gradRate - pGradRate) + 'pp YoY)' : ''}">
              <div class="i-rate-yr">${yr}</div>
              <div class="i-rate-track"><div class="i-rate-fill i-fill-curr" style="width:${gradRate}%"></div></div>
              <div class="i-rate-pct">${gradRate}%</div>
              <div class="i-rate-pill-col">${ppPill(gradRate, pGradRate, false)}</div>
            </div>
            ${hasPrev ? `
            <div class="i-rate-bar-row"
              data-tt-label="Graduation rate ${prevYrLabel}"
              data-tt-curr="${pGraduates != null && pEnrolled != null ? pGraduates.toLocaleString() + ' graduates / ' + pEnrolled.toLocaleString() + ' enrolled = ' + pGradRate + '%' : ''}">
              <div class="i-rate-yr">${prevYrLabel}</div>
              <div class="i-rate-track"><div class="i-rate-fill i-fill-prev" style="width:${pGradRate}%"></div></div>
              <div class="i-rate-pct">${pGradRate}%</div>
              <div></div>
            </div>` : ''}
          </div>

          <div class="i-rate-section">
            <div class="i-rate-section-label">Placement rate (of graduates)</div>
            <div class="i-rate-bar-row"
              data-tt-label="Placement rate ${yr}"
              data-tt-curr="${placed != null && graduates != null ? placed.toLocaleString() + ' placed / ' + graduates.toLocaleString() + ' graduates = ' + placeRate + '%' : ''}"
              data-tt-delta="${pPlaceRate != null ? 'vs ' + pPlaceRate + '% in ' + prevYrLabel + ' (' + (placeRate - pPlaceRate > 0 ? '+' : '') + (placeRate - pPlaceRate) + 'pp YoY)' : ''}">
              <div class="i-rate-yr">${yr}</div>
              <div class="i-rate-track"><div class="i-rate-fill i-fill-curr" style="width:${placeRate}%"></div></div>
              <div class="i-rate-pct">${placeRate}%</div>
              <div class="i-rate-pill-col">${ppPill(placeRate, pPlaceRate, false)}</div>
            </div>
            ${hasPrev ? `
            <div class="i-rate-bar-row"
              data-tt-label="Placement rate ${prevYrLabel}"
              data-tt-curr="${pPlaced != null && pGraduates != null ? pPlaced.toLocaleString() + ' placed / ' + pGraduates.toLocaleString() + ' graduates = ' + pPlaceRate + '%' : ''}">
              <div class="i-rate-yr">${prevYrLabel}</div>
              <div class="i-rate-track"><div class="i-rate-fill i-fill-prev" style="width:${pPlaceRate}%"></div></div>
              <div class="i-rate-pct">${pPlaceRate}%</div>
              <div></div>
            </div>` : ''}
          </div>

        </div>
      </div>`;

    return `<div class="chart-row cols-2">${card1}${card2}</div>`;
  }

  function wireISectionTooltips() {
    let tip = document.querySelector('.exec-tooltip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'exec-tooltip';
      document.body.appendChild(tip);
    }

    const p = state.payload;
    const yr = state.year;
    const prevYr = prevYearOf(yr);
    const hasPrev = !!prevYr;

    const getVal = (year, rowIdx) => {
      const t = p.tables['I1'];
      if (!t || !t.data || !t.data[year] || !t.data[year][rowIdx]) return null;
      const v = t.data[year][rowIdx][1];
      return typeof v === 'number' ? v : null;
    };

    const enrolled   = getVal(yr, 3);
    const graduates  = getVal(yr, 4);
    const placed     = getVal(yr, 5);
    const pEnrolled  = hasPrev ? getVal(prevYr, 3) : null;
    const pGraduates = hasPrev ? getVal(prevYr, 4) : null;
    const pPlaced    = hasPrev ? getVal(prevYr, 5) : null;

    const gradRate   = enrolled  > 0 ? Math.round(graduates / enrolled  * 100) : null;
    const placeRate  = graduates > 0 ? Math.round(placed    / graduates * 100) : null;
    const pGradRate  = (pEnrolled  && pGraduates) ? Math.round(pGraduates / pEnrolled  * 100) : null;
    const pPlaceRate = (pGraduates && pPlaced)    ? Math.round(pPlaced    / pGraduates * 100) : null;

    const fmt = v => v == null ? '—' : v.toLocaleString();
    const source = 'I1 · Year Totals';

    // % YoY (for counts) — green up, red down
    const yoyPctRow = (curr, prev) => {
      if (curr == null || prev == null || prev === 0) return '';
      const pct = Math.round((curr - prev) / Math.abs(prev) * 100);
      const color = pct > 0 ? 'var(--green)' : (pct < 0 ? 'var(--red)' : 'var(--text-3)');
      const sign = pct > 0 ? '+' : '';
      return `<div class="tt-row"><span>YoY change</span><span class="v" style="color:${color}">${sign}${pct}%</span></div>`;
    };

    // pp YoY (for rates)
    const yoyPpRow = (curr, prev) => {
      if (curr == null || prev == null) return '';
      const delta = curr - prev;
      const color = delta > 0 ? 'var(--green)' : (delta < 0 ? 'var(--red)' : 'var(--text-3)');
      const sign = delta > 0 ? '+' : '';
      return `<div class="tt-row"><span>YoY change</span><span class="v" style="color:${color}">${sign}${delta}pp</span></div>`;
    };

    const buildCountTip = (title, curr, prev) => `
      <div class="tt-name">${title}</div>
      <div class="tt-row"><span>Source</span><span class="v">${source}</span></div>
      <div class="tt-row"><span>${title} ${yr}</span><span class="v">${fmt(curr)}</span></div>
      <div class="tt-row"><span>${title} ${prevYr || ''}</span><span class="v">${fmt(prev)}</span></div>
      ${yoyPctRow(curr, prev)}
    `;

    const buildRateTip = (title, curr, prev) => `
      <div class="tt-name">${title}</div>
      <div class="tt-row"><span>Source</span><span class="v">${source}</span></div>
      <div class="tt-row"><span>${title} ${yr}</span><span class="v">${curr != null ? curr + '%' : '—'}</span></div>
      <div class="tt-row"><span>${title} ${prevYr || ''}</span><span class="v">${prev != null ? prev + '%' : '—'}</span></div>
      ${yoyPpRow(curr, prev)}
    `;

    const tipFor = (el) => {
      const label = el.dataset.ttLabel || '';
      if (label === 'Enrolled')       return buildCountTip('Enrolled',       enrolled,   pEnrolled);
      if (label === 'Graduates')      return buildCountTip('Graduates',      graduates,  pGraduates);
      if (label === 'Job Placements') return buildCountTip('Job Placements', placed,     pPlaced);
      if (label.startsWith('Graduation rate')) return buildRateTip('Graduation rate', gradRate, pGradRate);
      if (label.startsWith('Placement rate'))  return buildRateTip('Placement rate',  placeRate, pPlaceRate);
      return '';
    };

    document.querySelectorAll('.i-funnel-stage[data-tt-label], .i-rate-bar-row[data-tt-label]').forEach(el => {
      el.addEventListener('mouseenter', () => {
        const html = tipFor(el);
        if (!html) return;
        tip.innerHTML = html;
        tip.style.opacity = '1';
      });
      el.addEventListener('mousemove', e => {
        tip.style.left = (e.pageX + 14) + 'px';
        tip.style.top  = (e.pageY - 10) + 'px';
      });
      el.addEventListener('mouseleave', () => {
        tip.style.opacity = '0';
      });
    });
  }

// ------------------------------------------------------------
// SECTION J · Customer Operations
// ------------------------------------------------------------
function renderSectionJ() {

    const p = state.payload;
    const yr = state.year;
    const prevYr = prevYearOf(yr);
    const hasPrev = !!prevYr;
    const yearLabel = yr;
    const prevYearLabel = prevYr || '';

      const getJData = () => {
        const result = {}; allYears().forEach(y => result[y] = {});
        allYears().forEach(yr => {
          const d = result[yr];

          const get = (id, rowIdx, colIdx) => {
            const t = p.tables[id];
            if (!t || !t.data || !t.data[yr] || !t.data[yr][rowIdx]) return null;
            const v = t.data[yr][rowIdx][colIdx];
            if (typeof v === 'number') return v;
            if (typeof v === 'string') {
              const s = v.trim();
              if (s.endsWith('%')) {
                const n = parseFloat(s.slice(0, -1).replace(/,/g, ''));
                return isFinite(n) ? n / 100 : null;
              }
              const n = parseFloat(s.replace(/[,$\s]/g, ''));
              return isFinite(n) ? n : null;
            }
            return null;
          };

          d.dac_customers    = get('J9', 0, 1) || 0;
          d.nondac_customers = get('J9', 0, 3) || 0;
          d.total_customers  = d.dac_customers + d.nondac_customers;
          d.dac_pct          = get('J9', 0, 2) || 0;
          d.elec_total_dac    = get('J1', 0, 1) || 0;
          d.elec_total_nondac = get('J1', 0, 3) || 0;
          d.elec_dac_pct      = get('J1', 0, 2) || 0;
          d.gas_total_dac    = get('J2', 0, 1) || 0;
          d.gas_total_nondac = get('J2', 0, 3) || 0;
          d.gas_dac_pct      = get('J2', 0, 2) || 0;
          d.j4_accts_dac    = get('J4', 0, 1) || 0;
          d.j4_accts_nondac = get('J4', 1, 1) || 0;
          d.j4_accts_pct    = get('J4', 0, 2) || 0;
          d.j4_amt_dac      = get('J4', 0, 3) || 0;
          d.j4_amt_nondac   = get('J4', 1, 3) || 0;
          d.j4_amt_pct      = get('J4', 0, 4) || 0;
          d.disc_dac    = get('J5', 0, 1) || 0;
          d.disc_pct    = get('J5', 0, 2) || 0;
          d.disc_nondac = get('J5', 0, 3) || 0;
          d.rest_dac    = get('J5', 1, 1) || 0;
          d.rest_pct    = get('J5', 1, 2) || 0;
          d.rest_nondac = get('J5', 1, 3) || 0;
          d.dpa_accts_dac    = get('J6', 0, 1) || 0;
          d.dpa_accts_nondac = get('J6', 1, 1) || 0;
          d.dpa_accts_pct    = get('J6', 0, 2) || 0;
          d.dpa_amt_dac      = get('J6', 0, 3) || 0;
          d.dpa_amt_nondac   = get('J6', 1, 3) || 0;
          d.dpa_amt_pct      = get('J6', 0, 4) || 0;
          d.eap_pct     = get('J7', 0, 4) || 0;
          let eapAmtPct = get('J8', 0, 3);
          if (eapAmtPct == null) {
            const dacElec = get('J8', 0, 1) || 0;
            const dacGas  = get('J8', 0, 2) || 0;
            const totElec = get('J8', 2, 1) || 0;
            const totGas  = get('J8', 2, 2) || 0;
            const denom = totElec + totGas;
            eapAmtPct = denom > 0 ? (dacElec + dacGas) / denom : 0;
          }
          d.eap_amt_pct = eapAmtPct;
        });
        return result;
      };

      const J_TABLE_NAMES = {
        'J1': 'J1 · Residential Electric Usage',
        'J2': 'J2 · Residential Gas Usage',
        'J4': 'J4 · Unpaid Accounts 90+ Days Overdue',
        'J5': 'J5 · Service Disconnects and Restorations',
        'J6': 'J6 · Customers with Deferred Payment Agreements',
        'J7': 'J7 · Customers Enrolled in EAP',
        'J8': 'J8 · EAP Discount Dollars Delivered',
        'J9': 'J9 · Total Residential Customers'
      };

      const jAll = getJData();
      const d = jAll[state.year] || jAll[yr];
      const prev = hasPrev ? jAll[prevYr] : null;
      const prevYearKey = prevYr;

      const jPct = v => (v * 100).toFixed(0) + '%';
      const jDeltaPp = (curr, baseline) => {
        const delta = Math.round((curr - baseline) * 100);
        return (delta > 0 ? '+' : '') + delta + 'pp';
      };
      const fmtBig = v => {
        if (v >= 1e9) return '$' + (v/1e9).toFixed(2) + 'B';
        if (v >= 1e6) return '$' + (v/1e6).toFixed(1) + 'M';
        if (v >= 1e3) return '$' + (v/1e3).toFixed(0) + 'K';
        return '$' + v.toLocaleString();
      };

      // ── YoY pill helper ──
      const yoyPill = (curr, prevVal, lowerIsBetter) => {
        if (curr == null || prevVal == null || prevVal === 0) return '';
        const pct = Math.round((curr - prevVal) / Math.abs(prevVal) * 100);
        if (pct === 0) return `<span class="j-yoy-pill j-yoy-pill-neutral">→ 0% YoY</span>`;
        const isGood = lowerIsBetter ? pct < 0 : pct > 0;
        const cls = isGood ? 'up' : 'down';
        const arrow = pct > 0 ? '↑ +' : '↓ ';
        return `<span class="j-yoy-pill j-yoy-pill-${cls}">${arrow}${Math.abs(pct)}% YoY</span>`;
      };

      const ppPill = (curr, prevVal, lowerIsBetter) => {
        if (curr == null || prevVal == null) return '';
        const delta = Math.round((curr - prevVal) * 100);
        if (delta === 0) return `<span class="j-yoy-pill j-yoy-pill-neutral">→ 0pp YoY</span>`;
        const isGood = lowerIsBetter ? delta < 0 : delta > 0;
        const cls = isGood ? 'up' : 'down';
        const sign = delta > 0 ? '+' : '';
        return `<span class="j-yoy-pill j-yoy-pill-${cls}">${sign}${delta}pp YoY</span>`;
      };

      // ===== CARD 1 · Customer Burden vs Population (HTML rows, not SVG) =====
      const baselinePct = d.dac_pct;

      const burdenRows = [
        { label: 'Pop. share',   curr: d.dac_pct,      prevPct: prev ? prev.dac_pct      : null, type: 'baseline', src: 'J9', lowerBetter: false },
        { label: 'Electric use', curr: d.elec_dac_pct, prevPct: prev ? prev.elec_dac_pct : null, type: 'usage',    src: 'J1', lowerBetter: false },
        { label: 'Gas use',      curr: d.gas_dac_pct,  prevPct: prev ? prev.gas_dac_pct  : null, type: 'usage',    src: 'J2', lowerBetter: false },
        { label: 'Unpaid 90+',   curr: d.j4_accts_pct, prevPct: prev ? prev.j4_accts_pct : null, type: 'burden',   src: 'J4', lowerBetter: true  },
        { label: 'Disconnects',  curr: d.disc_pct,     prevPct: prev ? prev.disc_pct     : null, type: 'burden',   src: 'J5', lowerBetter: true  },
        { label: 'EAP enrolled', curr: d.eap_pct,      prevPct: prev ? prev.eap_pct      : null, type: 'assist',   src: 'J7', lowerBetter: false },
        { label: 'EAP $',        curr: d.eap_amt_pct,  prevPct: prev ? prev.eap_amt_pct  : null, type: 'assist',   src: 'J8', lowerBetter: false },
      ];

      const colorByType = {
        baseline: 'var(--dusk)',
        usage:    'var(--pale-sky)',
        burden:   'var(--red)',
        assist:   'var(--green)',
      };

      const burdenRowsHtml = burdenRows.map(r => {
        const color = colorByType[r.type];
        const pctNum = Math.round(r.curr * 100);
        const baseNum = Math.round(baselinePct * 100);
        const pill = r.prevPct !== null ? ppPill(r.curr, r.prevPct, r.lowerBetter) : '';

        // dot positions as % of 100% width
        const currLeft = (r.curr * 100).toFixed(1);
        const prevLeft = r.prevPct !== null ? (r.prevPct * 100).toFixed(1) : null;
        const baseLeft = (baselinePct * 100).toFixed(1);

        return `
          <div class="j-burden-html-row"
            data-label="${r.label}"
            data-pct="${jPct(r.curr)}"
            data-baseline="${jPct(baselinePct)}"
            data-prev="${r.prevPct !== null ? jPct(r.prevPct) : 'n/a'}"
            data-yoy="${r.prevPct !== null ? jDeltaPp(r.curr, r.prevPct) : ''}"
            data-delta="${r.type === 'baseline' ? '' : jDeltaPp(r.curr, baselinePct)}"
            data-type="${r.type}" data-src="${r.src}">
            <div class="j-bhr-label">${r.label}</div>
            <div class="j-bhr-track">
              <div class="j-bhr-baseline" style="left:${baseLeft}%"></div>
              ${prevLeft !== null ? `<div class="j-bhr-dot j-bhr-prev" style="left:${prevLeft}%"></div>` : ''}
              <div class="j-bhr-dot j-bhr-curr" style="left:${currLeft}%;background:${color}"></div>
              <span class="j-bhr-pct" style="left:${currLeft}%;color:${color}">${pctNum}%</span>
            </div>
            <div class="j-bhr-pill">${pill}</div>
          </div>`;
      }).join('');

      const card1 = `
        <div class="chart-card">
          <div class="chart-card-head">
            <div>
              <h3>Customer Burden vs Population</h3>
              <p class="chart-sub">DAC are ${jPct(d.dac_pct)} of customers</p>
            </div>
            <div class="chart-legend" style="font-size:9.5px;gap:8px">
              <div class="legend-item"><span class="j-burden-dot" style="background:var(--dusk);width:7px;height:7px"></span>Baseline</div>
              <div class="legend-item"><span class="j-burden-dot" style="background:var(--pale-sky);width:7px;height:7px"></span>Usage</div>
              <div class="legend-item"><span class="j-burden-dot" style="background:var(--red);width:7px;height:7px"></span>Burden</div>
              <div class="legend-item"><span class="j-burden-dot" style="background:var(--green);width:7px;height:7px"></span>Assistance</div>
              ${prev ? `<div class="legend-item"><span class="j-burden-dot" style="background:#888;opacity:.55;width:7px;height:7px"></span>${prevYearLabel}</div>` : ''}
            </div>
          </div>
          <div class="j-burden-html">
            ${burdenRowsHtml}
          </div>
        </div>`;

      // ===== CARD 2 · Unpaid Residential Accounts · 90+ days =====
      const totalAmt = d.j4_amt_dac + d.j4_amt_nondac;
      const dacPct = totalAmt > 0 ? d.j4_amt_dac / totalAmt : 0;
      const avgDac = d.j4_accts_dac > 0 ? d.j4_amt_dac / d.j4_accts_dac : 0;
      const avgNon = d.j4_accts_nondac > 0 ? d.j4_amt_nondac / d.j4_accts_nondac : 0;
      const prevDacAmt = prev ? prev.j4_amt_dac : null;
      const prevNonAmt = prev ? prev.j4_amt_nondac : null;
      const yoyDac = (prevDacAmt && prevDacAmt > 0) ? Math.round((d.j4_amt_dac - prevDacAmt) / prevDacAmt * 100) : null;
      const yoyNon = (prevNonAmt && prevNonAmt > 0) ? Math.round((d.j4_amt_nondac - prevNonAmt) / prevNonAmt * 100) : null;

      const unpaidPill = (yoy, isDAC) => {
        if (yoy === null) return '';
        // For arrears: going up is BAD (red), going down is GOOD (green)
        const isGood = yoy < 0;
        const cls = isGood ? 'up' : 'down';
        const arrow = yoy > 0 ? '↑ +' : '↓ ';
        return `<span class="j-yoy-pill j-yoy-pill-${cls}">${arrow}${Math.abs(yoy)}% YoY</span>`;
      };

      const card2 = `
        <div class="chart-card">
          <div class="chart-card-head">
            <div>
              <h3>Unpaid Residential Accounts · 90+ days</h3>
              <p class="chart-sub">${fmtBig(totalAmt)} unpaid · oldest debt</p>
            </div>
          </div>
          <div class="j-aff-body">
            <div class="j-aff-block j-aff-dac"
              data-group="dac"
              data-debt="${fmtBig(d.j4_amt_dac)}"
              data-pct="${(dacPct*100).toFixed(0)}%"
              data-accts="${d.j4_accts_dac.toLocaleString()}"
              data-avg="$${Math.round(avgDac).toLocaleString()}">
              <div class="j-aff-label">DAC</div>
              <div class="j-aff-num-row">
                <div class="j-aff-num">${fmtBig(d.j4_amt_dac)}</div>
                <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
                  ${unpaidPill(yoyDac, true)}
                  ${prevDacAmt ? `<span class="j-aff-yoy-sub">vs ${fmtBig(prevDacAmt)} in ${prevYearKey}</span>` : ''}
                </div>
              </div>
              <div class="j-aff-foot">${(dacPct*100).toFixed(0)}% of debt · ${(d.j4_accts_dac/1000).toFixed(0)}k accounts</div>
            </div>

            <div class="j-aff-block j-aff-non"
              data-group="nondac"
              data-debt="${fmtBig(d.j4_amt_nondac)}"
              data-pct="${((1-dacPct)*100).toFixed(0)}%"
              data-accts="${d.j4_accts_nondac.toLocaleString()}"
              data-avg="$${Math.round(avgNon).toLocaleString()}">
              <div class="j-aff-label">Non-DAC</div>
              <div class="j-aff-num-row">
                <div class="j-aff-num">${fmtBig(d.j4_amt_nondac)}</div>
                <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
                  ${unpaidPill(yoyNon, false)}
                  ${prevNonAmt ? `<span class="j-aff-yoy-sub">vs ${fmtBig(prevNonAmt)} in ${prevYearKey}</span>` : ''}
                </div>
              </div>
              <div class="j-aff-foot">${((1-dacPct)*100).toFixed(0)}% of debt · ${(d.j4_accts_nondac/1000).toFixed(0)}k accounts</div>
            </div>

            <div class="j-aff-note">DAC: more accounts in arrears, not bigger arrears per account</div>
          </div>
        </div>`;

      // ===== CARD 4 · DPA Growth =====
      let card4;
      if (!prev) {
        card4 = `
          <div class="chart-card">
            <div class="chart-card-head">
              <div>
                <h3>DPA Growth · ${yearLabel}</h3>
                <p class="chart-sub">Payment plan enrollment</p>
              </div>
            </div>
            <div class="empty-pane">No prior year baseline available</div>
          </div>`;
      } else {
        const dacGrowthNum = Math.round((d.dpa_accts_dac - prev.dpa_accts_dac) / prev.dpa_accts_dac * 100);
        const nonGrowthNum = Math.round((d.dpa_accts_nondac - prev.dpa_accts_nondac) / prev.dpa_accts_nondac * 100);
        const maxVal = Math.max(d.dpa_accts_dac, d.dpa_accts_nondac, prev.dpa_accts_dac, prev.dpa_accts_nondac);
        const barChartH = 200;
        const hDac23 = (prev.dpa_accts_dac / maxVal) * barChartH;
        const hDac24 = (d.dpa_accts_dac / maxVal) * barChartH;
        const hNon23 = (prev.dpa_accts_nondac / maxVal) * barChartH;
        const hNon24 = (d.dpa_accts_nondac / maxVal) * barChartH;

        const dpaPill = (pct) => {
          const cls = pct > 0 ? 'up' : 'down';
          const arrow = pct > 0 ? '↑ +' : '↓ ';
          return `<span class="j-yoy-pill j-yoy-pill-${cls}">${arrow}${Math.abs(pct)}% YoY</span>`;
        };

        card4 = `
          <div class="chart-card">
            <div class="chart-card-head">
              <div>
                <h3>DPA Growth · ${yearLabel}</h3>
                <p class="chart-sub">Payment plan enrollment</p>
              </div>
              <div class="chart-legend">
                <div class="legend-item"><span class="legend-swatch" style="background:var(--pale-sky)"></span>${prevYearLabel}</div>
                <div class="legend-item"><span class="legend-swatch" style="background:var(--dusk)"></span>${yearLabel}</div>
              </div>
            </div>
            <div class="j-dpa-chart" style="--bar-h:${barChartH}px">
              <div class="j-dpa-group" data-group="dac"
                data-prev="${prev.dpa_accts_dac.toLocaleString()}"
                data-curr="${d.dpa_accts_dac.toLocaleString()}"
                data-growth="${dacGrowthNum >= 0 ? '+' : ''}${dacGrowthNum}%"
                data-amt-prev="${fmtBig(prev.dpa_amt_dac)}"
                data-amt-curr="${fmtBig(d.dpa_amt_dac)}">
                <div class="j-dpa-bars">
                  <div class="j-dpa-bar-wrap">
                    <span class="j-dpa-num">${(prev.dpa_accts_dac/1000).toFixed(0)}k</span>
                    <div class="j-dpa-bar j-dpa-bar-prev" style="height:${hDac23}px"></div>
                  </div>
                  <div class="j-dpa-bar-wrap">
                    <span class="j-dpa-num">${(d.dpa_accts_dac/1000).toFixed(0)}k</span>
                    <div class="j-dpa-bar j-dpa-bar-curr" style="height:${hDac24}px"></div>
                  </div>
                </div>
                <div class="j-dpa-label">DAC</div>
                <div style="margin-top:4px">${dpaPill(dacGrowthNum)}</div>
              </div>
              <div class="j-dpa-group" data-group="nondac"
                data-prev="${prev.dpa_accts_nondac.toLocaleString()}"
                data-curr="${d.dpa_accts_nondac.toLocaleString()}"
                data-growth="${nonGrowthNum >= 0 ? '+' : ''}${nonGrowthNum}%"
                data-amt-prev="${fmtBig(prev.dpa_amt_nondac)}"
                data-amt-curr="${fmtBig(d.dpa_amt_nondac)}">
                <div class="j-dpa-bars">
                  <div class="j-dpa-bar-wrap">
                    <span class="j-dpa-num">${(prev.dpa_accts_nondac/1000).toFixed(0)}k</span>
                    <div class="j-dpa-bar j-dpa-bar-prev" style="height:${hNon23}px"></div>
                  </div>
                  <div class="j-dpa-bar-wrap">
                    <span class="j-dpa-num">${(d.dpa_accts_nondac/1000).toFixed(0)}k</span>
                    <div class="j-dpa-bar j-dpa-bar-curr" style="height:${hNon24}px"></div>
                  </div>
                </div>
                <div class="j-dpa-label">Non-DAC</div>
                <div style="margin-top:4px">${dpaPill(nonGrowthNum)}</div>
              </div>
            </div>
          </div>`;
      }

      window.__sectionJ_yr = yearLabel;
      window.__sectionJ_prevYr = prevYearLabel;
      window.__sectionJ_tables = J_TABLE_NAMES;

      return `
        <div class="chart-row cols-3">${card1}${card2}${card4}</div>`;
    }


  // ============================================================
  // SECTION INTERACTIONS (wiring of toggles, tooltips, and the Section E arc)
  // ============================================================

function wireQuadrantMetricToggle() {
    document.querySelectorAll('.quadrant-metric-toggle button').forEach(btn => {
      btn.addEventListener('click', () => {
        state.quadrantMetric = btn.dataset.metric;
        rerenderAll();
      });
    });
  }

function wireRankToggle() {
    document.querySelectorAll('.rank-toggle button').forEach(btn => {
      btn.addEventListener('click', () => {
        state.rankBy = btn.dataset.rank;
        rerenderAll();
      });
    });
  }

  /** Wire hover tooltips for the two stacked bars in Section A (Spend / Savings). */
  function wireSectionATooltips() {
    const tip = ensureTooltip();
    const bindMove = (el) => {
      el.addEventListener('mousemove', e => {
        tip.style.left = (e.pageX + 14) + 'px';
        tip.style.top  = (e.pageY - 8) + 'px';
      });
      el.addEventListener('mouseleave', () => { tip.style.opacity = '0'; });
    };
    document.querySelectorAll('.a-stacked-row').forEach(row => {
      row.addEventListener('mouseenter', () => {
        const d = row.dataset;
        const yoyTotalNum = d.aYoyTotal && d.aYoyTotal !== 'n/a' ? parseInt(d.aYoyTotal) : null;
        const yoyDacNum = d.aYoyDac && d.aYoyDac !== 'n/a' ? parseInt(d.aYoyDac) : null;
        const totalColor = yoyTotalNum === null ? 'var(--text-3)'
          : (yoyTotalNum > 0 ? 'var(--green)' : 'var(--red)');
        const dacColor = yoyDacNum === null ? 'var(--text-3)'
          : (yoyDacNum > 0 ? 'var(--green)' : 'var(--red)');
        const yrLabel = state.year;
        const prevLabel = prevYearOf(state.year) || 'prior';
        tip.innerHTML =
          `<div class="tt-name">${escapeHtml(d.aName)}</div>` +
          `<div class="tt-row"><span>Source</span><span class="v">${d.aSource}</span></div>` +
          `<div class="tt-row"><span>Metric</span><span class="v">${d.aMetric}</span></div>` +
          `<div class="tt-row" style="margin-top:4px;padding-top:4px;border-top:1px dashed var(--line)"><span>Total ${yrLabel}</span><span class="v">${d.aCurrTotal}</span></div>` +
          `<div class="tt-row"><span>DAC ${yrLabel}</span><span class="v">${d.aCurrDac}</span></div>` +
          `<div class="tt-row"><span>Non-DAC ${yrLabel}</span><span class="v">${d.aCurrNon}</span></div>` +
          `<div class="tt-row"><span>DAC share</span><span class="v" style="color:var(--dusk)">${d.aDacPct}</span></div>` +
          `<div class="tt-row" style="margin-top:4px;padding-top:4px;border-top:1px dashed var(--line)"><span>Total ${prevLabel}</span><span class="v">${d.aPrevTotal}</span></div>` +
          `<div class="tt-row"><span>DAC ${prevLabel}</span><span class="v">${d.aPrevDac}</span></div>` +
          `<div class="tt-row" style="margin-top:4px;padding-top:4px;border-top:1px dashed var(--line)"><span>Total YoY</span><span class="v" style="color:${totalColor}">${d.aYoyTotal}</span></div>` +
          `<div class="tt-row"><span>DAC YoY</span><span class="v" style="color:${dacColor}">${d.aYoyDac}</span></div>`;
        tip.style.opacity = '1';
      });
      bindMove(row);
    });
  }

function wireQuadrantTooltip() {
    // Use the SAME tooltip element as the rest of the dashboard for visual consistency.
    let tip = document.querySelector('.exec-tooltip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'exec-tooltip';
      document.body.appendChild(tip);
    }
    const circles = document.querySelectorAll('.scatter-svg circle[data-name]');
    circles.forEach(c => {
      c.addEventListener('mouseenter', () => {
        const name = c.getAttribute('data-name');
        const total = c.getAttribute('data-total');
        const dac = c.getAttribute('data-dac');
        const isMMBtu = state.quadrantMetric === 'mmbtu';
        const xLabel = isMMBtu ? 'Energy savings' : 'Total funding';
        // Decode the dac % from the existing attribute (it's a formatted string)
        const dacNum = parseFloat(dac);
        const dacColor = !isNaN(dacNum) && dacNum >= 35 ? 'var(--green)' : 'var(--text-2)';
        tip.innerHTML =
          `<div class="tt-name">${name}</div>` +
          `<div class="tt-row"><span>Source</span><span class="v">Section A · ${isMMBtu ? 'Table A2' : 'Table A1'}</span></div>` +
          `<div class="tt-row"><span>${xLabel}</span><span class="v">${total}</span></div>` +
          `<div class="tt-row"><span>DAC share</span><span class="v" style="color:${dacColor}">${dac}</span></div>` +
          `<div class="tt-row" style="margin-top:6px;padding-top:6px;border-top:1px solid var(--line)">` +
            `<span style="font-size:9.5px;color:var(--text-3);line-height:1.4">Dot position = X-axis ${xLabel.toLowerCase()} vs Y-axis DAC share. Size scales with X-value.</span>` +
          `</div>`;
        tip.style.opacity = '1';
      });
      c.addEventListener('mousemove', e => {
        tip.style.left = (e.pageX + 14) + 'px';
        tip.style.top  = (e.pageY - 8)  + 'px';
      });
      c.addEventListener('mouseleave', () => { tip.style.opacity = '0'; });
    });
  }

  /** Wire the "How to read this chart" help button for the Equity Quadrant. */
  function wireHelpButtons() {
    document.querySelectorAll('.help-btn[data-help="quadrant"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const isMMBtu = state.quadrantMetric === 'mmbtu';
        const xAxis = isMMBtu ? 'total energy savings (MMBtu)' : 'total funding ($)';
        const sizeNote = isMMBtu ? 'Bigger dots = more MMBtu saved.' : 'Bigger dots = more total spend.';
        const trDesc = isMMBtu
          ? 'Large savings · highly equitable. The ideal zone — impact + equity.'
          : 'Large programs · highly equitable. The ideal zone — scale + equity.';
        const brDesc = isMMBtu
          ? 'Large savings · low DAC share. Impact without equity — candidates for re-balancing.'
          : 'Large programs · low DAC share. Scale without equity — candidates for re-balancing.';
        const tlDesc = isMMBtu
          ? 'Small savings · highly equitable. Most savings reach DACs but limited impact.'
          : 'Small programs · highly equitable. Most funds reach DACs but limited scale.';
        const blDesc = isMMBtu
          ? 'Small savings · low DAC share. Limited reach in any dimension.'
          : 'Small programs · low DAC share. Limited reach in any dimension.';

        const modal = document.createElement('div');
        modal.className = 'help-modal-overlay';
        modal.innerHTML = `
          <div class="help-modal" role="dialog" aria-labelledby="help-modal-title">
            <div class="help-modal-head">
              <h3 id="help-modal-title">How to read the Equity Quadrant${isMMBtu ? ' · MMBtu mode' : ' · Dollars mode'}</h3>
              <button class="help-modal-close" type="button" aria-label="Close">×</button>
            </div>
            <div class="help-modal-body">
              <p>Each dot is a program. <em>X-axis</em> = ${xAxis}. <em>Y-axis</em> = share that reached DACs. ${sizeNote} The 50% dashed line splits the chart into four zones:</p>
              <div class="quadrant-zones">
                <div class="zone zone-tl"><span class="zone-label">↖ Top-Left</span><span class="zone-desc">${tlDesc}</span></div>
                <div class="zone zone-tr"><span class="zone-label">↗ Top-Right</span><span class="zone-desc">${trDesc}</span></div>
                <div class="zone zone-bl"><span class="zone-label">↙ Bottom-Left</span><span class="zone-desc">${blDesc}</span></div>
                <div class="zone zone-br"><span class="zone-label">↘ Bottom-Right</span><span class="zone-desc">${brDesc}</span></div>
              </div>
            </div>
          </div>`;
        document.body.appendChild(modal);
        const close = () => modal.remove();
        modal.addEventListener('click', e => { if (e.target === modal) close(); });
        modal.querySelector('.help-modal-close').addEventListener('click', close);
        document.addEventListener('keydown', function esc(e) {
          if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
        });
      });
    });
  }

function wireBTooltips() {
    let tip = document.querySelector('.exec-tooltip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'exec-tooltip';
      document.body.appendChild(tip);
    }

    const bindMove = (el) => {
      el.addEventListener('mousemove', e => {
        tip.style.left = (e.pageX + 14) + 'px';
        tip.style.top  = (e.pageY - 8) + 'px';
      });
      el.addEventListener('mouseleave', () => { tip.style.opacity = '0'; });
    };

    const yr = state.year;
    const prevYr = prevYearOf(state.year) || '';

    // Card 1 — Funding bars
    document.querySelectorAll('.b-fund-row').forEach(row => {
      row.addEventListener('mouseenter', () => {
        const label = row.dataset.label;
        const sign = row.dataset.yoySign;
        const yoyColor = sign === 'up' ? 'var(--green)' : (sign === 'down' ? 'var(--red)' : 'var(--text-3)');
        const interp = label === 'DAC'
          ? 'Make-Ready funding deployed to disadvantaged communities.'
          : label === 'Non-DAC'
            ? 'Funding deployed outside DAC neighborhoods.'
            : 'Total program funding across all communities.';
        tip.innerHTML =
          '<div class="tt-name">' + label + ' · Make-Ready Funding</div>' +
          '<div class="tt-row"><span>Source</span><span class="v">Table B1</span></div>' +
          '<div class="tt-row"><span>Funding ' + yr + '</span><span class="v">' + row.dataset.curr + '</span></div>' +
          '<div class="tt-row"><span>Funding ' + prevYr + '</span><span class="v">' + row.dataset.prev + '</span></div>' +
          '<div class="tt-row"><span>YoY change</span><span class="v" style="color:' + yoyColor + '">' + row.dataset.yoy + '</span></div>' +
          '<div class="tt-row"><span>% of total</span><span class="v">' + row.dataset.pct + '</span></div>' +
          '<div class="tt-row" style="margin-top:6px;padding-top:6px;border-top:1px solid var(--line)"><span style="font-size:9.5px;color:var(--text-3);line-height:1.4">' + interp + '</span></div>';
        tip.style.opacity = '1';
      });
      bindMove(row);
    });

    // Card 2 — Tornado rows
    document.querySelectorAll('.b-torn-row').forEach(row => {
      row.addEventListener('mouseenter', () => {
        const wins = row.dataset.dacWins === 'true';
        const winColor = wins ? 'var(--green)' : 'var(--text-2)';
        tip.innerHTML =
          '<div class="tt-name">' + row.dataset.metric + ' · DAC vs Non-DAC</div>' +
          '<div class="tt-row"><span>Source</span><span class="v">' + row.dataset.source + '</span></div>' +
          '<div class="tt-row"><span>DAC ' + yr + '</span><span class="v" style="color:' + winColor + '">' + row.dataset.dacCurr + '</span></div>' +
          '<div class="tt-row"><span>DAC ' + prevYr + '</span><span class="v">' + row.dataset.dacPrev + '</span></div>' +
          '<div class="tt-row"><span>DAC YoY</span><span class="v">' + row.dataset.dacYoy + '</span></div>' +
          '<div class="tt-row" style="margin-top:4px;padding-top:4px;border-top:1px dashed var(--line)"><span>Non-DAC ' + yr + '</span><span class="v">' + row.dataset.nonCurr + '</span></div>' +
          '<div class="tt-row"><span>Non-DAC ' + prevYr + '</span><span class="v">' + row.dataset.nonPrev + '</span></div>' +
          '<div class="tt-row"><span>Non-DAC YoY</span><span class="v">' + row.dataset.nonYoy + '</span></div>' +
          '<div class="tt-row" style="margin-top:6px;padding-top:6px;border-top:1px solid var(--line)"><span style="font-size:9.5px;color:var(--text-3);line-height:1.4">' + row.dataset.interp + '</span></div>';
        tip.style.opacity = '1';
      });
      bindMove(row);
    });
  }

function drawSectionEArc() {
    const canvas = document.getElementById('e-arc-canvas-section');
    if (!canvas) return;
    const cats = window.__sectionE_cats;
    const biggestIdx = window.__sectionE_biggestIdx;
    const yr = window.__sectionE_yr;
    if (!cats || cats.length === 0) return;

    const fmtBig = v => {
      if (v >= 1e9) return '$' + (v/1e9).toFixed(2) + 'B';
      if (v >= 1e6) return '$' + (v/1e6).toFixed(1) + 'M';
      if (v >= 1e3) return '$' + (v/1e3).toFixed(0) + 'K';
      return '$' + v.toLocaleString();
    };

    const DPR = Math.max(window.devicePixelRatio || 1, 2);
    const CW = canvas.parentElement.clientWidth - 32;
    const R_OUT = 82, R_IN = 54, SW_OUT = 20, SW_IN = 18;
    const TOP_PAD = SW_OUT/2 + 4;
    const CY = TOP_PAD + R_OUT;
    const LABEL_PAD = 1, LINE_H = 22;
    const CH = CY + LABEL_PAD + LINE_H * 3 + 4;
    const ARC_WIDTH = (R_OUT + SW_OUT/2) * 2;
    const TOTAL_ARCS_W = ARC_WIDTH * cats.length;
    const GAP = Math.max(8, (CW - TOTAL_ARCS_W) / (cats.length + 1));
    const SIDE_PAD = GAP + R_OUT + SW_OUT/2;
    const SPACING = ARC_WIDTH + GAP;

    canvas.width = CW * DPR;
    canvas.height = CH * DPR;
    canvas.style.width = CW + 'px';
    canvas.style.height = CH + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(DPR, DPR);
    ctx.textBaseline = 'middle';

    function drawSemi(cx, r, pct, color, sw) {
      if (pct <= 0.001) return;
      const p = Math.min(pct, 0.9999);
      const endAngle = Math.PI + Math.PI * p;
      ctx.beginPath();
      ctx.arc(cx, CY, r, Math.PI, endAngle, false);
      ctx.strokeStyle = color;
      ctx.lineWidth = sw;
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    const hitZones = [];
    cats.forEach((cat, i) => {
      const cx = SIDE_PAD + i * SPACING;
      const isBig = i === biggestIdx;
      const c24 = isBig ? '#2A7755' : '#2F5496';

      drawSemi(cx, R_OUT, 1.0, '#f0f0f0', SW_OUT);
      drawSemi(cx, R_IN, 1.0, '#f0f0f0', SW_IN);
      if (cat.prev !== null) drawSemi(cx, R_IN, cat.prev, '#BDDBF5', SW_IN);
      drawSemi(cx, R_OUT, cat.curr, c24, SW_OUT);

      let ty = CY + LABEL_PAD;
      ctx.textAlign = 'center';

      ctx.font = '700 25px Inter, system-ui, sans-serif';
      ctx.fillStyle = c24;
      ty += LINE_H;
      ctx.fillText((cat.curr*100).toFixed(0)+'%', cx, ty);

      if (cat.prev !== null) {
        ctx.font = '500 12px Inter, system-ui, sans-serif';
        ctx.fillStyle = '#aaa';
        ty += LINE_H + 1;
        ctx.fillText((cat.prev*100).toFixed(0)+'% → '+(cat.curr*100).toFixed(0)+'%', cx, ty);
      } else {
        ty += LINE_H - 1;
      }

      ctx.font = '600 13px Inter, system-ui, sans-serif';
      ctx.fillStyle = '#111';
      ty += LINE_H - 1;
      ctx.fillText(cat.name, cx, ty);

      const delta = cat.prev !== null ? Math.round((cat.curr - cat.prev) * 100) : null;
      hitZones.push({ cx, cat, delta, isBig });
    });

    let tip = document.querySelector('.e-tt');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'e-tt';
      document.body.appendChild(tip);
    }

    canvas.onmousemove = function(e) {
      const rect = canvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left) * (CW / rect.width);
      const hit = hitZones.find(z => Math.abs(mx - z.cx) < SPACING/2);
      if (hit) {
        const c = hit.cat, d = hit.delta;
        const dColor = d === null ? 'var(--text-3)' : (d > 0 ? 'var(--green)' : (d < 0 ? 'var(--red)' : 'var(--text-3)'));
        const dStr = d === null ? '—' : (d > 0 ? '+' : '') + d + 'pp';
        const prevStr = c.prev !== null ? (c.prev*100).toFixed(0)+'%' : 'n/a';
        tip.innerHTML =
          '<div class="e-tt-name">' + c.name + (hit.isBig ? ' ★ biggest gain' : '') + '</div>' +
          '<div class="e-tt-row"><span>Total investment</span><span class="v">' + fmtBig(c.total24) + '</span></div>' +
          '<div class="e-tt-row"><span>DAC exposure ' + yr + '</span><span class="v">' + (c.curr*100).toFixed(0) + '%</span></div>' +
          '<div class="e-tt-row"><span>Prior year</span><span class="v">' + prevStr + '</span></div>' +
          '<div class="e-tt-row"><span>Change</span><span class="v" style="color:' + dColor + '">' + dStr + '</span></div>';
        tip.style.opacity = '1';
        tip.style.left = (e.pageX + 14) + 'px';
        tip.style.top = (e.pageY - 8) + 'px';
      } else {
        tip.style.opacity = '0';
      }
    };
    canvas.onmouseleave = function() { tip.style.opacity = '0'; };

    document.querySelectorAll('.e-yoy-row').forEach(row => {
      row.onmouseenter = function() {
        const yoyVal = row.dataset.yoy;
        let yoyColor = 'var(--text-3)';
        if (yoyVal && yoyVal !== 'n/a' && yoyVal !== '0%') {
          yoyColor = yoyVal.startsWith('-') ? 'var(--red)' : 'var(--green)';
        }
        tip.innerHTML =
          '<div class="e-tt-name">' + row.dataset.name + '</div>' +
          '<div class="e-tt-row"><span>' + yr + ' investment</span><span class="v">' + row.dataset.total24 + '</span></div>' +
          '<div class="e-tt-row"><span>' + window.__sectionE_prevYr + ' investment</span><span class="v">' + row.dataset.total23 + '</span></div>' +
          '<div class="e-tt-row"><span>DAC % ' + yr + '</span><span class="v">' + row.dataset.curr + '</span></div>' +
          '<div class="e-tt-row"><span>DAC % ' + window.__sectionE_prevYr + '</span><span class="v">' + row.dataset.prev + '</span></div>' +
          '<div class="e-tt-row"><span>YoY change</span><span class="v" style="color:' + yoyColor + '">' + (yoyVal || 'n/a') + '</span></div>';
        tip.style.opacity = '1';
      };
      row.onmousemove = function(e) {
        tip.style.left = (e.pageX + 14) + 'px';
        tip.style.top = (e.pageY - 8) + 'px';
      };
      row.onmouseleave = function() { tip.style.opacity = '0'; };
    });
  }

function wireJTooltips() {
    if (state.route.sectionId !== 'J') return;

    let tip = document.querySelector('.j-tt');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'j-tt';
      document.body.appendChild(tip);
    }

    const bindMove = (el) => {
      el.addEventListener('mousemove', e => {
        tip.style.left = (e.pageX + 14) + 'px';
        tip.style.top  = (e.pageY - 8) + 'px';
      });
      el.addEventListener('mouseleave', () => { tip.style.opacity = '0'; });
    };

    const yr = window.__sectionJ_yr || '2024';
    const prevYr = window.__sectionJ_prevYr || '2023';
    const tableNames = window.__sectionJ_tables || {};

    // ===== Card 1 · Customer Burden Dumbbell rows =====
    document.querySelectorAll('.j-burden-html-row').forEach(row => {
      row.addEventListener('mouseenter', () => {
        const type = row.dataset.type;
        const isBurden = type === 'burden';
        const isAssist = type === 'assist';
        const deltaColor = isBurden ? 'var(--red)' : (isAssist ? 'var(--green)' : 'var(--text-3)');
        const yoyColor = isBurden ? 'var(--red)' : (isAssist ? 'var(--green)' : 'var(--text-3)');
        const interpretation = isBurden
          ? 'Over-represented vs population. DAC carries more of this burden.'
          : isAssist
            ? 'Reaching DAC at a higher rate than their population share. Good equity outcome.'
            : type === 'usage'
              ? 'DAC use roughly tracks population share. Lower energy intensity than Non-DAC on average.'
              : 'DAC share of all residential customers. The baseline equity reference.';
        const hasPrev = row.dataset.prev && row.dataset.prev !== 'n/a';
        tip.innerHTML =
          '<div class="j-tt-name">' + row.dataset.label + '</div>' +
          '<div class="j-tt-row"><span>Source</span><span class="v">' + (tableNames[row.dataset.src] || row.dataset.src) + '</span></div>' +
          '<div class="j-tt-row"><span>DAC share ' + yr + '</span><span class="v">' + row.dataset.pct + '</span></div>' +
          (hasPrev ? '<div class="j-tt-row"><span>DAC share ' + prevYr + '</span><span class="v">' + row.dataset.prev + '</span></div>' : '') +
          (hasPrev && row.dataset.yoy ? '<div class="j-tt-row"><span>YoY change</span><span class="v" style="color:' + yoyColor + '">' + row.dataset.yoy + '</span></div>' : '') +
          '<div class="j-tt-row"><span>Baseline</span><span class="v">' + row.dataset.baseline + '</span></div>' +
          (row.dataset.delta ? '<div class="j-tt-row"><span>vs baseline</span><span class="v" style="color:' + deltaColor + '">' + row.dataset.delta + '</span></div>' : '') +
          '<div class="j-tt-note">' + interpretation + '</div>';
        tip.style.opacity = '1';
      });
      bindMove(row);
    });

    // ===== Card 2 · Unpaid Residential Accounts blocks =====
    document.querySelectorAll('.j-aff-block').forEach(block => {
      block.addEventListener('mouseenter', () => {
        const isDac = block.dataset.group === 'dac';
        const interp = isDac
          ? 'DAC accounts hold the majority of the unpaid debt. Burden is concentrated here.'
          : 'Non-DAC unpaid debt is lower in absolute total despite serving more total customers.';
        tip.innerHTML =
          '<div class="j-tt-name">' + (isDac ? 'DAC' : 'Non-DAC') + ' \u00b7 90+ day unpaid debt</div>' +
          '<div class="j-tt-row"><span>Source</span><span class="v">' + (tableNames['J4'] || 'J4') + '</span></div>' +
          '<div class="j-tt-row"><span>Unpaid total</span><span class="v">' + block.dataset.debt + '</span></div>' +
          '<div class="j-tt-row"><span>% of all debt</span><span class="v">' + block.dataset.pct + '</span></div>' +
          '<div class="j-tt-row"><span>Accounts</span><span class="v">' + block.dataset.accts + '</span></div>' +
          '<div class="j-tt-row"><span>Avg per account</span><span class="v">' + block.dataset.avg + '</span></div>' +
          '<div class="j-tt-note">' + interp + '</div>';
        tip.style.opacity = '1';
      });
      bindMove(block);
    });

    // ===== Card 3 · Disconnect Flow stages =====
    document.querySelectorAll('.j-flow-stage').forEach(stage => {
      stage.addEventListener('mouseenter', () => {
        const s = stage.dataset.stage;
        let title, source, interp, convLabel;
        if (s === 'unpaid') {
          title = 'Unpaid 90+ days';
          source = tableNames['J4'] || 'J4';
          convLabel = '% that become disconnected';
          interp = 'Accounts 90+ days past due. The starting pool that can flow into disconnection.';
        } else if (s === 'disc') {
          title = 'Disconnected';
          source = tableNames['J5'] || 'J5';
          convLabel = '% restored within year';
          interp = 'Residential service disconnections for non-payment. DAC share rises vs the unpaid pool.';
        } else {
          title = 'Restored';
          source = tableNames['J5'] || 'J5';
          convLabel = 'Restoration rate';
          interp = 'Service restored after payment. The accounts that fully resolved within the reporting year.';
        }
        const hasPrev = stage.dataset.prev && stage.dataset.prev !== 'n/a';
        const yoyVal = stage.dataset.yoy;
        const yoyNum = yoyVal ? parseInt(yoyVal) : null;
        const isGoodUp = s === 'rest';
        const yoyColor = yoyNum === null ? 'var(--text-3)'
          : (yoyNum > 0
            ? (isGoodUp ? 'var(--green)' : 'var(--red)')
            : (isGoodUp ? 'var(--red)' : 'var(--green)'));

        tip.innerHTML =
          '<div class="j-tt-name">' + title + '</div>' +
          '<div class="j-tt-row"><span>Source</span><span class="v">' + source + '</span></div>' +
          '<div class="j-tt-row"><span>Total ' + yr + '</span><span class="v">' + stage.dataset.total + '</span></div>' +
          (hasPrev ? '<div class="j-tt-row"><span>Total ' + prevYr + '</span><span class="v">' + stage.dataset.prev + '</span></div>' : '') +
          (hasPrev && yoyVal ? '<div class="j-tt-row"><span>YoY change</span><span class="v" style="color:' + yoyColor + '">' + (yoyNum > 0 ? '\u2191 ' : '\u2193 ') + yoyVal + '</span></div>' : '') +
          '<div class="j-tt-row"><span>DAC share</span><span class="v">' + stage.dataset.dac + '</span></div>' +
          '<div class="j-tt-row"><span>Non-DAC share</span><span class="v">' + stage.dataset.nondac + '</span></div>' +
          '<div class="j-tt-row"><span>' + convLabel + '</span><span class="v">' + stage.dataset.conv + '</span></div>' +
          '<div class="j-tt-note">' + interp + '</div>';
        tip.style.opacity = '1';
      });
      bindMove(stage);
    });

    // ===== Card 4 · DPA Growth groups =====
    document.querySelectorAll('.j-dpa-group').forEach(g => {
      g.addEventListener('mouseenter', () => {
        const isDac = g.dataset.group === 'dac';
        const interp = isDac
          ? 'DAC accounts on deferred payment plans grew steadily. Sign of higher need or better outreach.'
          : 'Non-DAC plan enrollment grew faster than DAC in % terms but from a smaller base.';
        tip.innerHTML =
          '<div class="j-tt-name">' + (isDac ? 'DAC' : 'Non-DAC') + ' \u00b7 Deferred Payment Agreements</div>' +
          '<div class="j-tt-row"><span>Source</span><span class="v">' + (tableNames['J6'] || 'J6') + '</span></div>' +
          '<div class="j-tt-row"><span>Accounts ' + prevYr + '</span><span class="v">' + g.dataset.prev + '</span></div>' +
          '<div class="j-tt-row"><span>Accounts ' + yr + '</span><span class="v">' + g.dataset.curr + '</span></div>' +
          '<div class="j-tt-row"><span>YoY growth</span><span class="v" style="color:var(--green)">' + g.dataset.growth + '</span></div>' +
          '<div class="j-tt-row"><span>Balance ' + prevYr + '</span><span class="v">' + g.dataset.amtPrev + '</span></div>' +
          '<div class="j-tt-row"><span>Balance ' + yr + '</span><span class="v">' + g.dataset.amtCurr + '</span></div>' +
          '<div class="j-tt-note">' + interp + '</div>';
        tip.style.opacity = '1';
      });
      bindMove(g);
    });
  }

function wireDTooltips() {
    if (state.route.sectionId !== 'D') return;

    let tip = document.querySelector('.d-tt');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'd-tt';
      document.body.appendChild(tip);
    }

    const bindMove = (el) => {
      el.addEventListener('mousemove', e => {
        tip.style.left = (e.pageX + 14) + 'px';
        tip.style.top  = (e.pageY - 8) + 'px';
      });
      el.addEventListener('mouseleave', () => { tip.style.opacity = '0'; });
    };

    const yr = state.year;
    const prevYr = prevYearOf(state.year) || '';

    const tableNameMap = {
      'D2': 'D2 · All DERs (CDG + RC + NM)',
      'D3': 'D3 · Community Solar + Remote Crediting',
      'D4': 'D4 · Net Metering'
    };

    document.querySelectorAll('.d-bar-metric').forEach(m => {
      m.addEventListener('mouseenter', () => {
        const yoyStr = m.dataset.yoy;
        const yoyNum = yoyStr && yoyStr !== 'n/a' ? parseInt(yoyStr) : null;
        const yoyColor = yoyNum === null ? 'var(--text-3)'
          : (yoyNum > 0 ? 'var(--green)' : (yoyNum < 0 ? 'var(--red)' : 'var(--text-3)'));
        const tableId = m.dataset.table || '';
        const tableLine = '<div class="d-tt-row"><span>Source</span><span class="v">' + (tableNameMap[tableId] || tableId) + '</span></div>';

        let rowsHtml;
        if (m.dataset.isLmi === 'true') {
          // LMI single-bar tooltip
          rowsHtml =
            '<div class="d-tt-row"><span>Up to ' + yr + '</span><span class="v">' + m.dataset.curr + '</span></div>' +
            '<div class="d-tt-row"><span>Up to ' + prevYr + '</span><span class="v">' + m.dataset.prev + '</span></div>' +
            '<div class="d-tt-row"><span>YoY change</span><span class="v" style="color:' + yoyColor + '">' + m.dataset.yoy + '</span></div>';
        } else {
          // DAC + Non-DAC split tooltip
          rowsHtml =
            '<div class="d-tt-row"><span>Total ' + yr + '</span><span class="v">' + m.dataset.currTotal + '</span></div>' +
            '<div class="d-tt-row"><span>DAC ' + yr + '</span><span class="v">' + m.dataset.currDac + '</span></div>' +
            '<div class="d-tt-row"><span>Non-DAC ' + yr + '</span><span class="v">' + m.dataset.currNon + '</span></div>' +
            '<div class="d-tt-row"><span>DAC share ' + yr + '</span><span class="v" style="color:var(--dusk)">' + m.dataset.currDacPct + '</span></div>' +
            '<div class="d-tt-row" style="margin-top:4px;padding-top:4px;border-top:1px dashed var(--line)"><span>Total ' + prevYr + '</span><span class="v">' + m.dataset.prevTotal + '</span></div>' +
            '<div class="d-tt-row"><span>DAC ' + prevYr + '</span><span class="v">' + m.dataset.prevDac + '</span></div>' +
            '<div class="d-tt-row"><span>Non-DAC ' + prevYr + '</span><span class="v">' + m.dataset.prevNon + '</span></div>' +
            '<div class="d-tt-row"><span>DAC share ' + prevYr + '</span><span class="v" style="color:var(--dusk)">' + m.dataset.prevDacPct + '</span></div>' +
            '<div class="d-tt-row" style="margin-top:4px;padding-top:4px;border-top:1px dashed var(--line)"><span>YoY change</span><span class="v" style="color:' + yoyColor + '">' + m.dataset.yoy + '</span></div>';
        }

        tip.innerHTML =
          '<div class="d-tt-name">' + m.dataset.label + '</div>' +
          tableLine +
          rowsHtml;
        tip.style.opacity = '1';
      });
      bindMove(m);
    });
  }

function wireFTooltips() {
    if (state.route.sectionId !== 'F' && state.route.sectionId !== 'H') return;

    let tip = document.querySelector('.f-tt');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'f-tt';
      document.body.appendChild(tip);
    }

    const bindMove = (el) => {
      el.addEventListener('mousemove', e => {
        tip.style.left = (e.pageX + 14) + 'px';
        tip.style.top  = (e.pageY - 8) + 'px';
      });
      el.addEventListener('mouseleave', () => { tip.style.opacity = '0'; });
    };

    const yr = state.year;
    const prevYr = prevYearOf(state.year) || '';

    // ===== Card 2 · F2 Network vs Non-Network tiles (Section F only) =====
    document.querySelectorAll('.d-bar-metric[data-table="F2"]').forEach(m => {
      m.addEventListener('mouseenter', () => {
        const yoyStr = m.dataset.yoy;
        const yoyNum = yoyStr && yoyStr !== 'n/a' ? parseInt(yoyStr) : null;
        const yoyColor = yoyNum === null ? 'var(--text-3)'
          : (yoyNum > 0 ? 'var(--red)' : (yoyNum < 0 ? 'var(--green)' : 'var(--text-3)'));

        tip.innerHTML =
          '<div class="f-tt-name">' + m.dataset.label + '</div>' +
          '<div class="f-tt-row"><span>Source</span><span class="v">F2 · Outages by infrastructure</span></div>' +
          '<div class="f-tt-row"><span>Total ' + yr + '</span><span class="v">' + m.dataset.currTotal + '</span></div>' +
          '<div class="f-tt-row"><span>Network ' + yr + '</span><span class="v">' + m.dataset.currNet + '</span></div>' +
          '<div class="f-tt-row"><span>Non-Network ' + yr + '</span><span class="v">' + m.dataset.currNon + '</span></div>' +
          '<div class="f-tt-row" style="margin-top:4px;padding-top:4px;border-top:1px dashed var(--line)"><span>Total ' + prevYr + '</span><span class="v">' + m.dataset.prevTotal + '</span></div>' +
          '<div class="f-tt-row"><span>Network ' + prevYr + '</span><span class="v">' + m.dataset.prevNet + '</span></div>' +
          '<div class="f-tt-row"><span>Non-Network ' + prevYr + '</span><span class="v">' + m.dataset.prevNon + '</span></div>' +
          '<div class="f-tt-row" style="margin-top:4px;padding-top:4px;border-top:1px dashed var(--line)"><span>YoY change</span><span class="v" style="color:' + yoyColor + '">' + m.dataset.yoy + '</span></div>';
        tip.style.opacity = '1';
      });
      bindMove(m);
    });

    // ===== Borough rows (F9 in Section F, H1 in Section H) =====
    document.querySelectorAll('.f3-borough').forEach(b => {
      b.addEventListener('mouseenter', () => {
        const dacYoy = b.dataset.dacYoy;
        const nonYoy = b.dataset.nonYoy;
        const dacYoyNum = dacYoy && dacYoy !== 'n/a' ? parseInt(dacYoy) : null;
        const nonYoyNum = nonYoy && nonYoy !== 'n/a' ? parseInt(nonYoy) : null;
        const dacColor = dacYoyNum === null ? 'var(--text-3)'
          : (dacYoyNum > 0 ? 'var(--red)' : 'var(--green)');
        const nonColor = nonYoyNum === null ? 'var(--text-3)'
          : (nonYoyNum > 0 ? 'var(--red)' : 'var(--green)');
        const source = b.dataset.source || 'F9 · Customers interrupted';

        tip.innerHTML =
          '<div class="f-tt-name">' + b.dataset.name + '</div>' +
          '<div class="f-tt-row"><span>Source</span><span class="v">' + source + '</span></div>' +
          '<div class="f-tt-row"><span>Total ' + yr + '</span><span class="v">' + b.dataset.currTotal + '</span></div>' +
          '<div class="f-tt-row" style="margin-top:4px;padding-top:4px;border-top:1px dashed var(--line)"><span>DAC ' + yr + '</span><span class="v">' + b.dataset.currDac + ' (' + b.dataset.dacPct + ')</span></div>' +
          '<div class="f-tt-row"><span>DAC ' + prevYr + '</span><span class="v">' + b.dataset.prevDac + '</span></div>' +
          '<div class="f-tt-row"><span>DAC YoY</span><span class="v" style="color:' + dacColor + '">' + b.dataset.dacYoy + '</span></div>' +
          '<div class="f-tt-row" style="margin-top:4px;padding-top:4px;border-top:1px dashed var(--line)"><span>Non-DAC ' + yr + '</span><span class="v">' + b.dataset.currNon + ' (' + b.dataset.nonPct + ')</span></div>' +
          '<div class="f-tt-row"><span>Non-DAC ' + prevYr + '</span><span class="v">' + b.dataset.prevNon + '</span></div>' +
          '<div class="f-tt-row"><span>Non-DAC YoY</span><span class="v" style="color:' + nonColor + '">' + b.dataset.nonYoy + '</span></div>';
        tip.style.opacity = '1';
      });
      bindMove(b);
    });
  }

function wireHTooltips() {
    if (state.route.sectionId !== 'H') return;

    let tip = document.querySelector('.h-pie-tt');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'h-pie-tt';
      document.body.appendChild(tip);
    }

    const yr = state.year;
    const prevYr = prevYearOf(state.year) || '';

    document.querySelectorAll('.h-pie-slice').forEach(slice => {
      slice.addEventListener('mouseenter', () => {
        const yoyStr = slice.dataset.yoy;
        const yoyNum = yoyStr && yoyStr !== 'n/a' ? parseInt(yoyStr) : null;
        const yoyColor = yoyNum === null ? 'var(--text-3)'
          : (yoyNum > 0 ? 'var(--green)' : 'var(--red)');

        tip.innerHTML =
          '<div class="h-pie-tt-name">' + slice.dataset.name + '</div>' +
          '<div class="h-pie-tt-row"><span>Source</span><span class="v">H1 · Leak repairs</span></div>' +
          '<div class="h-pie-tt-row"><span>' + slice.dataset.label + ' ' + yr + '</span><span class="v">' + slice.dataset.value + '</span></div>' +
          '<div class="h-pie-tt-row"><span>' + slice.dataset.label + ' ' + prevYr + '</span><span class="v">' + slice.dataset.prevValue + '</span></div>' +
          '<div class="h-pie-tt-row"><span>YoY change</span><span class="v" style="color:' + yoyColor + '">' + slice.dataset.yoy + '</span></div>' +
          '<div class="h-pie-tt-row" style="margin-top:4px;padding-top:4px;border-top:1px dashed var(--line)"><span>Share of total ' + yr + '</span><span class="v">' + slice.dataset.pct + '</span></div>';
        tip.style.opacity = '1';
      });
      slice.addEventListener('mousemove', e => {
        tip.style.left = (e.pageX + 14) + 'px';
        tip.style.top  = (e.pageY - 8) + 'px';
      });
      slice.addEventListener('mouseleave', () => { tip.style.opacity = '0'; });
    });
  }
  // ============================================================
  // PUBLIC API · window.Dash
  //   Future phases will move into this same file; for now the
  //   namespace is here so we can migrate code incrementally.
  // ============================================================
  const Dash = {
    // Formatters
    fmtNum,
    fmtCompact,
    deltaPct,
    isNumeric,
    escapeHtml,

    // Year helpers
    allYears,
    prevYearOf,
    get state() { return state; },          // read-only handle to internal state
    get payload() { return state.payload; },
    get year() { return state.year; },

    // Chart primitives
    stackedBar,
    compareRows,
    groupedBars,
    quadrant,

    // Table rendering
    renderTable,
    renderSourceTables,
    wireYearToggles,

    // Persistence (Phase 6)
    Storage,

    // Constants
    SHORT_TITLES,
  };

  window.Dash = Dash;

  // ============================================================
  // PAYLOAD LOADING
  // ============================================================

  async function loadPayload() {
    try {
      const res = await fetch('payload.json');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      console.error('Failed to load payload.json', err);
      showFatalError(
        'Could not load payload.json',
        'Make sure the file exists next to index.html and you are opening this through a web server (not file://). ' +
        'For local development, run: <code>python -m http.server 8000</code> and open http://localhost:8000'
      );
      throw err;
    }
  }

  function showFatalError(title, message) {
    const view = document.getElementById('view-container');
    view.innerHTML = `
      <div style="padding:40px; max-width:600px; margin:60px auto; background:var(--white); border:1px solid var(--red); border-radius:8px;">
        <h2 style="color:var(--red); margin:0 0 12px;">${escapeHtml(title)}</h2>
        <p style="color:var(--text-2); line-height:1.6;">${message}</p>
      </div>
    `;
  }

  // ============================================================
  // SIDEBAR RENDERING
  // ============================================================

  function buildSidebar() {
    const sections = state.payload.sections;
    const nav = document.getElementById('sidebar-sections');
    const links = Object.entries(sections).map(([letter, sec]) => {
      const href = `#/section/${letter}`;
      return `<a class="nav-item" href="${href}" data-route="/section/${letter}">
        <span class="nav-letter">${letter}</span> ${escapeHtml(sec.full_name)}
      </a>`;
    }).join('');
    nav.innerHTML = links;

    const tableCount = Object.keys(state.payload.tables).length;
    const sectionCount = Object.keys(sections).length;
    document.getElementById('sidebar-foot').innerHTML = `
      <div>${sectionCount} areas · ${tableCount} tables</div>
    `;

    document.getElementById('sidebar-sub').textContent = `Reporting Year ${state.year}`;
  }

  function updateActiveNav() {
    const hash = location.hash || '#/';
    const route = hash.slice(1);
    document.querySelectorAll('.nav-item').forEach(a => {
      a.classList.toggle('active', a.dataset.route === route);
    });
  }

  // ============================================================
  // TOPBAR · Year selector
  // ============================================================

  function buildYearSelector() {
    const sel = document.getElementById('year-select');
    const years = allYears();
    sel.innerHTML = years.map(y =>
      `<option value="${y}"${y === state.year ? ' selected' : ''}>${y}</option>`
    ).join('');

    sel.addEventListener('change', e => {
      state.year = e.target.value;
      // Reset per-table view state so the year change is clean
      state.perTableYearView = {};
      document.getElementById('sidebar-sub').textContent = `Reporting Year ${state.year}`;
      rerenderCurrentView();
    });
  }

  function wireExportButton() {
    document.getElementById('btn-export').addEventListener('click', () => window.print());
  }

  // ============================================================
  // ROUTER
  // ============================================================

  function parseRoute(hash) {
    let path = (hash || '').replace(/^#/, '') || '/';
    if (path === '/' || path === '') return { name: 'executive' };
    if (path === '/ingest') return { name: 'ingest' };
    const m = path.match(/^\/section\/([A-J])$/);
    if (m) return { name: 'section', sectionId: m[1] };
    return { name: 'notfound', path };
  }

  function onRouteChange() {
    state.route = parseRoute(location.hash);
    state.activeTableId = null;  // reset active tab when moving between sections
    updateActiveNav();
    updateCrumb();
    renderCurrentView();
  }

  function updateCrumb() {
    const el = document.getElementById('crumb-current');
    const r = state.route;
    if (r.name === 'executive') el.textContent = 'Executive Summary';
    else if (r.name === 'section') {
      const sec = state.payload.sections[r.sectionId];
      el.textContent = `${r.sectionId}. ${sec.full_name}`;
    }
    else if (r.name === 'ingest') el.textContent = 'Data Ingestion';
    else el.textContent = 'Not found';
  }

  // ============================================================
  // VIEW RENDERING
  //   - Executive Summary: real charts (Phase 4)
  //   - Section views: placeholder + real source tables (Phase 3 demo)
  //   - Data Ingestion: placeholder for Phase 6
  // ============================================================

  function renderCurrentView() {
    const view = document.getElementById('view-container');
    const r = state.route;
    if (r.name === 'executive') {
      view.innerHTML = renderExecutiveSummary();
      wireExecutiveInteractions();
    }
    else if (r.name === 'section') {
      view.innerHTML = renderSection(r.sectionId);
      wireSectionInteractions(r.sectionId);
    }
    else if (r.name === 'ingest') {
      view.innerHTML = renderIngestPage();
      wireIngestPage();
    }
    else view.innerHTML = renderNotFound(r.path);
  }

  function rerenderCurrentView() {
    renderCurrentView();
  }

  // Aliased for legacy code copied from section_page.js that calls rerenderAll
  const rerenderAll = rerenderCurrentView;

  /** Wire all interactive parts of a section view (charts, tooltips, tables). */
  function wireSectionInteractions(letter) {
    const tables = Object.values(state.payload.tables)
      .filter(t => t.section === letter);

    // Re-render the source-tables strip when its toggles fire.
    const rerenderTables = () => {
      const container = document.getElementById('tables-container');
      if (!container) return;
      container.innerHTML = renderSourceTables(
        tables, state.year, state.perTableYearView, state.activeTableId
      );
      wireYearToggles(state, rerenderTables);
    };

    // Wire shared interactions (rank toggle and quadrant-metric only fire
    // on Section A, but it's cheap to attempt every time).
    wireRankToggle();
    wireQuadrantMetricToggle();
    wireQuadrantTooltip();
    wireHelpButtons();
    if (letter === 'A') wireSectionATooltips();
    if (letter === 'B') wireBTooltips();
    if (letter === 'E') drawSectionEArc();
    if (letter === 'J') wireJTooltips();
    if (letter === 'D') wireDTooltips();
    if (letter === 'F' || letter === 'H') wireFTooltips();
    if (letter === 'F') wireFSectionTooltips();
    if (letter === 'G') wireGSectionTooltips();
    if (letter === 'H') wireHTooltips();
    if (letter === 'I') wireISectionTooltips();

    wireYearToggles(state, rerenderTables);
  }

  function renderSection(letter) {
    const p = state.payload;
    const sec = p.sections[letter];
    if (!sec) return renderNotFound(`section/${letter}`);
    const tables = Object.values(p.tables).filter(t => t.section === letter);
    const yr = state.year;

    // Check if this section has any meaningful data for the selected year.
    // We look at: tables for the section, and any chart series whose key
    // starts with the section letter.
    const sectionHasData = (() => {
      const tablesNonEmpty = tables.some(t => {
        const rows = (t.data || {})[yr];
        return rows && !isEmptyYearData(rows);
      });
      if (tablesNonEmpty) return true;
      const chartsForSec = Object.entries(p.charts).filter(([k]) => k.startsWith(letter));
      const chartsNonEmpty = chartsForSec.some(([, c]) => {
        const v = c && c.values && c.values[yr];
        return v && !isEmptyYearData(v);
      });
      return chartsNonEmpty;
    })();

    const chartsHtml = sectionHasData
      ? renderSectionCharts(letter)
      : `<div class="chart-card" style="min-height:280px">${emptyYearPane(yr, {
          message: `No data has been entered for ${sec.full_name} in ${yr}.`,
          hint: 'Source tables for this section are shown below if any exist. Use Data Ingestion to add values.'
        })}</div>`;

    return `
      <div class="section-overview">
        <div class="section-overview-icon">${letter}</div>
        <div class="section-overview-text">
          <h2>${escapeHtml(sec.full_name)}</h2>
          <p>${escapeHtml(sec.blurb || '')}</p>
        </div>
        <dl class="section-overview-stats" id="section-stats">${fillSectionStats(letter)}</dl>
      </div>

      <div id="charts-container">${chartsHtml}</div>

      ${tables.length > 0 ? `
        <div class="section-divider"><span class="icon"></span> Source Tables <span class="icon" style="background:var(--dusk)"></span></div>
        <div id="tables-container">${renderSourceTables(tables, state.year, state.perTableYearView, state.activeTableId)}</div>
      ` : ''}
    `;
  }

  // ============================================================
  // DATA INGESTION (Phase 6b)
  // ============================================================
  //
  // Page layout:
  //   1. Page header
  //   2. Picker bar (Section / Table / Year dropdowns)
  //   3. Status bar (modified indicator + Reset + Save buttons)
  //   4. Editable grid (one input per cell; rows can be added/removed)
  //   5. History strip (last 5 saves for this table)
  //
  // State (in `state.ingest`):
  //   sectionId : 'A' | 'B' | ...
  //   tableId   : 'A1' | ...   (must belong to sectionId)
  //   year      : '2025' | ...
  //   draft     : 2D array of cell values being edited (null when unmodified)
  //   baseline  : 2D array snapshot before edits started (for diff/reset)
  //   schema    : array of column names for this table/year
  //   dirty     : true if draft differs from baseline
  // ============================================================

  // ---------- helpers ----------

  /** Returns true if the row label looks like a "total" row (case-insensitive). */
  function isTotalRowLabel(label) {
    if (label == null) return false;
    return /total|grand total|subtotal/i.test(String(label).trim());
  }

  /** Get the schema (column headers) for a given table+year. */
  function getTableSchema(table, year) {
    if (!table) return [];
    // Unified format: schema_by_year is the single source of truth
    if (table.schema_by_year && table.schema_by_year[year]) {
      return table.schema_by_year[year].slice();
    }
    // Fall back to any year's schema (used when adding a brand-new year)
    if (table.schema_by_year) {
      const anyYear = Object.keys(table.schema_by_year)[0];
      if (anyYear) return table.schema_by_year[anyYear].slice();
    }
    return [];
  }

  /** Get the body rows for a table+year (no header — schema_by_year holds that). */
  function getTableBody(table, year) {
    if (!table) return [];
    const rows = (table.data || {})[year];
    if (!rows) return [];
    return rows.map(r => r.slice());
  }

  /** Deep-clone a 2D array of primitives. */
  function clone2D(arr) {
    return arr.map(r => Array.isArray(r) ? r.slice() : r);
  }

  /** Format a number for display in a numeric input field (no formatting). */
  function rawNum(v) {
    if (v == null || v === '') return '';
    if (typeof v === 'number') return String(v);
    return String(v);
  }

  /** Parse a string from a numeric input back to a number (or null/string). */
  function parseNumericInput(str) {
    if (str == null) return null;
    const trimmed = String(str).trim();
    if (trimmed === '') return null;
    // Strip $ and commas
    const cleaned = trimmed.replace(/[$,]/g, '');
    const n = Number(cleaned);
    return isFinite(n) ? n : trimmed;
  }

  /** Format a timestamp for the history strip. */
  function formatTimeAgo(ts) {
    const now = Date.now();
    const diff = now - ts;
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return minutes + ' min ago';
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + ' hour' + (hours > 1 ? 's' : '') + ' ago';
    const days = Math.floor(hours / 24);
    if (days < 7) return days + ' day' + (days > 1 ? 's' : '') + ' ago';
    return new Date(ts).toLocaleDateString();
  }

  /**
   * Apply auto-calculation of "total" rows: for each row whose label looks
   * like a total, sum the numeric values in each non-label column from all
   * non-total rows above. Mutates the array.
   */
  function recomputeTotals(draft, schema) {
    if (!draft || !schema) return;
    // Identify total rows by their label (col 0)
    const totalRowIdxs = [];
    const nonTotalRows = [];
    draft.forEach((row, idx) => {
      if (isTotalRowLabel(row[0])) totalRowIdxs.push(idx);
      else nonTotalRows.push(row);
    });
    if (totalRowIdxs.length === 0) return;

    totalRowIdxs.forEach(idx => {
      for (let c = 1; c < schema.length; c++) {
        let sum = 0;
        let anyNumeric = false;
        nonTotalRows.forEach(r => {
          const v = r[c];
          if (typeof v === 'number' && isFinite(v)) {
            sum += v;
            anyNumeric = true;
          }
        });
        draft[idx][c] = anyNumeric ? sum : null;
      }
    });
  }

  /** Initialize state.ingest based on current selection. */
  function initIngestState() {
    const p = state.payload;
    if (!p) return;
    state.ingest = state.ingest || {};
    // Default to first section with editable tables, table A1, current year
    if (!state.ingest.sectionId) state.ingest.sectionId = Object.keys(p.sections)[0];
    const tablesForSec = Object.values(p.tables)
      .filter(t => t.section === state.ingest.sectionId)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (!state.ingest.tableId || !tablesForSec.some(t => t.id === state.ingest.tableId)) {
      state.ingest.tableId = tablesForSec.length ? tablesForSec[0].id : null;
    }
    if (!state.ingest.year) state.ingest.year = p.meta.current_year;

    loadIngestDraft();
  }

  /** Load the draft for the current selection (from override or baseline). */
  function loadIngestDraft() {
    const p = state.payload;
    const i = state.ingest;
    if (!p || !i || !i.tableId) return;
    const table = p.tables[i.tableId];
    if (!table) return;

    i.schema = getTableSchema(table, i.year);
    i.baseline = getTableBody(table, i.year);
    i.draft = clone2D(i.baseline);
    i.dirty = false;
  }

  /** Mark the draft as dirty (or clean) by diffing against baseline. */
  function recomputeDirty() {
    const i = state.ingest;
    if (!i || !i.draft || !i.baseline) { i && (i.dirty = false); return; }
    if (i.draft.length !== i.baseline.length) { i.dirty = true; return; }
    for (let r = 0; r < i.draft.length; r++) {
      const a = i.draft[r] || [];
      const b = i.baseline[r] || [];
      if (a.length !== b.length) { i.dirty = true; return; }
      for (let c = 0; c < a.length; c++) {
        if (a[c] !== b[c]) { i.dirty = true; return; }
      }
    }
    i.dirty = false;
  }

  // ---------- renderers ----------

  /** Main ingest page renderer. */
  function renderIngestPage() {
    const p = state.payload;
    initIngestState();
    const i = state.ingest;

    return `
      <div class="page-header" style="display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <h1>Data Ingestion</h1>
          <p class="page-sub">Enter or update values for any table, by year. Edits are saved to your browser and applied to the dashboard.</p>
        </div>
      </div>

      ${renderIngestPicker()}

      <div id="ingest-editor-mount">${renderIngestEditor()}</div>

      <div id="ingest-history-mount">${renderIngestHistory()}</div>
    `;
  }

  /** The 3-dropdown picker bar (section / table / year). */
  function renderIngestPicker() {
    const p = state.payload;
    const i = state.ingest;
    const sections = Object.entries(p.sections);
    const tablesForSec = Object.values(p.tables)
      .filter(t => t.section === i.sectionId)
      .sort((a, b) => a.id.localeCompare(b.id));
    const years = allYears();
    const addedYears = Storage.getAddedYears();

    const secOpts = sections.map(([letter, sec]) =>
      `<option value="${letter}"${letter === i.sectionId ? ' selected' : ''}>${letter}. ${escapeHtml(sec.full_name)}</option>`
    ).join('');

    const tableOpts = tablesForSec.map(t => {
      const num = t.id.replace(/^([A-Z])(\d+)$/, '$1.$2');
      const short = SHORT_TITLES[t.id] || t.short_title || '';
      return `<option value="${t.id}"${t.id === i.tableId ? ' selected' : ''}>${num} · ${escapeHtml(short)}</option>`;
    }).join('');

    const yearOpts = years.map(y => {
      const isAdded = addedYears.includes(y);
      const label = isAdded ? y + ' · added' : y;
      return `<option value="${y}"${y === i.year ? ' selected' : ''}>${label}</option>`;
    }).join('');

    const isCurrentYearUserAdded = addedYears.includes(i.year);
    const removeYearBtn = isCurrentYearUserAdded
      ? `<button id="ingest-remove-year" class="ingest-year-remove" type="button" title="Remove ${i.year} from the dashboard">× Remove ${i.year}</button>`
      : '';

    return `
      <div class="ingest-picker">
        <div class="ingest-picker-field">
          <label>Section</label>
          <select id="ingest-section" class="ingest-select">${secOpts}</select>
        </div>
        <div class="ingest-picker-field">
          <label>Table</label>
          <select id="ingest-table" class="ingest-select">${tableOpts}</select>
        </div>
        <div class="ingest-picker-field">
          <label>Year</label>
          <div class="ingest-year-row">
            <select id="ingest-year" class="ingest-select">${yearOpts}</select>
            <button id="ingest-add-year" class="ingest-year-add" type="button" title="Add a new reporting year">+ Add year</button>
          </div>
          ${removeYearBtn}
        </div>
      </div>`;
  }

  /** The editor (status bar + grid + add-row button). */
  function renderIngestEditor() {
    const p = state.payload;
    const i = state.ingest;
    if (!i || !i.tableId) {
      return `<div class="empty-pane">Select a table to begin editing.</div>`;
    }
    const table = p.tables[i.tableId];
    if (!table) {
      return `<div class="empty-pane">Table ${i.tableId} not found.</div>`;
    }

    recomputeTotals(i.draft, i.schema);
    recomputeDirty();

    const tableNum = i.tableId.replace(/^([A-Z])(\d+)$/, '$1.$2');
    const tableTitle = (table.title_by_year || {})[i.year] || ('Table ' + i.tableId);
    const cleanTitle = tableTitle.split('|')[0].trim();

    // Status bar
    const statusHtml = i.dirty
      ? `<span class="ingest-status modified">● Unsaved changes</span>`
      : `<span class="ingest-status clean">○ No changes</span>`;
    const saveBtnAttrs = i.dirty ? '' : ' disabled';
    const resetBtnAttrs = i.dirty ? '' : ' disabled';

    // Build header row
    const headerCells = i.schema.map((col, idx) =>
      `<th${idx === 0 ? ' class="ingest-th-label"' : ''}>${escapeHtml(col)}</th>`
    ).join('');

    // Build body rows
    const bodyRowsHtml = i.draft.map((row, rowIdx) => {
      const isTotal = isTotalRowLabel(row[0]);
      const cells = i.schema.map((_, colIdx) => {
        const v = row[colIdx];
        if (colIdx === 0) {
          // Label column — always editable text input
          return `<td class="ingest-td-label">
            <input type="text" value="${escapeHtml(rawNum(v))}" data-row="${rowIdx}" data-col="0" class="ingest-cell ingest-cell-label" />
          </td>`;
        }
        if (isTotal) {
          // Calculated cell — readonly, gray
          const display = (v == null || v === '') ? '—' :
            (typeof v === 'number' ? v.toLocaleString() : String(v));
          return `<td class="ingest-td-calc"><span class="ingest-cell-calc">${escapeHtml(display)}</span></td>`;
        }
        // Regular editable numeric cell
        const cellValue = v == null || v === '' ? '' : (typeof v === 'number' ? String(v) : String(v));
        return `<td>
          <input type="text" inputmode="decimal" value="${escapeHtml(cellValue)}" data-row="${rowIdx}" data-col="${colIdx}" class="ingest-cell ingest-cell-num" />
        </td>`;
      }).join('');
      return `<tr${isTotal ? ' class="ingest-row-total"' : ''} data-row="${rowIdx}">
        ${cells}
        <td class="ingest-td-actions">
          <button class="ingest-row-delete" type="button" data-row="${rowIdx}" title="Delete row">×</button>
        </td>
      </tr>`;
    }).join('');

    return `
      <div class="ingest-card">
        <div class="ingest-card-head">
          <div>
            <h3>${escapeHtml(cleanTitle)}</h3>
            <p class="chart-sub">${tableNum} · Year ${i.year} · ${i.schema.length} columns · ${i.draft.length} rows</p>
          </div>
          <div class="ingest-actions">
            ${statusHtml}
            <button id="ingest-reset" class="btn btn-secondary"${resetBtnAttrs}>Reset</button>
            <button id="ingest-save" class="btn btn-primary"${saveBtnAttrs}>Save changes</button>
          </div>
        </div>
        <div class="ingest-grid-wrap">
          <table class="ingest-grid">
            <thead>
              <tr>${headerCells}<th></th></tr>
            </thead>
            <tbody>
              ${bodyRowsHtml}
            </tbody>
          </table>
        </div>
        <div class="ingest-card-foot">
          <button id="ingest-add-row" class="btn btn-link" type="button">+ Add row</button>
          ${i.draft.some(r => isTotalRowLabel(r[0]))
            ? '<span class="ingest-foot-note">Rows labeled "Total" are auto-calculated from numeric rows above (read-only, shown in grey).</span>'
            : ''}
        </div>
      </div>`;
  }

  /**
   * Format a single cell value for display in the history detail.
   * Numbers get locale formatting; strings are escaped.
   */
  function fmtHistoryVal(v) {
    if (v == null || v === '') return '<em>empty</em>';
    if (typeof v === 'number') return v.toLocaleString();
    return escapeHtml(String(v));
  }

  /**
   * Build the inner HTML for the expanded change-detail list.
   * Groups changes by kind: deleted rows, added rows, then cell edits.
   */
  function renderChangeDetail(changes) {
    if (!changes || changes.length === 0) {
      return '<p class="ingest-history-empty" style="margin:6px 0 0">(No granular changes recorded.)</p>';
    }

    const adds    = changes.filter(c => c.kind === 'added');
    const deletes = changes.filter(c => c.kind === 'deleted');
    const cells   = changes.filter(c => c.kind === 'cell' || c.kind == null);   // legacy entries have no `kind`

    let html = '<ul class="ingest-history-detail">';

    deletes.forEach(c => {
      const label = (c.oldRow && c.oldRow[0] != null) ? String(c.oldRow[0]) : '(unlabeled)';
      html += `<li class="ingest-history-detail-del">
        <span class="ingest-history-detail-tag">REMOVED</span>
        <span class="ingest-history-detail-text">Row "${escapeHtml(label)}"</span>
      </li>`;
    });

    adds.forEach(c => {
      const label = (c.newRow && c.newRow[0] != null) ? String(c.newRow[0]) : '(unlabeled)';
      html += `<li class="ingest-history-detail-add">
        <span class="ingest-history-detail-tag">ADDED</span>
        <span class="ingest-history-detail-text">Row "${escapeHtml(label)}"</span>
      </li>`;
    });

    cells.forEach(c => {
      const rowLbl = c.rowLabel ? escapeHtml(String(c.rowLabel)) : '(row ' + (c.rowIdx + 1) + ')';
      const colLbl = c.colLabel ? escapeHtml(String(c.colLabel)) : '(col ' + (c.colIdx + 1) + ')';
      html += `<li class="ingest-history-detail-edit">
        <span class="ingest-history-detail-tag">EDIT</span>
        <span class="ingest-history-detail-text">
          <strong>${rowLbl}</strong> · ${colLbl}:
          <span class="ingest-history-old">${fmtHistoryVal(c.oldVal)}</span>
          <span class="ingest-history-arrow">→</span>
          <span class="ingest-history-new">${fmtHistoryVal(c.newVal)}</span>
        </span>
      </li>`;
    });

    html += '</ul>';
    return html;
  }

  /** Build the short summary text shown in the collapsed view. */
  function buildHistorySummary(changes) {
    if (!changes || changes.length === 0) return 'No changes';
    const adds    = changes.filter(c => c.kind === 'added').length;
    const deletes = changes.filter(c => c.kind === 'deleted').length;
    const cells   = changes.filter(c => c.kind === 'cell' || c.kind == null).length;
    const parts = [];
    if (cells > 0)   parts.push(`${cells} cell${cells   !== 1 ? 's' : ''} edited`);
    if (adds > 0)    parts.push(`${adds} row${adds      !== 1 ? 's' : ''} added`);
    if (deletes > 0) parts.push(`${deletes} row${deletes !== 1 ? 's' : ''} removed`);
    return parts.length > 0 ? parts.join(', ') : `${changes.length} changes`;
  }

  /** History strip below the editor. */
  function renderIngestHistory() {
    const i = state.ingest;
    if (!i || !i.tableId) return '';
    const history = Storage.getHistoryFor(i.tableId, i.year);
    if (history.length === 0) {
      return `<div class="ingest-history">
        <h4>Change history</h4>
        <p class="ingest-history-empty">No saves yet for ${i.tableId} · ${i.year}. Your save will appear here.</p>
      </div>`;
    }

    const showAll = state.ingest.historyShowAll === true;
    const visible = showAll ? history : history.slice(0, 10);

    const entries = visible.map((entry, idx) => {
      const ts = new Date(entry.ts);
      const tsStr = ts.toLocaleString();
      const ago = formatTimeAgo(entry.ts);
      const summary = buildHistorySummary(entry.changes);
      const detailHtml = renderChangeDetail(entry.changes);

      return `<li class="ingest-history-entry">
        <div class="ingest-history-meta">
          <span class="ingest-history-who">
            <strong>${escapeHtml(entry.user)}</strong>${entry.email ? ' <span class="ingest-history-email">&lt;' + escapeHtml(entry.email) + '&gt;</span>' : ''}
          </span>
          <span class="ingest-history-when" title="${escapeHtml(tsStr)}">${escapeHtml(ago)}</span>
        </div>
        <div class="ingest-history-body">
          <span class="ingest-history-summary">${summary}</span>
          <button class="ingest-history-toggle btn-link" type="button" data-idx="${idx}" aria-expanded="false">Show details</button>
        </div>
        <div class="ingest-history-detail-wrap" id="hist-detail-${idx}" hidden>
          ${detailHtml}
        </div>
      </li>`;
    }).join('');

    const showAllLink = (!showAll && history.length > 10)
      ? `<div class="ingest-history-showall-wrap">
          <button id="ingest-history-showall" class="btn-link" type="button">Show all ${history.length} saves</button>
        </div>`
      : (showAll && history.length > 10)
        ? `<div class="ingest-history-showall-wrap">
            <button id="ingest-history-showless" class="btn-link" type="button">Show recent 10 only</button>
          </div>`
        : '';

    return `<div class="ingest-history">
      <h4>Change history <span class="ingest-history-count">(${history.length} save${history.length !== 1 ? 's' : ''})</span></h4>
      <ul class="ingest-history-list">${entries}</ul>
      ${showAllLink}
    </div>`;
  }

  // ---------- interactions ----------

  /** Wire all clicks and input events for the ingest page. */
  function wireIngestPage() {
    // Picker dropdowns
    const selSection = document.getElementById('ingest-section');
    const selTable = document.getElementById('ingest-table');
    const selYear = document.getElementById('ingest-year');

    if (selSection) {
      selSection.addEventListener('change', e => {
        if (state.ingest.dirty && !confirm('Discard unsaved changes?')) {
          e.target.value = state.ingest.sectionId;
          return;
        }
        state.ingest.sectionId = e.target.value;
        // Pick first table in new section
        const tablesForSec = Object.values(state.payload.tables)
          .filter(t => t.section === state.ingest.sectionId)
          .sort((a, b) => a.id.localeCompare(b.id));
        state.ingest.tableId = tablesForSec.length ? tablesForSec[0].id : null;
        loadIngestDraft();
        rerenderIngestAll();
      });
    }

    if (selTable) {
      selTable.addEventListener('change', e => {
        if (state.ingest.dirty && !confirm('Discard unsaved changes?')) {
          e.target.value = state.ingest.tableId;
          return;
        }
        state.ingest.tableId = e.target.value;
        loadIngestDraft();
        rerenderIngestEditor();
        rerenderIngestHistory();
      });
    }

    if (selYear) {
      selYear.addEventListener('change', e => {
        if (state.ingest.dirty && !confirm('Discard unsaved changes?')) {
          e.target.value = state.ingest.year;
          return;
        }
        state.ingest.year = e.target.value;
        loadIngestDraft();
        rerenderIngestEditor();
        rerenderIngestHistory();
      });
    }

    wireIngestEditor();
    wireIngestHistory();

    // Add year button
    const addYearBtn = document.getElementById('ingest-add-year');
    if (addYearBtn) {
      addYearBtn.addEventListener('click', () => {
        if (state.ingest.dirty && !confirm('You have unsaved changes. Discard them to add a new year?')) {
          return;
        }
        openAddYearModal();
      });
    }

    // Remove year button (only present when current year is user-added)
    const removeYearBtn = document.getElementById('ingest-remove-year');
    if (removeYearBtn) {
      removeYearBtn.addEventListener('click', () => {
        const yr = state.ingest.year;
        const msg = `Remove ${yr} from the dashboard?\n\nThis will also delete any saved data for ${yr}. This cannot be undone.`;
        if (!confirm(msg)) return;

        // Remove from storage
        Storage.removeYear(yr);

        // Remove from in-memory meta.years
        const idx = state.payload.meta.years.indexOf(yr);
        if (idx >= 0) state.payload.meta.years.splice(idx, 1);

        // Drop any in-memory table.data for that year
        Object.values(state.payload.tables).forEach(t => {
          if (t.data && t.data[yr]) delete t.data[yr];
        });

        // If the user is currently viewing the removed year in the dashboard,
        // bump them back to the current_year
        if (state.year === yr) state.year = state.payload.meta.current_year;

        // Reset ingest state to the current year
        state.ingest.year = state.payload.meta.current_year;
        loadIngestDraft();

        // Refresh the year selector in the header and the ingest page
        buildYearSelector();
        rerenderIngestAll();
      });
    }
  }

  /** Open the "Add new year" modal. */
  function openAddYearModal() {
    const existingYears = allYears();
    const maxYear = Math.max(...existingYears.map(y => parseInt(y, 10)));
    const suggestedYear = String(maxYear + 1);

    const modal = document.createElement('div');
    modal.className = 'ingest-modal-overlay';
    modal.innerHTML = `
      <div class="ingest-modal" role="dialog" aria-labelledby="add-year-modal-title">
        <div class="ingest-modal-head">
          <h3 id="add-year-modal-title">Add a new reporting year</h3>
          <button class="ingest-modal-close" type="button" aria-label="Close">×</button>
        </div>
        <div class="ingest-modal-body">
          <p>The new year will appear in the year selector everywhere. The dashboard will show "no data" until values are entered.</p>
          <div class="ingest-modal-field">
            <label for="add-year-input">Year</label>
            <input id="add-year-input" type="number" min="2000" max="2100" step="1" value="${suggestedYear}" />
          </div>
          <div class="ingest-modal-hint">Existing years: ${existingYears.join(', ')}</div>
          <div class="ingest-modal-error" id="add-year-error" style="display:none"></div>
        </div>
        <div class="ingest-modal-foot">
          <button class="btn btn-secondary" id="add-year-cancel" type="button">Cancel</button>
          <button class="btn btn-primary" id="add-year-confirm" type="button">Add year</button>
        </div>
      </div>`;
    document.body.appendChild(modal);

    const close = () => modal.remove();
    modal.querySelector('.ingest-modal-close').addEventListener('click', close);
    modal.querySelector('#add-year-cancel').addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });

    const input = modal.querySelector('#add-year-input');
    const err = modal.querySelector('#add-year-error');
    const showError = (msg) => { err.textContent = msg; err.style.display = 'block'; };
    const clearError = () => { err.style.display = 'none'; };
    input.addEventListener('input', clearError);

    modal.querySelector('#add-year-confirm').addEventListener('click', () => {
      const raw = input.value.trim();
      const yr = parseInt(raw, 10);
      if (isNaN(yr)) { showError('Please enter a valid year.'); return; }
      if (yr < 2000 || yr > 2100) { showError('Year must be between 2000 and 2100.'); return; }
      const yrStr = String(yr);
      if (existingYears.includes(yrStr)) { showError(yrStr + ' already exists.'); return; }

      // Persist
      Storage.addYear(yrStr);

      // Merge into in-memory meta.years and re-sort newest first
      state.payload.meta.years.push(yrStr);
      state.payload.meta.years.sort((a, b) => parseInt(b) - parseInt(a));

      // Switch the ingest year picker to the new year
      state.ingest.year = yrStr;
      loadIngestDraft();

      // Refresh the year selector in the header AND the ingest page
      buildYearSelector();
      close();
      rerenderIngestAll();
    });

    setTimeout(() => input.focus(), 50);
  }

  /** Wire the editor's cell inputs, add-row, delete-row, save, reset. */
  function wireIngestEditor() {
    // Cell inputs
    document.querySelectorAll('.ingest-cell').forEach(input => {
      input.addEventListener('input', e => {
        const r = parseInt(e.target.dataset.row, 10);
        const c = parseInt(e.target.dataset.col, 10);
        if (isNaN(r) || isNaN(c)) return;
        const isLabel = c === 0;
        if (isLabel) {
          state.ingest.draft[r][c] = e.target.value;
        } else {
          state.ingest.draft[r][c] = parseNumericInput(e.target.value);
        }
        recomputeTotals(state.ingest.draft, state.ingest.schema);
        // Re-render editor to update calculated rows and status bar
        rerenderIngestEditor();
      });
    });

    // Delete-row buttons
    document.querySelectorAll('.ingest-row-delete').forEach(btn => {
      btn.addEventListener('click', () => {
        const r = parseInt(btn.dataset.row, 10);
        if (isNaN(r)) return;
        if (state.ingest.draft.length <= 1) {
          alert('Cannot delete the last row.');
          return;
        }
        if (!confirm('Delete this row?')) return;
        state.ingest.draft.splice(r, 1);
        recomputeTotals(state.ingest.draft, state.ingest.schema);
        rerenderIngestEditor();
      });
    });

    // Add row
    const addBtn = document.getElementById('ingest-add-row');
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        const newRow = state.ingest.schema.map(() => null);
        newRow[0] = '';
        state.ingest.draft.push(newRow);
        recomputeTotals(state.ingest.draft, state.ingest.schema);
        rerenderIngestEditor();
      });
    }

    // Reset
    const resetBtn = document.getElementById('ingest-reset');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        if (!confirm('Discard all unsaved changes and reset to the last saved version?')) return;
        state.ingest.draft = clone2D(state.ingest.baseline);
        rerenderIngestEditor();
      });
    }

    // Save
    const saveBtn = document.getElementById('ingest-save');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        openSaveModal();
      });
    }
  }

  /** Open the "Confirm save" modal (asks for name + email). */
  function openSaveModal() {
    const i = state.ingest;
    if (!i || !i.dirty) return;

    const changeCount = (() => {
      let count = 0;
      const a = i.draft, b = i.baseline;
      const rows = Math.max(a.length, b.length);
      for (let r = 0; r < rows; r++) {
        const ar = a[r] || [], br = b[r] || [];
        const cols = Math.max(ar.length, br.length);
        for (let c = 0; c < cols; c++) {
          if (ar[c] !== br[c]) count++;
        }
      }
      return count;
    })();

    const modal = document.createElement('div');
    modal.className = 'ingest-modal-overlay';
    modal.innerHTML = `
      <div class="ingest-modal" role="dialog" aria-labelledby="ingest-modal-title">
        <div class="ingest-modal-head">
          <h3 id="ingest-modal-title">Confirm save · ${i.tableId} · ${i.year}</h3>
          <button class="ingest-modal-close" type="button" aria-label="Close">×</button>
        </div>
        <div class="ingest-modal-body">
          <p>You are about to save <strong>${changeCount}</strong> cell change${changeCount !== 1 ? 's' : ''}. Please identify yourself:</p>
          <div class="ingest-modal-field">
            <label for="ingest-modal-name">Your name</label>
            <input id="ingest-modal-name" type="text" placeholder="e.g. Maria Lopez" autocomplete="name" />
          </div>
          <div class="ingest-modal-field">
            <label for="ingest-modal-email">Your email</label>
            <input id="ingest-modal-email" type="email" placeholder="e.g. maria@coned.com" autocomplete="email" />
          </div>
          <div class="ingest-modal-error" id="ingest-modal-error" style="display:none"></div>
        </div>
        <div class="ingest-modal-foot">
          <button class="btn btn-secondary" id="ingest-modal-cancel" type="button">Cancel</button>
          <button class="btn btn-primary" id="ingest-modal-confirm" type="button">Save</button>
        </div>
      </div>`;
    document.body.appendChild(modal);

    const close = () => modal.remove();
    modal.querySelector('.ingest-modal-close').addEventListener('click', close);
    modal.querySelector('#ingest-modal-cancel').addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });

    // Pre-fill name/email from last save if available (nice-to-have UX)
    const lastEntry = Storage.getAllHistory()[0];
    if (lastEntry) {
      modal.querySelector('#ingest-modal-name').value = lastEntry.user || '';
      modal.querySelector('#ingest-modal-email').value = lastEntry.email || '';
    }

    modal.querySelector('#ingest-modal-confirm').addEventListener('click', () => {
      const name = modal.querySelector('#ingest-modal-name').value.trim();
      const email = modal.querySelector('#ingest-modal-email').value.trim();
      const err = modal.querySelector('#ingest-modal-error');
      if (!name) { err.textContent = 'Please enter your name.'; err.style.display = 'block'; return; }
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        err.textContent = 'Please enter a valid email address.'; err.style.display = 'block'; return;
      }

      // Persist
      Storage.saveTable(i.tableId, i.year, clone2D(i.draft), {
        name, email,
        oldRows: clone2D(i.baseline),
        schema: i.schema ? i.schema.slice() : []
      });

      // Apply to live payload so dashboard updates immediately
      const table = state.payload.tables[i.tableId];
      if (table) {
        table.data = table.data || {};
        table.data[i.year] = clone2D(i.draft);
      }

      // New baseline = the draft we just saved
      i.baseline = clone2D(i.draft);
      i.dirty = false;

      close();
      rerenderIngestEditor();
      rerenderIngestHistory();
    });

    // Focus first field
    setTimeout(() => modal.querySelector('#ingest-modal-name').focus(), 50);
  }

  // ---------- partial re-renderers ----------

  function rerenderIngestAll() {
    const view = document.getElementById('view-container');
    if (!view) return;
    view.innerHTML = renderIngestPage();
    wireIngestPage();
  }

  function rerenderIngestEditor() {
    const mount = document.getElementById('ingest-editor-mount');
    if (!mount) return;
    mount.innerHTML = renderIngestEditor();
    wireIngestEditor();
  }

  function rerenderIngestHistory() {
    const mount = document.getElementById('ingest-history-mount');
    if (!mount) return;
    mount.innerHTML = renderIngestHistory();
    wireIngestHistory();
  }

  /** Wire collapsible toggle buttons and show-all link. */
  function wireIngestHistory() {
    // Toggle individual entry details
    document.querySelectorAll('.ingest-history-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = btn.dataset.idx;
        const wrap = document.getElementById('hist-detail-' + idx);
        if (!wrap) return;
        const isOpen = !wrap.hidden;
        wrap.hidden = isOpen;
        btn.textContent = isOpen ? 'Show details' : 'Hide details';
        btn.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
      });
    });

    // Show all / show less
    const showAllBtn = document.getElementById('ingest-history-showall');
    if (showAllBtn) {
      showAllBtn.addEventListener('click', () => {
        state.ingest.historyShowAll = true;
        rerenderIngestHistory();
      });
    }
    const showLessBtn = document.getElementById('ingest-history-showless');
    if (showLessBtn) {
      showLessBtn.addEventListener('click', () => {
        state.ingest.historyShowAll = false;
        rerenderIngestHistory();
      });
    }
  }

  // Compatibility: keep the old function name pointing to the new page
  const renderIngestPlaceholder = renderIngestPage;

  function renderNotFound(path) {
    return `
      <div style="padding:40px; max-width:600px; margin:60px auto; text-align:center;">
        <h2 style="color:var(--text-2);">Not found</h2>
        <p style="color:var(--text-3);">Unknown route: <code>${escapeHtml(String(path || ''))}</code></p>
        <p><a href="#/" style="color:var(--dusk);">← Back to Executive Summary</a></p>
      </div>
    `;
  }

  function placeholderCard(title, message, bullets) {
    const bulletHtml = bullets && bullets.length
      ? `<ul style="margin:16px 0 0; padding-left:20px; color:var(--text-2); line-height:1.8;">${
          bullets.map(b => `<li>${b}</li>`).join('')
        }</ul>`
      : '';
    return `
      <div style="background:var(--white); border:1px solid var(--line); border-radius:8px; padding:24px; max-width:800px;">
        <div style="font-size:11px; color:var(--text-3); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:8px;">Phase 3 placeholder</div>
        <h3 style="margin:0 0 12px; color:var(--text);">${escapeHtml(title)}</h3>
        <p style="margin:0; color:var(--text-2); line-height:1.6;">${message}</p>
        ${bulletHtml}
      </div>
    `;
  }

  // ============================================================
  // BOOT
  // ============================================================

  async function boot() {
    try {
      state.payload = await loadPayload();
    } catch (err) {
      return; // Error already surfaced
    }

    // Merge user-added years (e.g. 2026) into meta.years FIRST so that
    // any per-year overrides applied below can target them.
    Storage.applyAddedYears(state.payload);

    // Merge any user-saved overrides on top of the payload baseline
    Storage.applyOverrides(state.payload);

    // Initialize year from payload meta
    state.year = state.payload.meta.current_year;

    // Build static UI from payload
    buildSidebar();
    buildYearSelector();
    wireExportButton();

    // Wire router and trigger initial render (which also wires tables)
    window.addEventListener('hashchange', onRouteChange);
    onRouteChange();
  }

  // Kick off
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();