// Session path: fetch GitHub's own pages with the browser's cookies and read
// the deployments out of them. No token needed, but these pages are
// unversioned markup — everything brittle is confined to this file, and the
// PAT path in github-api.js stays available as the accurate fallback.
//
// Two strategies per page, in order:
//   1. the JSON payload GitHub embeds for its React views — real state strings,
//      survives visual redesigns;
//   2. the rendered DOM, anchored on the most stable links on the page.

import { deploymentsUrl, webBase } from "./config.js";
import { emptyDeployment } from "./deployment.js";
import { bucketOf, stateFromText } from "./state.js";

export class NotAuthenticatedError extends Error {}
export class UnparseableError extends Error {}

export async function fetchRepoEnvironments(config, owner, repo, { signal } = {}) {
  const html = await getPage(deploymentsUrl(config, owner, repo), { signal });
  const repoUrl = `${webBase(config)}/${owner}/${repo}`;
  const found = fromEmbeddedJson(html, (data) => collectEnvironments(data, repoUrl)) ||
    fromDom(html, (doc) => environmentsFromDom(doc, repoUrl));
  if (!found) throw new UnparseableError("Could not read environments from the page");
  return found;
}

/** Past deployments for one environment, scraped from its activity log. */
export async function fetchDeployments(config, owner, repo, environment, limit, { signal } = {}) {
  const repoUrl = `${webBase(config)}/${owner}/${repo}`;
  const url = `${repoUrl}/deployments/activity_log?environments_filter=${encodeURIComponent(environment)}`;
  const html = await getPage(url, { signal });

  const found = fromEmbeddedJson(html, (data) => collectDeployments(data, repoUrl)) ||
    fromDom(html, (doc) => deploymentsFromDom(doc, repoUrl));
  if (!found) throw new UnparseableError("Could not read the activity log");
  return found.slice(0, limit);
}

async function getPage(url, { signal }) {
  const res = await fetch(url, {
    signal,
    credentials: "include",
    headers: { Accept: "text/html" },
  });

  if (res.status === 404) {
    // GitHub 404s private repos for signed-out requests too, so this is
    // ambiguous — say so rather than guessing.
    throw new NotAuthenticatedError("Not found — private repo, or not signed in");
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const html = await res.text();
  if (looksSignedOut(html, res.url)) {
    throw new NotAuthenticatedError("Not signed in to GitHub in this browser");
  }
  return html;
}

function looksSignedOut(html, finalUrl) {
  if (/\/login($|\?)/.test(finalUrl || "")) return true;
  return /<form[^>]+action="\/session"/.test(html);
}

// --- strategy plumbing -----------------------------------------------------

function parse(html) {
  return new DOMParser().parseFromString(html, "text/html");
}

function fromEmbeddedJson(html, collect) {
  const doc = parse(html);
  for (const script of doc.querySelectorAll('script[type="application/json"]')) {
    let data;
    try {
      data = JSON.parse(script.textContent);
    } catch {
      continue;
    }
    const found = collect(data);
    if (found.length) return found;
  }
  return null;
}

function fromDom(html, collect) {
  const found = collect(parse(html));
  return found.length ? found : null;
}

// --- embedded JSON ---------------------------------------------------------

const NAME_KEYS = ["name", "environmentName", "environment"];
const STATE_KEYS = ["state", "status", "latestStatus", "currentState", "lastDeploymentState"];
const TIME_KEYS = ["updatedAt", "updated_at", "createdAt", "created_at", "timestamp"];
const ACTOR_KEYS = ["creator", "actor", "triggeredBy", "user", "author"];
const SHA_KEYS = ["sha", "oid", "commitOid", "commit_oid", "abbreviatedOid", "commitSha"];

/**
 * Walk an arbitrary payload, yielding every object it contains, once, in
 * document order — callers rely on "first match wins" meaning the first one
 * GitHub listed, so children go on the stack reversed.
 */
function* walk(root) {
  const seen = new Set();
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    if (!Array.isArray(node)) yield node;
    const children = Object.values(node);
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
}

/** @returns {Array<{name: string, latest: object}>} */
export function collectEnvironments(root, repoUrl = "") {
  const byName = new Map();
  for (const node of walk(root)) {
    const name = firstString(node, NAME_KEYS);
    const state = extractState(node);
    if (!name || !state || byName.has(name)) continue;
    byName.set(name, { name, latest: toDeployment(node, state, repoUrl) });
  }
  return [...byName.values()];
}

/** @returns {object[]} deployments, newest first */
export function collectDeployments(root, repoUrl = "") {
  const found = [];
  const seen = new Set();

  for (const node of walk(root)) {
    const state = extractState(node);
    const sha = firstString(node, SHA_KEYS);
    const when = firstString(node, TIME_KEYS);
    // A deployment record needs a state plus something identifying it;
    // an environment summary carries a name instead and is skipped here.
    if (!state || (!sha && !when)) continue;

    const key = String(node.id ?? `${sha}@${when}`);
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(toDeployment(node, state, repoUrl));
  }

  found.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  return found;
}

function toDeployment(node, state, repoUrl) {
  const sha = firstString(node, SHA_KEYS);
  const actor = extractActor(node);
  const when = firstString(node, TIME_KEYS);

  return emptyDeployment({
    id: node.id ?? null,
    state,
    bucket: bucketOf(state),
    updatedAt: when,
    createdAt: firstString(node, ["createdAt", "created_at"]) || when,
    actor,
    actorUrl: actor ? `${repoUrl.replace(/\/[^/]+\/[^/]+$/, "")}/${actor}` : null,
    sha,
    shaUrl: sha && repoUrl ? `${repoUrl}/commit/${sha}` : null,
    ref: firstString(node, ["ref", "refName", "branch"]),
    description: firstString(node, ["description"]),
    siteUrl: firstString(node, ["environmentUrl", "environment_url", "url"]),
  });
}

function firstString(obj, keys) {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function extractState(obj) {
  for (const key of STATE_KEYS) {
    const value = obj[key];
    if (typeof value === "string" && value.trim() && bucketOf(value) !== "idle") return value;
    if (typeof value === "string" && /^(inactive|destroyed|unknown)$/i.test(value.trim())) {
      return value.trim();
    }
    if (value && typeof value === "object") {
      const nested = firstString(value, ["state", "status"]);
      if (nested) return nested;
    }
  }
  return null;
}

function extractActor(obj) {
  const direct = firstString(obj, ["login"]);
  if (direct) return direct;
  for (const key of ACTOR_KEYS) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value && typeof value === "object") {
      const login = firstString(value, ["login", "name"]);
      if (login) return login;
    }
  }
  return null;
}

