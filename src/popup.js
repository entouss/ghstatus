import { loadConfig, deploymentsUrl, environmentUrl, webBase } from "./lib/config.js";
import { loadAll, loadHistory, orderedRepos, readCache, HISTORY_LIMIT } from "./lib/loader.js";
import { deploymentSubtitle } from "./lib/deployment.js";
import { EMOJI, BUCKET_LABEL, stateLabel } from "./lib/state.js";
import { timeAgo, duration, durationMs, formatDuration, formatDate, shortSha } from "./lib/util.js";

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
    el("span", { class: "dot", title: repoTooltip(result, envCount) },
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
    body.append(
      el("div", { class: "note error", title: errorTooltip(result) }, result.error)
    );
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

/** The failure, plus what to change about the token when that is the cause. */
function errorTooltip(result) {
  return [result.error, result.errorHint].filter(Boolean).join("\n\n");
}

function repoTooltip(result, envCount) {
  if (!result) return "Loading…";
  if (result.error) return errorTooltip(result);
  return concept("REPOSITORY", [
    `Rolled up from ${envCount} environment${envCount === 1 ? "" : "s"}:`,
    `the worst state among them is ${BUCKET_LABEL[result.bucket]}.`,
  ]);
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

  const summary = el("summary", { class: "env-row" });
  const subtitle = latest ? deploymentSubtitle(latest) : null;
  const line = el("div", { class: "row" });
  line.append(
    chevron(),
    el("span", { class: "dot", title: stateTooltip(latest) }, EMOJI[bucket]),
    el("span", { class: "env-name", title: concept(ENVIRONMENT, [env.name], env.rawJson) },
      env.name),
    subtitle ? el("span", { class: "tag" }, subtitle) : "",
    el("span", { class: "grow" }),
    el("span", { class: "meta" }, envMeta(latest)),
    openLink(
      environmentUrl(config, result.owner, result.repo, env.name),
      "Open this environment's latest deployment"
    )
  );
  summary.append(line);

  // The workflow that deployed, visible without expanding the environment.
  if (latest?.workflowName) {
    summary.append(
      el("div", {
        class: "workflow-line env-workflow",
        title: concept(WORKFLOW, [latest.workflowName], latest.jobJson),
      }, latest.workflowName)
    );
  }
  box.append(summary);

  const body = el("div", { class: "body" });
  body.append(latest ? renderFacts(latest) : el("div", { class: "note" }, "No deployments yet"));
  body.append(el("div", { class: "history" }));
  box.append(body);

  if (box.open) fillDetails(box, result, env);
  return box;
}

function fillDetails(box, result, env) {
  fillHistory(box, result, env);
}

function envMeta(latest) {
  if (!latest) return "";
  const parts = [];
  if (latest.updatedAt) parts.push(timeAgo(latest.updatedAt));
  if (latest.actor) parts.push(`@${latest.actor}`);
  return parts.join(" · ");
}

/**
 * Tooltips name the GitHub concept first, then explain, then show the API
 * objects behind it — these terms are easy to mix up, and seeing the JSON is
 * the quickest way to tell which is which.
 */
function concept(name, lines = [], json = null) {
  const parts = [name, ...lines.filter(Boolean)];
  if (json) parts.push("", json);
  return parts.join("\n");
}

const DEPLOYMENT = "DEPLOYMENT — a request to deploy one commit to one environment";
const ENVIRONMENT = "ENVIRONMENT — a named deploy target, with its own protection rules";
const WORKFLOW = "WORKFLOW — the Actions workflow whose run produced this deployment";
const JOB = "JOB — one job inside that workflow run; a job is where the steps run";
const COMMIT = "COMMIT — the code that was deployed";

function stateTooltip(d) {
  if (!d) return concept(DEPLOYMENT, ["None yet for this environment"]);

  const lines = [`Status: ${stateLabel(d.state)} (${BUCKET_LABEL[d.bucket]})`];
  if (d.superseded) {
    lines.push("Superseded — a later deployment replaced this one, so GitHub");
    lines.push("also marked it 'inactive'. The status above is its own outcome.");
  }
  if (d.inferredState) lines.push("No status reported yet — assumed in progress");
  if (d.updatedAt) lines.push(`Updated: ${formatDate(d.updatedAt)}`);
  const took = duration(d.createdAt, d.updatedAt);
  if (took) lines.push(`Took: ${took} from created to final status`);
  if (d.actor) lines.push(`Triggered by: @${d.actor}`);
  return concept(DEPLOYMENT, lines, d.rawJson);
}

// --- deployment detail -----------------------------------------------------

function renderFacts(d) {
  const dl = el("dl", { class: "facts" });

  addFact(dl, "Status", statusValue(d));
  addFact(dl, "Updated", d.updatedAt ? absolute(d.updatedAt) : null);
  addFact(dl, "Triggered by", d.actor ? maybeLink(d.actorUrl, `@${d.actor}`) : null);
  addFact(dl, "Commit", d.sha ? maybeLink(d.shaUrl, shortSha(d.sha), "mono") : null);
  addFact(dl, "Took", deployDuration(d));
  // A workflow name and a job name are both long and unrelated to each other,
  // so neither shares a row.
  addFact(dl, "Workflow", d.workflowName || null, true);
  addFact(dl, "Job", jobFact(d), true);
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

/** The deploying job, with how long it ran when we know. */
function jobFact(d) {
  if (!d.jobName) return null;
  const span = el("span", {}, maybeLink(d.jobUrl, d.jobName, ""));
  const ran = duration(d.jobStartedAt, d.jobCompletedAt);
  if (ran) span.append(el("span", { class: "hint" }, ` · ${ran}`));
  return span;
}

/** How long the deployment itself took: created until its status settled. */
function deployDuration(d) {
  return duration(d.createdAt, d.updatedAt) || null;
}

function statusValue(d) {
  // The state links to the run that produced it, when there is one.
  const span = el("span", {}, `${EMOJI[d.bucket]} `, maybeLink(d.logUrl, stateLabel(d.state)));
  if (d.inferredState) span.append(el("span", { class: "hint" }, " (no status reported)"));
  return span;
}

/** What each field of the detail panel actually is, in GitHub's own terms. */
const FACT_HELP = {
  Status: "DEPLOYMENT STATUS — the outcome reported against this deployment.\nA deployment can collect several; this is the latest meaningful one.",
  Updated: "When that deployment status was set",
  "Triggered by": "The account that created the deployment — often a bot for\nworkflow-driven deploys",
  Commit: COMMIT,
  Version: "Read out of the deployment's free-form payload",
  Image: "Read out of the deployment's free-form payload",
  Description: "Free text set by whatever created the deployment",
  Workflow: WORKFLOW,
  Job: JOB,
  Took: "From the deployment being created to its status settling",
  Links: "URLs carried on the deployment status: log_url and environment_url",
};

function addFact(dl, label, value, wide = false) {
  if (value === null || value === undefined || value === "") return;
  const attrs = { title: FACT_HELP[label] || label };
  if (wide) attrs.class = "wide";
  dl.append(el("dt", attrs, label), el("dd", wide ? { class: "wide" } : {}, value));
}

// --- history ---------------------------------------------------------------

async function fillHistory(box, result, env) {
  const container = box.querySelector(".history");
  if (container.dataset.loaded === "yes" || container.dataset.loading === "yes") return;
  container.dataset.loading = "yes";
  container.replaceChildren(el("div", { class: "note" }, "Loading history…"));

  try {
    const deployments = await loadHistory(config, result, env.name, { signal: controller?.signal });
    // loadHistory resolves the workflow and job for every deployment it
    // returns, including the current one — so the detail panel above can be
    // completed from it without a request of its own.
    refreshFacts(box, env.latest, deployments);
    container.replaceChildren(renderHistory(deployments));
    container.dataset.loaded = "yes";
  } catch (err) {
    if (err?.name === "AbortError") return;
    container.replaceChildren(el("div", { class: "note error" }, historyError(err, result)));
  } finally {
    container.dataset.loading = "no";
  }
}

function renderHistory(deployments) {
  const wrap = el("div");
  // No link on the heading itself — each row below carries its own.
  wrap.append(
    el("div", { class: "section-head" },
      el("span", { title: concept(DEPLOYMENT, [
        "Earlier deployments to this environment, newest first.",
      ]) }, "Past deployments")
    )
  );

  // The newest entry is already spelled out in the facts above.
  const past = deployments.slice(1);
  if (!past.length) {
    wrap.append(el("div", { class: "note" }, "No earlier deployments"));
    return wrap;
  }

  // Bars compare against the slowest job among the deployments we fetched, so
  // the scale is "the last 10", not the handful shown below the current one.
  const slowest = Math.max(
    0,
    ...deployments.map((d) => durationMs(d.jobStartedAt, d.jobCompletedAt))
  );

  const list = el("ul", { class: "row-list" });
  list.append(historyHeader());

  for (const d of past) {
    const item = el("li", { class: "history-row", title: stateTooltip(d) });
    item.append(
      el("div", { class: "row" },
        el("span", { class: "dot" }, EMOJI[d.bucket]),
        el("span", { class: "grow" }),
        d.sha
          ? link(d.shaUrl, shortSha(d.sha), "sha mono", concept(COMMIT, [d.sha]))
          : el("span", { class: "sha mono" }, "—"),
        el("span", { class: "meta" }, envMeta(d)),
        // Straight to the job that deployed, falling back to the whole run when
        // we could not resolve one.
        jobLink(d)
      )
    );
    // The job goes on its own line: names like "deploy / terraform apply" need
    // more room than a column can give them.
    if (d.workflowName) {
      item.append(
        el("div", { class: "workflow-line", title: concept(WORKFLOW, [d.workflowName], d.jobJson) },
          d.workflowName)
      );
    }
    if (d.jobName) {
      const job = el("div", { class: "job", title: concept(JOB, [d.jobName], d.jobJson) });
      job.append(el("span", { class: "job-label" }, d.jobName));
      const ms = durationMs(d.jobStartedAt, d.jobCompletedAt);
      if (ms) {
        job.append(el("span", { class: "hint" }, formatDuration(ms)));
        job.append(durationBar(ms, slowest));
      }
      item.append(job);
    }
    list.append(item);
  }
  wrap.append(list);

  if (deployments.length >= HISTORY_LIMIT) {
    wrap.append(el("div", { class: "hint" }, `Showing the latest ${HISTORY_LIMIT}.`));
  }
  return wrap;
}

/** Column headings, so each value is identifiable without clicking through. */
function historyHeader() {
  const head = el("li", { class: "history-row head" });
  head.append(
    el("div", { class: "row" },
      el("span", { class: "dot" }),
      el("span", { class: "deployment-head" }, "Deployment"),
      el("span", { class: "grow" }),
      el("span", { class: "sha" }, "Commit"),
      el("span", { class: "meta" }, "Deployed"),
      el("span", { class: "open" })
    )
  );
  return head;
}

/**
 * Where a past deployment row points. The job that deployed is the most
 * specific answer; each fallback is a wider view of the same event, so a row
 * is only ever unlinked when GitHub gave us nothing at all.
 */
function jobLink(d) {
  if (d.jobUrl) return openLink(d.jobUrl, "Open the Actions job that deployed this");
  if (d.runUrl) return openLink(d.runUrl, "Open the Actions run");
  if (d.logUrl) return openLink(d.logUrl, "Open the deployment log");
  if (d.shaUrl) return openLink(d.shaUrl, "Open the deployed commit");
  return el("span", { class: "open" });
}

/** Swap in a fuller detail panel once history has named the workflow and job. */
function refreshFacts(box, latest, deployments) {
  if (!latest) return;
  const enriched =
    deployments.find((d) => String(d.id) === String(latest.id)) || deployments[0];
  if (!enriched) return;

  const merged = { ...latest, ...pickResolved(enriched) };
  const facts = box.querySelector(".facts");
  if (facts) facts.replaceWith(renderFacts(merged));
  // The summary above shows the same workflow name; leaving it stale is how
  // the collapsed row ends up contradicting the panel below it.
  setEnvWorkflow(box, merged);
}

/** Keep the environment row's workflow line in step with what we now know. */
function setEnvWorkflow(box, d) {
  const summary = box.querySelector("summary");
  if (!summary) return;

  const existing = summary.querySelector(".env-workflow");
  if (!d.workflowName) {
    existing?.remove();
    return;
  }

  const line =
    existing ||
    summary.appendChild(el("div", { class: "workflow-line env-workflow" }));
  line.textContent = d.workflowName;
  line.title = concept(WORKFLOW, [d.workflowName], d.jobJson);
}

/** Only the fields history resolves — never overwrite the current state. */
function pickResolved(d) {
  return {
    workflowName: d.workflowName,
    jobName: d.jobName,
    jobUrl: d.jobUrl,
    jobJson: d.jobJson,
    jobStartedAt: d.jobStartedAt,
    jobCompletedAt: d.jobCompletedAt,
    runUrl: d.runUrl,
  };
}

/**
 * How this job's duration compares with the slowest of the last 10. A bar
 * makes an outlier obvious in a way a column of times does not.
 */
function durationBar(ms, slowest) {
  const share = slowest > 0 ? ms / slowest : 0;
  const track = el("span", {
    class: "bar",
    title: `${formatDuration(ms)} — ${Math.round(share * 100)}% of the slowest of the last ${HISTORY_LIMIT} (${formatDuration(slowest)})`,
  });
  const fill = el("span", { class: "bar-fill" });
  // A floor keeps a very fast job from rendering as an invisible sliver.
  fill.style.width = `${Math.max(3, share * 100).toFixed(1)}%`;
  track.append(fill);
  return track;
}

function historyError(err, result) {
  if (result.source === "session") {
    return `Could not read the activity log (${err.message}). A token in options gives reliable history.`;
  }
  return err.message || "Could not load history";
}

function repoUrl(result) {
  return `${webBase(config)}/${result.owner}/${result.repo}`;
}

// --- small DOM helpers -----------------------------------------------------

function chevron() {
  return el("span", { class: "chev", "aria-hidden": "true" }, "›");
}

function absolute(value) {
  const node = el("span", { title: formatDate(value) }, timeAgo(value));
  return node;
}

/** Link the value when we know where it points, plain text when we don't. */
function maybeLink(href, text, className = "") {
  if (!href) return className ? el("span", { class: className }, text) : text;
  return link(href, text, className);
}

function link(href, text, className = "", title = "") {
  const a = el("a", { href, target: "_blank", rel: "noreferrer" }, text);
  if (className) a.className = className;
  if (title) a.title = title;
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
