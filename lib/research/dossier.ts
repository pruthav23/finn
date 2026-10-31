import { company } from "../sources/screener";
import { pool } from "../http";
import { usage } from "../llm/gemini";
import { fundamentals, type Fundamentals } from "./fundamentals";
import { extractAnnualReport, extractCall, type BusinessExtract, type CallExtract } from "./documents";
import { synthesize, type Synthesis } from "./synthesis";

export type Dossier = {
  symbol: string;
  generatedAt: string;
  fundamentals: Fundamentals;
  business: BusinessExtract | null;
  calls: CallExtract[];
  synthesis: Synthesis | null;
  sources: { id: string; label: string; url: string }[];
  errors: string[];
  cost?: { calls: number; inTokens: number; outTokens: number };
};

/** The last N distinct calls that have a transcript, newest first. */
export function pickTranscripts(f: Fundamentals, n = 4) {
  const seen = new Set<string>();
  const out: { label: string; url: string }[] = [];
  for (const c of f.documents.concalls) {
    if (!c.transcript || seen.has(c.label)) continue;
    seen.add(c.label);
    out.push({ label: c.label, url: c.transcript });
    if (out.length === n) break;
  }
  return out;
}

export function sourcesOf(f: Fundamentals, calls: CallExtract[], ar: BusinessExtract | null) {
  return [
    { id: "FIN", label: `Reported financials (${f.basis}) via screener.in`, url: f.screenerUrl },
    ...(ar ? [{ id: "AR", label: `Annual report FY${ar.year}`, url: ar.url }] : []),
    ...calls.map((c) => ({ id: c.id, label: `${c.quarter} earnings call transcript`, url: c.url })),
  ];
}

/** Full pipeline in one process (used by the precompute script; the web app runs the same stages separately). */
export async function buildDossier(symbol: string, log = console.log): Promise<Dossier> {
  const errors: string[] = [];
  const f = fundamentals(await company(symbol));
  log(`${symbol}: fundamentals ok (${f.quarterly.cols.length} quarters)`);
  const ts = pickTranscripts(f);
  const calls = (
    await pool(ts, 2, async (t, i) => {
      try { return await extractCall(t.url, `C${i + 1}`, f.name); }
      catch (e) { errors.push(`call ${t.label}: ${String(e).slice(0, 140)}`); return null; }
    })
  ).filter(Boolean) as CallExtract[];
  log(`${symbol}: ${calls.length}/${ts.length} transcripts`);
  let business: BusinessExtract | null = null;
  const ar = f.documents.annualReports[0];
  if (ar) {
    try { business = await extractAnnualReport(ar.url, ar.year, f.name); }
    catch (e) { errors.push(`annual report: ${String(e).slice(0, 140)}`); }
  }
  log(`${symbol}: annual report ${business ? "ok" : "skipped"}`);
  let synthesis: Synthesis | null = null;
  try { synthesis = await synthesize(f, calls, business); }
  catch (e) { errors.push(`synthesis: ${String(e).slice(0, 140)}`); }
  return {
    symbol: f.symbol, generatedAt: new Date().toISOString(), fundamentals: f, business, calls, synthesis,
    sources: sourcesOf(f, calls, business), errors,
    cost: { calls: usage.calls, inTokens: usage.inTokens, outTokens: usage.outTokens },
  };
}
