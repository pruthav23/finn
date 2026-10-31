import type { Company, Table } from "../sources/screener";

// Everything here is arithmetic on reported numbers — no LLM. Numbers an investor
// will act on should never be generated text.

export type Series = { label: string; cols: string[]; values: (number | null)[] };
export type Flag = { tone: "good" | "bad" | "neutral"; text: string; area: string };

export type Fundamentals = {
  symbol: string;
  name: string;
  bse: string | null;
  basis: "consolidated" | "standalone";
  financialCo: boolean;
  screenerUrl: string;
  ratios: Record<string, string>;
  quarterly: { cols: string[]; revenue: (number | null)[]; opProfit: (number | null)[]; opm: (number | null)[]; pat: (number | null)[]; revYoY: (number | null)[]; patYoY: (number | null)[] };
  annual: { cols: string[]; revenue: (number | null)[]; opm: (number | null)[]; pat: (number | null)[] };
  cagr: { rev3: number | null; rev5: number | null; pat3: number | null; pat5: number | null };
  balance: { cols: string[]; borrowings: (number | null)[]; equity: (number | null)[]; de: (number | null)[] };
  cash: { cols: string[]; cfo: (number | null)[]; fcf: (number | null)[]; pat: (number | null)[]; conversion5y: number | null };
  efficiency: { cols: string[]; rows: Record<string, (number | null)[]> };
  holding: { cols: string[]; promoter: (number | null)[]; fii: (number | null)[]; dii: (number | null)[] };
  flags: Flag[];
  documents: { annualReports: Company["annualReports"]; concalls: Company["concalls"] };
};

const pick = (t: Table, ...names: string[]) => {
  for (const n of names) {
    const k = Object.keys(t.rows).find((r) => r.toLowerCase() === n.toLowerCase());
    if (k) return t.rows[k];
  }
  return t.cols.map(() => null);
};
const r1 = (n: number) => Math.round(n * 10) / 10;
const growth = (a: (number | null)[], lag: number) => a.map((v, i) => (i < lag || v == null || a[i - lag] == null || a[i - lag] === 0 ? null : r1(((v - a[i - lag]!) / Math.abs(a[i - lag]!)) * 100)));
function cagr(a: (number | null)[], years: number): number | null {
  const end = a.at(-1), start = a.at(-1 - years);
  if (end == null || start == null || start <= 0 || end <= 0) return null;
  return r1(((end / start) ** (1 / years) - 1) * 100);
}
const lastN = <T,>(a: T[], n: number) => a.slice(Math.max(0, a.length - n));

export function fundamentals(c: Company): Fundamentals {
  const financialCo = !c.quarters.rows["Sales"] && !!(c.quarters.rows["Revenue"] || c.quarters.rows["Financing Profit"]);

  // Quarterly (last 12)
  const qN = Math.min(12, c.quarters.cols.length);
  const qRev = pick(c.quarters, "Sales", "Revenue");
  const qOp = pick(c.quarters, "Operating Profit", "Financing Profit");
  const qOpm = pick(c.quarters, "OPM %", "Financing Margin %");
  const qPat = pick(c.quarters, "Net Profit", "Profit after tax");
  const quarterly = {
    cols: lastN(c.quarters.cols, qN), revenue: lastN(qRev, qN), opProfit: lastN(qOp, qN), opm: lastN(qOpm, qN), pat: lastN(qPat, qN),
    revYoY: lastN(growth(qRev, 4), qN), patYoY: lastN(growth(qPat, 4), qN),
  };

  // Annual: drop the TTM column for CAGRs
  const fyIdx = c.pnl.cols.map((k, i) => (/^Mar|^Dec|^Jun|^Sep/.test(k) ? i : -1)).filter((i) => i >= 0);
  const fy = (a: (number | null)[]) => fyIdx.map((i) => a[i]);
  const aRev = fy(pick(c.pnl, "Sales", "Revenue")), aPat = fy(pick(c.pnl, "Net Profit", "Profit after tax")), aOpm = fy(pick(c.pnl, "OPM %", "Financing Margin %"));
  const annual = { cols: lastN(fyIdx.map((i) => c.pnl.cols[i]), 10), revenue: lastN(aRev, 10), opm: lastN(aOpm, 10), pat: lastN(aPat, 10) };

  // Balance sheet
  const eqc = pick(c.balance, "Equity Capital"), res = pick(c.balance, "Reserves"), bor = pick(c.balance, "Borrowings", "Borrowing");
  const equity = eqc.map((e, i) => (e == null || res[i] == null ? null : e + res[i]!));
  const de = bor.map((b, i) => (b == null || !equity[i] ? null : Math.round((b / equity[i]!) * 100) / 100));
  const bN = Math.min(8, c.balance.cols.length);
  const balance = { cols: lastN(c.balance.cols, bN), borrowings: lastN(bor, bN), equity: lastN(equity, bN), de: lastN(de, bN) };

  // Cash quality: match CFO to PAT by fiscal-year column
  const cfoAll = pick(c.cashflow, "Cash from Operating Activity"), fcfAll = pick(c.cashflow, "Free Cash Flow");
  const patByCol = new Map(c.pnl.cols.map((k, i) => [k, pick(c.pnl, "Net Profit", "Profit after tax")[i]]));
  const cN = Math.min(8, c.cashflow.cols.length);
  const cashCols = lastN(c.cashflow.cols, cN);
  const cash = {
    cols: cashCols, cfo: lastN(cfoAll, cN), fcf: lastN(fcfAll, cN), pat: cashCols.map((k) => patByCol.get(k) ?? null),
    conversion5y: null as number | null,
  };
  const last5 = cashCols.map((k, i) => ({ cfo: cash.cfo[i], pat: cash.pat[i] })).slice(-5).filter((x) => x.cfo != null && x.pat != null);
  const sumPat = last5.reduce((s, x) => s + x.pat!, 0);
  if (last5.length >= 3 && sumPat > 0) cash.conversion5y = Math.round((last5.reduce((s, x) => s + x.cfo!, 0) / sumPat) * 100) / 100;

  // Efficiency
  const eN = Math.min(8, c.efficiency.cols.length);
  const efficiency = { cols: lastN(c.efficiency.cols, eN), rows: Object.fromEntries(Object.entries(c.efficiency.rows).map(([k, v]) => [k, lastN(v, eN)])) };

  const hN = Math.min(8, c.shareholding.cols.length);
  const holding = {
    cols: lastN(c.shareholding.cols, hN),
    promoter: lastN(pick(c.shareholding, "Promoters"), hN), fii: lastN(pick(c.shareholding, "FIIs"), hN), dii: lastN(pick(c.shareholding, "DIIs"), hN),
  };

  const f: Fundamentals = {
    symbol: c.symbol, name: c.name, bse: c.bse, basis: c.consolidated ? "consolidated" : "standalone", financialCo,
    screenerUrl: c.url, ratios: c.ratios, quarterly, annual,
    cagr: { rev3: cagr(aRev, 3), rev5: cagr(aRev, 5), pat3: cagr(aPat, 3), pat5: cagr(aPat, 5) },
    balance, cash, efficiency, holding, flags: [],
    documents: { annualReports: c.annualReports, concalls: c.concalls },
  };
  f.flags = flags(f);
  return f;
}

