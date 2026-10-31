import { extractText, getDocumentProxy } from "unpdf";

/** Extract per-page text. `maxPages` keeps huge annual reports bounded. */
export async function pdfPages(bytes: Uint8Array, maxPages = 400): Promise<string[]> {
  const doc = await getDocumentProxy(new Uint8Array(bytes));
  const n = Math.min(doc.numPages, maxPages);
  if (n === doc.numPages) {
    const { text } = await extractText(doc, { mergePages: false });
    return (text as string[]).map(clean);
  }
  const pages: string[] = [];
  for (let i = 1; i <= n; i++) {
    const p = await doc.getPage(i);
    const c = await p.getTextContent();
    pages.push(clean(c.items.map((it: any) => ("str" in it ? it.str : "")).join(" ")));
  }
  return pages;
}

const clean = (s: string) => s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

/** Rough token estimate (~4 chars/token) used for budgeting prompts. */
export const tokens = (s: string) => Math.ceil(s.length / 4);

/** Keep the pages most relevant to a set of keywords, within a token budget, in page order. */
export function selectPages(pages: string[], keywords: RegExp[], budgetTokens: number): { text: string; pages: number[] } {
  const scored = pages.map((p, i) => ({
    i,
    score: keywords.reduce((s, k) => s + (p.match(new RegExp(k.source, "gi"))?.length ?? 0), 0),
    t: tokens(p),
  }));
  const picked: number[] = [];
  let used = 0;
  for (const s of [...scored].sort((a, b) => b.score - a.score)) {
    if (s.score === 0) break;
    if (used + s.t > budgetTokens) continue;
    picked.push(s.i);
    used += s.t;
  }
  picked.sort((a, b) => a - b);
  return { text: picked.map((i) => `[page ${i + 1}]\n${pages[i]}`).join("\n\n"), pages: picked.map((i) => i + 1) };
}
