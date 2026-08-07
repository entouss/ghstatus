// PAT path: the REST API gives us environments, deployments and states as real
// data, so this is the accurate source whenever a token is available.

import { webBase } from "./config.js";
import { describeDeployment } from "./deployment.js";
import { api } from "./rest.js";
import { mapLimit, toJsonSnippet } from "./util.js";

const FANOUT = 4;

/**
 * Every environment of a repo with its current deployment.
 * @returns {Promise<Array<{name: string, latest: import("./deployment.js").Deployment|null}>>}
 */
export async function fetchRepoEnvironments(config, owner, repo, { signal } = {}) {
  const envs = await api(config, `/repos/${owner}/${repo}/environments?per_page=100`, { signal });

  return mapLimit(envs.environments || [], FANOUT, async (env) => {
    const [latest = null] = await fetchDeployments(config, owner, repo, env.name, 1, { signal });
    return { name: env.name, latest, rawJson: environmentJson(env) };
  });
}

function environmentJson(env) {
  return toJsonSnippet({
    environment: {
      id: env.id,
      name: env.name,
      created_at: env.created_at,
      updated_at: env.updated_at,
      protection_rules: (env.protection_rules || []).map((rule) => ({
        type: rule.type,
        wait_timer: rule.wait_timer,
        reviewers: rule.reviewers?.length,
      })),
    },
  });
}

/**
 * Deployment history for one environment, newest first.
 * @returns {Promise<import("./deployment.js").Deployment[]>}
 */
export async function fetchDeployments(config, owner, repo, environment, limit, { signal } = {}) {
  const query = new URLSearchParams({ environment, per_page: String(limit) });
  const deployments = await api(
    config,
    `/repos/${owner}/${repo}/deployments?${query}`,
    { signal }
  );
  const repoUrl = `${webBase(config)}/${owner}/${repo}`;

  return mapLimit(deployments, FANOUT, async (deployment) => {
    // More than one status: GitHub appends an "inactive" one when a later
    // deployment supersedes this, and that one hides both the outcome and the
    // log URL of the status before it.
    const statuses = await api(
      config,
      `/repos/${owner}/${repo}/deployments/${deployment.id}/statuses?per_page=10`,
      { signal }
    );
    return describeDeployment(repoUrl, deployment, statuses);
  });
}

/** Cheap probe so the UI can tell "bad token" from "repo missing". */
export async function checkToken(config) {
  const user = await api(config, "/user");
  return user.login;
}
