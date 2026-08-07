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

export function shortSha(sha) {
  return sha ? String(sha).slice(0, 7) : null;
}