function flags(f: Fundamentals): Flag[] {
  const out: Flag[] = [];
  const q = f.quarterly;
  const rY = q.revYoY.at(-1), pY = q.patYoY.at(-1);
  if (rY != null) out.push({ area: "Trajectory", tone: rY >= 12 ? "good" : rY < 0 ? "bad" : "neutral", text: `Revenue ${rY >= 0 ? "+" : ""}${rY}% YoY in ${q.cols.at(-1)}` });
  if (pY != null && rY != null && Math.abs(pY - rY) > 10)
    out.push({ area: "Trajectory", tone: pY > rY ? "good" : "bad", text: `Profit ${pY > rY ? "outgrowing" : "lagging"} revenue (${pY >= 0 ? "+" : ""}${pY}% vs ${rY >= 0 ? "+" : ""}${rY}%)` });
  const opm = q.opm.filter((x) => x != null) as number[];
  if (opm.length >= 8) {
    const recent = opm.slice(-4).reduce((a, b) => a + b, 0) / 4, prior = opm.slice(-8, -4).reduce((a, b) => a + b, 0) / 4;
    if (Math.abs(recent - prior) >= 1.5)
      out.push({ area: "Trajectory", tone: recent > prior ? "good" : "bad", text: `Margins ${recent > prior ? "expanding" : "compressing"}: ${r1(prior)}% → ${r1(recent)}% (4-qtr avg)` });
  }
  if (f.cash.conversion5y != null && !f.financialCo)
    out.push({ area: "Cash quality", tone: f.cash.conversion5y >= 0.9 ? "good" : f.cash.conversion5y < 0.7 ? "bad" : "neutral", text: `${Math.round(f.cash.conversion5y * 100)}% of 5-yr profit turned into operating cash` });
  const de = f.balance.de.filter((x) => x != null) as number[];
  if (de.length >= 2 && !f.financialCo) {
    const now = de.at(-1)!, then = de[Math.max(0, de.length - 4)];
    if (now < 0.1) out.push({ area: "Balance sheet", tone: "good", text: `Practically debt-free (D/E ${now.toFixed(2)})` });
    else if (now - then > 0.25) out.push({ area: "Balance sheet", tone: "bad", text: `Leverage rising: D/E ${then.toFixed(2)} → ${now.toFixed(2)}` });
    else if (now > 1) out.push({ area: "Balance sheet", tone: "bad", text: `High leverage: D/E ${now.toFixed(2)}` });
  }
  const ccc = f.efficiency.rows["Cash Conversion Cycle"]?.filter((x) => x != null) as number[] | undefined;
  if (ccc && ccc.length >= 3) {
    const d = ccc.at(-1)! - ccc[ccc.length - 3];
    if (Math.abs(d) >= 15) out.push({ area: "Balance sheet", tone: d > 0 ? "bad" : "good", text: `Working-capital cycle ${d > 0 ? "lengthened" : "shortened"} ${Math.abs(Math.round(d))} days in 2 yrs (now ${Math.round(ccc.at(-1)!)})` });
  }
  const p = f.holding.promoter.filter((x) => x != null) as number[];
  if (p.length >= 4) {
    const d = r1(p.at(-1)! - p[p.length - 4]);
    if (Math.abs(d) >= 1) out.push({ area: "Ownership", tone: d > 0 ? "good" : "bad", text: `Promoter holding ${d > 0 ? "up" : "down"} ${Math.abs(d)}pp over 3 quarters (${p.at(-1)}%)` });
  }
  return out;
}
