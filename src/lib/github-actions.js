// The workflow run behind a deployment, and its jobs.
//
// A deployment status usually carries a log_url pointing straight at the run,
// which is the reliable route. When it doesn't — some tooling puts the deployed
// site in target_url instead — the run is found by the commit it deployed.

import { api } from "./rest.js";
import { toJsonSnippet } from "./util.js";

/** GitHub's own conclusions, mapped onto the dashboard's four buckets. */
const CONCLUSION_BUCKET = {
  success: "ok",
  failure: "bad",
  timed_out: "bad",
  startup_failure: "bad",
  action_required: "waiting",
  cancelled: "idle",
  skipped: "idle",
  neutral: "idle",
  stale: "idle",
};

/**
 * @typedef {object} Job
 * @property {number} id
 * @property {string} name
 * @property {string} status      queued | in_progress | completed | waiting
 * @property {string|null} conclusion
 * @property {string} bucket
 * @property {string|null} startedAt
 * @property {string|null} completedAt
 * @property {string|null} url
 */

/** A job with no conclusion yet is still running — unless it is blocked on an
 *  approval, which its status says and its conclusion cannot. */
export function jobBucket(job) {
  if (!job.conclusion) return job.status === "waiting" ? "waiting" : "busy";
  return CONCLUSION_BUCKET[job.conclusion] || "idle";
}

export function describeJob(job) {
  return {
    id: job.id,
    name: job.name,
    // The jobs endpoint names the workflow, so we get it without fetching the
    // run itself.
    workflowName: job.workflow_name || null,
    status: job.status,
    conclusion: job.conclusion || null,
    bucket: jobBucket(job),
    startedAt: job.started_at || null,
    completedAt: job.completed_at || null,
    url: job.html_url || null,
    runId: job.run_id ? String(job.run_id) : null,
    rawJson: jobJson(job),
  };
}

/**
 * A Job as JSON, for the tooltip. `status` is where it is in its lifecycle and
 * `conclusion` is how it ended — the pair trips people up, so both are here
 * alongside the steps that make up the job.
 */
function jobJson(job) {
  return toJsonSnippet({
    job: {
      id: job.id,
      name: job.name,
      workflow_name: job.workflow_name,
      run_id: job.run_id,
      run_attempt: job.run_attempt,
      status: job.status,
      conclusion: job.conclusion,
      started_at: job.started_at,
      completed_at: job.completed_at,
      steps: (job.steps || []).map((step) => ({
        name: step.name,
        status: step.status,
        conclusion: step.conclusion,
      })),
    },
  });
}

/** Pull a run id out of a deployment's log/target URL. */
export function runIdFromUrl(url) {
  const m = String(url || "").match(/\/actions\/runs\/(\d+)/);
  return m ? m[1] : null;
}

/** @returns {Promise<Job[]>} */
export async function fetchRunJobs(config, owner, repo, runId, { signal } = {}) {
  const data = await api(
    config,
    `/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=100&filter=latest`,
    { signal }
  );
  return (data.jobs || []).map(describeJob);
}

/**
 * Which job in a run actually did the deploying — the one a past deployment
 * row should link to. A run has build, test and deploy jobs; the interesting
 * one names the environment, or failed, or ran last.
 * @returns {Job|null}
 */
export function pickDeployJob(jobs, deployment = {}) {
  if (!jobs?.length) return null;

  const environment = deployment.environment;
  if (environment) {
    const named = jobs.find((job) =>
      job.name.toLowerCase().includes(environment.toLowerCase())
    );
    if (named) return named;
  }

  // A failed deployment is asking "what broke", so point at what broke.
  if (deployment.bucket === "bad") {
    const failed = jobs.find((job) => job.bucket === "bad");
    if (failed) return failed;
  }

  return jobs[jobs.length - 1];
}

/**
 * The repo's recent runs, in one request. Naming the workflow behind every
 * environment's current deployment costs one call per repo this way, rather
 * than one per environment.
 */
export async function fetchRecentRuns(config, owner, repo, { signal } = {}) {
  const data = await api(config, `/repos/${owner}/${repo}/actions/runs?per_page=100`, { signal });
  return (data.workflow_runs || []).map(normalizeRun);
}

function normalizeRun(run) {
  return {
    id: String(run.id),
    workflowName: run.name || null,
    headSha: run.head_sha || null,
    displayTitle: run.display_title || null,
  };
}

/**
 * Which of those runs deployed this. Same rule as the per-commit search: a run
 * naming the environment beats one that merely shares the commit.
 */
export function pickRunForDeployment(runs, deployment) {
  if (!deployment?.sha) return null;

  const candidates = runs.filter((run) => run.headSha === deployment.sha);
  if (!candidates.length) return null;

  const environment = deployment.environment;
  if (environment) {
    const named = candidates.find((run) =>
      `${run.workflowName || ""} ${run.displayTitle || ""}`
        .toLowerCase()
        .includes(environment.toLowerCase())
    );
    if (named) return named;
  }
  return candidates[0];
}

/**
 * Last resort: find the run by the commit that was deployed. Several runs can
 * share a commit, so prefer one that actually targeted this environment.
 */
export async function findRun(config, owner, repo, deployment, { signal } = {}) {
  if (!deployment.sha) return null;

  const query = new URLSearchParams({ head_sha: deployment.sha, per_page: "20" });
  const data = await api(config, `/repos/${owner}/${repo}/actions/runs?${query}`, { signal });
  // Same selection rule as the dashboard's bulk lookup, so the two paths
  // cannot disagree about which run deployed.
  return pickRunForDeployment((data.workflow_runs || []).map(normalizeRun), deployment);
}

