// Covers the logic that can be wrong without anyone noticing: state
// normalisation and rollup, payload sniffing, and the walks over GitHub's
// embedded React payloads. Run with `npm test`.

import test from "node:test";
import assert from "node:assert/strict";

import { bucketOf, stateFromText, stateLabel, mostSevere } from "../src/lib/state.js";
import { collectEnvironments, collectDeployments } from "../src/lib/github-html.js";
import { describeDeployment, readPayload, deploymentSubtitle } from "../src/lib/deployment.js";
import { parseRepo } from "../src/lib/config.js";
import { mapLimit, timeAgo, shortSha } from "../src/lib/util.js";

const REPO_URL = "https://github.com/my-org/api";

test("bucketOf maps every REST deployment state", () => {
  assert.equal(bucketOf("success"), "ok");
  assert.equal(bucketOf("active"), "ok");
  assert.equal(bucketOf("failure"), "bad");
  assert.equal(bucketOf("error"), "bad");
  assert.equal(bucketOf("in_progress"), "busy");
  assert.equal(bucketOf("queued"), "busy");
  assert.equal(bucketOf("pending"), "busy");
  assert.equal(bucketOf("waiting"), "busy");
  assert.equal(bucketOf("inactive"), "idle");
  assert.equal(bucketOf(null), "idle");
  assert.equal(bucketOf("something-new"), "idle");
});

test("bucketOf tolerates rendered spellings", () => {
  assert.equal(bucketOf("In progress"), "busy");
  assert.equal(bucketOf("  SUCCESS "), "ok");
  assert.equal(bucketOf("in-progress"), "busy");
});

test("mostSevere rolls a repo up to its worst environment", () => {
  // A broken environment outranks one that merely happens to be deploying.
  assert.equal(mostSevere(["ok", "busy", "bad"]), "bad");
  assert.equal(mostSevere(["ok", "busy"]), "busy");
  assert.equal(mostSevere(["ok", "idle"]), "ok");
  assert.equal(mostSevere(["idle", "idle"]), "idle");
  assert.equal(mostSevere([]), "idle");
});

test("stateFromText picks the most urgent state on one card", () => {
  // Within a single card the opposite rule applies to the rollup: a run
  // happening now supersedes the outcome printed next to it.
  assert.equal(stateFromText("production Deployed 2 days ago"), "success");
  assert.equal(stateFromText("staging Failure 10 minutes ago"), "failure");
  assert.equal(stateFromText("production Active In progress · deploy #42"), "in_progress");
  assert.equal(stateFromText("prod Waiting for approval · last deployed 3 days ago"), "waiting");
  assert.equal(stateFromText("qa Deployed yesterday Failed 1 hour ago"), "failure");
  assert.equal(stateFromText("nothing recognisable here"), null);
});

test("stateLabel is human readable", () => {
  assert.equal(stateLabel("in_progress"), "In progress");
  assert.equal(stateLabel(null), "No deployments");
});

// --- deployment shape ------------------------------------------------------

const DEPLOYMENT = {
  id: 12,
  sha: "abc1234def5678",
  ref: "v2.3.1",
  environment: "production",
  description: "Release 2.3.1",
  created_at: "2026-08-05T09:00:00Z",
  creator: { login: "alice", html_url: "https://github.com/alice" },
  payload: { image: "ghcr.io/my-org/api:2.3.1", deploy: { version: "2.3.1" } },
};

test("describeDeployment folds a deployment and its status together", () => {
  const d = describeDeployment(REPO_URL, DEPLOYMENT, {
    state: "success",
    updated_at: "2026-08-05T09:04:00Z",
    log_url: "https://github.com/my-org/api/actions/runs/1",
    environment_url: "https://api.example.com",
  });

  assert.equal(d.state, "success");
  assert.equal(d.bucket, "ok");
  assert.equal(d.inferredState, false);
  assert.equal(d.updatedAt, "2026-08-05T09:04:00Z");
  assert.equal(d.actor, "alice");
  assert.equal(d.actorUrl, "https://github.com/alice");
  assert.equal(d.shaUrl, `${REPO_URL}/commit/abc1234def5678`);
  assert.equal(d.image, "ghcr.io/my-org/api:2.3.1");
  assert.equal(d.version, "2.3.1");
  assert.equal(d.logUrl, "https://github.com/my-org/api/actions/runs/1");
  assert.equal(d.siteUrl, "https://api.example.com");
});

test("a deployment with no status yet counts as in progress", () => {
  const d = describeDeployment(REPO_URL, DEPLOYMENT, undefined);
  assert.equal(d.state, "in_progress");
  assert.equal(d.bucket, "busy");
  assert.equal(d.inferredState, true);
  // Falls back to the deployment's own timestamp so the row still dates itself.
  assert.equal(d.updatedAt, "2026-08-05T09:00:00Z");
});

test("readPayload digs one level for image and version", () => {
  assert.deepEqual(readPayload({ image: "app:1", nested: { version: "1.0" } }), {
    image: "app:1",
    version: "1.0",
  });
  // Payloads arrive as JSON strings just as often as objects.
  assert.deepEqual(readPayload('{"docker_image":"app:2","tag":"2.0"}'), {
    image: "app:2",
    version: "2.0",
  });
  assert.deepEqual(readPayload("just a note"), { image: null, version: null });
  assert.deepEqual(readPayload(null), { image: null, version: null });
  assert.deepEqual(readPayload([1, 2]), { image: null, version: null });
  assert.equal(readPayload({ build: 42 }).version, "42");
});

