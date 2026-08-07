// Picks an auth path per repo, caches results, and keeps the popup from
// hammering GitHub with a burst of parallel requests.

import { parseRepo } from "./config.js";
import * as api from "./github-api.js";
import * as html from "./github-html.js";

const CACHE_KEY = "cache";
const CONCURRENCY = 4;

/** @typedef {{key: string, owner: string, repo: string, source: "session"|"pat",
 *   environments: object[], error: string|null, fetchedAt: number}} RepoResult */

export function orderedRepos(config) {
  return config.repos
    .map((entry) => ({ entry, parsed: parseRepo(entry) }))
    .filter((r) => r.parsed)
    .map(({ parsed }) => ({ ...parsed, key: `${parsed.owner}/${parsed.repo}` }));
}

export async function readCache() {
  const { [CACHE_KEY]: cache } = await chrome.storage.local.get(CACHE_KEY);
  return cache || {};
}

async function writeCache(cache) {
  await chrome.storage.local.set({ [CACHE_KEY]: cache });
}

/**
 * Fetch every configured repo, reporting each result as it lands.
 * @param {object} config
 * @param {(result: RepoResult) => void} onResult
 * @param {{force?: boolean, signal?: AbortSignal}} options
 */
export async function loadAll(config, onResult, { force = false, signal } = {}) {
  const repos = orderedRepos(config);
  const cache = await readCache();
  const fresh = Date.now() - config.cacheTtlSeconds * 1000;

  const queue = [...repos];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const { owner, repo, key } = queue.shift();
      const cached = cache[key];
      if (!force && cached && !cached.error && cached.fetchedAt > fresh) {
        onResult(cached);
        continue;
      }
      const result = await loadRepo(config, owner, repo, { signal });
      cache[key] = result;
      onResult(result);
    }
  });

  await Promise.all(workers);
  await writeCache(cache);
}

async function loadRepo(config, owner, repo, { signal }) {
  const key = `${owner}/${repo}`;
  const base = { key, owner, repo, fetchedAt: Date.now() };
  const order = authOrder(config);
  let lastError = null;

  for (const source of order) {
    try {
      const environments =
        source === "pat"
          ? await api.fetchRepoEnvironments(config, owner, repo, { signal })
          : await html.fetchRepoEnvironments(config, owner, repo, { signal });
      environments.sort((a, b) => a.name.localeCompare(b.name));
      return { ...base, source, environments, error: null };
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      lastError = err;
    }
  }

  return {
    ...base,
    source: order[0],
    environments: [],
    error: describe(lastError, order),
  };
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
