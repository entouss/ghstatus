import { loadConfig, deploymentsUrl, environmentUrl, webBase } from "./lib/config.js";
import {
  loadAll,
  loadHistory,
  loadJobs,
  orderedRepos,
  readCache,
  HISTORY_LIMIT,
} from "./lib/loader.js";
import { deploymentSubtitle } from "./lib/deployment.js";
import { EMOJI, BUCKET_LABEL, stateLabel } from "./lib/state.js";
import { timeAgo, duration, shortSha } from "./lib/util.js";

const reposEl = document.getElementById("repos");
const emptyEl = document.getElementById("empty");
const statusEl = document.getElementById("status");
const refreshEl = document.getElementById("refresh");

const EXPANDED_KEY = "expanded";

let config;
let controller;
/** Which disclosures are open, keyed "owner/repo" and "owner/repo#env". */
let expanded = {};
/** Latest result per repo, so env rows can reach their repo's auth source. */
const results = new Map();

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

  const stored = await chrome.storage.local.get(EXPANDED_KEY);
  expanded = stored[EXPANDED_KEY] || {};

  // Draw rows straight away, filled from cache where we have it, so the popup
  // never opens blank while requests are in flight.
  const cache = await readCache();
  for (const repo of repos) {
    if (cache[repo.key]) results.set(repo.key, cache[repo.key]);
    reposEl.append(renderRepo(repo, cache[repo.key]));
  }

  refresh({ force: false });
}

async function refresh({ force }) {
  controller?.abort();
  controller = new AbortController();

  refreshEl.disabled = true;
  statusEl.textContent = "Loading…";

  try {
    await loadAll(
      config,
      (result) => {
        results.set(result.key, result);
        document.getElementById(rowId(result.key))?.replaceWith(renderRepo(result, result));
      },
      { force, signal: controller.signal }
    );
    statusEl.textContent = `Updated just now`;
  } catch (err) {
    if (err?.name !== "AbortError") statusEl.textContent = err.message || "Failed";
  } finally {
    refreshEl.disabled = false;
  }
}

// --- expansion state -------------------------------------------------------

function isOpen(key) {
  return Boolean(expanded[key]);
}

function setOpen(key, open) {
  if (open) expanded[key] = true;
  else delete expanded[key];
  chrome.storage.local.set({ [EXPANDED_KEY]: expanded });
}

function rowId(key) {
  return `repo-${key.replace(/[^\w-]/g, "_")}`;
}

// --- repo level ------------------------------------------------------------

function renderRepo(repo, result) {
  const box = el("details", { class: "repo", id: rowId(repo.key) });
  if (isOpen(repo.key)) box.open = true;
  box.addEventListener("toggle", () => setOpen(repo.key, box.open));

  const envCount = result?.environments?.length ?? 0;
  const summary = el("summary", { class: "row repo-row" });
  summary.append(
    chevron(),
    el("span", { class: "dot", title: result ? BUCKET_LABEL[result.bucket] : "Loading" },
      result ? EMOJI[result.bucket] : EMOJI.idle),
    repoLabel(repo),
    el("span", { class: "grow" }),
    el("span", { class: "meta" }, repoMeta(result, envCount)),
    openLink(deploymentsUrl(config, repo.owner, repo.repo), "Open deployments page")
  );
  box.append(summary);

  const body = el("div", { class: "body" });
  if (!result) {
    body.append(el("div", { class: "note" }, "Loading…"));
  } else if (result.error) {
    body.append(el("div", { class: "note error" }, result.error));
  } else if (!envCount) {
    body.append(el("div", { class: "note" }, "No environments"));
  } else {
    for (const env of result.environments) body.append(renderEnv(result, env));
  }
  box.append(body);
  return box;
}

function repoLabel(repo) {
  const name = el("span", { class: "repo-name", title: repo.key });
  name.append(el("span", { class: "owner" }, `${repo.owner}/`), repo.repo);
  return name;
}

function repoMeta(result, envCount) {
  if (!result || result.error) return "";
  const parts = [`${envCount} env${envCount === 1 ? "" : "s"}`];
  if (result.updatedAt) parts.push(timeAgo(result.updatedAt));
  if (result.source === "session") parts.push("session");
  return parts.join(" · ");
}

// --- environment level -----------------------------------------------------

function renderEnv(result, env) {
  const key = `${result.key}#${env.name}`;
  const latest = env.latest;
  const bucket = latest?.bucket || "idle";

  const box = el("details", { class: "env" });
  if (isOpen(key)) box.open = true;
  box.addEventListener("toggle", () => {
    setOpen(key, box.open);
    if (box.open) fillDetails(box, result, env);
  });

  const summary = el("summary", { class: "row env-row" });
  const subtitle = latest ? deploymentSubtitle(latest) : null;
  summary.append(
    chevron(),
    el("span", { class: "dot", title: stateTooltip(latest) }, EMOJI[bucket]),
    el("span", { class: "env-name" }, env.name),
    subtitle ? el("span", { class: "tag" }, subtitle) : "",
    el("span", { class: "grow" }),
    branchCell(latest),
    el("span", { class: "meta" }, envMeta(latest)),
    openLink(
      environmentUrl(config, result.owner, result.repo, env.name),
      "Open this environment's latest deployment"
    )
  );
  box.append(summary);

  const body = el("div", { class: "body" });
  body.append(latest ? renderFacts(latest) : el("div", { class: "note" }, "No deployments yet"));
  if (latest) body.append(el("div", { class: "jobs" }));
  body.append(el("div", { class: "history" }));
  box.append(body);

  if (box.open) fillDetails(box, result, env);
  return box;
}

