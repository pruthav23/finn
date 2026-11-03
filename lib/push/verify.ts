import type { Table } from "../sources/screener";

// Results numbers are checked against screener.in's independently compiled
// quarterly table: every column (this quarter, last quarter, a year ago) and
// every line it publishes (revenue, PBT, net profit), not just this quarter's
// revenue. Period labels come from the column the numbers matched, never from
// the model, which misreads them (a Sep 2026 table labelled "Q2 FY25").

const QEND = ["Jun", "Sep", "Dec", "Mar"] as const;

/** "Q2 FY27" → "Sep 2026" (screener's column header). */
export function screenerCol(q: string): string | null {
  const m = q.match(/^Q([1-4]) FY(\d\d)$/);
  if (!m) return null;
  const n = +m[1], fy = 2000 + +m[2];
  return `${QEND[n - 1]} ${n === 4 ? fy : fy - 1}`;
}

/** "Sep 2026" → "Q2 FY27". */
export function quarterOfCol(col: string): string | null {
  const m = col.match(/^(Jun|Sep|Dec|Mar) (\d{4})$/);
  if (!m) return null;
  const n = QEND.indexOf(m[1] as (typeof QEND)[number]) + 1, y = +m[2];
  return `Q${n} FY${String((n === 4 ? y : y + 1) % 100).padStart(2, "0")}`;
}

/** The quarter n quarters before q. */
export function shiftQuarter(q: string, n: number): string {
  const m = q.match(/^Q([1-4]) FY(\d\d)$/);
  if (!m) return q;
  let idx = (2000 + +m[2]) * 4 + (+m[1] - 1) - n;
  return `Q${(idx % 4) + 1} FY${String(Math.floor(idx / 4) % 100).padStart(2, "0")}`;
}

/** The last quarter that had ended before a filing date: what a results filing reports. */
export function quarterBefore(iso: string): string {
  const d = new Date(iso);
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1; // 1-12
  // Quarter ends: Jun 30, Sep 30, Dec 31, Mar 31. A filing on Oct 28 reports the Sep quarter.
  const endMonth = m >= 10 ? 9 : m >= 7 ? 6 : m >= 4 ? 3 : 12;
  const endYear = m >= 4 ? y : y - 1;
  return quarterOfCol(`${({ 3: "Mar", 6: "Jun", 9: "Sep", 12: "Dec" } as Record<number, string>)[endMonth]} ${endYear}`)!;
}

export type Screener = { quarters: Table };

function col(t: Table, q: string): number {
  const c = screenerCol(q);
  return c ? t.cols.indexOf(c) : -1;
}

function line(t: Table, names: string[], q: string): number | null {
  const i = col(t, q);
  if (i < 0) return null;
  for (const n of names) {
    const r = t.rows[n];
    if (r && r[i] != null) return r[i]!;
  }
  return null;
}

const near = (a: number | null | undefined, b: number | null, tol: number) =>
  a != null && b != null && (b === 0 ? Math.abs(a) < 1 : Math.abs(a / b - 1) <= tol);

/**
 * Find the quarter and unit factor at which the extracted revenue matches screener.
 * Tries the quarter the filing date implies first, then the model's own label,
 * then screener's last four columns.
 */
export function anchor(
  t: Table,
  revenue: number | null,
  candidates: string[],
  factors: number[],
): { quarter: string; factor: number } | null {
  if (revenue == null) return null;
  const tail = t.cols.slice(-4).map(quarterOfCol).filter(Boolean) as string[];
  const qs = [...new Set([...candidates, ...tail.reverse()])];
  for (const q of qs)
    for (const f of factors) {
      const ref = line(t, ["Sales", "Revenue"], q);
      if (near(revenue * f, ref, 0.02)) return { quarter: q, factor: f };
    }
  return null;
}

export type Check = { metric: string; period: string; card: number | null; screener: number | null; ok: boolean | null };

/**
 * Compare a card's figures with screener, line by line and column by column.
 * `pat` carries both definitions: screener's consolidated "Net Profit" is profit
 * for the period (including minority interest); cards show profit to owners.
 */
export function crossCheck(
  t: Table,
  periods: { cur: string; prevQ: string; yoyQ: string },
  v: {
    revenue: (number | null)[];
    pbt: (number | null)[];
    patOwners: (number | null)[];
    patTotal: (number | null)[];
    nii?: (number | null)[];
  },
): Check[] {
  const out: Check[] = [];
  const ps = [periods.cur, periods.prevQ, periods.yoyQ];
  ps.forEach((q, k) => {
    const rev = line(t, ["Sales", "Revenue"], q);
    out.push({ metric: "revenue", period: q, card: v.revenue[k], screener: rev, ok: rev == null || v.revenue[k] == null ? null : near(v.revenue[k], rev, 0.02) });
    const pbt = line(t, ["Profit before tax"], q);
    out.push({ metric: "PBT", period: q, card: v.pbt[k], screener: pbt, ok: pbt == null || v.pbt[k] == null ? null : near(v.pbt[k], pbt, 0.03) });
    const np = line(t, ["Net Profit"], q);
    const mine = v.patTotal[k] ?? v.patOwners[k];
    out.push({
      metric: "net profit", period: q, card: mine, screener: np,
      ok: np == null || mine == null ? null : near(v.patTotal[k], np, 0.03) || near(v.patOwners[k], np, 0.03),
    });
    if (v.nii) {
      const rv = line(t, ["Revenue"], q), int = line(t, ["Interest"], q);
      const ref = rv != null && int != null ? Math.round((rv - int) * 100) / 100 : null;
      out.push({ metric: "NII", period: q, card: v.nii[k], screener: ref, ok: ref == null || v.nii[k] == null ? null : near(v.nii[k], ref, 0.03) });
    }
  });
  return out;
}

/** Screener's operating profit (sales − operating expenses), comparable to derived EBITDA. */
export const screenerOperatingProfit = (t: Table, q: string) => line(t, ["Operating Profit", "Financing Profit"], q);

const fmt = (n: number | null) => (n == null ? "–" : new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(n));

/** One plain sentence per mismatch, for the card's notes. */
export function mismatchNotes(checks: Check[]): string[] {
  return checks
    .filter((c) => c.ok === false)
    .map((c) => `Screener has ${c.metric} for ${c.period} at ₹${fmt(c.screener)} cr; the filing as read gives ₹${fmt(c.card)} cr.`);
}

/** A compact line for the run log: "revenue ✓✓✓ PBT ✓✗✓ net profit ✓✓–". */
export function auditLine(checks: Check[]): string {
  const by = new Map<string, Check[]>();
  for (const c of checks) by.set(c.metric, [...(by.get(c.metric) ?? []), c]);
  return [...by.entries()]
    .map(([m, cs]) => `${m} ${cs.map((c) => (c.ok === true ? "✓" : c.ok === false ? `✗(${fmt(c.card)} vs ${fmt(c.screener)})` : "–")).join("")}`)
    .join("  ");
}
