import { NextResponse } from "next/server";
import { company } from "@/lib/sources/screener";
import { fundamentals, type Fundamentals } from "@/lib/research/fundamentals";
import { extractAnnualReport, extractCall, type BusinessExtract, type CallExtract } from "@/lib/research/documents";
import { synthesize } from "@/lib/research/synthesis";
import { pickTranscripts } from "@/lib/research/dossier";
import { get } from "@/lib/http";

// Live research runs as separate stages so each fits a serverless time budget and
// the client can show the investor exactly what FINN is reading, as it reads it.
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  try {
    switch (body.stage) {
      case "search": {
        // name → symbol, so the investor can type "asian paints" (or say it)
        const q = String(body.q || "").trim().slice(0, 60);
        if (q.length < 2) return NextResponse.json([]);
        const r = await get(`https://www.screener.in/api/company/search/?q=${encodeURIComponent(q)}&v=3`, { headers: { Accept: "application/json" } });
        const j: { name: string; url: string }[] = r.ok ? await r.json() : [];
        return NextResponse.json(
          j.map((x) => ({ name: x.name, symbol: decodeURIComponent(x.url.split("/")[2] ?? "") }))
            .filter((x) => x.symbol).slice(0, 6),
        );
      }
      case "base": {
        const symbol = String(body.symbol || "").toUpperCase().replace(/\.(NS|BO)$/, "").trim();
        if (!/^[A-Z0-9&-]{1,20}$/.test(symbol)) return err("Enter an NSE symbol like TCS or ASIANPAINT", 400);
        const f = fundamentals(await company(symbol));
        const ar = f.documents.annualReports[0] ?? null;
        return NextResponse.json({ fundamentals: f, transcripts: pickTranscripts(f), annualReport: ar });
      }
      case "call": {
        const c: CallExtract = await extractCall(body.url, body.id, body.name);
        return NextResponse.json(c);
      }
      case "annual": {
        const b: BusinessExtract = await extractAnnualReport(body.url, body.year, body.name);
        return NextResponse.json(b);
      }
      case "synth": {
        const s = await synthesize(body.fundamentals as Fundamentals, body.calls ?? [], body.business ?? null);
        return NextResponse.json(s);
      }
      default:
        return err("unknown stage", 400);
    }
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    return err(/Unknown symbol/.test(msg) ? msg : `FINN couldn't finish this step: ${msg.slice(0, 200)}`, /Unknown symbol/.test(msg) ? 404 : 502);
  }
}

const err = (error: string, status: number) => NextResponse.json({ error }, { status });