/** Jobs and history load together, in parallel, the first time you expand. */
function fillDetails(box, result, env) {
  fillHistory(box, result, env.name);
  if (env.latest) fillJobs(box, result, env.latest);
}

function envMeta(latest) {
  if (!latest) return "";
  const parts = [];
  if (latest.updatedAt) parts.push(timeAgo(latest.updatedAt));
  if (latest.actor) parts.push(`@${latest.actor}`);
  return parts.join(" · ");
}

function stateTooltip(latest) {
  if (!latest) return "No deployments";
  const parts = [`${stateLabel(latest.state)} (${BUCKET_LABEL[latest.bucket]})`];
  if (latest.inferredState) parts.push("no status reported yet — assumed in progress");
  if (latest.updatedAt) parts.push(new Date(latest.updatedAt).toLocaleString());
  return parts.join("\n");
}

// --- deployment detail -----------------------------------------------------

function renderFacts(d) {
  const dl = el("dl", { class: "facts" });

  addFact(dl, "Status", statusValue(d));
  addFact(dl, "Updated", d.updatedAt ? absolute(d.updatedAt) : null);
  addFact(dl, "Triggered by", d.actor ? maybeLink(d.actorUrl, `@${d.actor}`) : null);
  addFact(dl, "Commit", d.sha ? maybeLink(d.shaUrl, shortSha(d.sha), "mono") : null);
  addFact(dl, refLabel(d), d.ref ? maybeLink(d.refUrl, d.ref, "mono") : null);
  addFact(dl, "Version", d.version ? maybeLink(d.versionUrl, d.version, "mono") : null);
  // These three run long, so they take a row to themselves.
  addFact(dl, "Image", d.image ? maybeLink(d.imageUrl, d.image, "mono wrap") : null, true);
  addFact(dl, "Description", d.description || null, true);

  const links = [];
  if (d.logUrl) links.push(link(d.logUrl, "View logs"));
  if (d.siteUrl) links.push(link(d.siteUrl, "Open environment"));
  if (links.length) {
    addFact(dl, "Links", el("span", { class: "links" }, ...interleave(links, " · ")), true);
  }
  return dl;
}

/** Name the ref for what it is, so "main" and "v2.3.1" aren't both "Ref". */
function refLabel(d) {
  return { tag: "Tag", commit: "Ref commit" }[d.refKind] || "Branch";
}

function statusValue(d) {
  // The state links to the run that produced it, when there is one.
  const span = el("span", {}, `${EMOJI[d.bucket]} `, maybeLink(d.logUrl, stateLabel(d.state)));
  if (d.inferredState) span.append(el("span", { class: "hint" }, " (no status reported)"));
  return span;
}

function addFact(dl, label, value, wide = false) {
  if (value === null || value === undefined || value === "") return;
  const cls = wide ? { class: "wide" } : {};
  dl.append(el("dt", cls, label), el("dd", cls, value));
}

// --- Actions jobs ----------------------------------------------------------

async function fillJobs(box, result, deployment) {
  const container = box.querySelector(".jobs");
  if (!container || container.dataset.loaded === "yes" || container.dataset.loading === "yes") {
    return;
  }
  container.dataset.loading = "yes";
  container.replaceChildren(el("div", { class: "note" }, "Loading jobs…"));

  try {
    const run = await loadJobs(config, result, deployment, { signal: controller?.signal });
    container.replaceChildren(renderJobs(run, result));
    container.dataset.loaded = "yes";
  } catch (err) {
    if (err?.name === "AbortError") return;
    container.replaceChildren(jobsFallback(err, deployment));
  } finally {
    container.dataset.loading = "no";
  }
}

function renderJobs(run, result) {
  const wrap = el("div");
  const runUrl = `${repoUrl(result)}/actions/runs/${run.runId}`;

  wrap.append(
    el("div", { class: "section-head" },
      el("span", {}, "Actions jobs"),
      openLink(runUrl, "Open the workflow run")
    )
  );

  if (!run.jobs.length) {
    wrap.append(el("div", { class: "note" }, "This run reported no jobs"));
    return wrap;
  }

  const list = el("ul", { class: "row-list" });
  for (const job of run.jobs) {
    const item = el("li", { class: "row job-row", title: jobTooltip(job) });
    item.append(
      el("span", { class: "dot" }, EMOJI[job.bucket]),
      maybeLink(job.url, job.name, "job-name"),
      el("span", { class: "grow" }),
      el("span", { class: "meta" }, duration(job.startedAt, job.completedAt))
    );
    list.append(item);
  }
  wrap.append(list);
  return wrap;
}

