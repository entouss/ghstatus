// The shape both auth paths produce, so the UI never has to care where a
// deployment came from. Fields are best-effort: the REST path fills all of
// them, the page-scraping path fills what the markup happens to expose.

import { runIdFromUrl } from "./github-actions.js";
import { bucketOf } from "./state.js";
import { shortSha } from "./util.js";

/**
 * @typedef {object} Deployment
 * @property {string|number|null} id
 * @property {string|null} state       canonical state
 * @property {string} bucket           ok | bad | busy | idle
 * @property {boolean} inferredState   true when we supplied the state ourselves
 * @property {string|null} updatedAt   when the state last changed
 * @property {string|null} createdAt   when the deployment was created
 * @property {string|null} actor       login of whoever triggered it
 * @property {string|null} actorUrl
 * @property {string|null} sha
 * @property {string|null} shaUrl
 * @property {string|null} ref
 * @property {"branch"|"tag"|"commit"|null} refKind what that ref actually is
 * @property {string|null} refUrl
 * @property {string|null} version
 * @property {string|null} versionUrl
 * @property {string|null} image
 * @property {string|null} imageUrl
 * @property {string|null} description
 * @property {string|null} logUrl      build/run log for this deployment
 * @property {string|null} siteUrl     the deployed environment itself
 * @property {string|null} environment name of the environment deployed to
 * @property {string|null} runId       Actions run that performed it, if known
 * @property {string|null} runUrl
 * @property {string|null} jobUrl      the job within that run that deployed
 * @property {string|null} jobName     that job's name
 */

export function emptyDeployment(overrides = {}) {
  return {
    id: null,
    state: null,
    bucket: "idle",
    inferredState: false,
    updatedAt: null,
    createdAt: null,
    actor: null,
    actorUrl: null,
    sha: null,
    shaUrl: null,
    ref: null,
    refKind: null,
    refUrl: null,
    version: null,
    versionUrl: null,
    image: null,
    imageUrl: null,
    description: null,
    logUrl: null,
    siteUrl: null,
    environment: null,
    runId: null,
    runUrl: null,
    jobUrl: null,
    jobName: null,
    ...overrides,
  };
}

/**
 * Fold a REST deployment + its latest status into a Deployment.
 * @param {string} repoUrl e.g. https://github.com/org/repo
 */
export function describeDeployment(repoUrl, deployment, status) {
  // A deployment with no status row yet is work in flight, not an absence of
  // information — GitHub's own UI shows these as in progress.
  const inferredState = !status;
  const state = status?.state || "in_progress";
  const payload = readPayload(deployment.payload);

  return withLinks(
    emptyDeployment({
      id: deployment.id,
      state,
      bucket: bucketOf(state),
      inferredState,
      updatedAt: status?.updated_at || status?.created_at || deployment.updated_at || deployment.created_at,
      createdAt: deployment.created_at,
      actor: deployment.creator?.login || null,
      actorUrl: deployment.creator?.html_url || null,
      sha: deployment.sha || null,
      ref: deployment.ref || null,
      version: payload.version || versionFromRef(deployment.ref),
      image: payload.image,
      description: deployment.description || status?.description || null,
      logUrl: status?.log_url || status?.target_url || null,
      siteUrl: status?.environment_url || null,
      environment: deployment.environment || null,
    }),
    repoUrl
  );
}

/**
 * Point every field we can at the page it came from. Both auth paths run this,
 * so a scraped deployment links out exactly like an API one.
 */
export function withLinks(d, repoUrl) {
  if (!repoUrl) return d;
  const kind = refKind(d.ref);

  d.shaUrl = d.sha ? `${repoUrl}/commit/${d.sha}` : null;
  d.refKind = kind;
  d.refUrl = d.ref ? `${repoUrl}/tree/${encodePath(d.ref)}` : null;
  // Only a version that *is* the deployed tag has a release page to point at;
  // a version read out of the payload is just a string we were handed.
  d.versionUrl =
    d.version && d.version === d.ref && kind === "tag"
      ? `${repoUrl}/releases/tag/${encodePath(d.version)}`
      : null;
  d.imageUrl = imageUrl(repoUrl, d.image);

  // The status URL usually points straight at the Actions run that deployed.
  d.runId = d.runId || runIdFromUrl(d.logUrl);
  d.runUrl = d.runId ? `${repoUrl}/actions/runs/${d.runId}` : null;
  // When it names a specific job — which is what GitHub's own "View logs"
  // links to — that is already the answer, no lookup needed.
  d.jobUrl = d.jobUrl || (isJobUrl(d.logUrl) ? d.logUrl : null);
  return d;
}

