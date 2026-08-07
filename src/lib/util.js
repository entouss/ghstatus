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

/**
 * An absolute timestamp, with the month spelled out. A bare toLocaleString()
 * gives "7/8/2026", which is July 8th or 8th July depending on who is reading
 * it — and the wrong reading makes the data look a month out.
 */
export function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
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

const MAX_JSON = 1600;

/**
 * Pretty-print an object for a tooltip. Callers pass a curated shape rather
 * than a raw API response: those carry kilobytes of app metadata that would
 * push the fields worth reading past the cap.
 */
export function toJsonSnippet(value) {
  let text;
  try {
    text = JSON.stringify(value, dropEmpty, 2);
  } catch {
    return null;
  }
  if (!text) return null;
  return text.length > MAX_JSON ? `${text.slice(0, MAX_JSON)}\n  … truncated` : text;
}

function dropEmpty(key, value) {
  return value === null || value === undefined || value === "" ? undefined : value;
}

export function shortSha(sha) {
  return sha ? String(sha).slice(0, 7) : null;
}
