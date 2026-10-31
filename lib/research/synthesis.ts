import { generate } from "../llm/gemini";
import type { Fundamentals } from "./fundamentals";
import type { BusinessExtract, CallExtract } from "./documents";

// Reduce step: one call to the stronger model, fed only compact extracts + reported numbers.
// It has to cite a source id for every point, and is told to say "not in sources" rather than recall.

export type Synthesis = {
  take: string;
  promises: { said: string; quarter: string; metric: string; promise: string; delivered: string; verdict: "delivered" | "missed" | "partial" | "pending"; source: string }[];
  narrative: { claim: string; numbers: string; verdict: "agrees" | "diverges" | "unclear"; sources: string[] }[];
  guidance: { metric: string; latest: string; horizon: string | null; change: "raised" | "maintained" | "lowered" | "new" | "dropped"; source: string }[];
  bull: { point: string; sources: string[] }[];
  bear: { point: string; sources: string[] }[];
  watch: string[];
};

const S = { type: "string" } as const;
const SCHEMA = {
  type: "object",
  properties: {
    take: { type: "string", description: "2 sentences: the single most important thing an investor should understand right now. Analytical, not promotional." },
    promises: {
      type: "array",
      description: "Promise vs delivery over the calls provided: what management guided, and what the reported numbers in later quarters show. 4-8 rows, most decision-relevant first.",
      items: {
        type: "object",
        properties: {
          said: { ...S, description: "call id where it was said, e.g. C3" },
          quarter: { ...S, description: "quarter of that call, e.g. Q3 FY26" },
          metric: S,
          promise: { ...S, description: "max 14 words" },
          delivered: { ...S, description: "what the numbers show, with figures, max 16 words; 'too early' if not yet reportable" },
          verdict: { type: "string", enum: ["delivered", "missed", "partial", "pending"] },
          source: { ...S, description: "ids backing the delivered column, e.g. 'FIN' or 'C1'" },
        },
        required: ["said", "quarter", "metric", "promise", "delivered", "verdict", "source"],
      },
    },
    narrative: {
      type: "array",
      description: "3-4 places where management's story and the numbers agree or diverge",
      items: {
        type: "object",
        properties: { claim: { ...S, description: "management's claim, max 16 words" }, numbers: { ...S, description: "what the numbers say, max 18 words" }, verdict: { type: "string", enum: ["agrees", "diverges", "unclear"] }, sources: { type: "array", items: S } },
        required: ["claim", "numbers", "verdict", "sources"],
      },
    },
    guidance: {
      type: "array",
      description: "current explicit guidance from the most recent calls, and how it moved vs earlier calls",
      items: {
        type: "object",
        properties: { metric: S, latest: S, horizon: { type: "string", nullable: true }, change: { type: "string", enum: ["raised", "maintained", "lowered", "new", "dropped"] }, source: S },
        required: ["metric", "latest", "change", "source"],
      },
    },
    bull: { type: "array", description: "3 points, max 22 words each", items: { type: "object", properties: { point: S, sources: { type: "array", items: S } }, required: ["point", "sources"] } },
    bear: { type: "array", description: "3 points, max 22 words each", items: { type: "object", properties: { point: S, sources: { type: "array", items: S } }, required: ["point", "sources"] } },
    watch: { type: "array", items: S, description: "2-3 specific things to check in the next results, max 14 words each" },
  },
  required: ["take", "promises", "narrative", "guidance", "bull", "bear", "watch"],
};

const SYSTEM = `You are a buy-side analyst writing for a portfolio manager. You analyse management; you do not summarise them.
Rules:
- Use ONLY the data provided. Do not use outside knowledge of this company, its peers, news, or broker views. If something is not in the data, leave it out.
- Every claim cites source ids from the provided list (FIN = reported financials, AR = annual report, C1..Cn = earnings calls, C1 = most recent).
- Judge promises against reported numbers. A promise for a period not yet reported is "pending".
- Indian fiscal year: FY27 = Apr 2026–Mar 2027; Q1 = Apr–Jun, Q2 = Jul–Sep, Q3 = Oct–Dec, Q4 = Jan–Mar. Screener column "Sep 2026" = Q2 FY27.
- Short, specific, numeric. No adjectives like "robust", "strong", "impressive".`;

export async function synthesize(f: Fundamentals, calls: CallExtract[], ar: BusinessExtract | null): Promise<Synthesis> {
  const q = f.quarterly;
  const fin = {
    basis: f.basis,
    quarterly: q.cols.map((c, i) => ({ q: c, revenue: q.revenue[i], revYoY: q.revYoY[i], opm: q.opm[i], pat: q.pat[i], patYoY: q.patYoY[i] })),
    annual: f.annual.cols.map((c, i) => ({ fy: c, revenue: f.annual.revenue[i], opm: f.annual.opm[i], pat: f.annual.pat[i] })).slice(-5),
    cagr: f.cagr,
    debtToEquity: f.balance.cols.map((c, i) => ({ c, de: f.balance.de[i] })).slice(-4),
    cashConversion5y: f.cash.conversion5y,
    cfo: f.cash.cols.map((c, i) => ({ c, cfo: f.cash.cfo[i], pat: f.cash.pat[i] })).slice(-4),
    efficiency: f.efficiency,
    ratios: f.ratios,
    computedFlags: f.flags.map((x) => x.text),
  };
  const callsOut = calls.map((c) => ({ id: c.id, quarter: c.quarter, tone: c.tone, guidance: c.guidance, commentary: c.growthCommentary, analystPushback: c.pushback }));
  const payload = {
    company: f.name,
    sources: ["FIN: reported financials (₹ crore)", ...(ar ? [`AR: FY${ar.year} annual report`] : []), ...calls.map((c) => `${c.id}: ${c.quarter} earnings call`)],
    FIN: fin,
    AR: ar && { whatItDoes: ar.whatItDoes, segments: ar.segments, geography: ar.geography, scale: ar.scale, risks: ar.risks },
    calls: callsOut,
  };
  return generate<Synthesis>({
    tier: calls.length ? "smart" : "lite",
    system: SYSTEM,
    parts: [{ text: JSON.stringify(payload) }],
    schema: SCHEMA,
    temperature: 0.2,
  });
}
