// Persisted settings + the derived URLs everything else builds on.

export const DEFAULTS = {
  /** @type {string[]} entries of the form "org/repo" */
  repos: [],
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
  return { ...DEFAULTS, ...stored };
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
