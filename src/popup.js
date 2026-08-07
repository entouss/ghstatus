import { loadConfig, deploymentsUrl } from "./lib/config.js";
import { loadAll, orderedRepos, readCache } from "./lib/loader.js";
import { EMOJI, BUCKET_LABEL, stateLabel } from "./lib/state.js";

const reposEl = document.getElementById("repos");
const emptyEl = document.getElementById("empty");
const statusEl = document.getElementById("status");
const refreshEl = document.getElementById("refresh");

let config;
let controller;

document.getElementById("options").addEventListener("click", openOptions);
document.getElementById("empty-options").addEventListener("click", openOptions);
refreshEl.addEventListener("click", () => refresh({ force: true }));

function openOptions() {
  chrome.runtime.openOptionsPage();
}

init();

async function init() {
  config = await loadConfig();
  const repos = orderedRepos(config);

  if (!repos.length) {
    emptyEl.hidden = false;
    statusEl.textContent = "";
    return;
  }

  // Draw the rows straight away, filled from cache where we have it, so the
  // popup never opens blank while requests are in flight.
  const cache = await readCache();
  for (const repo of repos) {
    reposEl.append(renderRepo(repo, cache[repo.key]));
  }

  refresh({ force: false });
}

async function refresh({ force }) {
  controller?.abort();
  controller = new AbortController();

  refreshEl.disabled = true;
  statusEl.textContent = "Loading…";
  const started = Date.now();

  try {
    await loadAll(
      config,
      (result) => {
        const next = renderRepo(result, result);
        document.getElementById(rowId(result.key))?.replaceWith(next);
      },
      { force, signal: controller.signal }
    );
    statusEl.textContent = `Updated ${timeAgo(started)}`;
  } catch (err) {
    if (err?.name !== "AbortError") statusEl.textContent = err.message || "Failed";
  } finally {
    refreshEl.disabled = false;
  }
}

function rowId(key) {
  return `repo-${key.replace(/[^\w-]/g, "_")}`;
}

/**
 * @param {{owner: string, repo: string, key: string}} repo
 * @param {object} [result] cached or freshly fetched data, if any
 */
function renderRepo(repo, result) {
  const row = el("div", { class: "repo", id: rowId(repo.key) });

  const head = el("div", { class: "repo-head" });
  const link = el("a", {
    class: "repo-name",
    href: deploymentsUrl(config, repo.owner, repo.repo),
    target: "_blank",
    rel: "noreferrer",
    title: repo.key,
  });
  link.append(el("span", { class: "owner" }, `${repo.owner}/`), repo.repo);
  head.append(link);
  if (result?.source && !result.error) {
    head.append(el("span", { class: "source" }, result.source === "pat" ? "API" : "session"));
  }
  row.append(head);

  if (!result) {
    row.append(el("div", { class: "skeleton" }, "Loading…"));
    return row;
  }
  if (result.error) {
    row.append(el("div", { class: "note error" }, result.error));
    return row;
  }
  if (!result.environments.length) {
    row.append(el("div", { class: "note" }, "No environments"));
    return row;
  }

  const envs = el("div", { class: "envs" });
  for (const env of result.environments) {
    envs.append(renderEnv(repo, env));
  }
  row.append(envs);
  return row;
}

function renderEnv(repo, env) {
  const url = `${deploymentsUrl(config, repo.owner, repo.repo)}/activity_log?environments_filter=${encodeURIComponent(env.name)}`;
  const chip = el("a", {
    class: "env",
    href: url,
    target: "_blank",
    rel: "noreferrer",
    title: tooltip(env),
  });
  chip.append(
    el("span", { class: "dot" }, EMOJI[env.bucket] || EMOJI.idle),
    el("span", { class: "name" }, env.name)
  );
  return chip;
}

function tooltip(env) {
  const parts = [`${env.name}: ${stateLabel(env.state)}`];
  if (env.state && BUCKET_LABEL[env.bucket] !== stateLabel(env.state)) {
    parts[0] += ` (${BUCKET_LABEL[env.bucket]})`;
  }
  if (env.updatedAt) parts.push(new Date(env.updatedAt).toLocaleString());
  return parts.join("\n");
}

function timeAgo(ts) {
  const seconds = Math.round((Date.now() - ts) / 1000);
  return seconds < 60 ? "just now" : `${Math.round(seconds / 60)}m ago`;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}
