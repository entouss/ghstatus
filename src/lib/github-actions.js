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
    workflowId: run.workflow_id ? String(run.workflow_id) : null,
    workflowName: run.name || null,
    headSha: run.head_sha || null,
    displayTitle: run.display_title || null,
    status: run.status || null,
    conclusion: run.conclusion || null,
    event: run.event || null,
    headBranch: run.head_branch || null,
    createdAt: run.created_at || null,
    updatedAt: run.updated_at || null,
    url: run.html_url || null,
    bucket: runBucket(run),
    rawJson: runJson(run),
  };
}

/** A run carries the same status/conclusion pair a job does. */
export const runBucket = jobBucket;

function runJson(run) {
  return toJsonSnippet({
    run: {
      id: run.id,
      name: run.name,
      workflow_id: run.workflow_id,
      event: run.event,
      status: run.status,
      conclusion: run.conclusion,
      head_branch: run.head_branch,
      head_sha: run.head_sha,
      run_number: run.run_number,
      created_at: run.created_at,
    },
  });
}

/** The workflows the repo defines, whether or not any of them has ever run. */
export async function fetchWorkflows(config, owner, repo, { signal } = {}) {
  const data = await api(config, `/repos/${owner}/${repo}/actions/workflows?per_page=100`, { signal });
  return (data.workflows || []).map(normalizeWorkflow);
}

function normalizeWorkflow(workflow) {
  return {
    id: workflow.id ? String(workflow.id) : null,
    name: workflow.name || null,
    path: workflow.path || null,
    // The last segment addresses the workflow on the web — /actions/workflows/ci.yml.
    file: workflow.path ? workflow.path.split("/").pop() : null,
    state: workflow.state || null,
    rawJson: workflowJson(workflow),
  };
}

function workflowJson(workflow) {
  return toJsonSnippet({
    workflow: {
      id: workflow.id,
      name: workflow.name,
      path: workflow.path,
      state: workflow.state,
      created_at: workflow.created_at,
      updated_at: workflow.updated_at,
    },
  });
}

/**
 * The repo's workflows, each carrying its latest run.
 *
 * The list is the workflows the repo defines — not the runs that happened to
 * be recent. A run's `name` is the run's own title (a `run-name:` can make
 * every run of one workflow read differently), so the name here comes from the
 * definition and the run is joined on `workflow_id`.
 *
 * Ordered by how recently each ran, since that is what you scan for; the ones
 * that have never run sort last, alphabetically.
 */
export function summariseWorkflows(workflows, runs = []) {
  const latest = new Map();
  for (const run of runs) {
    // Runs come back newest first, so the first sighting is the latest run.
    if (run.workflowId && !latest.has(run.workflowId)) latest.set(run.workflowId, run);
  }

  return workflows
    .map((workflow) => {
      const run = (workflow.id && latest.get(workflow.id)) || null;
      return {
        ...workflow,
        run,
        bucket: run ? run.bucket : "idle",
        lastRunAt: run ? run.createdAt : null,
      };
    })
    .sort((a, b) => {
      if (a.lastRunAt && b.lastRunAt) return b.lastRunAt.localeCompare(a.lastRunAt);
      if (a.lastRunAt || b.lastRunAt) return a.lastRunAt ? -1 : 1;
      return (a.name || "").localeCompare(b.name || "");
    });
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

