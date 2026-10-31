export function Loading() {
  return (
    <main className="px-4 pt-16" aria-busy>
      <div className="pulse h-8 w-2/3 rounded bg-[var(--rule)]" />
      <div className="pulse mt-3 h-8 w-1/2 rounded bg-[var(--rule)]" />
    </main>
  );
}
export function Empty({ title, body }: { title: string; body: string }) {
  return (
    <main className="px-4 pt-16">
      <h1 className="text-[24px] font-bold">{title}</h1>
      <p className="mt-2 text-ink-2">{body}</p>
    </main>
  );
}
