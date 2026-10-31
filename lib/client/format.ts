import { istMs } from "./data";

const inr = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const inr1 = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 1 });

/** ₹ crore, compact: 1,23,456 → "1.23 L cr"; 12,345 → "12,345 cr" */
export function cr(n: number | null | undefined): string {
  if (n == null) return "—";
  const a = Math.abs(n);
  if (a >= 100000) return `${(n / 100000).toFixed(2)}L cr`;
  if (a >= 1000) return `${inr.format(n)} cr`;
  return `${inr1.format(n)} cr`;
}
export const pct = (n: number | null | undefined, sign = true) =>
  n == null ? "—" : `${sign && n > 0 ? "+" : ""}${n.toFixed(Math.abs(n) >= 100 ? 0 : 1)}%`;
export const tone = (n: number | null | undefined) => (n == null || n === 0 ? "" : n > 0 ? "up" : "down");
export const price = (n: number) => `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: n < 100 ? 2 : 1 }).format(n)}`;

export function ago(at: string, ref = Date.now()): string {
  const m = Math.max(0, (ref - istMs(at)) / 60000);
  if (m < 60) return `${Math.round(m)}m`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h`;
  const d = Math.round(m / 1440);
  return d < 8 ? `${d}d` : new Date(istMs(at)).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}
export const day = (iso: string) => new Date(iso.length <= 10 ? `${iso}T12:00:00+05:30` : istMs(iso)).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
