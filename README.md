# GH Deployment Status

A Chrome extension that shows, at a glance, the deployment state of every
environment across the repos you care about.

```
› 🟥 my-org/api                        3 envs · 12m ago
› 🟩 my-org/web                        2 envs · 4h ago
```

Expand a repo for its environments, and an environment for its detail and
history:

```
▾ 🟥 my-org/api                                    3 envs · 12m ago
    › 🟩 production  v2.3.1                         2h ago · @alice
    ▾ 🟥 staging     ghcr.io/…:2.4.0-rc1           12m ago · @bob
          Status        🟥 Failure          Updated  12m ago
          Triggered by  @bob                Commit   abc1234
          Workflow      Deploy              Job      deploy (staging) · ran 1m 20s
          Took          4m 12s              Version  2.4.0-rc1
          Image         ghcr.io/my-org/api:2.4.0-rc1
          Description   Automatic deployment from workflow "Deploy" #4821
          Links         View logs · Open environment

          PAST DEPLOYMENTS
             WORKFLOW                        COMMIT    DEPLOYED
          🟩 Deploy                          9f2e10c   2d ago · @alice ↗
               deploy (production) / terraform apply · 1m 20s
          🟩 Release and deploy              41ab7c3   6d ago · @alice ↗
               deploy / terraform apply to staging · 3m 04s
    › ⬜ preview                                  no deployments
```

| | State |
|---|---|
| 🟩 | `success`, `active` |
| 🟧 | `in_progress`, `queued`, `pending`, `waiting` (approval) |
| 🟥 | `failure`, `error` |
| ⬜ | `inactive`, `destroyed`, no deployments, unknown |

The repo's dot is a **rollup: the worst state across its environments**, so a
broken production shows red even while another environment is mid-deploy.
Note this is the opposite of how a single card is read — there, a run happening
*now* supersedes the outcome printed beside it. Both orderings live in
[`src/lib/state.js`](src/lib/state.js) (`SEVERITY` and `CARD_PRIORITY`).

A deployment that GitHub has created but not yet reported a status for is shown
as 🟧 in progress rather than blank, marked *(no status reported)*.

**`inactive` is not an outcome.** GitHub appends an `inactive` status to a
deployment once a later one supersedes it, which says nothing about whether it
worked — reading only the latest status makes every past deployment look ⬜.
The dot shows the most recent status that was something other than `inactive`,
with "superseded" noted in the tooltip. That status is also the one carrying
`log_url`, so this is what lets past deployments reach their Actions run.

### Tooltips

GitHub's deployment vocabulary is easy to mix up, so every tooltip names the
concept it is showing — REPOSITORY, ENVIRONMENT, DEPLOYMENT, WORKFLOW, WORKFLOW
RUN, JOB, COMMIT — explains it in a line, and then prints the API objects
behind it as JSON.

The JSON is a curated shape, not the raw response: a real deployment object is
several kilobytes of app metadata that would push the interesting fields out of
a tooltip. Empty fields are dropped. Hovering a job shows both `status` (where
it is in its lifecycle) and `conclusion` (how it ended) together, since that
pair is the usual source of confusion.

## Install

```sh
git clone https://github.com/entouss/ghstatus && cd ghstatus
```

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** → pick this directory.
3. Click the extension icon → **Settings**, add repos as `org/repo`, one per line.

No build step: the source is loaded as-is.

## Authentication

Two paths, and by default the extension picks for you (`Auto`):

**Browser session** — the extension fetches
`https://github.com/<org>/<repo>/deployments` with your existing github.com
cookies and reads the environments out of the page. Nothing to set up, and it
works for anything you can already open in this browser profile.

The catch: those pages are unversioned HTML. The parser
([`src/lib/github-html.js`](src/lib/github-html.js)) tries GitHub's embedded
React JSON payload first and falls back to reading the rendered DOM, but a
redesign can still break it, and it recovers fewer fields than the API does.
It is deliberately the only file that knows what the pages look like.

**Personal access token** — uses the REST API (`/environments`,
`/deployments`, `/deployments/{id}/statuses`), which is versioned and returns
real states, actors, payloads and log URLs. More reliable, and the only option
for repos you can't reach from this browser session. Scopes:

- classic: `repo`
- fine-grained: read access to *Deployments*, *Environments*, *Contents* and
  *Actions* (the last one only for the jobs list)

The token lives in `chrome.storage.local` for this profile only. **Settings →
Test** verifies it.

In `Auto` mode a token, when set, is tried first and the session is the
fallback; with no token, only the session is used.

## Behaviour

- **Repos are collapsed by default.** What you expand is remembered across
  popup openings.
- **History and Actions jobs are fetched lazily** — only when you expand an
  environment, in parallel, and only the latest 10 deployments — so the initial
  dashboard stays cheap.
- Results are cached (default 120s) so reopening the popup is instant.
  **Refresh** re-fetches everything and drops the history cache too.
- Repos are fetched 4 at a time, environments within a repo likewise.
- Failures are reported per repo, so one bad repo doesn't blank the dashboard.

