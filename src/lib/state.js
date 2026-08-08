// Normalisation of the many ways GitHub spells a deployment state, and the
// mapping down to the four buckets the dashboard renders.

/** @typedef {"ok"|"bad"|"busy"|"waiting"|"idle"} Bucket */

export const EMOJI = {
  ok: "\u{1F7E9}", // green
  bad: "\u{1F7E5}", // red
  busy: "\u{1F7E6}", // blue
  waiting: "\u{1F7E8}", // yellow
  idle: "\u{2B1C}", // white
};

export const BUCKET_LABEL = {
  ok: "Success",
  bad: "Failed",
  busy: "In progress",
  waiting: "Waiting",
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
  waiting: "waiting",
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

// Two different orderings, for two different questions.
//
// CARD_PRIORITY answers "one card mentions several states, which is current?"
// — a run happening now, or one blocked on approval, supersedes the outcome
// printed beside it.
const CARD_PRIORITY = { busy: 4, waiting: 3, bad: 2, ok: 1, idle: 0 };

// SEVERITY answers "several environments, how bad is this repo?" — a broken
// production outranks everything, then something blocked on a human, then a
// deploy that is simply running and will resolve itself.
export const SEVERITY = { bad: 4, waiting: 3, busy: 2, ok: 1, idle: 0 };

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
 * Roll several environment buckets up into the one worth showing on the repo.
 * @param {Bucket[]} buckets
 * @returns {Bucket}
 */
export function mostSevere(buckets) {
  let worst = "idle";
  for (const bucket of buckets) {
    if (SEVERITY[bucket] > SEVERITY[worst]) worst = bucket;
  }
  return worst;
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
    if (!best || CARD_PRIORITY[bucketOf(state)] > CARD_PRIORITY[bucketOf(best)]) {
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
