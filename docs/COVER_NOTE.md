# ENAM - IIT screening - 2027: FINN

**Prototype:** <VERCEL_URL> (open on a phone; "Add to Home Screen" installs it)
**Repo:** https://github.com/pruthav23/finn
**Build history:** https://claude.ai/share/09689208-ee51-48db-90c0-2a2c668f71bb (Claude: one end-to-end build conversation)

## What I built
FINN treats the investor's problem as filtering, not aggregating. The front page shows how many filings landed in my portfolio over a window I choose and how many matter, as a field of dots where only the few that matter are highlighted. Underneath, three tiers: rich cards for what matters, one line each for what's worth a glance, and routine paperwork folded away as counts.

- **Push, digest:** 20 NSE holdings, BSE filings, any window (24h to a month, or since a date). Results cards read the actual results PDF and show Revenue / EBITDA / PBT / PAT QoQ and YoY, with deltas computed in code and revenue cross-checked against screener. Management cards show who the incoming person is, from the filing's profile plus a grounded web lookup. A results day that produces five filings becomes one card.
- **Push, alerts:** the investor sets what "unusual" means (±X% move, N× 20-day volume, which filing types), and thresholds re-evaluate live on the device.
- **Listen:** a one-minute spoken brief, composed on the device and read by the phone's speech engine. No model cost.
- **Pull:** any NSE ticker, typed or spoken. Fundamentals come from code. A cheap model extracts every commitment from the last four call transcripts with verbatim quotes. One stronger-model call produces **promised vs delivered**, story vs numbers, guidance drift and bull/bear. Every claim carries a source chip that opens the PDF.

## Key decisions
1. **Rules before models.** I pulled a real month of portfolio filings (292) and tuned the classifier on them. BSE's own subcategory is reliable; headlines often aren't. Infosys titles nearly every filing "Enclosed", so for those, and only those, a cheap model reads page 1.
2. **Numbers never come from the model.** The LLM copies numbers from statements at temperature 0. QoQ/YoY, margins, CAGRs, cash conversion and leverage are arithmetic in TypeScript. EBITDA (not printed in Indian results) is derived and labelled as such. Banks get NII instead.
3. **Model routing.** Flash-Lite does bulk extraction in batches (60 headlines per call); Flash does reasoning (results tables, promise-vs-delivery). The expensive model never sees a raw transcript, only extracts. Every call is cached by content hash and the cache is committed, so daily re-runs pay only for new filings. It runs at ₹0 on the free tier, and each run's cost is printed in the app footer.
4. **Git as the database.** A GitHub Actions cron builds the digest every two hours on weekdays and commits it; the app reads static JSON. It is instant, free to serve, and an audit trail of what FINN told me and when.
5. **Primary-source discipline on pull.** The synthesis prompt forbids outside knowledge, every point must cite FIN / AR / C1–C4, and unverifiable promises are marked "pending" rather than judged.

## Left out, on purpose
OS-level push notifications (needs a push service; the thresholds and data are ready), intraday prices (the brief says EOD), accounts and sync, and investor decks as a source (management's framing; transcripts are where commitments go on record).

## Next
Real push notifications with per-user thresholds; promise tracking that persists quarter to quarter (a management credibility score per company); peer-relative alerts (a move that's unusual against the sector, not just the stock); retrieval over full annual reports for questions like "what changed in contingent liabilities?".
