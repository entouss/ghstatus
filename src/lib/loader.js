// Picks an auth path per repo, rolls environments up to a repo status, caches
// results, and keeps the popup from hammering GitHub with a burst of requests.

import { parseRepo } from "./config.js";
import * as api from "./github-api.js";
import * as html from "./github-html.js";
import { mostSevere } from "./state.js";
import { mapLimit } from "./util.js";

const CACHE_KEY = "cache";
const HISTORY_KEY = "historyCache";
const CONCURRENCY = 4;
export const HISTORY_LIMIT = 10;

/**
 * @typedef {object} RepoResult
 * @property {string} key "owner/repo"
 * @property {string} owner
 * @property {string} repo
 * @property {"session"|"pat"} source
 * @property {Array<{name: string, latest: object|null}>} environments
 * @property {string} bucket       rolled-up worst state across environments
 * @property {string|null} updatedAt most recent deployment update in the repo
 * @property {string|null} error
 * @property {number} fetchedAt
 */

export function orderedRepos(config) {
  return config.repos
    .map(parseRepo)
    .filter(Boolean)
    .map(({ owner, repo }) => ({ owner, repo, key: `${owner}/${repo}` }));
}

export async function readCache() {
  const { [CACHE_KEY]: cache } = await chrome.storage.local.get(CACHE_KEY);
  return cache || {};
}

/**
 * Fetch every configured repo, reporting each result as it lands.
 * @param {(result: RepoResult) => void} onResult
 */
export async function loadAll(config, onResult, { force = false, signal } = {}) {
  const repos = orderedRepos(config);
  const cache = await readCache();
  const freshAfter = Date.now() - config.cacheTtlSeconds * 1000;

  await mapLimit(repos, CONCURRENCY, async ({ owner, repo, key }) => {
    const cached = cache[key];
    if (!force && cached && !cached.error && cached.fetchedAt > freshAfter) {
      onResult(cached);
      return;
    }
    const result = await loadRepo(config, owner, repo, { signal });
    cache[key] = result;
    onResult(result);
  });

  if (force) await chrome.storage.local.remove(HISTORY_KEY);
  await chrome.storage.local.set({ [CACHE_KEY]: cache });
}

async function loadRepo(config, owner, repo, { signal }) {
  const key = `${owner}/${repo}`;
  const base = { key, owner, repo, fetchedAt: Date.now() };
  const order = authOrder(config);
  let lastError = null;

  for (const source of order) {
    try {
      const environments = await client(source).fetchRepoEnvironments(config, owner, repo, { signal });
      environments.sort((a, b) => a.name.localeCompare(b.name));
      return { ...base, source, environments, ...rollUp(environments), error: null };
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      lastError = err;
    }
  }

  return {
    ...base,
    source: order[0] || "session",
    environments: [],
    bucket: "idle",
    updatedAt: null,
    error: describe(lastError, order),
  };
}

/**
 * Past deployments for one environment. Fetched only when the user expands it,
 * and cached separately so collapsing and reopening the popup stays instant.
 */
export async function loadHistory(config, result, environment, { signal } = {}) {
  const cacheKey = `${result.key}#${environment}`;
  const { [HISTORY_KEY]: cache = {} } = await chrome.storage.local.get(HISTORY_KEY);
  const cached = cache[cacheKey];
  if (cached && cached.fetchedAt > Date.now() - config.cacheTtlSeconds * 1000) {
    return cached.deployments;
  }

  const deployments = await client(result.source).fetchDeployments(
    config,
    result.owner,
    result.repo,
    environment,
    HISTORY_LIMIT,
    { signal }
  );

  cache[cacheKey] = { deployments, fetchedAt: Date.now() };
  await chrome.storage.local.set({ [HISTORY_KEY]: cache });
  return deployments;
}

/** Worst state across environments, and the freshest update among them. */
function rollUp(environments) {
  const deployments = environments.map((e) => e.latest).filter(Boolean);
  return {
    bucket: mostSevere(deployments.map((d) => d.bucket)),
    updatedAt: deployments
      .map((d) => d.updatedAt)
      .filter(Boolean)
      .sort()
      .pop() || null,
  };
}

function client(source) {
  return source === "pat" ? api : html;
}

/** Which auth paths to try, best first. */
function authOrder(config) {
  const hasToken = Boolean(config.token);
  if (config.authMode === "pat") return hasToken ? ["pat"] : [];
  if (config.authMode === "session") return ["session"];
  // auto: the token is the accurate source, the session is the no-setup one.
  return hasToken ? ["pat", "session"] : ["session"];
}

function describe(err, order) {
  if (!order.length) return "No token set — add one in options, or switch to session auth";
  if (!err) return "Unknown error";
  if (err instanceof html.NotAuthenticatedError) {
    return `${err.message}. Sign in to GitHub, or add a token in options.`;
  }
  if (err instanceof html.UnparseableError) {
    return "GitHub's page layout changed — add a token in options to use the API instead.";
  }
  return err.message || String(err);
}
