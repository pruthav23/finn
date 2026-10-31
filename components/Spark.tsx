export function Spark({ data, w = 72, h = 24, className = "" }: { data: number[]; w?: number; h?: number; className?: string }) {
  if (data.length < 2) return null;
  const min = Math.min(...data), max = Math.max(...data), r = max - min || 1;
  const pts = data.map((v, i) => `${((i / (data.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - min) / r) * (h - 4)).toFixed(1)}`).join(" ");
  const upTrend = data.at(-1)! >= data[0];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className={className} aria-hidden>
      <polyline points={pts} fill="none" stroke={upTrend ? "var(--up)" : "var(--down)"} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** Minimal bar chart for reported series. Negative values hang below the axis. */
export function Bars({
  values, labels, h = 96, highlightLast = true, format = (n: number) => String(n),
}: { values: (number | null)[]; labels: string[]; h?: number; highlightLast?: boolean; format?: (n: number) => string }) {
  const vals = values.map((v) => v ?? 0);
  const max = Math.max(0, ...vals), min = Math.min(0, ...vals), span = max - min || 1;
  const zero = (max / span) * h;
  const n = vals.length, bw = 100 / n;
  return (
    <figure className="w-full">
      <svg viewBox={`0 0 100 ${h}`} preserveAspectRatio="none" className="block h-[96px] w-full" role="img"
        aria-label={labels.map((l, i) => `${l}: ${values[i] == null ? "n/a" : format(values[i]!)}`).join(", ")}>
        {vals.map((v, i) => {
          const bh = (Math.abs(v) / span) * h;
          return (
            <rect key={i} x={i * bw + bw * 0.18} width={bw * 0.64} y={v >= 0 ? zero - bh : zero} height={Math.max(bh, 0.5)} rx={0.8}
              fill={highlightLast && i === n - 1 ? "var(--ink)" : v < 0 ? "var(--down)" : "color-mix(in oklab, var(--ink) 28%, transparent)"} />
          );
        })}
        <line x1="0" x2="100" y1={zero} y2={zero} stroke="var(--rule)" strokeWidth="0.6" vectorEffect="non-scaling-stroke" />
      </svg>
      <figcaption className="mt-1 flex justify-between text-[11px] text-muted num">
        <span>{labels[0]}</span>
        <span className="text-ink font-semibold">{values.at(-1) == null ? "—" : format(values.at(-1)!)}</span>
        <span>{labels.at(-1)}</span>
      </figcaption>
    </figure>
  );
}
