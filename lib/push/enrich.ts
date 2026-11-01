import { generate, pdfPart, looseJson } from "../llm/gemini";
import { fetchPdf } from "../sources/bse";
import { pdfPages } from "../pdf";
import { CATEGORIES, KMP, type Category } from "./taxonomy";
import type { PersonCard, ResultsCard } from "../types";

// ---------- 1. Batch triage: one cheap call scores a whole window of headlines ----------

export type TriageIn = { i: number; company: string; category: Category; text: string };
export type TriageOut = { i: number; materiality: number; why: string | null; category?: string };

const TRIAGE_SYSTEM = `You triage Indian stock-exchange filings for a long-only fundamental investor who holds these stocks.
For each filing return materiality 0-100: how likely it changes the investment view or moves the stock.
Calibrate: quarterly results 80-95; acquisitions/mergers 60-90 by size; CEO/CFO/MD change 70-85, independent director 20-35;
large order wins with a stated value 45-70, generic press releases 15-35; regulatory penalties scale with amount;
credit downgrades 60+, reaffirmations 15; schedules of investor meetings, intimations, compliance paperwork 0-10.
"why" = one plain sentence (max 16 words) on why a holder should care, SPECIFIC to this filing (amounts, counterparties, direction).
Never generic lines like "results impact valuation" or "leadership changes affect strategy" — if the headline gives nothing specific, return null. No hype, no advice.`;

export async function triage(batch: TriageIn[]): Promise<Map<number, TriageOut>> {
  const out = new Map<number, TriageOut>();
  for (let s = 0; s < batch.length; s += 60) {
    const chunk = batch.slice(s, s + 60);
    const res = await generate<{ items: TriageOut[] }>({
      tier: "lite",
      system: TRIAGE_SYSTEM,
      parts: [{ text: chunk.map((b) => `#${b.i} [${b.company}] (${b.category}) ${b.text}`).join("\n") }],
      schema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: { i: { type: "integer" }, category: { type: "string", enum: [...CATEGORIES], description: "correct category if the given one is wrong, else repeat it" }, materiality: { type: "integer" }, why: { type: "string", nullable: true } },
              required: ["i", "materiality"],
            },
          },
        },
        required: ["items"],
      },
    });
    for (const r of res.items) out.set(r.i, r);
  }
  return out;
}

// ---------- 2. Results: read the actual results PDF, extract numbers, compute deltas in code ----------

type RawResults = {
  found: boolean;
  basis: "consolidated" | "standalone";
  unit: string;
  financial_company: boolean;
  period_labels: { current: string; previous_quarter: string; year_ago_quarter: string };
  revenue_from_operations: number[];
  other_income: number[];
  finance_costs: number[];
  depreciation: number[];
  profit_before_tax: number[];
  profit_after_tax: number[];
  net_interest_income: number[];
  operating_profit_before_provisions: number[];
  exceptional_items_note: string | null;
};

const triple = { type: "array", items: { type: "number", nullable: true }, description: "[current quarter, previous quarter, same quarter last year]" };

const RESULTS_SCHEMA = {
  type: "object",
  properties: {
    found: { type: "boolean", description: "false if this PDF contains no quarterly results table" },
    basis: { type: "string", enum: ["consolidated", "standalone"] },
    unit: { type: "string", description: "unit stated in the table header, e.g. '₹ crore', '₹ lakh', '₹ million'" },
    financial_company: { type: "boolean", description: "true for banks/NBFCs/insurers" },
    period_labels: {
      type: "object",
      properties: { current: { type: "string" }, previous_quarter: { type: "string" }, year_ago_quarter: { type: "string" } },
      required: ["current", "previous_quarter", "year_ago_quarter"],
    },
    revenue_from_operations: triple,
    other_income: triple,
    finance_costs: triple,
    depreciation: triple,
    profit_before_tax: triple,
    profit_after_tax: { ...triple, description: "net profit attributable to owners if shown, else total net profit. [cur, prevQ, yoyQ]" },
    net_interest_income: { ...triple, description: "banks/NBFCs only: interest earned minus interest expended" },
    operating_profit_before_provisions: { ...triple, description: "banks/NBFCs only" },
    exceptional_items_note: { type: "string", nullable: true },
  },
  required: ["found", "basis", "unit", "financial_company", "period_labels", "revenue_from_operations", "profit_before_tax", "profit_after_tax"],
};

function toCrore(unit: string): number {
  const u = unit.toLowerCase();
  if (/lakh|lac/.test(u)) return 1 / 100;
  if (/million|mn/.test(u)) return 1 / 10;
  if (/billion|bn/.test(u)) return 100;
  if (/thousand|'000/.test(u)) return 1 / 10000;
  return 1; // crore
}

const pct = (a: number | null, b: number | null) => (a == null || b == null || b === 0 ? null : Math.round(((a - b) / Math.abs(b)) * 1000) / 10);

/** "30.09.2026" / "September 30, 2026" / "30 Sep 26" → "Q2 FY27" (Indian fiscal year). */
export function quarterLabel(s: string): string {
  const M: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  let m: number | undefined, y: number | undefined;
  const num = s.match(/(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})/);
  if (num) { m = +num[2]; y = +num[3]; }
  else {
    const w = s.toLowerCase().match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[^0-9]*(?:\d{1,2}(?:st|nd|rd|th)?,?\s*)?(\d{2,4})/);
    if (w) { m = M[w[1]]; y = +w[2]; }
  }
  if (!m || !y) return s;
  if (y < 100) y += 2000;
  const q = m <= 3 ? 4 : m <= 6 ? 1 : m <= 9 ? 2 : 3;
  const fy = (m <= 3 ? y : y + 1) % 100;
  return `Q${q} FY${String(fy).padStart(2, "0")}`;
}

