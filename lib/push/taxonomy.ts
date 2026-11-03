// ENAM's announcement taxonomy, with a prior "how much should an investor care" score.
// Rules do ~90% of the classification for free; the LLM only adjusts materiality
// and writes the one-line "why it matters".

export const CATEGORIES = [
  "results", "M&A", "fund_raise", "management_change", "litigation", "insider_trading",
  "earnings_call", "investor_meetings", "credit_rating", "dividend", "bonus_split", "capex",
  "press_release", "postal_ballot", "agm_egm", "pledging", "unclassified",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const LABEL: Record<Category, string> = {
  results: "Results",
  "M&A": "M&A",
  fund_raise: "Fund raise",
  management_change: "Management",
  litigation: "Litigation",
  insider_trading: "Insider trade",
  earnings_call: "Earnings call",
  investor_meetings: "Investor meet",
  credit_rating: "Credit rating",
  dividend: "Dividend",
  bonus_split: "Bonus / split",
  capex: "Capex",
  press_release: "Press release",
  postal_ballot: "Postal ballot",
  agm_egm: "AGM / EGM",
  pledging: "Pledging",
  unclassified: "Routine",
};

export const PRIOR: Record<Category, number> = {
  results: 90, "M&A": 80, management_change: 70, fund_raise: 72, litigation: 62, pledging: 70,
  credit_rating: 50, capex: 62, insider_trading: 45, bonus_split: 50, dividend: 35,
  press_release: 35, earnings_call: 25, investor_meetings: 8, agm_egm: 15, postal_ballot: 18, unclassified: 4,
};

// Order matters: routine paperwork is matched first so "Closure of trading window"
// never becomes an insider trade, and "Newspaper publication of results" is a duplicate.
const RULES: [Category, RegExp][] = [
  ["unclassified", /trading window|newspaper|publication|esop|esps|employee stock|allotment of (equity )?shares? (under|pursuant to) .*(esop|scheme)|certificate under|reg(ulation)?\.? ?74\s?\(5\)|compliance certificate|loss of share|duplicate share|investor complaints?|brsr|business responsibility|esg|sustainability report|secretarial|scrutini[sz]er|change in (registrar|rta)|book closure intimation|statement of deviation|reconciliation of share capital|record of (bulk|block)/i],
  ["earnings_call", /transcript|earnings (conference )?call|conference call|con-?call|audio (recording|link)|video recording|webcast/i],
  ["results", /financial results?|results? for the (quarter|period|year)|unaudited|audited (standalone|consolidated)|integrated filing.*financial|outcome of (the )?board meeting.*result|limited review/i],
  ["investor_meetings", /analyst|investor (meet|conference|day)|institutional investors? meet|non-deal roadshow|one[- ]on[- ]one/i],
  ["pledging", /pledge|encumbrance|invocation/i],
  ["insider_trading", /\bsast\b|insider trading|regulation 7\(2\)|reg\.? 7\(2\)|regulation 29|regulation 31|acquisition of shares by promoter|disposal of shares/i],
  ["fund_raise", /\bqip\b|qualified institutions? placement|preferential|rights issue|buy-?back|commercial paper|non-convertible|\bncds?\b|debentures?|fund ?rais|bond issu|warrants/i],
  ["M&A", /acqui|merger|amalgamat|demerger|joint venture|\bjv\b|scheme of arrangement|stake sale|divest|disinvest|wholly[- ]owned subsidiary|incorporation of (a )?(new )?subsidiary|strategic investment/i],
  ["management_change", /change in (management|directorate|kmp|senior management)|(appoint|resign|cessation|retire|re-?designat)\w*[^.]{0,80}(director|officer|\bceo\b|\bcfo\b|\bmd\b|secretary|kmp|head)|chief (executive|financial|operating|technology) officer|key managerial/i],
  ["litigation", /litigation|penalt|show[- ]cause|demand (order|notice)|tax demand|\bgst\b|income tax|adjudicat|insolvency|nclt|court|tribunal|sebi order|order (received|passed)|fine imposed|regulatory action|search and seizure|disput/i],
  ["credit_rating", /credit rating|rating (agency|action)|crisil|icra|care ratings|india ratings|\bfitch\b|moody|s&p/i],
  ["bonus_split", /bonus|stock split|sub-?division|split of (equity )?shares/i],
  ["dividend", /dividend|record date/i],
  ["capex", /capex|capital expenditure|capacity (expansion|addition)|new (plant|facility|factory)|greenfield|brownfield|commission(ing|ed)/i],
  ["agm_egm", /\bagm\b|\begm\b|annual general meeting|extra-?ordinary general meeting|annual report/i],
  ["postal_ballot", /postal ballot|e-?voting/i],
  ["press_release", /press release|media release|order (win|received|inflow)|bags|wins|contract|launch|partnership|collaborat|clarification|update/i],
];

// BSE's own subcategory is the most reliable signal when it is specific.
// Generic ones ("General", "Outcome of Board Meeting", "Press Release"…) fall through to text rules.
const SUBCAT: [RegExp, Category][] = [
  [/newspaper|certificate under|esop|esps|repayment of commercial paper|monitoring agency|half yearly report|trading window|loss of share/i, "unclassified"],
  [/^financial results$|^investor presentation$/i, "results"],
  [/^board meeting$/i, "results"], // intimation of an upcoming board meeting (usually results) → marked scheduled
  [/earnings call transcript/i, "earnings_call"],
  [/change in (directorate|management)|resignation of|appointment of|cessation/i, "management_change"],
  [/acquisition|scheme of arrangement|restructuring|amalgamation|merger|demerger|disinvestment|diversification|joint venture/i, "M&A"],
  [/qualified institutional|preferential issue|rights issue|buy ?back|issue of securities/i, "fund_raise"],
  [/insolvency|cirp|litigation|penalt|regulatory action/i, "litigation"],
  [/credit rating/i, "credit_rating"],
  [/dividend/i, "dividend"],
  [/bonus|split/i, "bonus_split"],
  [/sast|insider|regulation 7\(|reg\.? ?7\(/i, "insider_trading"],
  [/pledge|encumbrance/i, "pledging"],
  [/award of order|receipt of order|monthly business updates/i, "press_release"],
  [/postal ballot/i, "postal_ballot"],
  [/^agm$|^egm$|general meeting/i, "agm_egm"],
];

/** Returns the category and whether it came from BSE's own (specific) subcategory. */
export function classify(subcategory: string, text: string): { category: Category; bySubcat: boolean } {
  for (const [re, cat] of SUBCAT) if (re.test(subcategory)) {
    // a results press release filed under a generic heading is still part of the results event
    if (cat === "press_release" && /financial results/i.test(text)) return { category: "results", bySubcat: true };
    return { category: cat, bySubcat: true };
  }
  if (/analyst|investor meet/i.test(subcategory) && !/transcript|audio|recording|earnings call|conference call|presentation/i.test(text))
    return { category: "investor_meetings", bySubcat: true };
  for (const [cat, re] of RULES) if (re.test(text)) return { category: cat, bySubcat: false };
  return { category: "unclassified", bySubcat: false };
}

/** Some companies title every filing "Enclosed" — the headline carries no information. */
export const opaque = (headline: string) =>
  headline.trim().length < 24 || /^(enclosed|please (find|refer)[^.]{0,40}(enclosed|attached)[^.]{0,20}|announcement as attached|as attached|attached herewith)\.?$/i.test(headline.trim()) ||
  /^(disclosure|intimation|information|announcement) under (regulation|reg\.?) ?30\b[^.]{0,120}$/i.test(headline.trim());

/** Top-of-house roles that make a management change genuinely material. */
export const KMP = /\b(ceo|cfo|coo|managing director|md\b|chief executive|chief financial|chief operating|whole[- ]time director|chairman|chairperson|president)\b/i;

/**
 * How senior a role is, for materiality. "top": the people who set strategy and sign the
 * accounts (CEO, MD, CFO, chair). "second": deputy/joint MDs, whole-time and executive
 * directors, COOs, PSU functional directors. Everything else (group heads, SVPs,
 * independent or nominee directors, subsidiary roles) is "other".
 */
export function roleRank(role: string): "top" | "second" | "other" {
  const r = role.toLowerCase();
  if (/independent|nominee|\bhead\b|vice[- ]president|\bsvp\b|\bevp\b|senior management|subsidiary|security|information|compliance|company secretary|of [a-z][^,]* (limited|ltd)\b/.test(r)) return "other";
  if (/deputy|joint|additional|alternate/.test(r) && /managing director|\bmd\b|chief/.test(r)) return "second";
  if (/managing director|\bmd\b|chief executive|\bceo\b|chief financial|\bcfo\b|chair(man|person)|director \(finance\)|director - finance|director-finance/.test(r)) return "top";
  if (/whole[- ]time director|executive director|chief operating|\bcoo\b|director \((operations|personnel|hr|human resources|technical|marketing|commercial|projects|production|engineering|r&d)\)|director - |director-|president/.test(r)) return "second";
  return "other";
}

/**
 * Category priors are averages; some kinds of filing inside a category sit far from them.
 * Routine debt is not a fund raise in the sense that matters; a deal with your own wholly owned
 * subsidiary moves nothing for a shareholder; listing a big subsidiary does.
 */
export function priorFor(category: Category, text: string): number {
  const t = text.toLowerCase();
  // A listed holding's own filings about an IPO, DRHP or prospectus concern a subsidiary going public.
  if (/\bdrhp\b|\brhp\b|red herring|prospectus|initial public offer|\bipo\b|issue price|offer for sale/.test(t)) return 82;
  if (category === "fund_raise" && /\bncds?\b|non-convertible|debentures?|commercial paper|\bbonds?\b/.test(t) && !/\bqip\b|preferential|rights issue|warrants|buy-?back/.test(t)) return 12;
  if (category === "M&A" && /incorporat(ion|ed)|letter of comfort|amalgamation of [^|]*(wholly|subsidiar)|wholly[- ]owned subsidiar|step-down subsidiar|business transfer agreement/.test(t) && !/\b(sale|sell|divest|acquire[sd]?|acquisition) of \d|stake (sale|in)|embraer|third party/.test(t)) return 28;
  if (/clarification|sought clarification|news (report|item|article)|media report/.test(t)) return 50;
  // A penalty or demand of under ₹1 crore is noise for any of these companies.
  if ((category === "litigation" || /penalt|fine|demand|disincentive/.test(t)) && (rupees(t) ?? Infinity) < 1e7) return 15;
  return PRIOR[category];
}

/** The first rupee amount in a text, in rupees: "Rs. 1,50,000", "INR 5.41 million", "Rs 6.95 Lakh", "₹2.79 crore". */
export function rupees(text: string): number | null {
  const m = text.toLowerCase().match(/(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d+)?)\s*(crores?|cr\b|lakhs?|lacs?|million|mn\b|billion|bn\b)?/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const u = m[2] ?? "";
  return n * (/^cr/.test(u) ? 1e7 : /^la/.test(u) ? 1e5 : /^(million|mn)/.test(u) ? 1e6 : /^(billion|bn)/.test(u) ? 1e9 : 1);
}
