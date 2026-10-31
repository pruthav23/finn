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
  const res = await get(url, { headers: { Referer: "https://www.bseindia.com/", Accept: "application/pdf,*/*" }, timeoutMs: 45000 });
  if (!res.ok) throw new Error(`PDF ${res.status} ${url}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf[0] !== 0x25 || buf[1] !== 0x50) throw new Error(`Not a PDF: ${url}`); // "%P"
  return buf;
}
