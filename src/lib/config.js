// Persisted settings + the derived URLs everything else builds on.

export const DEFAULTS = {
  /** @type {string[]} every configured repo, flattened out of `groups` */
  repos: [],
  /**
   * Repos as the user arranged them.
   * @type {Array<{name: string|null, repos: string[]}>}
   */
  groups: [],
  /** Personal access token, used when session auth is unavailable. */
  token: "",
  /** "auto" | "session" | "pat" */
  authMode: "auto",
  /** Hostname, so GitHub Enterprise Server installs work too. */
  host: "github.com",
  /** How long a fetched result stays fresh, in seconds. */
  cacheTtlSeconds: 120,
};

export async function loadConfig() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const config = { ...DEFAULTS, ...stored };

  // Installs that predate grouping have a flat list and no groups.
  if (!config.groups.length && config.repos.length) {
    config.groups = [{ name: null, repos: config.repos }];
  }
  return config;
}

/**
 * Parse the repo textarea. A line ending in a colon opens a group; repos
 * listed before any such line stay ungrouped. Repo URLs contain colons but
 * never end with one, so the two can't be confused.
 *
 *   System 1:
 *     my-org/api
 *     my-org/web
 *
 * @returns {Array<{name: string|null, repos: string[]}>}
 */
export function parseRepoList(text) {
  const groups = [];
  let current = null;

  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    const header = line.match(/^(.+?)\s*:$/);
    if (header) {
      current = { name: header[1].trim(), repos: [] };
      groups.push(current);
      continue;
    }

    const parsed = parseRepo(line);
    if (!parsed) continue;

    if (!current) {
      current = { name: null, repos: [] };
      groups.unshift(current);
    }
    const key = `${parsed.owner}/${parsed.repo}`;
    if (!current.repos.includes(key)) current.repos.push(key);
  }

  return groups.filter((group) => group.repos.length);
}

/** Render groups back to the textarea, so a save shows what was kept. */
export function formatRepoList(groups) {
  return groups
    .map((group) => (group.name ? `${group.name}:\n${group.repos.join("\n")}` : group.repos.join("\n")))
    .join("\n\n");
}

/** Every repo across every group, in order. */
export function flattenGroups(groups) {
  return [...new Set(groups.flatMap((group) => group.repos))];
}

export async function saveConfig(patch) {
  await chrome.storage.local.set(patch);
}

/** Base URL for the human-facing site. */
export function webBase(config) {
  return `https://${config.host}`;
}

/** Base URL for the REST API — github.com and GHES differ here. */
export function apiBase(config) {
  return config.host === "github.com"
    ? "https://api.github.com"
    : `https://${config.host}/api/v3`;
}

export function deploymentsUrl(config, owner, repo) {
  return `${webBase(config)}/${owner}/${repo}/deployments`;
}

/** GitHub's page for one environment, showing its latest deployment. */
export function environmentUrl(config, owner, repo, environment) {
  return `${deploymentsUrl(config, owner, repo)}/${encodeURIComponent(environment)}`;
}

/**
 * Split "org/repo" (or a full URL to one) into its parts.
 * @returns {{owner: string, repo: string}|null}
 */
export function parseRepo(entry) {
  const cleaned = String(entry || "")
    .trim()
    .replace(/^https?:\/\/[^/]+\//, "")
    .replace(/\.git$/, "")
    .replace(/^\/+|\/+$/g, "");
  const m = cleaned.match(/^([\w.-]+)\/([\w.-]+)/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/**
 * Host permissions are static for github.com; a custom host needs a grant.
 * Call this synchronously from a click handler — Chrome only shows the prompt
 * during a user gesture, and an earlier `await` would spend it.
 */
export function ensureHostPermission(config) {
  if (config.host === "github.com") return Promise.resolve(true);
  // Already-granted origins resolve true without prompting.
  return chrome.permissions.request({ origins: [`https://${config.host}/*`] });
}
