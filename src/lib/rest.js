// One authenticated GitHub REST call, shared by every API-backed module.

import { apiBase } from "./config.js";

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function api(config, path, { signal } = {}) {
  if (!config.token) throw new ApiError("No token set", 401);

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
