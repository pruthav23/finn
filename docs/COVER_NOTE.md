# ENAM - IIT screening - 2027: FINN

**Prototype:** https://finn-rosy.vercel.app (open on a phone; "Add to Home Screen" installs it)
**Repo:** https://github.com/pruthav23/finn
**Build history:** https://claude.ai/share/09689208-ee51-48db-90c0-2a2c668f71bb

## What I built
FINN treats an investor's problem as filtering, not aggregating. The front page says how many filings landed in my 20-stock portfolio over a window I pick, and how many matter. It shows them as a field of dots with the few that matter highlighted. Below sit three tiers: a card for what matters, one line each for what's worth a glance, and routine paperwork folded into counts.
- **Push.** Results cards are read from the results PDF and cross-checked line by line against screener. Management cards say who is coming in. A results day's five filings, or a three-week insolvency fight, become one card.
- **Alerts and Listen.** Price and volume thresholds that I set, evaluated live on the phone, plus a one-minute spoken brief that costs no model calls.
- **Pull.** Any NSE ticker, typed or spoken. Fundamentals come from code, commitments from four call transcripts with verbatim quotes, and one reasoning call produces **promised vs delivered**, guidance drift and bull/bear. Every claim cites its PDF.

## Key decisions
1. **Rules before models.** BSE's own subcategory and tuned rules classify for free. A model reads page 1 only when a title says nothing ("Enclosed").
2. **Rank on headlines, decide on documents.** One cheap call scores 60 headlines at once. Anything that might matter is then read in full against the company's size before it reaches the Brief.
3. **Numbers never come from the model.** It copies figures at temperature 0; code computes deltas, margins, NII and EBITDA (net of one-offs). Screener acts as the referee: a line that disagrees is re-read once, and if it still disagrees it's shown with a "?" rather than hidden or replaced.
4. **A "why" must state a consequence.** Restatements are rejected in code, and results whys may only use numbers on the card.
5. **Git as the database.** A GitHub Actions cron commits the digest, the LLM cache and a readable run log. The result is instant to serve, free to run, and an audit trail.

## What real data taught me
I ran the job against a real month of filings, read every act item, and fixed the rule behind each error. Six runs took the Brief from 23 act and 43 glance items to 20 and 15, with 13 of 16 results cards matching screener on every line, in all three quarters.
- **Headlines lie.** Two whys were wrong:
  - HAL buying out a small JV got a "why" about a "power segment" HAL doesn't have.
  - My prompt's example sentence was pasted onto two Polycab filings.

  Reading the filing fixed both.
- **Some filings were scored at their category's average.** Eternal moving a business into its own subsidiary scored as M&A. Jio Platforms' IPO, the biggest event for Reliance holders, sat in glance. Both needed priors refined in code.
- **Stories span weeks.** Polycab's insolvency was four cards until folding learned to follow a matter, not a day.
- **Extraction slips are specific:**
  - a quarter labelled Q2 FY25;
  - ITC's "+44% revenue", which was new excise duty;
  - standalone NII labelled as consolidated;
  - exceptional items inside EBITDA.

  Only a line-by-line check against an independent source caught them.
- **Free tiers fail in surprising ways.** The newest Flash model kept returning "overloaded" errors, and one retired model sent the client into a loop. The fallback rotates models, and fallback answers are never cached, so tomorrow's run retries with the better model.

## What I left out
OS push notifications (the data and thresholds are ready), intraday prices, accounts, investor decks and news as sources, and silently replacing a misread number with screener's.

## What's next
- Merge the audit branch, and keep reading the run log each week.
- Promise tracking that persists quarter to quarter: a credibility score for each management team.
- Peer-relative alerts: a move unusual against the sector, not just against the stock.
- Retrieval over full annual reports, for questions like "what changed in contingent liabilities?"
- Real push notifications.
