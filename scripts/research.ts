// Precompute research dossiers: `npm run research -- ASIANPAINT PAYTM`
// With no args, builds the demo set. The web app computes any other ticker live.
import { promises as fs } from "node:fs";
import { RESEARCH_DEMO } from "../lib/portfolio";
import { buildDossier } from "../lib/research/dossier";

const symbols = process.argv.slice(2).length ? process.argv.slice(2) : RESEARCH_DEMO;
await fs.mkdir("public/data/research", { recursive: true });
const index: string[] = [];
for (const s of symbols) {
  try {
    const d = await buildDossier(s);
    await fs.writeFile(`public/data/research/${d.symbol}.json`, JSON.stringify(d));
    index.push(d.symbol);
    console.log(`${s}: done · ${d.calls.length} calls · synthesis ${d.synthesis ? "ok" : "missing"}${d.errors.length ? ` · errors: ${d.errors.join("; ")}` : ""}`);
  } catch (e) {
    console.error(`${s}: FAILED ${String(e).slice(0, 200)}`);
  }
}
const existing = await fs.readdir("public/data/research");
await fs.writeFile("public/data/research-index.json", JSON.stringify(existing.filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", "")).sort()));
