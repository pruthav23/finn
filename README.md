# FINN: your portfolio, filtered

A mobile-first investment agent for a 20-stock NSE portfolio. It **pushes** what changed and why it matters, and **pulls** research on any NSE company, using only primary filings.

> **Point of view:** an investor doesn't need another feed; they need a sieve. FINN's front page shows every filing as a dot, marks the few that matter, and puts the rest away where they can still be found. Every screen answers "should I care?" before "what happened?".

## What it does

**Brief (push).** Every filing across the portfolio for a window you pick (24 hours, 3 days, a week, a month, or since a date), in three tiers:
- **What matters:** a rich card for each item.
  - *Results* are read from the actual results PDF: Revenue, EBITDA, PBT and PAT against last quarter and the same quarter last year. Every line is cross-checked against screener.in in all three columns, and the "why" is written from those checked numbers.
  - *Management changes* name the person and role, with a background from the filing's own profile or a grounded web lookup, and a LinkedIn link.
  - *Legal matters and subsidiary IPOs* are one card per story.
- **Worth a glance:** one factual line per filing, written from the filing itself.
- **Set aside:** routine paperwork (ESOP allotments, Reg 74(5) certificates, newspaper ads), collapsed into counts.

One event often arrives as 3–5 filings: outcome, results, press release, deck, newspaper ad. One story can arrive as several events over weeks, such as an insolvency admission, stay, hearing and order. FINN folds both kinds.

**Watch (push alerts).** You set what "unusual" means: a ±X% daily move, volume of at least N× the 20-day average, and which filing types should alert you. Thresholds apply live on the device, so you can drag a slider and watch the alert list change.

**Listen.** A one-minute spoken brief, composed on the device from the same data and read by the phone's speech engine. It makes no model calls.

