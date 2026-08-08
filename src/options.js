import { loadConfig, saveConfig, parseRepo, ensureHostPermission } from "./lib/config.js";
import { checkToken } from "./lib/github-api.js";
import { permissionHint } from "./lib/rest.js";

const fields = {
  repos: document.getElementById("repos"),
  token: document.getElementById("token"),
  authMode: document.getElementById("authMode"),
  host: document.getElementById("host"),
  cacheTtlSeconds: document.getElementById("cacheTtlSeconds"),
};
const savedEl = document.getElementById("saved");
const tokenResultEl = document.getElementById("token-result");

let config = await loadConfig();
fields.repos.value = config.repos.join("\n");
fields.token.value = config.token;
fields.authMode.value = config.authMode;
fields.host.value = config.host;
fields.cacheTtlSeconds.value = config.cacheTtlSeconds;

document.getElementById("save").addEventListener("click", save);
document.getElementById("test").addEventListener("click", test);

function collect() {
  const repos = fields.repos.value
    .split("\n")
    .map((line) => parseRepo(line))
    .filter(Boolean)
    .map(({ owner, repo }) => `${owner}/${repo}`);

  return {
    repos: [...new Set(repos)],
    token: fields.token.value.trim(),
    authMode: fields.authMode.value,
    host: fields.host.value.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "") || "github.com",
    cacheTtlSeconds: clamp(Number(fields.cacheTtlSeconds.value) || 0, 0, 3600),
  };
}

async function save() {
  const next = collect();

  if (!(await ensureHostPermission(next))) {
    return note(savedEl, `Permission for ${next.host} was declined`, "error");
  }

  await saveConfig(next);
  // Drop cached results so the next popup reflects the new settings.
  await chrome.storage.local.remove("cache");
  config = next;

  // Show back exactly what was stored, so dropped or normalised lines are visible.
  fields.repos.value = next.repos.join("\n");
  fields.host.value = next.host;
  fields.cacheTtlSeconds.value = next.cacheTtlSeconds;
  note(savedEl, `Saved ${next.repos.length} ${next.repos.length === 1 ? "repo" : "repos"}`, "ok");
}

async function test() {
  const next = collect();
  if (!next.token) return note(tokenResultEl, "Enter a token first", "error");

  note(tokenResultEl, "Checking…");
  try {
    if (!(await ensureHostPermission(next))) {
      return note(tokenResultEl, `Permission for ${next.host} was declined`, "error");
    }
    const login = await checkToken(next);
    note(tokenResultEl, `Token works — signed in as ${login}`, "ok");
  } catch (err) {
    const hint = permissionHint(err);
    note(tokenResultEl, [err.message || "Token check failed", hint].filter(Boolean).join(" "), "error");
  }
}

function note(el, text, kind = "") {
  el.textContent = text;
  el.className = `hint result ${kind}`;
  if (kind === "ok" && el === savedEl) {
    setTimeout(() => {
      if (el.textContent === text) el.textContent = "";
    }, 2500);
  }
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}