export async function results(pdfUrl: string, opts: { financial?: boolean; refRevenue?: number | null; refBasis?: string | null } = {}): Promise<ResultsCard | null> {
  const bytes = await fetchPdf(pdfUrl);
  let parts;
  if (bytes.length < 15_000_000) {
    parts = [pdfPart(bytes), { text: `Extract the quarterly results table. Prefer CONSOLIDATED if present.${opts.financial ? " This is a bank/NBFC: fill net_interest_income and operating_profit_before_provisions; revenue_from_operations = total income / interest earned." : ""}` }];
  } else {
    const pages = await pdfPages(bytes, 25);
    parts = [{ text: `Results filing text:\n${pages.join("\n\n").slice(0, 120_000)}\n\nExtract the quarterly results table. Prefer CONSOLIDATED.` }];
  }
  const r = await generate<RawResults>({
    tier: "smart",
    system: "You read Indian listed-company quarterly results filings and copy numbers exactly as printed. Never compute or estimate; use null when a figure is absent. Negative numbers (losses) must be negative.",
    parts,
    schema: RESULTS_SCHEMA,
    cacheKey: `results:${pdfUrl}${opts.financial ? ":fin" : ""}`,
    temperature: 0,
  });
  if (!r.found || !r.revenue_from_operations?.length) return null;

  let k = toCrore(r.unit);
  // Unit slips (₹ million read as crore, lakh as crore…) are the commonest extraction error.
  // screener's independently compiled quarterly revenue tells us the true scale.
  let verified: boolean | undefined;
  const raw0 = r.revenue_from_operations?.[0];
  if (opts.refRevenue && raw0) {
    const basisOk = !opts.refBasis || opts.refBasis === r.basis;
    for (const kk of [k, 1, 0.1, 0.01, 1e-4, 1e-5, 10, 100]) {
      const ratio = (raw0 * kk) / opts.refRevenue;
      if (Math.abs(ratio - 1) < 0.03) { k = kk; verified = basisOk; break; }
    }
  }
  const financial = opts.financial || r.financial_company;
  const v = (a?: (number | null)[]) => [0, 1, 2].map((i) => (a?.[i] == null ? null : Math.round((a[i] as number) * k * 100) / 100));
  const row = (label: string, a: (number | null)[], derived = false) => ({
    label, cur: a[0], prevQ: a[1], yoyQ: a[2], qoq: pct(a[0], a[1]), yoy: pct(a[0], a[2]), derived,
  });

  const rev = v(r.revenue_from_operations), pbt = v(r.profit_before_tax), pat = v(r.profit_after_tax);
  const rows: ResultsCard["rows"] = [];
  if (financial) {
    // Banks don't have EBITDA; the comparable lines are NII and pre-provision operating profit.
    if (r.net_interest_income?.some((x) => x != null)) rows.push(row("Net interest income", v(r.net_interest_income)));
    else rows.push(row("Total income", rev));
    if (r.operating_profit_before_provisions?.some((x) => x != null)) rows.push(row("Pre-provision op. profit", v(r.operating_profit_before_provisions)));
    rows.push(row("PBT", pbt), row("PAT", pat));
  } else {
    // EBITDA isn't printed in Indian results; derive the operating version:
    // PBT + finance costs + depreciation − other income.
    const fc = v(r.finance_costs), dep = v(r.depreciation), oi = v(r.other_income);
    const ebitda = [0, 1, 2].map((i) =>
      pbt[i] == null || fc[i] == null || dep[i] == null ? null : Math.round((pbt[i]! + fc[i]! + dep[i]! - (oi[i] ?? 0)) * 100) / 100,
    );
    rows.push(row("Revenue", rev), row("EBITDA", ebitda, true), row("PBT", pbt), row("PAT", pat));
  }
  const e = rows.find((x) => x.label === "EBITDA");
  const marginNote =
    e && rev[0] && rev[2] && e.cur != null && e.yoyQ != null
      ? `EBITDA margin ${((e.cur / rev[0]) * 100).toFixed(1)}% vs ${((e.yoyQ / rev[2]) * 100).toFixed(1)}% a year ago`
      : undefined;
  return {
    kind: "results",
    basis: r.basis,
    periods: { cur: quarterLabel(r.period_labels.current), prevQ: quarterLabel(r.period_labels.previous_quarter), yoyQ: quarterLabel(r.period_labels.year_ago_quarter) },
    financial,
    verified,
    rows,
    marginNote,
    notes: r.exceptional_items_note ? [r.exceptional_items_note] : [],
  };
}

