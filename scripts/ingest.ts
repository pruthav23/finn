// Daily push job (GitHub Actions cron, or `npm run ingest` locally).
// Writes public/data/digest.json, which the app reads. Git is the database:
// every run is a commit, so the history of what FINN told you is auditable.
import { promises as fs } from "node:fs";
import { buildDigest } from "../lib/push/digest";

const windowDays = Number(process.argv[2] ?? 30);
const t0 = Date.now();
const d = await buildDigest({ windowDays });
if (!d.quotes.length && !d.items.length) {
  console.error("All sources failed; keeping the previous digest.\n" + d.errors.join("\n"));
  process.exit(1);
}
await fs.mkdir("public/data", { recursive: true });
await fs.writeFile("public/data/digest.json", JSON.stringify(d));
const tiers = d.items.reduce((m, i) => ((m[i.tier] = (m[i.tier] ?? 0) + 1), m), {} as Record<string, number>);
console.log(
  `\ndigest: ${d.items.length} items ${JSON.stringify(tiers)} · ${d.quotes.length} quotes · ` +
  `${d.cost.calls} LLM calls (${d.cost.cached} cached) · ${d.cost.inTokens + d.cost.outTokens} tokens · ${((Date.now() - t0) / 1000).toFixed(0)}s`,
);
if (d.errors.length) console.log(`errors (${d.errors.length}):\n  ${d.errors.join("\n  ")}`);