### Getting to the Actions jobs

Every deployment names the **workflow** that produced it and the **job** within
that workflow run that did the deploying, with how long that job ran. Each
**past deployment** links straight to the job that deployed it —
`/actions/runs/<runId>/job/<jobId>`. Runs list several jobs, so the one picked
is, in order: a job naming the environment, then a failed job if the deployment
failed, then the last job in the run. Where none can be resolved the row falls
back to the run as a whole.

The run is found from the deployment status's `log_url`, which is where the
`deployments` API puts it when something sets it. Plenty of setups set no URL
at all, or put the deployed site in `target_url`; in that case the run is found
by searching workflow runs for the deployed commit, preferring one whose name
mentions the environment. That search runs once per distinct commit, not once
per deployment.

If a deployment resolves to no run — nothing in Actions ever deployed that
commit — its ↗ falls back to the deployment log, then to the commit itself.
Seeing *"Open the deployed commit"* on every row means no runs were matched at
all, which is expected when the deployments come from something other than
GitHub Actions.

**Naming the workflow and job needs a token** — there is no dependable way to
read a run's jobs out of the rendered page. The *links* do not: GitHub's own
**View logs** (in each deployment's `...` menu) is a plain anchor on the page,
so session mode scrapes it and every row still reaches its run or job.

If a status names a specific job — which `View logs` usually does — that is used
as-is, with no lookup at all.

Almost everything on screen is a link back to where it came from:

| Shown | Opens |
|---|---|
| Status | the run that produced it (`log_url`/`target_url`) |
| Triggered by | the GitHub profile |
| Commit | `/commit/<sha>` |
| Version | `/releases/tag/<v>`, only when the version *is* the deployed tag |
| Image | the package page — `ghcr.io` under this repo, or Docker Hub |
| ↗ on a repo | `/deployments` |
| ↗ on an environment | `/deployments/<environment>` — its latest deployment |
| ↗ on a past deployment | `/actions/runs/<runId>/job/<jobId>` |

Where a link can't be derived with confidence the value is shown as plain
text rather than pointed somewhere that might 404.

### Reading the columns

**Workflow** is the Actions workflow that produced the deployment, with the
specific **job** on the line below it — job names like
`deploy / terraform apply to staging` need more room than a column affords.
Both come from the jobs already fetched to build the row's link, so neither
costs an extra request.

**Took** is the deployment's own elapsed time — created until its status
settled. The **Job** line carries how long that job ran, which is a different
measurement: a deployment can wait on approval long before its job starts.
Durations appear wherever both ends of the interval are known.

**Version** and **Image** come from the deployment payload, which is free-form.
The whole payload is searched, shallowest key first, for the conventional
spellings (`version`, `app_version`, `tag`, `image`, `container_image`, …). If
your tooling uses different key names, these columns stay empty — tell me the
names and they can be added.

**Dates** are shown relative ("2d ago"), with the absolute timestamp on hover
formatted with the month spelled out. A numeric `7/8/2026` reads as two
different days depending on locale, and the wrong reading looks like the data
is a month out.

## GitHub Enterprise Server

Settings → Advanced → **GitHub host**. Chrome will ask for permission for that
host; the API base becomes `https://<host>/api/v3`.

## Development

```sh
npm test              # node --test, no dependencies
npm run icons         # regenerate icons/ from tools/make-icons.mjs
```

Layout:

```
manifest.json
src/
  popup.{html,css,js}      dashboard: repo -> environment -> history tree
  options.{html,css,js}    settings
  lib/
    config.js              storage + URL derivation
    state.js               state -> 🟩🟧🟥⬜, and the two orderings
    deployment.js          the shape both auth paths produce
    rest.js                one authenticated REST call
    github-api.js          PAT path (REST API)
    github-actions.js      the workflow run behind a deployment, and its jobs
    github-html.js         session path (page scraping)
    loader.js              auth selection, rollup, caching, concurrency
    util.js                mapLimit, timeAgo, duration, shortSha
```

## Known limits

- The session path depends on GitHub's page markup. If it breaks, the popup
  says so and points at the token option. History in session mode is scraped
  from the environment's activity log and recovers less detail — no payload,
  so no image or version.
- Only the latest 10 deployments per environment are listed. The environment's
  own ↗ opens its GitHub page if you need the rest.
- The image link assumes a `ghcr.io` package published from the repo it is
  shown under, which is the usual setup but not guaranteed — if yours is
  published elsewhere the link can 404. Nested `ghcr.io` paths and third-party
  registries are left unlinked rather than guessed at.
- The REST path costs 1 + 2N requests per repo (N = environments) for the
  dashboard. Expanding an environment adds 1 + 10 for history and — to resolve
  the workflow, job and job link — one per distinct commit whose status named
  no run, plus one per distinct run found. The cache keeps this in check, and a
  failed lookup degrades to a wider link rather than failing the history.
- The workflow and job of the *current* deployment are filled in when you
  expand the environment: they come from the same history fetch, which resolves
  them for every deployment it returns, so they cost no extra request.
