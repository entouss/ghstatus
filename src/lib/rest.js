// One authenticated GitHub REST call, shared by every API-backed module.

import { apiBase } from "./config.js";

export class ApiError extends Error {
  constructor(message, status, path = "") {
    super(message);
    this.status = status;
    this.path = path;
  }
}

/**
 * Which token permission an endpoint needs, in the words GitHub's own token
 * screens use — a bare 403 tells the user nothing actionable.
 */
export function permissionFor(path) {
  if (path.includes("/actions/")) return "Actions: Read-only";
  if (path.includes("/environments")) return "Environments: Read-only";
  if (path.includes("/deployments")) return "Deployments: Read-only";
  if (path.startsWith("/user")) return "no repository permission — it only reads the token's owner";
  return "Contents: Read-only";
}

/** A tooltip explaining what to change, or null when the error isn't about access. */
export function permissionHint(err) {
  if (!(err instanceof ApiError)) return null;
  const needed = permissionFor(err.path || "");

  switch (err.status) {
    case 401:
      return [
        "The token was rejected — expired, revoked, or mistyped.",
        "Check it under Settings, using the Test button.",
      ].join("\n");
    case 403:
      return [
        "Forbidden, or the hourly rate limit is spent.",
        `If it is permissions, this call needs ${needed}.`,
        "Fine-grained tokens also need SSO authorised for the org.",
      ].join("\n");
    case 404:
      return [
        "A 404 here almost always means the token cannot see the repository,",
        "since GitHub hides private repos rather than admitting they exist.",
        'Classic tokens need the "repo" scope.',
        `Fine-grained tokens need this repository selected, plus ${needed}.`,
      ].join("\n");
    default:
      return null;
  }
}

export async function api(config, path, { signal } = {}) {
  if (!config.token) throw new ApiError("No token set", 401, path);

  const res = await fetch(`${apiBase(config)}${path}`, {
    signal,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${config.token}`,
    },
  });
  if (res.status === 401) throw new ApiError("Token rejected (401)", 401, path);
  if (res.status === 403) throw new ApiError("Forbidden or rate limited (403)", 403, path);
  if (res.status === 404) throw new ApiError("Not found (404)", 404, path);
  if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status, path);
  return res.json();
}