// --- rendered DOM ----------------------------------------------------------
// Each environment links to its own activity log; that link is the most stable
// anchor on the deployments page, so we find those and read the card around it.

function environmentsFromDom(doc, repoUrl) {
  const byName = new Map();

  for (const link of doc.querySelectorAll('a[href*="environments_filter="]')) {
    const name = environmentName(link);
    if (!name || byName.has(name)) continue;
    const card = cardFor(link);
    const state = stateFromText(card.textContent);
    byName.set(name, {
      name,
      latest: state ? deploymentFromCard(card, state, repoUrl) : null,
    });
  }
  return [...byName.values()];
}

// On the activity log every row carries a commit link, so those anchor the rows.
function deploymentsFromDom(doc, repoUrl) {
  const found = [];
  const seen = new Set();

  for (const link of doc.querySelectorAll('a[href*="/commit/"]')) {
    const sha = (link.getAttribute("href").match(/\/commit\/([0-9a-f]{7,40})/) || [])[1];
    if (!sha || seen.has(sha)) continue;
    const card = cardFor(link);
    const state = stateFromText(card.textContent);
    if (!state) continue;
    seen.add(sha);
    found.push(deploymentFromCard(card, state, repoUrl));
  }
  return found;
}

function deploymentFromCard(card, state, repoUrl) {
  const time = card.querySelector("relative-time[datetime], time[datetime]");
  const commit = card.querySelector('a[href*="/commit/"]');
  const sha = commit
    ? (commit.getAttribute("href").match(/\/commit\/([0-9a-f]{7,40})/) || [])[1]
    : null;
  const actor = actorFromCard(card);

  return emptyDeployment({
    state,
    bucket: bucketOf(state),
    updatedAt: time?.getAttribute("datetime") || null,
    createdAt: time?.getAttribute("datetime") || null,
    actor,
    actorUrl: actor ? `${webBaseOf(repoUrl)}/${actor}` : null,
    sha,
    shaUrl: sha && repoUrl ? `${repoUrl}/commit/${sha}` : null,
  });
}

/** A profile link is a bare "/login" href — anything deeper is a repo path. */
function actorFromCard(card) {
  for (const link of card.querySelectorAll('a[href^="/"]')) {
    const href = link.getAttribute("href");
    const m = href.match(/^\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/?$/);
    if (m) return m[1];
  }
  return null;
}

function webBaseOf(repoUrl) {
  return repoUrl.replace(/\/[^/]+\/[^/]+$/, "");
}

function environmentName(link) {
  const href = link.getAttribute("href") || "";
  const m = href.match(/environments_filter=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1].replace(/\+/g, " "));
    } catch {
      /* fall through to the link text */
    }
  }
  return link.textContent.trim() || null;
}

/** Widen out from an anchor until we have enough text to hold a status label. */
function cardFor(link) {
  let node = link;
  for (let i = 0; i < 6 && node.parentElement; i++) {
    node = node.parentElement;
    if (node.textContent.replace(/\s+/g, " ").trim().length > 24) return node;
  }
  return node;
}
