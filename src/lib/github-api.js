// PAT path: the REST API gives us environments and deployment states as real
// data, so this is the accurate source whenever a token is available.

import { apiBase } from "./config.js";
import { bucketOf } from "./state.js";

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function api(config, path, { signal } = {}) {
  const res = await fetch(`${apiBase(config)}${path}`, {
    signal,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${config.token}`,
    },
  });
  if (res.status === 401) throw new ApiError("Token rejected (401)", 401);
  if (res.status === 403) throw new ApiError("Forbidden or rate limited (403)", 403);
  if (res.status === 404) throw new ApiError("Not found (404)", 404);
  if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status);
  return res.json();
}

/**
 * Latest deployment state for every environment of one repo.
 * @returns {Promise<Array<{name: string, state: string|null, bucket: string,
 *   updatedAt: string|null, url: string|null}>>}
 */
export async function fetchRepoEnvironments(config, owner, repo, { signal } = {}) {
  const envs = await api(config, `/repos/${owner}/${repo}/environments?per_page=100`, { signal });
  const names = (envs.environments || []).map((e) => e.name);

  return Promise.all(
    names.map(async (name) => {
      const status = await latestStatus(config, owner, repo, name, { signal });
      return {
        name,
        state: status?.state ?? null,
        bucket: bucketOf(status?.state),
        updatedAt: status?.updatedAt ?? null,
        url: status?.url ?? null,
      };
    })
  );
}

async function latestStatus(config, owner, repo, environment, { signal }) {
  const q = new URLSearchParams({ environment, per_page: "1" });
  const deployments = await api(
    config,
    `/repos/${owner}/${repo}/deployments?${q}`,
    { signal }
  );
  const deployment = deployments[0];
  if (!deployment) return null;

  const statuses = await api(
    config,
    `/repos/${owner}/${repo}/deployments/${deployment.id}/statuses?per_page=1`,
    { signal }
  );
  const status = statuses[0];
  if (!status) {
    // A deployment with no status yet is still pending work.
    return { state: "pending", updatedAt: deployment.created_at, url: null };
  }
  return {
    state: status.state,
    updatedAt: status.updated_at || status.created_at,
    url: status.target_url || status.environment_url || null,
  };
}

/** Cheap probe so the UI can tell "bad token" from "repo missing". */
export async function checkToken(config) {
  const user = await api(config, "/user");
  return user.login;
}
