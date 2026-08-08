// Covers the logic that can be wrong without anyone noticing: state
// normalisation and rollup, payload sniffing, and the walks over GitHub's
// embedded React payloads. Run with `npm test`.

import test from "node:test";
import assert from "node:assert/strict";

import { bucketOf, stateFromText, stateLabel, mostSevere } from "../src/lib/state.js";
import { collectEnvironments, collectDeployments } from "../src/lib/github-html.js";
import {
  describeDeployment,
  readPayload,
  deploymentSubtitle,
  refKind,
  imageUrl,
} from "../src/lib/deployment.js";
import {
  parseRepo,
  environmentUrl,
  parseRepoList,
  formatRepoList,
  flattenGroups,
} from "../src/lib/config.js";
import { mapLimit, timeAgo, duration, durationMs, shortSha } from "../src/lib/util.js";
import {
  runIdFromUrl,
  jobBucket,
  describeJob,
  pickDeployJob,
  pickRunForDeployment,
} from "../src/lib/github-actions.js";
import { ApiError, permissionFor, permissionHint } from "../src/lib/rest.js";

const REPO_URL = "https://github.com/my-org/api";

test("bucketOf maps every REST deployment state", () => {
  assert.equal(bucketOf("success"), "ok");
  assert.equal(bucketOf("active"), "ok");
  assert.equal(bucketOf("failure"), "bad");
  assert.equal(bucketOf("error"), "bad");
  assert.equal(bucketOf("in_progress"), "busy");
  assert.equal(bucketOf("queued"), "busy");
  assert.equal(bucketOf("pending"), "busy");
  assert.equal(bucketOf("waiting"), "waiting");
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
  // Something blocked on a human outranks one that will resolve itself.
  assert.equal(mostSevere(["ok", "busy", "waiting"]), "waiting");
  assert.equal(mostSevere(["waiting", "bad"]), "bad");
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
  // A run happening now still supersedes one merely blocked on approval.
  assert.equal(stateFromText("prod Waiting for approval · In progress"), "in_progress");
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

test("an inactive status does not hide the outcome underneath it", () => {
  // GitHub appends "inactive" when a later deployment supersedes this one.
  // That is a lifecycle fact, not a verdict on whether the deploy worked.
  const d = describeDeployment(REPO_URL, DEPLOYMENT, [
    { state: "inactive", created_at: "2026-08-06T10:00:00Z" },
    {
      state: "success",
      updated_at: "2026-08-05T09:04:00Z",
      log_url: "https://github.com/my-org/api/actions/runs/4821",
    },
  ]);

  assert.equal(d.state, "success");
  assert.equal(d.bucket, "ok");
  assert.equal(d.superseded, true);
  // The inactive status carries no log_url; the real one does.
  assert.equal(d.runId, "4821");
  assert.equal(d.updatedAt, "2026-08-05T09:04:00Z");
});

test("a live deployment is not marked superseded", () => {
  const d = describeDeployment(REPO_URL, DEPLOYMENT, [{ state: "success" }]);
  assert.equal(d.superseded, false);
  assert.equal(d.bucket, "ok");
});

test("a deployment deactivated with no prior outcome still reads inactive", () => {
  const d = describeDeployment(REPO_URL, DEPLOYMENT, [{ state: "inactive" }]);
  assert.equal(d.state, "inactive");
  assert.equal(d.bucket, "idle");
  assert.equal(d.superseded, false);
});

test("a deployment with no status yet counts as in progress", () => {
  const d = describeDeployment(REPO_URL, DEPLOYMENT, undefined);
  assert.equal(d.state, "in_progress");
  assert.equal(d.bucket, "busy");
  assert.equal(d.inferredState, true);
  // Falls back to the deployment's own timestamp so the row still dates itself.
  assert.equal(d.updatedAt, "2026-08-05T09:00:00Z");
});

test("readPayload finds image and version however they are nested", () => {
  assert.deepEqual(readPayload({ image: "app:1", nested: { version: "1.0" } }), {
    image: "app:1",
    version: "1.0",
  });
  // Teams nest deeply; a two-level payload must still be readable.
  assert.deepEqual(
    readPayload({ spec: { template: { containerImage: "app:3", appVersion: "3.0" } } }),
    { image: "app:3", version: "3.0" }
  );
  // A shallower key wins over a deeper one.
  assert.equal(readPayload({ version: "top", deep: { version: "nested" } }).version, "top");
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
  // Not the sha — that has a column of its own now.
  assert.equal(deploymentSubtitle({ version: null, image: null, sha: "abcdef1234" }), null);
  assert.equal(deploymentSubtitle({}), null);
});

test("deploymentSubtitle shows a tag version even though it is also the ref", () => {
  // Nothing else displays the ref any more, so there is nothing to dedupe
  // against — suppressing this would lose the only thing identifying the row.
  assert.equal(deploymentSubtitle({ version: "v2.3.1", ref: "v2.3.1" }), "v2.3.1");
});

// --- outbound links --------------------------------------------------------

test("refKind tells branches, tags and raw commits apart", () => {
  assert.equal(refKind("main"), "branch");
  assert.equal(refKind("feature/login"), "branch");
  assert.equal(refKind("v2.3.1"), "tag");
  assert.equal(refKind("2.3.1"), "tag");
  assert.equal(refKind("9f2e10c4b8d7a1e6f3c2b5a8d9e7f1c4b6a3d8e2"), "commit");
  assert.equal(refKind(null), null);
});

test("a branch links to its tree, slashes intact", () => {
  const d = describeDeployment(REPO_URL, { ...DEPLOYMENT, ref: "feature/login" }, { state: "success" });
  assert.equal(d.refKind, "branch");
  assert.equal(d.refUrl, `${REPO_URL}/tree/feature/login`);
  // A slash is a path separator here, not a character to escape.
  assert.ok(!d.refUrl.includes("%2F"));
});

test("a branch with a character needing escaping is still safe", () => {
  const d = describeDeployment(REPO_URL, { ...DEPLOYMENT, ref: "fix/a b" }, { state: "success" });
  assert.equal(d.refUrl, `${REPO_URL}/tree/fix/a%20b`);
});

test("only a version that is the deployed tag gets a release link", () => {
  const tagged = describeDeployment(
    REPO_URL,
    { ...DEPLOYMENT, ref: "v2.3.1", payload: null },
    { state: "success" }
  );
  assert.equal(tagged.versionUrl, `${REPO_URL}/releases/tag/v2.3.1`);

  // A version read out of the payload names no release we can point at.
  const fromPayload = describeDeployment(
    REPO_URL,
    { ...DEPLOYMENT, ref: "main", payload: { version: "2.3.1" } },
    { state: "success" }
  );
  assert.equal(fromPayload.version, "2.3.1");
  assert.equal(fromPayload.versionUrl, null);
});

test("imageUrl only links registries whose web URL is unambiguous", () => {
  assert.equal(
    imageUrl(REPO_URL, "ghcr.io/my-org/api:2.3.1"),
    `${REPO_URL}/pkgs/container/api`
  );
  assert.equal(imageUrl(REPO_URL, "ghcr.io/my-org/api@sha256:abc123"), `${REPO_URL}/pkgs/container/api`);
  // A different owner's package does not live under this repo.
  assert.equal(imageUrl(REPO_URL, "ghcr.io/other-org/api:1.0"), null);
  // Nested ghcr paths are ambiguous, so we decline rather than guess.
  assert.equal(imageUrl(REPO_URL, "ghcr.io/my-org/team/api:1.0"), null);

  assert.equal(imageUrl(REPO_URL, "my-ns/api:1.0"), "https://hub.docker.com/r/my-ns/api");
  assert.equal(imageUrl(REPO_URL, "docker.io/my-ns/api:1.0"), "https://hub.docker.com/r/my-ns/api");

  assert.equal(imageUrl(REPO_URL, "registry.example.com/my-ns/api:1.0"), null);
  assert.equal(imageUrl(REPO_URL, null), null);
});

test("scraped deployments get the same links as API ones", () => {
  const [env] = collectEnvironments(
    { environments: [{ name: "production", state: "success", sha: "abc1234def", ref: "main" }] },
    REPO_URL
  );
  assert.equal(env.latest.refUrl, `${REPO_URL}/tree/main`);
  assert.equal(env.latest.refKind, "branch");
  assert.equal(env.latest.shaUrl, `${REPO_URL}/commit/abc1234def`);
});

// --- Actions runs and jobs -------------------------------------------------

test("runIdFromUrl finds the run in the URLs GitHub actually sets", () => {
  assert.equal(runIdFromUrl("https://github.com/my-org/api/actions/runs/4821"), "4821");
  // log_url often points at a specific job within the run.
  assert.equal(
    runIdFromUrl("https://github.com/my-org/api/actions/runs/4821/job/99"),
    "4821"
  );
  assert.equal(runIdFromUrl("https://github.com/my-org/api/actions/runs/4821?check_suite=1"), "4821");
  // Some tooling puts the deployed site here instead — that is not a run.
  assert.equal(runIdFromUrl("https://api.example.com"), null);
  assert.equal(runIdFromUrl(null), null);
});

test("a deployment carries the run its status points at", () => {
  const d = describeDeployment(REPO_URL, DEPLOYMENT, {
    state: "success",
    log_url: "https://github.com/my-org/api/actions/runs/4821",
  });
  assert.equal(d.runId, "4821");
  assert.equal(d.runUrl, `${REPO_URL}/actions/runs/4821`);
  assert.equal(d.environment, "production");
});

test("a status naming a specific job is the job link, with no lookup", () => {
  // This is what GitHub's own "View logs" points at.
  const d = describeDeployment(REPO_URL, DEPLOYMENT, {
    state: "success",
    log_url: "https://github.com/my-org/api/actions/runs/4821/job/99",
  });
  assert.equal(d.jobUrl, "https://github.com/my-org/api/actions/runs/4821/job/99");
  assert.equal(d.runUrl, `${REPO_URL}/actions/runs/4821`);
});

test("a status naming only the run leaves the job to be resolved", () => {
  const d = describeDeployment(REPO_URL, DEPLOYMENT, {
    state: "success",
    log_url: "https://github.com/my-org/api/actions/runs/4821",
  });
  assert.equal(d.jobUrl, null);
  assert.equal(d.runUrl, `${REPO_URL}/actions/runs/4821`);
});

test("a scraped deployment picks up the run link from the page", () => {
  const [env] = collectEnvironments(
    {
      environments: [
        {
          name: "production",
          state: "success",
          sha: "abc1234def",
          logUrl: "https://github.com/my-org/api/actions/runs/4821/job/99",
        },
      ],
    },
    REPO_URL
  );
  assert.equal(env.latest.jobUrl, "https://github.com/my-org/api/actions/runs/4821/job/99");
  assert.equal(env.latest.runId, "4821");
});

test("a deployment whose status points elsewhere has no run", () => {
  const d = describeDeployment(REPO_URL, DEPLOYMENT, {
    state: "success",
    target_url: "https://api.example.com",
  });
  assert.equal(d.runId, null);
  assert.equal(d.runUrl, null);
});

test("jobBucket treats an unfinished job as running", () => {
  assert.equal(jobBucket({ status: "in_progress", conclusion: null }), "busy");
  assert.equal(jobBucket({ status: "queued", conclusion: null }), "busy");
  // A job held for approval is not running; only its status says so, since a
  // job that has not finished has no conclusion to read.
  assert.equal(jobBucket({ status: "waiting", conclusion: null }), "waiting");
  assert.equal(jobBucket({ status: "completed", conclusion: "success" }), "ok");
  assert.equal(jobBucket({ status: "completed", conclusion: "failure" }), "bad");
  assert.equal(jobBucket({ status: "completed", conclusion: "timed_out" }), "bad");
  assert.equal(jobBucket({ status: "completed", conclusion: "cancelled" }), "idle");
  assert.equal(jobBucket({ status: "completed", conclusion: "skipped" }), "idle");
  // action_required means a human has to step in — that is waiting, not running.
  assert.equal(jobBucket({ status: "completed", conclusion: "action_required" }), "waiting");
  assert.equal(jobBucket({ status: "completed", conclusion: "something_new" }), "idle");
});

test("a job's tooltip JSON carries the concepts it is meant to teach", () => {
  const job = describeJob({
    id: 99,
    name: "deploy",
    workflow_name: "Deploy",
    run_id: 4821,
    status: "completed",
    conclusion: "success",
    steps: [{ name: "checkout", status: "completed", conclusion: "success" }],
  });
  const parsed = JSON.parse(job.rawJson);
  assert.equal(parsed.job.workflow_name, "Deploy");
  assert.equal(parsed.job.run_id, 4821);
  // status and conclusion are the pair people mix up, so both must survive.
  assert.equal(parsed.job.status, "completed");
  assert.equal(parsed.job.conclusion, "success");
  assert.equal(parsed.job.steps[0].name, "checkout");
});

test("a deployment's tooltip JSON separates intent from outcome", () => {
  const d = describeDeployment(REPO_URL, DEPLOYMENT, [{ state: "success", log_url: "u" }]);
  const parsed = JSON.parse(d.rawJson);
  assert.equal(parsed.deployment.environment, "production");
  assert.equal(parsed.deployment.sha, "abc1234def5678");
  assert.equal(parsed.statuses[0].state, "success");
  // Empty fields are dropped rather than printed as nulls.
  assert.ok(!("task" in parsed.deployment));
});

test("describeJob normalises the fields the row needs", () => {
  const job = describeJob({
    id: 99,
    name: "deploy (production)",
    status: "completed",
    conclusion: "success",
    started_at: "2026-08-05T09:00:00Z",
    completed_at: "2026-08-05T09:03:20Z",
    html_url: "https://github.com/my-org/api/actions/runs/4821/job/99",
  });
  assert.equal(job.name, "deploy (production)");
  assert.equal(job.bucket, "ok");
  assert.equal(duration(job.startedAt, job.completedAt), "3m 20s");
});

test("pickDeployJob finds the job a deployment row should open", () => {
  const jobs = [
    { name: "build", bucket: "ok", url: "u/build" },
    { name: "test", bucket: "ok", url: "u/test" },
    { name: "deploy (production)", bucket: "ok", url: "u/deploy-prod" },
    { name: "notify", bucket: "ok", url: "u/notify" },
  ];

  // Naming the environment beats every other signal.
  assert.equal(pickDeployJob(jobs, { environment: "production" }).url, "u/deploy-prod");
  // With nothing to match on, the last job is the one that finished the work.
  assert.equal(pickDeployJob(jobs, {}).url, "u/notify");

  // A failed deployment should land on what actually broke.
  const broken = [
    { name: "build", bucket: "ok", url: "u/build" },
    { name: "migrate", bucket: "bad", url: "u/migrate" },
    { name: "notify", bucket: "idle", url: "u/notify" },
  ];
  assert.equal(pickDeployJob(broken, { bucket: "bad" }).url, "u/migrate");
  // ...but an environment match still wins, since it is the more specific one.
  assert.equal(
    pickDeployJob([...broken, { name: "ship to staging", bucket: "ok", url: "u/ship" }], {
      bucket: "bad",
      environment: "staging",
    }).url,
    "u/ship"
  );

  assert.equal(pickDeployJob([], { environment: "production" }), null);
  assert.equal(pickDeployJob(undefined), null);
});

test("pickRunForDeployment matches on commit, then on the environment", () => {
  const runs = [
    { id: "1", workflowName: "CI", headSha: "aaa", displayTitle: "tests" },
    { id: "2", workflowName: "Deploy to staging", headSha: "aaa", displayTitle: "" },
    { id: "3", workflowName: "Deploy", headSha: "bbb", displayTitle: "" },
  ];

  // Naming the environment wins over merely sharing the commit.
  assert.equal(pickRunForDeployment(runs, { sha: "aaa", environment: "staging" }).id, "2");
  // With nothing to disambiguate, the first run on that commit.
  assert.equal(pickRunForDeployment(runs, { sha: "aaa" }).id, "1");
  assert.equal(pickRunForDeployment(runs, { sha: "bbb", environment: "prod" }).id, "3");
  // A commit no run touched, and a deployment with no commit at all.
  assert.equal(pickRunForDeployment(runs, { sha: "zzz" }), null);
  assert.equal(pickRunForDeployment(runs, {}), null);
});

test("a run the deployment already names is not re-guessed by commit", () => {
  // Two runs on one commit: the deploy, and a CI run that merely shares it.
  const runs = [
    { id: "9", workflowName: "CI", headSha: "aaa", displayTitle: "" },
    { id: "7", workflowName: "Deploy", headSha: "aaa", displayTitle: "" },
  ];
  // Guessing by commit alone picks the wrong one here, which is exactly the
  // disagreement the runId lookup avoids.
  assert.equal(pickRunForDeployment(runs, { sha: "aaa" }).id, "9");
  assert.equal(runs.find((r) => r.id === "7").workflowName, "Deploy");
});

test("permissionFor names the permission each endpoint needs", () => {
  assert.equal(permissionFor("/repos/o/r/environments"), "Environments: Read-only");
  assert.equal(permissionFor("/repos/o/r/deployments?environment=prod"), "Deployments: Read-only");
  assert.equal(permissionFor("/repos/o/r/actions/runs/1/jobs"), "Actions: Read-only");
});

test("permissionHint turns a status code into something actionable", () => {
  const notFound = permissionHint(new ApiError("Not found (404)", 404, "/repos/o/r/environments"));
  // A 404 is really an access problem, and saying so is the whole point.
  assert.match(notFound, /cannot see the repository/);
  assert.match(notFound, /Environments: Read-only/);
  assert.match(notFound, /"repo" scope/);

  const forbidden = permissionHint(new ApiError("Forbidden", 403, "/repos/o/r/actions/runs"));
  assert.match(forbidden, /Actions: Read-only/);

  assert.match(permissionHint(new ApiError("Token rejected", 401, "/user")), /rejected/);
  // Not every failure is about permissions.
  assert.equal(permissionHint(new ApiError("HTTP 500", 500, "/x")), null);
  assert.equal(permissionHint(new Error("network down")), null);
});

test("environmentUrl points at the environment's own page", () => {
  const config = { host: "github.com" };
  assert.equal(
    environmentUrl(config, "my-org", "api", "production"),
    "https://github.com/my-org/api/deployments/production"
  );
  // Environment names are free text and become a single path segment.
  assert.equal(
    environmentUrl(config, "my-org", "api", "prod eu/west"),
    "https://github.com/my-org/api/deployments/prod%20eu%2Fwest"
  );
  assert.equal(
    environmentUrl({ host: "github.example.com" }, "my-org", "api", "production"),
    "https://github.example.com/my-org/api/deployments/production"
  );
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

test("parseRepoList reads groups out of the textarea", () => {
  const groups = parseRepoList(`
    System 1:
    my-org/api
    my-org/web

    System 2:
    my-org/infra
  `);
  assert.deepEqual(groups, [
    { name: "System 1", repos: ["my-org/api", "my-org/web"] },
    { name: "System 2", repos: ["my-org/infra"] },
  ]);
});

test("repos above the first group stay ungrouped", () => {
  const groups = parseRepoList("my-org/loose\nSystem 1:\nmy-org/api");
  assert.deepEqual(groups, [
    { name: null, repos: ["my-org/loose"] },
    { name: "System 1", repos: ["my-org/api"] },
  ]);
});

test("a repo URL is not mistaken for a group header", () => {
  // It contains a colon but does not end with one, which is the whole rule.
  const groups = parseRepoList("https://github.com/my-org/api");
  assert.deepEqual(groups, [{ name: null, repos: ["my-org/api"] }]);
});

test("parseRepoList drops empty groups and duplicate repos", () => {
  const groups = parseRepoList("Empty:\n\nSystem:\nmy-org/api\nmy-org/api");
  assert.deepEqual(groups, [{ name: "System", repos: ["my-org/api"] }]);
});

test("groups survive a round trip through the textarea", () => {
  const text = "my-org/loose\n\nSystem 1:\nmy-org/api\nmy-org/web";
  assert.equal(formatRepoList(parseRepoList(text)), text);
});

test("flattenGroups gives every repo once, in order", () => {
  const groups = [
    { name: "A", repos: ["o/one", "o/two"] },
    { name: "B", repos: ["o/two", "o/three"] },
  ];
  assert.deepEqual(flattenGroups(groups), ["o/one", "o/two", "o/three"]);
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

test("duration reads at a glance", () => {
  const t = (a, b) => duration(a, b);
  assert.equal(t("2026-08-05T09:00:00Z", "2026-08-05T09:00:45Z"), "45s");
  assert.equal(t("2026-08-05T09:00:00Z", "2026-08-05T09:03:00Z"), "3m");
  assert.equal(t("2026-08-05T09:00:00Z", "2026-08-05T09:03:20Z"), "3m 20s");
  assert.equal(t("2026-08-05T09:00:00Z", "2026-08-05T10:04:00Z"), "1h 04m");
  // A job still running has no end, and clock skew must not print nonsense.
  assert.equal(t("2026-08-05T09:00:00Z", null), "");
  assert.equal(t("2026-08-05T09:05:00Z", "2026-08-05T09:00:00Z"), "");
});

test("durationMs gives the number the comparison bars need", () => {
  assert.equal(durationMs("2026-08-05T09:00:00Z", "2026-08-05T09:03:20Z"), 200000);
  // Zero, not NaN or a negative: the bar maths divides by these.
  assert.equal(durationMs("2026-08-05T09:00:00Z", null), 0);
  assert.equal(durationMs("2026-08-05T09:05:00Z", "2026-08-05T09:00:00Z"), 0);
  assert.equal(durationMs(null, null), 0);
});

test("shortSha trims to the usual seven", () => {
  assert.equal(shortSha("abc1234def5678"), "abc1234");
  assert.equal(shortSha(null), null);
});