// ---------- 3. Management change: who is it, and where did they come from ----------

type RawChanges = { changes: { person: string; role: string; action: PersonCard["changes"][number]["action"]; effective: string | null; reason: string | null; profile_in_filing: string | null }[] };

export async function management(pdfUrl: string, company: string, headline: string): Promise<PersonCard | null> {
  let text = headline;
  try {
    const pages = await pdfPages(await fetchPdf(pdfUrl), 8);
    text = pages.join("\n\n").slice(0, 40_000);
  } catch {}
  const r = await generate<RawChanges>({
    tier: "lite",
    system: "Extract every management/board change in this Indian exchange filing. Copy names exactly. profile_in_filing = the brief profile/experience paragraph the filing gives for the person (verbatim-ish, max 60 words), else null.",
    parts: [{ text: `Company: ${company}\nHeadline: ${headline}\n\n${text}` }],
    schema: {
      type: "object",
      properties: {
        changes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              person: { type: "string" },
              role: { type: "string" },
              action: { type: "string", enum: ["appointed", "resigned", "retired", "re-appointed", "ceased", "redesignated", "other"] },
              effective: { type: "string", nullable: true },
              reason: { type: "string", nullable: true },
              profile_in_filing: { type: "string", nullable: true },
            },
            required: ["person", "role", "action"],
          },
        },
      },
      required: ["changes"],
    },
    cacheKey: `mgmt:${pdfUrl}`,
  });
  if (!r.changes?.length) return null;

  const changes: PersonCard["changes"] = [];
  for (const c of r.changes.slice(0, 4)) {
    // company-level top roles only: not subsidiary heads, SVPs or functional officers
    const kmp = KMP.test(c.role) && !/vice president|\bhead\b|\bic\b|subsidiary|security|information|compliance|nominee|independent/i.test(c.role);
    let bio = c.profile_in_filing;
    let bioSources: { title: string; url: string }[] = [];
    // Push-side enrichment may use the web: look up incoming senior people.
    if ((c.action === "appointed" || c.action === "redesignated") && kmp) {
      try {
        const g = await generate<{ text: string; sources: { title: string; url: string }[] }>({
          tier: "lite",
          search: true,
          parts: [{ text: `In at most 45 words, give the professional background of ${c.person}, newly ${c.action} as ${c.role} of ${company} (India): previous employers and roles, years of experience, education. Facts only, no praise. If you cannot find reliable information, reply exactly UNKNOWN.` }],
          cacheKey: `bio:${c.person}:${company}`,
        });
        if (g.text && !/^UNKNOWN/i.test(g.text)) { bio = g.text; bioSources = g.sources.slice(0, 3); }
      } catch (e) { console.warn("bio lookup failed", c.person, String(e).slice(0, 120)); }
    }
    changes.push({
      person: c.person, role: c.role, action: c.action, effective: c.effective, reason: c.reason, kmp, bio, bioSources,
      linkedin: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${c.person} ${company}`)}`,
    });
  }
  return { kind: "management", changes };
}

// ---------- 4. Everything else worth a glance: one line, from the filing itself ----------

export async function oneLiner(pdfUrl: string | null, company: string, headline: string): Promise<string | null> {
  if (!pdfUrl) return null;
  let text: string;
  try {
    text = (await pdfPages(await fetchPdf(pdfUrl), 3)).join("\n").slice(0, 12_000);
  } catch { return null; }
  if (text.length < 80) return null; // scanned image PDF — headline stands alone
  const r = await generate<{ line: string | null }>({
    tier: "lite",
    system: "Summarise this exchange filing for an investor in ONE factual line (max 22 words). Lead with the concrete fact: amounts in ₹, counterparties, dates. No adjectives, no advice. null if it says nothing beyond the headline.",
    parts: [{ text: `${company} — ${headline}\n\n${text}` }],
    schema: { type: "object", properties: { line: { type: "string", nullable: true } }, required: ["line"] },
    cacheKey: `line:${pdfUrl}`,
  });
  return r.line;
}

/** For filings titled "Enclosed": read page 1-2 and return a real title, category and line. */
export async function readOpaque(pdfUrl: string, company: string): Promise<{ title: string; category: Category; line: string | null } | null> {
  let text: string;
  try { text = (await pdfPages(await fetchPdf(pdfUrl), 2)).join("\n").slice(0, 8000); } catch { return null; }
  if (text.length < 80) return null;
  return generate({
    tier: "lite",
    system: "You label Indian exchange filings whose title is uninformative. title = what the filing actually is, max 12 words. line = the concrete fact for an investor, max 22 words, or null if pure paperwork.",
    parts: [{ text: `${company}\n\n${text}` }],
    schema: {
      type: "object",
      properties: { title: { type: "string" }, category: { type: "string", enum: [...CATEGORIES] }, line: { type: "string", nullable: true } },
      required: ["title", "category", "line"],
    },
    cacheKey: `opaque:${pdfUrl}`,
  });
}

export { looseJson };
