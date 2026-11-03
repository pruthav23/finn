import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { sleep } from "../http";

// Model routing:
//   lite  → bulk, schema-constrained extraction (classify filings, pull guidance from transcripts)
//   smart → the few steps that need reasoning (promise-vs-delivery, bull/bear, reading results tables)
// Every call is cached on disk by content hash, so re-running the daily job only pays for new filings.

export type Tier = "lite" | "smart";

const API = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULTS: Record<Tier, string> = {
  lite: process.env.GEMINI_MODEL_LITE || "gemini-2.5-flash-lite",
  smart: process.env.GEMINI_MODEL_SMART || "gemini-2.5-flash",
};
const resolved: Partial<Record<Tier, string>> = {};
let smartDown = false;

export const usage = { calls: 0, cached: 0, inTokens: 0, outTokens: 0, byTier: { lite: 0, smart: 0 } as Record<Tier, number> };

const CACHE_DIR = process.env.VERCEL ? "/tmp/finn-cache" : path.join(process.cwd(), "data/cache/llm");

function key() {
  const k = process.env.GEMINI_API_KEY;
  if (!k) throw new Error("GEMINI_API_KEY is not set");
  return k;
}

/** If a default model has been retired, pick the newest available one of the same class. */
async function discover(tier: Tier): Promise<string> {
  const res = await fetch(`${API}/models?pageSize=200&key=${key()}`);
  const j = await res.json();
  const names: string[] = (j.models ?? [])
    .filter((m: any) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m: any) => m.name.replace("models/", ""))
    .filter((n: string) => /^gemini-[\d.]+-flash/.test(n) && !/(image|tts|live|audio|thinking|exp)/.test(n));
  const pool = names.filter((n) => (tier === "lite" ? /flash-lite/.test(n) : !/lite/.test(n)));
  const ver = (n: string) => parseFloat(n.match(/gemini-([\d.]+)/)?.[1] ?? "0");
  pool.sort((a, b) => ver(b) - ver(a) || Number(/preview/.test(a)) - Number(/preview/.test(b)));
  if (!pool.length) throw new Error(`No Gemini ${tier} model available`);
  return pool[0];
}

export type Part = { text: string } | { inline_data: { mime_type: string; data: string } };

type Opts = {
  tier: Tier;
  system?: string;
  parts: Part[];
  schema?: object; // JSON schema (OpenAPI subset) → structured output
  search?: boolean; // Google Search grounding (push-side enrichment only)
  cacheKey?: string; // stable id for the content (e.g. a PDF URL) instead of hashing bytes
  temperature?: number;
  /** cap on attempts; grounded lookups that keep failing shouldn't hold up the run for minutes */
  maxAttempts?: number;
  /** told which tier actually answered (smart can degrade to lite mid-run) */
  onTier?: (t: Tier) => void;
};

export async function generate<T = any>(o: Opts): Promise<T> {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([o.tier, o.system, o.schema, o.search, o.cacheKey ?? o.parts]))
    .digest("hex").slice(0, 24);
  const file = path.join(CACHE_DIR, `${fingerprint}.json`);
  try {
    const hit = JSON.parse(await fs.readFile(file, "utf8"));
    usage.cached++;
    return hit as T;
  } catch {}

  const body: any = {
    contents: [{ role: "user", parts: o.parts }],
    generationConfig: { temperature: o.temperature ?? 0.2 },
  };
  if (o.system) body.systemInstruction = { parts: [{ text: o.system }] };
  if (o.search) body.tools = [{ google_search: {} }];
  else if (o.schema) {
    body.generationConfig.responseMimeType = "application/json";
    body.generationConfig.responseSchema = o.schema;
  }

  let tier: Tier = o.tier === "smart" && smartDown ? "lite" : o.tier;
  let last = 0;
  const attempts = o.maxAttempts ?? 8;
  let smartFails = 0;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const model = resolved[tier] ?? DEFAULTS[tier];
    const res = await fetch(`${API}/models/${model}:generateContent?key=${key()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 404 || res.status === 400 && (await res.clone().text()).includes("not found")) {
      resolved[tier] = await discover(tier);
      console.warn(`[gemini] ${model} unavailable → ${resolved[tier]}`);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      last = res.status;
      const t = await res.text();
      const retry = Number(t.match(/"retryDelay":\s*"(\d+)s"/)?.[1] ?? 0);
      // Smart model rate-limited (free tiers are tight), or failing repeatedly → degrade to lite for the
      // rest of this run rather than stall. A 503 ("overloaded") gets three tries first: it usually passes.
      if (tier === "smart" && (res.status === 429 || ++smartFails >= 3)) { smartDown = true; tier = "lite"; console.warn(`[gemini] smart tier ${res.status} → using lite`); continue; }
      if (attempt < attempts - 1) await sleep(Math.min(60_000, Math.max(retry * 1000, 2000 * 2 ** attempt)));
      continue;
    }
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);

    const j = await res.json();
    usage.calls++;
    usage.byTier[tier]++;
    usage.inTokens += j.usageMetadata?.promptTokenCount ?? 0;
    usage.outTokens += j.usageMetadata?.candidatesTokenCount ?? 0;
    const cand = j.candidates?.[0];
    const text: string = (cand?.content?.parts ?? []).map((p: any) => p.text ?? "").join("");
    let out: any;
    if (o.schema && !o.search) {
      out = JSON.parse(text);
    } else {
      const sources = (cand?.groundingMetadata?.groundingChunks ?? [])
        .map((c: any) => c.web && { title: c.web.title, url: c.web.uri })
        .filter(Boolean);
      out = { text: text.trim(), sources };
    }
    o.onTier?.(tier);
    // An answer from the fallback model is used, but not cached under the smart model's key:
    // the next run asks the smart model again instead of keeping the weaker answer for good.
    if (tier === o.tier) {
      await fs.mkdir(CACHE_DIR, { recursive: true }).catch(() => {});
      await fs.writeFile(file, JSON.stringify(out)).catch(() => {});
    }
    return out as T;
  }
  throw new Error(`Gemini: retries exhausted${last ? ` (last status ${last})` : ""}`);
}

export const pdfPart = (bytes: Uint8Array): Part => ({
  inline_data: { mime_type: "application/pdf", data: Buffer.from(bytes).toString("base64") },
});

/** Pull the first JSON object out of free text (used with grounded calls, which can't use schemas). */
export function looseJson<T>(text: string): T | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]) as T; } catch { return null; }
}
