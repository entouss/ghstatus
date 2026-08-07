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
▾ 🟥 my-org/api                        3 envs · 12m ago
    › 🟩 production   v2.3.1           2h ago · @alice
    ▾ 🟥 staging      abc1234          12m ago · @bob
          Status        🟥 Failure
          Updated       12m ago
          Triggered by  @bob
          Commit        abc1234
          Ref           main
          Image         ghcr.io/my-org/api:2.4.0-rc1
          Links         View logs · Open environment

          PAST DEPLOYMENTS                              ↗
          🟩 9f2e10c  v2.3.1      2d ago · @alice
          🟩 41ab7c3  v2.3.0      6d ago · @alice
    › ⬜ preview                       no deployments
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
- fine-grained: read access to *Deployments*, *Environments*, *Contents*

The token lives in `chrome.storage.local` for this profile only. **Settings →
Test** verifies it.

In `Auto` mode a token, when set, is tried first and the session is the
fallback; with no token, only the session is used.

## Behaviour

- **Repos are collapsed by default.** What you expand is remembered across
  popup openings.
- **History is fetched lazily** — only when you expand an environment, and only
  the latest 10 — so the initial dashboard stays cheap.
- Results are cached (default 120s) so reopening the popup is instant.
  **Refresh** re-fetches everything and drops the history cache too.
- Repos are fetched 4 at a time, environments within a repo likewise.
- Failures are reported per repo, so one bad repo doesn't blank the dashboard.
- Every ↗ opens the corresponding GitHub page; commit hashes and `@handles`
  link out too.

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
    github-api.js          PAT path (REST API)
    github-html.js         session path (page scraping)
    loader.js              auth selection, rollup, caching, concurrency
    util.js                mapLimit, timeAgo, shortSha
```

## Known limits

- The session path depends on GitHub's page markup. If it breaks, the popup
  says so and points at the token option. History in session mode is scraped
  from the environment's activity log and recovers less detail — no payload,
  so no image or version.
- Only the latest 10 deployments per environment are listed; the ↗ beside
  **Past deployments** opens the full activity log.
- The REST path costs 1 + 2N requests per repo (N = environments) for the
  dashboard, plus 1 + 10 when an environment is expanded. The cache keeps this
  in check.