test("version only comes from a ref that looks like a release tag", () => {
  const tagged = describeDeployment(REPO_URL, { ...DEPLOYMENT, payload: null }, { state: "success" });
  assert.equal(tagged.version, "v2.3.1");

  const branch = describeDeployment(
    REPO_URL,
    { ...DEPLOYMENT, ref: "feature/login", payload: null },
    { state: "success" }
  );
  assert.equal(branch.version, null);
});

test("deploymentSubtitle prefers the most specific identifier", () => {
  assert.equal(deploymentSubtitle({ version: "1.2", image: "a:1", sha: "abcdef1234" }), "1.2");
  assert.equal(deploymentSubtitle({ version: null, image: "a:1", sha: "abcdef1234" }), "a:1");
  assert.equal(deploymentSubtitle({ version: null, image: null, sha: "abcdef1234" }), "abcdef1");
  assert.equal(deploymentSubtitle({ version: null, image: null, sha: null, ref: "main" }), "main");
  assert.equal(deploymentSubtitle({}), null);
});

// --- embedded JSON walks ---------------------------------------------------

test("collectEnvironments reads nested React payloads", () => {
  const payload = {
    payload: {
      environments: [
        {
          name: "production",
          latestStatus: { state: "success" },
          updatedAt: "2026-08-01T10:00:00Z",
          creator: { login: "alice" },
          sha: "abc1234def",
        },
        { name: "staging", latestStatus: { state: "failure" } },
        { name: "preview", state: "in_progress" },
      ],
    },
  };

  const envs = collectEnvironments(payload, REPO_URL);
  assert.deepEqual(
    envs.map((e) => [e.name, e.latest.state, e.latest.bucket]),
    [
      ["production", "success", "ok"],
      ["staging", "failure", "bad"],
      ["preview", "in_progress", "busy"],
    ]
  );
  const prod = envs[0].latest;
  assert.equal(prod.actor, "alice");
  assert.equal(prod.updatedAt, "2026-08-01T10:00:00Z");
  assert.equal(prod.shaUrl, `${REPO_URL}/commit/abc1234def`);
});

test("collectEnvironments ignores objects with no usable state", () => {
  assert.deepEqual(collectEnvironments({ user: { name: "octocat" } }), []);
  assert.deepEqual(collectEnvironments({ repo: { name: "api", state: "" } }), []);
});

test("collectEnvironments survives cycles", () => {
  const node = { name: "production", state: "success" };
  node.self = node;
  assert.equal(collectEnvironments({ node }).length, 1);
});

test("collectDeployments returns history newest first", () => {
  const payload = {
    deployments: [
      { id: 1, state: "success", sha: "aaa1111", createdAt: "2026-08-01T10:00:00Z", creator: { login: "alice" } },
      { id: 2, state: "failure", sha: "bbb2222", createdAt: "2026-08-04T10:00:00Z", creator: { login: "bob" } },
    ],
  };

  const found = collectDeployments(payload, REPO_URL);
  assert.deepEqual(found.map((d) => d.sha), ["bbb2222", "aaa1111"]);
  assert.equal(found[0].actor, "bob");
  assert.equal(found[0].bucket, "bad");
});

test("collectDeployments skips records with a state but nothing identifying", () => {
  assert.deepEqual(collectDeployments({ button: { state: "active" } }), []);
});

// --- helpers ---------------------------------------------------------------

test("parseRepo accepts the shapes people paste", () => {
  assert.deepEqual(parseRepo("my-org/api"), { owner: "my-org", repo: "api" });
  assert.deepEqual(parseRepo("  my-org/api  "), { owner: "my-org", repo: "api" });
  assert.deepEqual(parseRepo("https://github.com/my-org/api"), { owner: "my-org", repo: "api" });
  assert.deepEqual(parseRepo("https://github.com/my-org/api/deployments"), {
    owner: "my-org",
    repo: "api",
  });
  assert.equal(parseRepo(""), null);
  assert.equal(parseRepo("just-an-org"), null);
});

test("mapLimit preserves order while bounding concurrency", async () => {
  let inFlight = 0;
  let peak = 0;

  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    peak = Math.max(peak, ++inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight--;
    return n * 2;
  });

  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14]);
  assert.ok(peak <= 3, `peak concurrency was ${peak}`);
});

test("timeAgo is compact", () => {
  const ago = (ms) => timeAgo(new Date(Date.now() - ms).toISOString());
  assert.equal(ago(5e3), "just now");
  assert.equal(ago(3 * 6e4), "3m ago");
  assert.equal(ago(5 * 36e5), "5h ago");
  assert.equal(ago(2 * 864e5), "2d ago");
  assert.equal(timeAgo(null), "");
  assert.equal(timeAgo("not a date"), "");
});

test("shortSha trims to the usual seven", () => {
  assert.equal(shortSha("abc1234def5678"), "abc1234");
  assert.equal(shortSha(null), null);
});