**Research (pull).** Type or say any NSE company. FINN reads:
1. **Reported financials** (screener.in's standardised statements). Trajectory, margins, leverage, working-capital cycle, cash conversion and promoter holding are **computed in code**.
2. **The last four earnings-call transcripts.** A cheap model extracts every explicit commitment with a verbatim quote.
3. **The latest annual report.** Pages are selected by relevance, and the business snapshot comes from those pages only.
4. **Synthesis.** One call to a stronger model, fed only the extracts above, produces:
   - promised vs delivered;
   - story vs numbers;
   - guidance and how it moved;
   - bull and bear;
   - what to check next quarter.

   Every point cites a source (FIN / AR / C1–C4) that opens the PDF.

## Architecture

```
 GitHub Actions (every 2 h, weekdays 09:30–19:30 IST)            Vercel (bom1, Mumbai)
┌──────────────────────────────────────────────────────────┐   ┌────────────────────────────────┐
│ scripts/ingest.ts                                        │   │ Next.js 15 PWA                  │
│                                                          │   │                                 │
│  BSE daily series ─► prices, 20-day volume ratios        │   │  /            Brief             │
│  BSE filings API ─► classify (subcategory → rules)       │   │  /watch       thresholds, live  │
│                  ─► fold (event clusters, story threads) │   │  /research    any NSE ticker    │
│                  ─► triage (Flash-Lite, 60 per call)     │   │  /api/research  staged, ≤60 s   │
│                  ─► read & re-rank (Flash-Lite, the doc) │   │      search → base → call×4     │
│                  ─► results PDF (Flash) ─► screener check│   │      → annual → synth           │
│                  ─► whys from checked facts              │   │                                 │
│  → public/data/digest.json + data/last-run.log ─commit─► │──►│  reads static JSON              │
│                                                          │   │                                 │
│ scripts/research.ts → public/data/research/*.json        │   │                                 │
└──────────────────────────────────────────────────────────┘   └────────────────────────────────┘
          git = database, LLM cache, and audit log of what FINN told you, and when
```

- **Push runs as a scheduled job, not on page load.** The app reads static JSON, so the Brief opens instantly and costs nothing per view.
- **Pull runs live in staged API calls**, each within a serverless time budget. The UI shows what FINN is reading as it reads it. Demo companies are precomputed; any other ticker is built on first open and cached on the device.
- **Every run's log** (`data/last-run.log`) ends with the results cross-check table and the act and glance lists exactly as the Brief will show them, so each run can be read and judged.

## Model routing

| Step | Model | Why |
|---|---|---|
| Category of a filing | **none**: BSE subcategory, then rules | Free, and BSE's own subcategory is reliable when specific |
| Starting score | **none**: category prior, refined in code | Routine debt, intra-group deals, rating reaffirmations and small penalties sit far below their category's average; subsidiary IPOs sit far above |
| Filings titled "Enclosed" | Flash-Lite, page 1–2 of the PDF | Only when the title carries no information |
| Materiality and "why" from headlines | Flash-Lite, **one batched call per 60 headlines** | Cheap, and it sees the whole window, so it can rank |
| Anything scoring 40+ (not results or management) | Flash-Lite reads the filing, with the company's size | A headline can't tell a ₹5 lakh deal from a ₹5,000 crore one. Once read, the document's judgment outweighs the category prior (0.2 / 0.8) |
| Results table | **Flash**, PDF native, temperature 0 | Numbers only, copied. Arithmetic in code, then checked against screener. A failing line gets one re-read, kept only if it then agrees |
| Results "why" | Flash-Lite, from the checked figures | Any number not on the card sends the line back |
| Management change | Flash-Lite (people, roles, profile annexure) + grounded search for background | Role rank in code decides materiality: CEO/MD/CFO/chair vs deputy/whole-time vs everyone else |
| Transcript → commitments | Flash-Lite (map) | Long context, schema-constrained |
| Promised vs delivered, bull/bear | Flash (reduce) | The one place reasoning matters; it never sees raw transcripts |

**Cost and resilience.**
- **Cache:** every call is cached by content hash, and the cache is committed, so a re-run pays only for new filings. The Brief's footer shows each run's calls, cache hits and tokens. It runs on Gemini's free tier.
- **Retired models:** a model that returns 404 is retired for the run, and FINN discovers the newest available model of the same class.
- **Overloaded models:** an overloaded Flash model rests for five minutes and the next Flash takes over. If none is left, the run degrades to Flash-Lite.
- **Fallback answers aren't kept:** a Flash-Lite answer to a Flash request is used but never cached, so the next run asks Flash again.

## Grounding rules

**Push side**
- **Numbers come from code.** The model copies figures from statements at temperature 0, and code computes QoQ, YoY, margins, NII, PPOP and EBITDA.
- **EBITDA** = PBT − exceptional items − associates' share + finance costs + depreciation − other income. It is marked as derived, and one-offs are stated in a note.
- **Every results line is cross-checked** against screener in all three columns: revenue, PBT, net profit, EBITDA (against screener's operating profit), and NII for banks.
  - A mismatch is shown on the card with a "?" and a plain note, and kept out of the headline and the spoken brief.
  - Owners' profit sitting a steady few per cent under screener's total is accepted as minority interest, and the card says so.
- **The quarter comes from the filing date,** anchored on the screener column the revenue matched, never from the model's label.
- **"Why" lines state a consequence, not a restatement.** Restatements ("Provides an update…", "Reports performance…") are rejected in code. Results whys may use only numbers that appear on the card.

**Pull side**
- The synthesis prompt forbids outside knowledge, news and broker views, and each claim must cite a provided source id.
- A full-year target judged mid-year is "pending" or "partial", never "missed" off one quarter.
- Transcript quotes are verbatim, and the UI shows them next to the extracted target.

## Decisions and trade-offs

- **BSE for prices and filings.** Yahoo rate-limits cloud runners, and NSE's API needs cookies and blocks datacenter IPs. BSE carries the same Reg-30 filings and answers server-side. Volume spikes are ratios to each stock's own 20-day average, so the exchange's volume base doesn't matter.
- **Rules first, model second.** The classifier was tuned on a real month of portfolio filings (~290). Models only re-label text-rule guesses and opaque titles, and may never relabel a filing *into* "results", because that label promises a results card.
- **Headlines rank cheaply, then documents decide.** The 60-headline batch keeps the free tier viable. Only what scores 40+ is read in full. The cost is one extra cheap call per candidate (~15–20 a run).
- **Screener as the referee, not the source.** Figures come from the company's own PDF; screener only says whether they were read right.
  - The trade-off: screener's definitions sometimes differ. Examples are tobacco excise (handled by netting it out), minority interest (handled) and L&T's lending-arm interest (flagged, not forced).
  - Rejected alternative: showing screener's number instead would make FINN an aggregator.
- **Flag rather than hide.** A line that fails the check stays visible with a "?" and a reason. A portfolio manager would rather see "unverified" than lose the line or be shown a wrong one.
- **Folding by story, not just by day.** An insolvency matter, a news clarification or a subsidiary IPO is one card led by its latest filing, with the history underneath. The cost is a broader regex net, limited to one company and the window.
- **Long context over RAG** for four transcripts (~100k tokens). It is simpler and doesn't miss guidance buried in Q&A. Retrieval becomes worth it at portfolio scale.
- **Windows measure back from the last refresh, not the wall clock**, so a weekend doesn't empty the Brief.
- **Git as the database.** It is free and diffable, and it is an audit trail of what FINN said and when. The cost is a 2-hour refresh rather than real time, and a growing repo (the LLM cache is small JSON).

## Deliberately left out

- **OS push notifications.** They need a push service and stored subscriptions; the thresholds and data model are ready for them.
- **Intraday prices.** The brief asks for end-of-day.
- **Accounts and sync.** Preferences live on the device.
- **Investor presentations as a research source.** Decks are management's framing; transcripts and reports are where commitments go on record.
- **News and broker views.** FINN filters primary filings. The only web use is the background of an incoming senior person.
- **Replacing a misread figure with screener's.** It's flagged instead (see above).

## Run it

```bash
npm ci
cp .env.example .env.local                                # add GEMINI_API_KEY (free: aistudio.google.com/apikey)
npx tsx --env-file=.env.local scripts/ingest.ts 30        # builds public/data/digest.json; log on stdout
npx tsx --env-file=.env.local scripts/research.ts TCS     # precompute a dossier
npm run dev                                               # http://localhost:3000
npm run typecheck
```

- **Deploy:** import the repo in Vercel (region `bom1` is set in `vercel.json`) and set `GEMINI_API_KEY`.
- **Scheduled job:** add the same key as a GitHub Actions secret. The digest workflow runs on its schedule, on demand (*Actions → Push digest → Run workflow*, any branch), or when `.github/digest-request` changes. Research dossiers run from `research.yml`.
- **Without a key,** the digest still builds rules-only.
- **Run locally, prices** fall back to Yahoo if BSE refuses.

## Repo map

```
app/
  page.tsx                Brief (window picker, sieve, three tiers, spoken brief)
  watch/                  thresholds, applied live on the device
  research/               search (typed or spoken) and the dossier page
  api/research/route.ts   staged pull: search → base → call → annual → synth
components/               Items (act cards, glance rows), Sieve, AudioBrief, WindowPicker, Spark, Nav, States
lib/
  sources/                bse.ts (filings, prices, PDFs) · screener.ts · yahoo.ts
  push/
    taxonomy.ts           categories, BSE subcategory and text rules, refined priors, role ranks
    digest.ts             the pipeline: prices → filings → fold → triage → read → enrich → log
    enrich.ts             triage, results extraction, document assessment, management, whys
    verify.ts             screener cross-check, quarter anchoring, audit lines
    signals.ts            daily change and volume ratios
  research/               fundamentals.ts (code) · documents.ts (map) · synthesis.ts (reduce) · dossier.ts
  llm/gemini.ts           routing, schema output, cache, model discovery and fallback
  client/                 formatting, preferences, data loading
scripts/                  ingest.ts · research.ts (run by .github/workflows)
data/                     last-run.log · LLM cache (committed)
public/data/              digest.json · research/*.json
docs/COVER_NOTE.md        one-page covering note
```
