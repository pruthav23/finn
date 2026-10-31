import { generate } from "../llm/gemini";
import { fetchPdf } from "../sources/bse";
import { pdfPages, selectPages } from "../pdf";

// Map step: cheap model reads each primary document once and returns structured facts.
// The expensive model never sees raw transcripts — only these extracts.

export type CallExtract = {
  id: string; // C1 = most recent
  url: string;
  quarter: string; // "Q2 FY27"
  guidance: { metric: string; statement: string; target: string | null; horizon: string | null; quote: string; speaker: string | null }[];
  growthCommentary: string[];
  pushback: { topic: string; question: string; answer: string }[];
  tone: "confident" | "cautious" | "defensive" | "mixed";
  error?: string;
};

const CALL_SCHEMA = {
  type: "object",
  properties: {
    quarter: { type: "string", description: "fiscal quarter the call discusses, Indian FY convention, e.g. 'Q2 FY27' (Jul-Sep 2026)" },
    guidance: {
      type: "array",
      description: "Every explicit forward-looking target management gave: growth, margins, capex, volumes, order book, store/plant additions. Not vague hopes.",
      items: {
        type: "object",
        properties: {
          metric: { type: "string", description: "short: 'Revenue growth', 'EBITDA margin', 'Capex', 'Order inflow'…" },
          statement: { type: "string", description: "what was promised, max 20 words" },
          target: { type: "string", nullable: true, description: "the number/range, e.g. '18-20%', '₹1,200 cr'" },
          horizon: { type: "string", nullable: true, description: "e.g. 'FY27', 'next 2-3 years', 'H2'" },
          quote: { type: "string", description: "verbatim supporting words from the transcript, max 30 words" },
          speaker: { type: "string", nullable: true },
        },
        required: ["metric", "statement", "quote"],
      },
    },
    growth_commentary: { type: "array", items: { type: "string" }, description: "max 4 short lines: how management explained this quarter's performance" },
    pushback: {
      type: "array",
      description: "max 3 topics analysts pressed hardest on",
      items: { type: "object", properties: { topic: { type: "string" }, question: { type: "string" }, answer: { type: "string" } }, required: ["topic", "question", "answer"] },
    },
    tone: { type: "string", enum: ["confident", "cautious", "defensive", "mixed"] },
  },
  required: ["quarter", "guidance", "growth_commentary", "pushback", "tone"],
};

export async function extractCall(url: string, id: string, company: string): Promise<CallExtract> {
  const pages = await pdfPages(await fetchPdf(url), 80);
  const text = pages.join("\n\n").slice(0, 180_000);
  if (text.length < 2000) throw new Error("transcript has no extractable text (scanned?)");
  const r = await generate<any>({
    tier: "lite",
    system: `You extract facts from an earnings-call transcript of ${company}. Use only the transcript. Quotes must be verbatim. Be terse.`,
    parts: [{ text }],
    schema: CALL_SCHEMA,
    cacheKey: `call:${url}`,
    temperature: 0,
  });
  return { id, url, quarter: r.quarter, guidance: r.guidance ?? [], growthCommentary: r.growth_commentary ?? [], pushback: r.pushback ?? [], tone: r.tone };
}

export type BusinessExtract = {
  year: number;
  url: string;
  pages: number[];
  whatItDoes: string;
  segments: { name: string; share: number | null; comment: string }[];
  geography: string | null;
  scale: string[]; // capacity, stores, customers, employees…
  risks: string[];
};

export async function extractAnnualReport(url: string, year: number, company: string): Promise<BusinessExtract> {
  const all = await pdfPages(await fetchPdf(url), 160);
  const { text, pages } = selectPages(
    all,
    [/segment/, /revenue/, /business overview/, /management discussion/, /our (business|products|brands|customers)/, /capacity/, /market share/, /geograph/, /risk/],
    22_000,
  );
  if (!text) throw new Error("annual report has no extractable text");
  const r = await generate<any>({
    tier: "lite",
    system: `You read selected pages of ${company}'s FY${year} annual report. Use only these pages. Be terse and concrete (numbers over adjectives).`,
    parts: [{ text }],
    schema: {
      type: "object",
      properties: {
        what_it_does: { type: "string", description: "2 sentences, plain English" },
        segments: {
          type: "array",
          items: { type: "object", properties: { name: { type: "string" }, revenue_share_pct: { type: "number", nullable: true }, comment: { type: "string", description: "max 14 words" } }, required: ["name", "comment"] },
        },
        geography: { type: "string", nullable: true, description: "domestic vs export mix if stated" },
        scale: { type: "array", items: { type: "string" }, description: "max 4 hard facts on scale: capacity, stores, customers, employees" },
        risks: { type: "array", items: { type: "string" }, description: "max 4 risks management itself flags, max 12 words each" },
      },
      required: ["what_it_does", "segments", "scale", "risks"],
    },
    cacheKey: `ar:${url}`,
    temperature: 0,
  });
  return { year, url, pages, whatItDoes: r.what_it_does, segments: (r.segments ?? []).map((s: any) => ({ name: s.name, share: s.revenue_share_pct ?? null, comment: s.comment })), geography: r.geography ?? null, scale: r.scale ?? [], risks: r.risks ?? [] };
}
