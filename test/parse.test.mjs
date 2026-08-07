// Covers the two bits of logic that can be wrong without anyone noticing:
// state normalisation, and the walk over GitHub's embedded React payload.
// Run with `node --test test/`.

import test from "node:test";
import assert from "node:assert/strict";

import { bucketOf, stateFromText, stateLabel } from "../src/lib/state.js";
import { collectEnvironments } from "../src/lib/github-html.js";
import { parseRepo } from "../src/lib/config.js";

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

test("stateFromText picks the most urgent state on a card", () => {
  // A card commonly shows both the current run and the last outcome.
  assert.equal(stateFromText("production Deployed 2 days ago"), "success");
  assert.equal(stateFromText("staging Failure 10 minutes ago"), "failure");
  assert.equal(
    stateFromText("production Active In progress · deploy #42"),
    "in_progress"
  );
  assert.equal(
    stateFromText("prod Waiting for approval · last deployed 3 days ago"),
    "waiting"
  );
  // A failure outranks an older success on the same card.
  assert.equal(stateFromText("qa Deployed yesterday Failed 1 hour ago"), "failure");
  assert.equal(stateFromText("nothing recognisable here"), null);
});

test("stateLabel is human readable", () => {
  assert.equal(stateLabel("in_progress"), "In progress");
  assert.equal(stateLabel(null), "No deployments");
});

test("collectEnvironments reads nested React payloads", () => {
  const payload = {
    payload: {
      environments: [
        { name: "production", latestStatus: { state: "success" }, updatedAt: "2026-08-01T10:00:00Z" },
        { name: "staging", latestStatus: { state: "failure" } },
        { name: "preview", state: "in_progress" },
      ],
    },
  };

  const envs = collectEnvironments(payload);
  assert.deepEqual(
    envs.map((e) => [e.name, e.state, e.bucket]),
    [
      ["production", "success", "ok"],
      ["staging", "failure", "bad"],
      ["preview", "in_progress", "busy"],
    ]
  );
  assert.equal(envs[0].updatedAt, "2026-08-01T10:00:00Z");
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

test("parseRepo accepts the shapes people paste", () => {
  assert.deepEqual(parseRepo("my-org/api"), { owner: "my-org", repo: "api" });
  assert.deepEqual(parseRepo("  my-org/api  "), { owner: "my-org", repo: "api" });
  assert.deepEqual(parseRepo("https://github.com/my-org/api"), { owner: "my-org", repo: "api" });
  assert.deepEqual(parseRepo("https://github.com/my-org/api/deployments"), {
    owner: "my-org",
    repo: "api",
  });
  assert.deepEqual(parseRepo("git@host/my-org/api.git"), null);
  assert.equal(parseRepo(""), null);
  assert.equal(parseRepo("just-an-org"), null);
});
