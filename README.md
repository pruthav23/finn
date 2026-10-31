# FINN: your portfolio, filtered

A mobile-first investment agent for a 20-stock NSE portfolio. It **pushes** what changed and why it matters, and **pulls** research on any NSE company that is grounded only in primary filings.

> **Point of view:** an investor doesn't need another feed. They need a sieve. FINN's front page shows every filing as a dot, marks the few that matter, and puts the rest away where they can still be found. Every screen answers "should I care?" before "what happened?".

## What it does

**Brief (push, windowed digest).** Every filing across the portfolio for a window you pick (24h / 3d / week / month / since a date), in three tiers:
- **Matters**: rich cards. *Results* get a first cut of Revenue, EBITDA, PBT and PAT vs last quarter and the same quarter last year, read from the actual results PDF, with deltas computed in code and revenue cross-checked against screener's independently compiled number. *Management changes* name the person and role, with a short background from the filing's own profile annexure plus a grounded web lookup and a LinkedIn link.
- **Worth a glance**: one factual line per filing, written from the filing itself.
- **Set aside**: routine paperwork (ESOP allotments, Reg 74(5) certificates, newspaper ads), collapsed into counts.

One corporate event often arrives as 3–5 filings (outcome, results, press release, investor deck, newspaper ad). FINN folds these into one card and keeps the results statement as the lead.

**Watch (push, triggered alerts).** You set what "unusual" means: a ±X% daily move, volume ≥ N× the 20-day average, and which filing types alert you. Thresholds apply live on the device, so you can drag a slider and watch the alert list change.

**Listen.** A one-minute spoken brief, composed on the device from the same data and read by the phone's speech engine. It costs nothing in model calls and is made for the commute.

**Research (pull).** Type or say any NSE company. FINN reads:
1. **Reported financials** (screener.in's standardised statements, compiled from filings). Trajectory, margins, leverage, working-capital cycle, cash conversion and promoter holding are **computed in code**, never generated.
2. **The last four earnings-call transcripts.** A cheap model extracts every explicit commitment with a verbatim quote, plus what analysts pushed on.
3. **The latest annual report.** Pages are selected by relevance and the business snapshot comes from those pages only.
4. **Synthesis.** One call to a stronger model, fed only the extracts above, produces **promised vs delivered** (each guidance item checked against later reported quarters), story vs numbers, current guidance and how it moved, bull and bear, and what to check next quarter. Every point cites a source id (FIN / AR / C1…C4) that links to the PDF.

## Architecture

```
GitHub Actions (cron, every 2h on weekdays)        Vercel (bom1, Mumbai)
┌──────────────────────────────────────────┐        ┌──────────────────────────────┐
│ scripts/ingest.ts                        │ commit │ Next.js PWA                  │
│  Yahoo EOD ─┐                            │ ─────▶ │  /           Brief           │
│  BSE API ───┼─▶ classify → fold → triage │  JSON  │  /watch      thresholds      │
│             │   → enrich → digest.json   │        │  /research   any ticker      │
│ scripts/research.ts (demo dossiers)      │        │  /api/research (staged, live)│
└──────────────────────────────────────────┘        └──────────────────────────────┘
          git = database + audit log of what FINN told you, and when
```

- **Push** runs as a scheduled job, not on page load. The app reads a static JSON, so the Brief opens instantly and costs nothing per view.
- **Pull** runs live in staged API calls (financials → each transcript → annual report → synthesis). Each stage fits a serverless time budget, and the UI shows exactly what FINN is reading as it reads it. Demo companies are precomputed. Any other ticker is built on first open and cached on the device.

### Model routing and cost

| Step | Model | Why |
|---|---|---|
| Category of a filing | **none** (BSE subcategory + rules) | Free. BSE's own subcategory is reliable when specific |
| Materiality + "why it matters" | Flash-Lite, **one batched call per 60 headlines** | Cheap, and it sees the whole window, so it can rank |
| Filings titled "Enclosed" (Infosys, M&M, HAL…) | Flash-Lite on page 1 of the PDF | Only when the title carries no information |
| Results table | Flash, PDF native | Numbers only. Extraction at temperature 0, arithmetic in code |
| Person background | Flash + Google Search grounding | The only web-enriched step, push side only, as the brief allows |
| Transcript → commitments | Flash-Lite (map) | Long context, schema-constrained |
| Promise vs delivery, bull/bear | Flash (reduce) | The one place reasoning matters; it never sees raw transcripts |

Every model call is cached by content hash (PDF URL plus prompt) and the cache is committed, so a re-run pays only for new filings. The footer of the Brief shows each run's calls, cache hits and tokens. It runs comfortably on Gemini's free tier. If a default model is retired, FINN discovers the newest model of the same class. If the smart model's daily quota runs out, it degrades to the lite model instead of failing.

### Grounding discipline (pull side)
- Numbers come from code, not the model.
- The synthesis prompt forbids outside knowledge, news and broker views. Each claim must cite a provided source id. A promise for a period not yet reported is marked "pending", never guessed.
- Transcript quotes must be verbatim, and the UI shows them next to the extracted target.

## Decisions and trade-offs
- **BSE over NSE for filings.** NSE's API needs a cookie dance and blocks most datacenter IPs. BSE carries the same Reg-30 filings for dual-listed companies and answers server-side.
- **Rules first, model second.** Tuned on a real month of portfolio filings (292 of them): BSE subcategory → text rules → model only for re-labelling text-rule guesses and opaque titles.
- **EBITDA is derived.** Indian results statements don't print EBITDA. FINN computes PBT + finance costs + depreciation − other income and marks it as derived. Banks and NBFCs get NII and pre-provision operating profit instead.
- **Long context over RAG** for four transcripts (~100k tokens). It is simpler and doesn't miss guidance buried in Q&A. Retrieval becomes worth it at portfolio scale.
- **Windows measure back from the last refresh, not the wall clock**, so a weekend doesn't empty the Brief.

## Deliberately left out
- Real OS push notifications (needs a push service and stored subscriptions). The data model and thresholds are ready for them.
- Intraday prices. The brief asks for EOD.
- Accounts and sync. Preferences live on the device.
- Investor presentations as a source. Decks are management's framing; transcripts and reports are where commitments are made on record.

## Run it

```bash
npm install
cp .env.example .env.local        # add GEMINI_API_KEY (free: aistudio.google.com/apikey)
npx tsx --env-file=.env.local scripts/ingest.ts 30      # builds public/data/digest.json
npx tsx --env-file=.env.local scripts/research.ts TCS   # precompute a dossier
npm run dev
```
Deploy: import the repo in Vercel, set `GEMINI_API_KEY`, done. For the daily job, add the same key as a GitHub Actions secret. Without a key, the digest still builds rules-only.

## Repo map
```
lib/sources/     yahoo.ts · bse.ts · screener.ts      plumbing
lib/push/        taxonomy.ts · digest.ts · enrich.ts · signals.ts
lib/research/    fundamentals.ts (code) · documents.ts (map) · synthesis.ts (reduce)
lib/llm/         gemini.ts   routing, schema output, cache, model discovery
app/             Brief · Watch · Research · /api/research
scripts/         ingest.ts · research.ts (run by .github/workflows)
```
