// PAT path: the REST API gives us environments, deployments and states as real
// data, so this is the accurate source whenever a token is available.

import { webBase } from "./config.js";
import { describeDeployment } from "./deployment.js";
import { api } from "./rest.js";
import { mapLimit } from "./util.js";

const FANOUT = 4;

/**
 * Every environment of a repo with its current deployment.
 * @returns {Promise<Array<{name: string, latest: import("./deployment.js").Deployment|null}>>}
 */
export async function fetchRepoEnvironments(config, owner, repo, { signal } = {}) {
  const envs = await api(config, `/repos/${owner}/${repo}/environments?per_page=100`, { signal });
  const names = (envs.environments || []).map((e) => e.name);

  return mapLimit(names, FANOUT, async (name) => {
    const [latest = null] = await fetchDeployments(config, owner, repo, name, 1, { signal });
    return { name, latest };
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
    const statuses = await api(
      config,
      `/repos/${owner}/${repo}/deployments/${deployment.id}/statuses?per_page=1`,
      { signal }
    );
    return describeDeployment(repoUrl, deployment, statuses[0]);
  });
}

/** Cheap probe so the UI can tell "bad token" from "repo missing". */
export async function checkToken(config) {
  const user = await api(config, "/user");
  return user.login;
}
