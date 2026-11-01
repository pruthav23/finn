import { get } from "../http";

// BSE's public announcements API. Works server-side with a bseindia.com referer.
// (NSE's equivalent needs a cookie dance and blocks most datacenter IPs; BSE carries
// the same Reg-30 filings for dual-listed companies, so it is the more reliable feed.)

export type RawFiling = {
  id: string;
  bse: string;
  company: string;
  headline: string;
  subject: string;
  bseCategory: string;
  bseSubcategory: string;
  critical: boolean;
  at: string; // ISO, IST wall time
  pdf: string | null;
  pdfBytes: number | null;
};

const HDRS = {
  Accept: "application/json, text/plain, */*",
  Referer: "https://www.bseindia.com/",
  Origin: "https://www.bseindia.com",
};

const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");

export async function filings(bseCode: string, from: Date, to: Date): Promise<RawFiling[]> {
  const out: RawFiling[] = [];
  for (let page = 1; page <= 5; page++) {
    const url =
      `https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w?pageno=${page}` +
      `&strCat=-1&strPrevDate=${ymd(from)}&strScrip=${bseCode}&strSearch=P&strToDate=${ymd(to)}&strType=C&subcategory=-1`;
    const res = await get(url, { headers: HDRS });
    if (!res.ok) throw new Error(`BSE ${res.status} for ${bseCode}`);
    const text = await res.text();
    if (text.trim().startsWith("<")) throw new Error(`BSE returned HTML for ${bseCode} (blocked?)`);
    const j = JSON.parse(text);
    const rows: any[] = j.Table ?? [];
    for (const r of rows) {
      out.push({
        id: r.NEWSID,
        bse: String(r.SCRIP_CD),
        company: r.SLONGNAME,
        headline: (r.HEADLINE || r.NEWSSUB || "").trim(),
        subject: (r.NEWSSUB || "").trim(),
        bseCategory: r.CATEGORYNAME || "",
        bseSubcategory: r.SUBCATNAME || "",
        critical: r.CRITICALNEWS === "1",
        at: r.NEWS_DT,
        pdf: r.ATTACHMENTNAME ? attachmentUrl(r.ATTACHMENTNAME, r.OLD) : null,
        pdfBytes: r.Fld_Attachsize ?? null,
      });
    }
    const total = j.Table1?.[0]?.ROWCNT ?? rows.length;
    if (out.length >= total || rows.length === 0) break;
  }
  return out;
}

export function attachmentUrl(name: string, old?: number) {
  // Recent files live under AttachLive, older ones under AttachHis; AnnPdfOpen resolves both.
  return `https://www.bseindia.com/stockinfo/AnnPdfOpen.aspx?Pname=${name}`;
}

export async function fetchPdf(url: string): Promise<Uint8Array> {
  const res = await get(url, { headers: { Referer: "https://www.bseindia.com/", Accept: "application/pdf,*/*" }, timeoutMs: 90000, retries: 2 });
  if (!res.ok) throw new Error(`PDF ${res.status} ${url}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf[0] !== 0x25 || buf[1] !== 0x50) throw new Error(`Not a PDF: ${url}`); // "%P"
  return buf;
}

/** A year of daily closes + volume from BSE (works from cloud IPs where Yahoo rate-limits). */
export async function bseDaily(bseCode: string): Promise<{ date: string; c: number; v: number }[]> {
  const url = `https://api.bseindia.com/BseIndiaAPI/api/StockReachGraph/w?scripcode=${bseCode}&flag=12M&fromdate=&todate=&seriesid=`;
  const res = await get(url, { headers: HDRS });
  if (!res.ok) throw new Error(`BSE price ${res.status} for ${bseCode}`);
  const j = await res.json();
  const rows: { dttm: string; vale1: string; vole: string }[] = JSON.parse(j.Data ?? "[]");
  const M: Record<string, string> = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
  return rows
    .map((r) => {
      const [, mon, dd, yyyy] = r.dttm.split(" "); // "Fri Oct 30 2026 00:00:00"
      return { date: `${yyyy}-${M[mon]}-${dd}`, c: Number(r.vale1), v: Number(r.vole) };
    })
    .filter((r) => r.c > 0 && /^\d{4}-\d\d-\d\d$/.test(r.date));
}
