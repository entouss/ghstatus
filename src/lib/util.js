/** Run `fn` over `items`, at most `limit` in flight, preserving input order. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });

  await Promise.all(workers);
  return results;
}

/** "3m ago" / "2d ago" — compact enough for a chip. */
export function timeAgo(value) {
  if (!value) return "";
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms)) return "";
  if (ms < 0) return "just now";

  const units = [
    ["y", 31536e6],
    ["mo", 2592e6],
    ["d", 864e5],
    ["h", 36e5],
    ["m", 6e4],
  ];
  for (const [suffix, size] of units) {
    if (ms >= size) return `${Math.floor(ms / size)}${suffix} ago`;
  }
  return "just now";
}

/** Elapsed time between two timestamps, as "45s" / "3m 12s" / "1h 04m". */
export function duration(from, to) {
  if (!from || !to) return "";
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";

  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  }
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function shortSha(sha) {
  return sha ? String(sha).slice(0, 7) : null;
}
