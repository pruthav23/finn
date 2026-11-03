"use client";
import { useEffect, useRef, useState } from "react";
import type { DigestItem } from "@/lib/types";
import type { Alert } from "@/lib/client/data";

// A one-minute spoken brief for the commute. Composed from the same data on-device,
// read by the phone's own speech engine: zero model cost, works offline once loaded.

const say = (n: number) => `${n > 0 ? "up" : "down"} ${Math.abs(n).toFixed(1)} percent`;

export function script(act: DigestItem[], glance: number, routine: number, moves: Alert[], windowLabel: string): string {
  const parts: string[] = [];
  const h = new Date().getHours();
  parts.push(`Good ${h < 12 ? "morning" : h < 17 ? "afternoon" : "evening"}. Here is your portfolio, ${windowLabel}.`);
  if (!act.length) parts.push("Nothing material. ");
  else parts.push(`${act.length} ${act.length === 1 ? "thing matters" : "things matter"}.`);
  act.slice(0, 5).forEach((i) => {
    const e = i.enrichment;
    if (e?.kind === "results") {
      // never read out a line that disagrees with screener
      const top = e.rows.find((r) => !r.mismatch && r.label !== "EBITDA"), pat = e.rows.find((r) => r.label === "PAT" && !r.mismatch);
      const bits = [top && top !== pat && `${top.label.replace(/, net of excise/, "")} ${top.yoy != null ? say(top.yoy) : "flat"}`, pat?.yoy != null && `profit ${say(pat.yoy)}`].filter(Boolean);
      parts.push(`${i.name} results${bits.length ? `: ${bits.join(", ")} year on year` : ""}.${i.why ? ` ${i.why}` : ""}`);
    } else if (e?.kind === "management") {
      const c = e.changes[0];
      parts.push(`${i.name}: ${c.person} ${c.action} as ${c.role}.`);
    } else parts.push(`${i.name}. ${i.why ?? i.headline}`);
  });
  const px = moves.filter((m) => m.kind !== "filing").slice(0, 3);
  if (px.length) parts.push(`On the tape: ${px.map((m) => (m.kind === "price" ? `${m.name} ${say(m.value)}` : `${m.name} traded ${m.value.toFixed(1)} times its usual volume`)).join("; ")}.`);
  parts.push(`${glance} more worth a glance, and ${routine} routine filings I've set aside.`);
  return parts.join(" ");
}

export function AudioBrief({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "playing">("idle");
  const [ok, setOk] = useState(false);
  const u = useRef<SpeechSynthesisUtterance | null>(null);
  useEffect(() => { setOk(typeof window !== "undefined" && "speechSynthesis" in window); return () => { try { speechSynthesis.cancel(); } catch {} }; }, []);
  if (!ok) return null;
  const toggle = () => {
    if (state === "playing") { speechSynthesis.cancel(); setState("idle"); return; }
    const utt = new SpeechSynthesisUtterance(text);
    const voices = speechSynthesis.getVoices();
    utt.voice = voices.find((v) => v.lang === "en-IN") ?? voices.find((v) => v.lang.startsWith("en-GB")) ?? null;
    utt.rate = 1.04;
    utt.onend = utt.onerror = () => setState("idle");
    u.current = utt;
    speechSynthesis.speak(utt);
    setState("playing");
  };
  return (
    <button onClick={toggle} className="chip" aria-pressed={state === "playing"} aria-label={state === "playing" ? "Stop audio brief" : "Listen to the brief"}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        {state === "playing" ? <rect x="6" y="6" width="12" height="12" rx="2" /> : <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" />}
      </svg>
      {state === "playing" ? "Stop" : "Listen"}
    </button>
  );
}
