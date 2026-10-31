import * as cheerio from "cheerio";
import { get } from "../http";

// screener.in compiles standardised multi-year financials straight from exchange
// filings, and links the primary documents (annual reports, concall transcripts).
// We use it for (a) the numbers and (b) the document links — never its commentary.

export type Table = { cols: string[]; rows: Record<string, (number | null)[]> };

export type Company = {
  symbol: string;
  name: string;
  bse: string | null;
  consolidated: boolean;
  url: string;
  ratios: Record<string, string>; // top-line ratio strip
  quarters: Table;
  pnl: Table;
  balance: Table;
  cashflow: Table;
  efficiency: Table; // screener "ratios" section (debtor days, CCC, ROCE…)
  shareholding: Table;
  annualReports: { year: number; url: string }[];
  concalls: { label: string; date: string; transcript: string | null; ppt: string | null }[];
};

const MONTHS: Record<string, string> = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };

function num(s: string): number | null {
  const t = s.replace(/[,%₹\s]/g, "");
  if (t === "" || t === "-") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function parseTable($: cheerio.CheerioAPI, sel: string): Table {
  const t = $(`${sel} table.data-table`).first();
  const cols = t.find("thead th").toArray().slice(1).map((th) => $(th).text().trim());
  const rows: Table["rows"] = {};
  t.find("tbody tr").each((_, tr) => {
    const cells = $(tr).children("td").toArray();
    if (!cells.length) return;
    const label = $(cells[0]).text().replace(/\+$/, "").replace(/\s+/g, " ").replace(/\s*\+\s*$/, "").trim();
    if (!label || /raw pdf/i.test(label)) return;
    rows[label] = cells.slice(1).map((c) => num($(c).text()));
  });
  return { cols, rows };
}

async function fetchPage(symbol: string, consolidated: boolean) {
  const url = `https://www.screener.in/company/${encodeURIComponent(symbol)}/${consolidated ? "consolidated/" : ""}`;
  const res = await get(url, { headers: { Accept: "text/html" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`screener ${res.status} for ${symbol}`);
  return { url: res.url || url, html: await res.text() };
}

export async function company(symbolIn: string): Promise<Company> {
  const symbol = symbolIn.toUpperCase().trim();
  let page = await fetchPage(symbol, true);
  if (!page) throw new Error(`Unknown symbol "${symbol}" on screener.in`);
  let $ = cheerio.load(page.html);
  let consolidated = true;
  // Companies without subsidiaries publish only standalone numbers.
  if ($("#quarters table.data-table tbody tr").length === 0) {
    const sa = await fetchPage(symbol, false);
    if (sa) { page = sa; $ = cheerio.load(sa.html); consolidated = false; }
  }

  const ratios: Record<string, string> = {};
  $("#top-ratios li").each((_, li) => {
    const k = $(li).find(".name").text().trim();
    const v = $(li).find(".value").text().replace(/\s+/g, " ").trim();
    if (k) ratios[k] = v;
  });

  const bse = page.html.match(/BSE:\s*(\d{6})/)?.[1] ?? null;
  const name = $("h1").first().text().replace(/\s+/g, " ").trim() || symbol;

  const annualReports: Company["annualReports"] = [];
  $("#documents .annual-reports a").each((_, a) => {
    const year = Number($(a).text().match(/(20\d\d)/)?.[1]);
    const href = $(a).attr("href");
    if (year && href) annualReports.push({ year, url: href });
  });

  const concalls: Company["concalls"] = [];
  $("#documents .concalls li").each((_, li) => {
    const label = $(li).children("div").first().text().trim(); // e.g. "Oct 2026"
    const [mon, yr] = label.split(/\s+/);
    const tr = $(li).find('a[title="Raw Transcript"], a:contains("Transcript")').first().attr("href") ?? null;
    const ppt = $(li).find('a:contains("PPT")').first().attr("href") ?? null;
    concalls.push({ label, date: yr && MONTHS[mon] ? `${yr}-${MONTHS[mon]}` : label, transcript: tr, ppt });
  });

  return {
    symbol, name, bse, consolidated, url: page.url, ratios,
    quarters: parseTable($, "#quarters"),
    pnl: parseTable($, "#profit-loss"),
    balance: parseTable($, "#balance-sheet"),
    cashflow: parseTable($, "#cash-flow"),
    efficiency: parseTable($, "#ratios"),
    shareholding: parseTable($, "#shareholding"),
    annualReports, concalls,
  };
}
