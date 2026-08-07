// Normalisation of the many ways GitHub spells a deployment state, and the
// mapping down to the four buckets the dashboard renders.

/** @typedef {"ok"|"bad"|"busy"|"idle"} Bucket */

export const EMOJI = {
  ok: "\u{1F7E9}", // green
  bad: "\u{1F7E5}", // red
  busy: "\u{1F7E7}", // orange
  idle: "\u{2B1C}", // white
};

export const BUCKET_LABEL = {
  ok: "Success",
  bad: "Failed",
  busy: "In progress",
  idle: "Idle",
};

// Canonical REST API states -> bucket.
const STATE_BUCKET = {
  success: "ok",
  active: "ok",
  failure: "bad",
  error: "bad",
  in_progress: "busy",
  pending: "busy",
  queued: "busy",
  waiting: "busy",
  inactive: "idle",
  destroyed: "idle",
  unknown: "idle",
};

// Phrases as they appear in the rendered deployments page, longest/most
// specific first so "waiting for approval" wins over a bare "waiting".
const PHRASE_STATE = [
  ["waiting for approval", "waiting"],
  ["review required", "waiting"],
  ["pending approval", "waiting"],
  ["in progress", "in_progress"],
  ["deploying", "in_progress"],
  ["queued", "queued"],
  ["pending", "pending"],
  ["waiting", "waiting"],
  ["failure", "failure"],
  ["failed", "failure"],
  ["error", "error"],
  ["destroyed", "destroyed"],
  ["inactive", "inactive"],
  ["active", "success"],
  ["succeeded", "success"],
  ["success", "success"],
  ["deployed", "success"],
];

// When a card mentions several states at once, the most "urgent" one is the
// one worth surfacing: something running now beats a stale failure, which in
// turn beats an older success.
const BUCKET_PRIORITY = { busy: 3, bad: 2, ok: 1, idle: 0 };

/**
 * @param {string|null|undefined} state
 * @returns {Bucket}
 */
export function bucketOf(state) {
  if (!state) return "idle";
  const key = String(state).trim().toLowerCase().replace(/[\s-]+/g, "_");
  return STATE_BUCKET[key] || "idle";
}

/**
 * Pull a deployment state out of free-form card text.
 * @param {string} text
 * @returns {string|null} canonical state, or null if nothing recognisable
 */
export function stateFromText(text) {
  const hay = String(text || "").toLowerCase();
  let best = null;
  for (const [phrase, state] of PHRASE_STATE) {
    if (!hay.includes(phrase)) continue;
    if (!best || BUCKET_PRIORITY[bucketOf(state)] > BUCKET_PRIORITY[bucketOf(best)]) {
      best = state;
    }
  }
  return best;
}

/** Pretty-print a canonical state for the UI. */
export function stateLabel(state) {
  if (!state) return "No deployments";
  return String(state).replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}
