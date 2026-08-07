# GH Deployment Status

A Chrome extension that shows, at a glance, the deployment state of every
environment across the repos you care about.

```
my-org/api      🟩 production   🟧 staging   ⬜ preview
my-org/web      🟥 production   🟩 staging
```

| | State |
|---|---|
| 🟩 | `success`, `active` |
| 🟧 | `in_progress`, `queued`, `pending`, `waiting` (approval) |
| 🟥 | `failure`, `error` |
| ⬜ | `inactive`, `destroyed`, no deployments, unknown |

## Install

```sh
git clone <this repo> && cd ghstatus
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

The catch: that page is unversioned HTML. The parser
([`src/lib/github-html.js`](src/lib/github-html.js)) tries GitHub's embedded
React JSON payload first and falls back to reading the rendered cards, but a
redesign can still break it. It is deliberately the only file that knows what
the page looks like.

**Personal access token** — uses the REST API (`/environments`,
`/deployments`, `/deployments/{id}/statuses`), which is versioned and returns
real state strings. More reliable, and the only option for repos you can't
reach from this browser session. Scopes:

- classic: `repo`
- fine-grained: read access to *Deployments*, *Environments*, *Contents*

The token lives in `chrome.storage.local` for this profile only. **Settings →
Test** verifies it.

In `Auto` mode a token, when set, is tried first and the session is the
fallback; with no token, only the session is used.

## Behaviour

- Results are cached (default 120s) so reopening the popup is instant; the
  **Refresh** button always re-fetches.
- Repos are fetched 4 at a time.
- A repo name links to its deployments page; an environment chip links to that
  environment's activity log. Hover a chip for the exact state and timestamp.
- Failures are reported per repo, so one bad repo doesn't blank the dashboard.

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
  popup.{html,css,js}      dashboard
  options.{html,css,js}    settings
  lib/
    config.js              storage + URL derivation
    state.js               state -> 🟩🟧🟥⬜ mapping
    github-api.js          PAT path (REST API)
    github-html.js         session path (page scraping)
    loader.js              auth selection, caching, concurrency
```

## Known limits

- The session path depends on GitHub's page markup. If it breaks, the popup
  says so and points at the token option.
- Only the *latest* deployment per environment is shown.
- The REST path costs 1 + 2N requests per repo (N = environments), which the
  cache keeps in check.
