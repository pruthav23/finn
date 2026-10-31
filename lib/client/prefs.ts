"use client";
import { useCallback, useSyncExternalStore } from "react";
import type { Category } from "../push/taxonomy";

// The investor decides what "unusual" means. Stored per device.
export type Prefs = {
  window: "24h" | "3d" | "7d" | "30d" | "custom";
  since: string | null; // ISO date for custom window
  priceMove: number; // alert when |daily move| ≥ this %
  volumeX: number; // alert when volume ≥ this × 20-day average
  watch: Category[]; // filing types that raise an alert
  seen: string[]; // item ids the investor has cleared
};

export const DEFAULT_PREFS: Prefs = {
  window: "24h",
  since: null,
  priceMove: 4,
  volumeX: 2,
  watch: ["results", "M&A", "management_change", "fund_raise", "litigation", "pledging", "credit_rating"],
  seen: [],
};

const KEY = "finn.prefs.v1";
let cache: Prefs | null = null;
const subs = new Set<() => void>();

function read(): Prefs {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    cache = raw ? { ...DEFAULT_PREFS, ...JSON.parse(raw) } : DEFAULT_PREFS;
  } catch {
    cache = DEFAULT_PREFS;
  }
  return cache!;
}

export function setPrefs(patch: Partial<Prefs>) {
  cache = { ...read(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch {}
  subs.forEach((f) => f());
}

export function usePrefs(): [Prefs, (p: Partial<Prefs>) => void] {
  const p = useSyncExternalStore(
    (f) => { subs.add(f); return () => subs.delete(f); },
    read,
    () => DEFAULT_PREFS,
  );
  return [p, useCallback(setPrefs, [])];
}
