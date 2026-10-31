"use client";
import { usePrefs, type Prefs } from "@/lib/client/prefs";

const OPTS: { v: Prefs["window"]; label: string }[] = [
  { v: "24h", label: "24 hours" },
  { v: "3d", label: "3 days" },
  { v: "7d", label: "Week" },
  { v: "30d", label: "Month" },
  { v: "custom", label: "Since…" },
];

export const windowLabel = (p: Prefs) =>
  p.window === "custom" && p.since
    ? `since ${new Date(p.since).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`
    : { "24h": "over the last 24 hours", "3d": "over the last 3 days", "7d": "this past week", "30d": "this past month", custom: "since your chosen date" }[p.window];

export function WindowPicker({ maxDays }: { maxDays: number }) {
  const [p, set] = usePrefs();
  const min = new Date(Date.now() - maxDays * 86400_000).toISOString().slice(0, 10);
  return (
    <div className="-mx-4 px-4 scroll-x">
      <div className="flex gap-2" role="group" aria-label="Time window">
        {OPTS.map((o) => (
          <button key={o.v} className="chip" aria-pressed={p.window === o.v}
            onClick={() => set({ window: o.v, since: o.v === "custom" ? (p.since ?? new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10)) : p.since })}>
            {o.label}
          </button>
        ))}
        {p.window === "custom" && (
          <input type="date" aria-label="Show filings since" className="chip" min={min} max={new Date().toISOString().slice(0, 10)}
            value={p.since ?? ""} onChange={(e) => set({ since: e.target.value })} />
        )}
      </div>
    </div>
  );
}