const JOB_URL = /\/actions\/runs\/\d+\/job\/\d+/;

export function isJobUrl(url) {
  return JOB_URL.test(String(url || ""));
}

/** GitHub deployment refs are branches, tags or raw commits. */
export function refKind(ref) {
  if (!ref) return null;
  if (/^[0-9a-f]{40}$/i.test(ref)) return "commit";
  return /^v?\d+[\w.+-]*$/.test(ref) ? "tag" : "branch";
}

/** Branch names contain slashes that must survive as path separators. */
function encodePath(ref) {
  return String(ref).split("/").map(encodeURIComponent).join("/");
}

/**
 * Registry references we can turn into a browsable page. Deliberately narrow:
 * a wrong link is worse than none, so this only handles the two conventions
 * whose web URL is unambiguous.
 */
export function imageUrl(repoUrl, image) {
  if (!image || !repoUrl) return null;

  const path = String(image).split("@")[0].replace(/:[^:/]+$/, "");
  const parts = path.split("/").filter(Boolean);
  const owner = repoUrl.split("/").slice(-2)[0];

  // ghcr.io/<owner>/<name> — the package page lives under the repo, which
  // holds when the image was published from it (the usual setup).
  if (parts[0] === "ghcr.io" && parts.length === 3) {
    return parts[1].toLowerCase() === String(owner).toLowerCase()
      ? `${repoUrl}/pkgs/container/${encodeURIComponent(parts[2])}`
      : null;
  }

  // docker.io/<ns>/<name>, or the bare <ns>/<name> that implies Docker Hub.
  const hub =
    (parts[0] === "docker.io" && parts.length === 3) ||
    (parts.length === 2 && !parts[0].includes("."));
  if (hub) {
    const [ns, name] = parts.slice(-2);
    return `https://hub.docker.com/r/${encodeURIComponent(ns)}/${encodeURIComponent(name)}`;
  }

  return null;
}

const IMAGE_KEYS = [
  "image",
  "image_tag",
  "imageTag",
  "image_name",
  "imageName",
  "docker_image",
  "dockerImage",
  "container_image",
  "containerImage",
  "container",
  "artifact",
];
const VERSION_KEYS = [
  "version",
  "app_version",
  "appVersion",
  "chart_version",
  "chartVersion",
  "release_version",
  "releaseVersion",
  "tag",
  "release",
  "build",
  "build_number",
  "buildNumber",
];

/**
 * Deployment payloads are free-form — a JSON object, a JSON string, or a bare
 * string — and teams nest them however they like. Search the whole structure
 * for the keys people conventionally use, shallowest match first.
 */
export function readPayload(raw) {
  let payload = raw;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      return { image: null, version: null };
    }
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { image: null, version: null };
  }

  const sources = objectsWithin(payload);
  return {
    image: pick(sources, IMAGE_KEYS),
    version: pick(sources, VERSION_KEYS),
  };
}

/** Every object inside `root`, breadth-first so shallower keys win. */
function objectsWithin(root, maxDepth = 4) {
  const found = [];
  const seen = new Set();
  const queue = [[root, 0]];

  while (queue.length) {
    const [node, depth] = queue.shift();
    if (!node || typeof node !== "object" || seen.has(node) || depth > maxDepth) continue;
    seen.add(node);
    if (!Array.isArray(node)) found.push(node);
    for (const value of Object.values(node)) queue.push([value, depth + 1]);
  }
  return found;
}

function pick(sources, keys) {
  for (const source of sources) {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === "string" && value.trim()) return value.trim();
      if (typeof value === "number") return String(value);
    }
  }
  return null;
}

/** A ref is only interesting as a version when it looks like a release tag. */
function versionFromRef(ref) {
  if (!ref) return null;
  return /^v?\d+[\w.+-]*$/.test(ref) ? ref : null;
}

/**
 * One-line summary of what shipped, for the left of a collapsed row. The
 * branch and commit have columns of their own, so whatever is already shown
 * there is not repeated here.
 * @param {{hasShaColumn?: boolean}} columns which columns the row already has
 */
export function deploymentSubtitle(deployment, { hasShaColumn = false } = {}) {
  const label =
    deployment.version ||
    deployment.image ||
    (hasShaColumn ? null : shortSha(deployment.sha)) ||
    null;
  return label && label !== deployment.ref ? label : null;
}
