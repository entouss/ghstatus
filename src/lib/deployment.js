// The shape both auth paths produce, so the UI never has to care where a
// deployment came from. Fields are best-effort: the REST path fills all of
// them, the page-scraping path fills what the markup happens to expose.

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
 * @property {string|null} version
 * @property {string|null} image
 * @property {string|null} description
 * @property {string|null} logUrl      build/run log for this deployment
 * @property {string|null} siteUrl     the deployed environment itself
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
    version: null,
    image: null,
    description: null,
    logUrl: null,
    siteUrl: null,
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

  return emptyDeployment({
    id: deployment.id,
    state,
    bucket: bucketOf(state),
    inferredState,
    updatedAt: status?.updated_at || status?.created_at || deployment.updated_at || deployment.created_at,
    createdAt: deployment.created_at,
    actor: deployment.creator?.login || null,
    actorUrl: deployment.creator?.html_url || null,
    sha: deployment.sha || null,
    shaUrl: deployment.sha ? `${repoUrl}/commit/${deployment.sha}` : null,
    ref: deployment.ref || null,
    version: payload.version || versionFromRef(deployment.ref),
    image: payload.image,
    description: deployment.description || status?.description || null,
    logUrl: status?.log_url || status?.target_url || null,
    siteUrl: status?.environment_url || null,
  });
}

const IMAGE_KEYS = ["image", "image_tag", "imageTag", "docker_image", "dockerImage", "container_image", "artifact"];
const VERSION_KEYS = ["version", "app_version", "appVersion", "tag", "release", "build", "build_number"];

/**
 * Deployment payloads are free-form — a JSON object, a JSON string, or a bare
 * string. Dig one level deep for the fields people conventionally put there.
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

  const nested = Object.values(payload).filter(
    (v) => v && typeof v === "object" && !Array.isArray(v)
  );
  const sources = [payload, ...nested];

  return {
    image: pick(sources, IMAGE_KEYS),
    version: pick(sources, VERSION_KEYS),
  };
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

/** One-line summary of what shipped, for the collapsed row. */
export function deploymentSubtitle(deployment) {
  return (
    deployment.version ||
    deployment.image ||
    shortSha(deployment.sha) ||
    deployment.ref ||
    null
  );
}
