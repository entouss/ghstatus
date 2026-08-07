// Session path: fetch the deployments page with the browser's own github.com
// cookies and read the environments out of it. No token needed, but the page
// is unversioned markup — everything brittle is confined to this file, and the
// PAT path in github-api.js stays available as the accurate fallback.

import { deploymentsUrl } from "./config.js";
import { bucketOf, stateFromText } from "./state.js";

export class NotAuthenticatedError extends Error {}
export class UnparseableError extends Error {}

export async function fetchRepoEnvironments(config, owner, repo, { signal } = {}) {
  const url = deploymentsUrl(config, owner, repo);
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
  return parseDeploymentsHtml(html);
}

function looksSignedOut(html, finalUrl) {
  if (/\/login($|\?)/.test(finalUrl || "")) return true;
  return /<form[^>]+action="\/session"/.test(html);
}

/**
 * @param {string} html
 * @returns {Array<{name: string, state: string|null, bucket: string, updatedAt: string|null}>}
 */
export function parseDeploymentsHtml(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const found = fromEmbeddedJson(doc) || fromDom(doc);
  if (!found) {
    throw new UnparseableError("Could not read environments from the page");
  }
  return found;
}

// --- strategy 1: the React payload GitHub embeds in the page ---------------
// Preferred when present: it carries real state strings rather than rendered
// labels, and survives visual redesigns.

function fromEmbeddedJson(doc) {
  const scripts = doc.querySelectorAll('script[type="application/json"]');
  for (const script of scripts) {
    let data;
    try {
      data = JSON.parse(script.textContent);
    } catch {
      continue;
    }
    const envs = collectEnvironments(data);
    if (envs.length) return envs;
  }
  return null;
}

const NAME_KEYS = ["name", "environmentName", "environment"];
const STATE_KEYS = ["state", "status", "latestStatus", "currentState", "lastDeploymentState"];

export function collectEnvironments(root) {
  /** @type {Map<string, object>} */
  const byName = new Map();
  const seen = new Set();

  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }

    const name = firstString(node, NAME_KEYS);
    const state = extractState(node);
    if (name && state && !byName.has(name)) {
      byName.set(name, {
        name,
        state,
        bucket: bucketOf(state),
        updatedAt: firstString(node, ["updatedAt", "createdAt", "updated_at", "created_at"]),
      });
    }
    Object.values(node).forEach(visit);
  };

  visit(root);
  return [...byName.values()];
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
    if (typeof value === "string" && bucketOf(value) !== "idle") return value;
    if (typeof value === "string" && /^(inactive|destroyed|unknown)$/i.test(value)) return value;
    if (value && typeof value === "object") {
      const nested = firstString(value, ["state", "status"]);
      if (nested) return nested;
    }
  }
  return null;
}

// --- strategy 2: read the rendered cards -----------------------------------
// Each environment links to its own activity log; that link is the most stable
// anchor on the page, so we find those and read the surrounding card text.

function fromDom(doc) {
  const links = doc.querySelectorAll('a[href*="environments_filter="]');
  /** @type {Map<string, object>} */
  const byName = new Map();

  for (const link of links) {
    const name = environmentName(link);
    if (!name || byName.has(name)) continue;
    const state = stateFromText(cardText(link));
    byName.set(name, {
      name,
      state,
      bucket: bucketOf(state),
      updatedAt: cardTimestamp(link),
    });
  }
  return byName.size ? [...byName.values()] : null;
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
  const text = link.textContent.trim();
  return text || null;
}

/** Widen out from the link until we have enough text to hold a status label. */
function cardText(link) {
  let node = link;
  for (let i = 0; i < 6 && node.parentElement; i++) {
    node = node.parentElement;
    const text = node.textContent.replace(/\s+/g, " ").trim();
    if (text.length > 24) return text;
  }
  return node.textContent.replace(/\s+/g, " ").trim();
}

function cardTimestamp(link) {
  let node = link;
  for (let i = 0; i < 6 && node.parentElement; i++) {
    node = node.parentElement;
    const time = node.querySelector("relative-time[datetime], time[datetime]");
    if (time) return time.getAttribute("datetime");
  }
  return null;
}