function jobTooltip(job) {
  const state = job.conclusion || job.status;
  return `${job.name}: ${stateLabel(state)}`;
}

/**
 * Without a token we can't list jobs, but we can still hand over the link to
 * the run when the deployment told us where it is.
 */
function jobsFallback(err, deployment) {
  const wrap = el("div", { class: "note" });
  if (deployment.runUrl) {
    wrap.append(link(deployment.runUrl, "Open the Actions run ↗"), ` — ${err.message}`);
  } else {
    wrap.append(err.message || "Could not load jobs");
  }
  return wrap;
}

// --- history ---------------------------------------------------------------

async function fillHistory(box, result, envName) {
  const container = box.querySelector(".history");
  if (container.dataset.loaded === "yes" || container.dataset.loading === "yes") return;
  container.dataset.loading = "yes";
  container.replaceChildren(el("div", { class: "note" }, "Loading history…"));

  try {
    const deployments = await loadHistory(config, result, envName, { signal: controller?.signal });
    container.replaceChildren(renderHistory(deployments, result, envName));
    container.dataset.loaded = "yes";
  } catch (err) {
    if (err?.name === "AbortError") return;
    container.replaceChildren(el("div", { class: "note error" }, historyError(err, result)));
  } finally {
    container.dataset.loading = "no";
  }
}

function renderHistory(deployments, result, envName) {
  const wrap = el("div");
  wrap.append(
    el("div", { class: "section-head" },
      el("span", {}, `Past deployments`),
      openLink(activityUrl(result, envName), "Open activity log")
    )
  );

  // The newest entry is already spelled out in the facts above.
  const past = deployments.slice(1);
  if (!past.length) {
    wrap.append(el("div", { class: "note" }, "No earlier deployments"));
    return wrap;
  }

  const list = el("ul", { class: "row-list" });
  for (const d of past) {
    const item = el("li", { class: "row history-row", title: stateTooltip(d) });
    const label = deploymentSubtitle(d, { hasShaColumn: true }) || stateLabel(d.state);
    item.append(
      el("span", { class: "dot" }, EMOJI[d.bucket]),
      el("span", { class: "tag" }, label),
      el("span", { class: "grow" }),
      branchCell(d),
      d.sha ? link(d.shaUrl, shortSha(d.sha), "sha mono") : el("span", { class: "sha mono" }, "—"),
      el("span", { class: "meta" }, envMeta(d)),
      // Straight to the job that deployed, falling back to the whole run when
      // we could not resolve one.
      jobLink(d)
    );
    list.append(item);
  }
  wrap.append(list);

  if (deployments.length >= HISTORY_LIMIT) {
    wrap.append(el("div", { class: "hint" }, `Showing the latest ${HISTORY_LIMIT}.`));
  }
  return wrap;
}

function jobLink(d) {
  if (d.jobUrl) return openLink(d.jobUrl, "Open the Actions job that deployed this");
  if (d.runUrl) return openLink(d.runUrl, "Open the Actions run");
  return el("span", { class: "open" });
}

function historyError(err, result) {
  if (result.source === "session") {
    return `Could not read the activity log (${err.message}). A token in options gives reliable history.`;
  }
  return err.message || "Could not load history";
}

function activityUrl(result, envName) {
  return `${deploymentsUrl(config, result.owner, result.repo)}/activity_log?environments_filter=${encodeURIComponent(envName)}`;
}

function repoUrl(result) {
  return `${webBase(config)}/${result.owner}/${result.repo}`;
}

// --- small DOM helpers -----------------------------------------------------

function chevron() {
  return el("span", { class: "chev", "aria-hidden": "true" }, "›");
}

/** Rendered even when empty, so the column stays put down the list. */
function branchCell(d) {
  const cell = el("span", { class: "branch" });
  if (d?.ref) {
    cell.title = `${refLabel(d)}: ${d.ref}`;
    cell.append(maybeLink(d.refUrl, d.ref, "mono"));
  }
  return cell;
}

function absolute(value) {
  const node = el("span", { title: new Date(value).toLocaleString() }, timeAgo(value));
  return node;
}

/** Link the value when we know where it points, plain text when we don't. */
function maybeLink(href, text, className = "") {
  if (!href) return className ? el("span", { class: className }, text) : text;
  return link(href, text, className);
}

function link(href, text, className = "") {
  const a = el("a", { href, target: "_blank", rel: "noreferrer" }, text);
  if (className) a.className = className;
  // Anchors inside a <summary> would otherwise toggle the disclosure too.
  a.addEventListener("click", (e) => e.stopPropagation());
  return a;
}

function openLink(href, title) {
  const a = link(href, "↗");
  a.className = "open";
  a.title = title;
  return a;
}

function interleave(nodes, separator) {
  return nodes.flatMap((node, i) => (i ? [separator, node] : [node]));
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children.filter((c) => c !== "" && c !== null && c !== undefined));
  return node;
}
