// The workflow run behind a deployment, and its jobs.
//
// A deployment status usually carries a log_url pointing straight at the run,
// which is the reliable route. When it doesn't — some tooling puts the deployed
// site in target_url instead — we fall back to looking up runs by commit.

import { api } from "./rest.js";

/** GitHub's own conclusions, mapped onto the dashboard's four buckets. */
const CONCLUSION_BUCKET = {
  success: "ok",
  failure: "bad",
  timed_out: "bad",
  startup_failure: "bad",
  action_required: "busy",
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

/** A job with no conclusion yet is still running, whatever its status says. */
export function jobBucket(job) {
  if (!job.conclusion) return "busy";
  return CONCLUSION_BUCKET[job.conclusion] || "idle";
}

export function describeJob(job) {
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion || null,
    bucket: jobBucket(job),
    startedAt: job.started_at || null,
    completedAt: job.completed_at || null,
    url: job.html_url || null,
  };
}

/** Pull a run id out of a deployment's log/target URL. */
export function runIdFromUrl(url) {
  const m = String(url || "").match(/\/actions\/runs\/(\d+)/);
  return m ? m[1] : null;
}

/**
 * The jobs of the run behind a deployment.
 * @returns {Promise<{runId: string, jobs: Job[]}>}
 */
export async function fetchDeploymentJobs(config, owner, repo, deployment, { signal } = {}) {
  const runId = deployment.runId || (await findRunId(config, owner, repo, deployment, { signal }));
  if (!runId) throw new Error("No Actions run found for this deployment");

  const data = await api(
    config,
    `/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=100&filter=latest`,
    { signal }
  );
  return { runId, jobs: (data.jobs || []).map(describeJob) };
}

/**
 * Last resort: find the run by the commit that was deployed. Several runs can
 * share a commit, so prefer one that actually targeted this environment.
 */
export async function findRunId(config, owner, repo, deployment, { signal } = {}) {
  if (!deployment.sha) return null;

  const query = new URLSearchParams({ head_sha: deployment.sha, per_page: "20" });
  const data = await api(config, `/repos/${owner}/${repo}/actions/runs?${query}`, { signal });
  const runs = data.workflow_runs || [];
  if (!runs.length) return null;

  const environment = deployment.environment;
  const match =
    (environment &&
      runs.find((r) =>
        `${r.name || ""} ${r.display_title || ""}`.toLowerCase().includes(environment.toLowerCase())
      )) ||
    runs[0];
  return String(match.id);
}
