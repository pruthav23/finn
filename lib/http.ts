// Small fetch helper: browser-like headers, timeout, retry with backoff.
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

export async function get(
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs?: number; retries?: number } = {},
): Promise<Response> {
  const { headers = {}, timeoutMs = 20000, retries = 2 } = opts;
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", ...headers },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "follow",
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status} ${url}`);
      return res;
    } catch (e) {
      lastErr = e;
      if (i < retries) await sleep(800 * 2 ** i);
    }
  }
  throw lastErr;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run async tasks with bounded concurrency, preserving order. */
export async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}
