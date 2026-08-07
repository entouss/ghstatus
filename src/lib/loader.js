// Picks an auth path per repo, rolls environments up to a repo status, caches
// results, and keeps the popup from hammering GitHub with a burst of requests.

import { parseRepo, webBase } from "./config.js";
import * as actions from "./github-actions.js";
import * as api from "./github-api.js";
import * as html from "./github-html.js";
import { mostSevere } from "./state.js";
import { mapLimit } from "./util.js";

const CACHE_KEY = "cache";
const HISTORY_KEY = "historyCache";
const JOBS_KEY = "jobsCache";
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

  if (force) await chrome.storage.local.remove([HISTORY_KEY, JOBS_KEY]);
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
  await attachJobLinks(config, result, deployments, { signal });

  cache[cacheKey] = { deployments, fetchedAt: Date.now() };
  await chrome.storage.local.set({ [HISTORY_KEY]: cache });
  return deployments;
}

/**
 * Point each past deployment at the job that deployed it.
 *
 * Only some deployment statuses name their run in log_url; plenty carry no URL
 * at all, so those have to be found by the commit they deployed before their
 * jobs can be read. Both lookups are deduplicated and bounded, and a failure in
 * either is not worth failing the history over — the row just falls back to a
 * wider link.
 */
async function attachJobLinks(config, result, deployments, { signal }) {
  if (!config.token) return;

  await findMissingRuns(config, result, deployments, { signal });

  const runIds = [...new Set(deployments.map((d) => d.runId).filter(Boolean))];
  if (!runIds.length) return;

  const jobsByRun = new Map();
  await mapLimit(runIds, CONCURRENCY, async (runId) => {
    try {
      jobsByRun.set(runId, await actions.fetchRunJobs(config, result.owner, result.repo, runId, { signal }));
    } catch (err) {
      if (err?.name === "AbortError") throw err;
    }
  });

  for (const deployment of deployments) {
    const jobs = jobsByRun.get(deployment.runId);
    if (!jobs) continue;
    // A job link already taken from "View logs" is the authoritative one — look
    // it up by URL so we can name it, rather than re-picking a different job.
    const job =
      jobs.find((candidate) => candidate.url === deployment.jobUrl) ||
      actions.pickDeployJob(jobs, deployment);
    deployment.jobUrl = job?.url || deployment.jobUrl || null;
    deployment.jobName = job?.name || null;
    deployment.workflowName = job?.workflowName || deployment.workflowName || null;
    deployment.jobJson = job?.rawJson || null;
  }
}

/** Fill in runId/runUrl for deployments whose status never named a run. */
async function findMissingRuns(config, result, deployments, { signal }) {
  // One lookup per commit, not per deployment: redeploys of the same commit
  // are common and they resolve to the same run.
  const bySha = new Map();
  for (const d of deployments) {
    if (!d.runId && d.sha && !bySha.has(d.sha)) bySha.set(d.sha, d);
  }
  if (!bySha.size) return;

  const runBySha = new Map();
  await mapLimit([...bySha.values()], CONCURRENCY, async (deployment) => {
    try {
      const run = await actions.findRun(config, result.owner, result.repo, deployment, { signal });
      if (run) runBySha.set(deployment.sha, run);
    } catch (err) {
      if (err?.name === "AbortError") throw err;
    }
  });

  const base = `${webBase(config)}/${result.owner}/${result.repo}`;
  for (const deployment of deployments) {
    if (deployment.runId) continue;
    const run = runBySha.get(deployment.sha);
    if (!run) continue;
    deployment.runId = run.id;
    deployment.runUrl = `${base}/actions/runs/${run.id}`;
    deployment.workflowName = run.workflowName;
  }
}

/**
 * The Actions jobs behind one deployment. Needs the API — there is no reliable
 * way to read a run's jobs out of the rendered page — so this is the one place
 * a token is required rather than merely preferred.
 */
export async function loadJobs(config, result, deployment, { signal } = {}) {
  if (!config.token) {
    throw new Error("Actions jobs need a token — add one in options");
  }

  const cacheKey = `${result.key}#${deployment.id ?? deployment.sha}`;
  const { [JOBS_KEY]: cache = {} } = await chrome.storage.local.get(JOBS_KEY);
  const cached = cache[cacheKey];
  if (cached && cached.fetchedAt > Date.now() - config.cacheTtlSeconds * 1000) {
    return cached.run;
  }

  const run = await actions.fetchDeploymentJobs(
    config,
    result.owner,
    result.repo,
    deployment,
    { signal }
  );

  cache[cacheKey] = { run, fetchedAt: Date.now() };
  await chrome.storage.local.set({ [JOBS_KEY]: cache });
  return run;
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
