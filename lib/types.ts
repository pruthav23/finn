import type { Category } from "./push/taxonomy";

export type Tier = "act" | "glance" | "routine";

export type ResultsCard = {
  kind: "results";
  basis: "consolidated" | "standalone";
  periods: { cur: string; prevQ: string; yoyQ: string };
  financial: boolean; // bank / NBFC layout
  rows: { label: string; cur: number | null; prevQ: number | null; yoyQ: number | null; qoq: number | null; yoy: number | null; derived?: boolean }[];
  marginNote?: string;
  notes: string[];
  verified?: boolean; // revenue matched screener's independently-compiled number
};

export type PersonCard = {
  kind: "management";
  changes: {
    person: string;
    role: string;
    action: "appointed" | "resigned" | "retired" | "re-appointed" | "ceased" | "redesignated" | "other";
    effective: string | null;
    reason: string | null;
    kmp: boolean;
    bio: string | null;
    bioSources: { title: string; url: string }[];
    linkedin: string;
  }[];
};

export type Enrichment = ResultsCard | PersonCard;

export type DigestItem = {
  id: string;
  symbol: string;
  name: string;
  sector: string;
  at: string;
  category: Category;
  headline: string;
  summary: string | null; // one line, from the filing itself
  why: string | null; // why it matters to a holder
  score: number; // 0-100 materiality
  tier: Tier;
  pdf: string | null;
  related: { id: string; headline: string; pdf: string | null; at: string }[]; // collapsed duplicates
  enrichment?: Enrichment;
};

export type DayStat = { date: string; close: number; chg: number; vol: number; volX: number };

export type Quote = {
  symbol: string;
  name: string;
  sector: string;
  close: number;
  chg: number; // % vs previous close
  volX: number; // today's volume / 20-day average
  hi52: number;
  lo52: number;
  spark: number[]; // last 60 closes
  days: DayStat[]; // last 30 sessions, for client-side threshold alerts
};

export type Digest = {
  generatedAt: string;
  asOf: string; // last EOD session date
  windowDays: number;
  items: DigestItem[];
  quotes: Quote[];
  errors: string[];
  cost: { calls: number; cached: number; inTokens: number; outTokens: number; byTier: Record<string, number> };
};
