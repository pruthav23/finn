"use client";
import type { DigestItem } from "@/lib/types";

/** The hero: every filing in the window as a dot. Routine paperwork recedes; what matters is marked. */
export function Sieve({ items, onPick }: { items: DigestItem[]; onPick: (id: string) => void }) {
  const ordered = [...items].sort((a, b) => a.score - b.score);
  return (
    <div className="flex flex-wrap gap-[5px]" aria-hidden>
      {ordered.map((i, k) => {
        const size = i.tier === "act" ? 14 : i.tier === "glance" ? 8 : 5;
        const style = {
          width: size, height: size, animationDelay: `${Math.min(k * 6, 600)}ms`,
          background: i.tier === "act" ? "var(--mark)" : i.tier === "glance" ? "var(--ink-2)" : "var(--rule)",
          boxShadow: i.tier === "act" ? "0 0 0 2px color-mix(in oklab, var(--mark) 35%, transparent)" : undefined,
        } as const;
        return i.tier === "act" ? (
          <button key={i.id} tabIndex={-1} onClick={() => onPick(i.id)} title={`${i.symbol}: ${i.headline}`} className="dot self-center rounded-full" style={style} />
        ) : (
          <span key={i.id} className="dot self-center rounded-full" style={style} />
        );
      })}
    </div>
  );
}
