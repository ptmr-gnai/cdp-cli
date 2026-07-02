# cdp-cli

Agent-first Chrome DevTools Protocol CLI.

`cdp-cli` treats browser automation as a coding problem. It connects to a local Chrome DevTools Protocol endpoint, performs actions, and projects page state into local files so coding agents can inspect, diff, and iterate using normal shell and editor tools.

## Principles

- JSON is the default command output.
- Browser state is cached in the filesystem.
- Mutating commands capture before and after snapshots and write diffs.
- DOM, accessibility, text, metadata, scripts, screenshots, and command results live in files.
- Raw JavaScript evaluation is always available, but it is recorded as an artifact.
- Site helpers are discoverable from the current page and can be run as agent-readable recipes.

## Chrome setup

For Chrome 144 and newer, open:

```text
chrome://inspect/#remote-debugging
```

Enable remote debugging and accept Chrome's permission dialog. By default the CLI connects to:

```text
http://127.0.0.1:9222
```

Chrome's live-profile remote debugging flow writes the actual browser WebSocket endpoint to `DevToolsActivePort` in the Chrome user-data directory. The classic `/json/version` and `/json/list` endpoints may return `404` in this mode. `cdp-cli` handles this automatically by reading:

```text
~/Library/Application Support/Google/Chrome/DevToolsActivePort
```

Override the location when needed:

```sh
cdp-cli --user-data-dir "/path/to/Chrome/User Data" status
```

For older/manual flows, launch Chrome with a non-default profile:

```sh
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/cdp-cli-chrome-profile
```

## Quick start

```sh
npm install
npm run build
npm link

cdp-cli status
cdp-cli list
cdp-cli open https://example.com
cdp-cli snapshot
cdp-cli current
cdp-cli eval 'document.title'
cdp-cli wait 1000
```

Every command prints JSON with filesystem paths and suggested next actions.

## Commands

```sh
cdp-cli status
cdp-cli list
cdp-cli open https://example.com
cdp-cli navigate https://example.org
cdp-cli close --target example.com
cdp-cli snapshot [label]
cdp-cli current
cdp-cli orient
cdp-cli eval 'document.title'
cdp-cli eval --file ./scratch.js
cdp-cli wait 1000
cdp-cli settle 1000
cdp-cli click 'a[href]'
cdp-cli click n000017
cdp-cli click n000017 --wait 3000
cdp-cli type 'input[name="q"]' 'search text'
cdp-cli fill n000017 'search text'
cdp-cli press Enter
cdp-cli helpers list
cdp-cli helpers run generic links
cdp-cli evals readonly-sites
```

For live-profile Chrome, prefer the persistent daemon:

```sh
cdp-cli --trace daemon start
cdp-cli --daemon status
cdp-cli --daemon open https://example.com
cdp-cli --daemon snapshot
cdp-cli daemon stop
```

Global options:

```sh
--browser-url http://127.0.0.1:9222
--user-data-dir "/path/to/Chrome/User Data"
--out-dir .cdp-cli
--target <target-id-title-or-url-fragment>
--timeout 5000
--trace
--daemon
--no-screenshot
```

## Filesystem projection

Artifacts are written under `.cdp-cli/` by default:

```text
.cdp-cli/
  targets/
    <url>-<target-id>/
      current/
        meta.json
        state.json
        dump.txt
        text.md
        dom.html
        nodes.ndjson
        links.ndjson
        controls.ndjson
        visible-controls.ndjson
        forms.ndjson
        dialogs.ndjson
        frames.ndjson
        accessibility.json
        dom-snapshot.json
        helpers.json
        screenshot.png
      snapshots/
        <timestamp>-<label>/
      diffs/
        <timestamp>-<label>/
          state.diff
          text.diff
          dom.diff
  runs/
    <timestamp>-eval/
      script.js
      result.json
```

The important files for agents are usually:

- `state.json`: URL, title, viewport, headings, controls, dialogs, active element, and metadata.
- `dump.txt`: grep-first tree of the page, including selectors, visibility, rects, text nodes, same-origin frames, and open shadow roots.
- `text.md`: readable page text.
- `nodes.ndjson`: one structured record for every element in `dump.txt`; action refs use this to traverse shadow roots and same-origin frames.
- `visible-controls.ndjson`: visible links/buttons/inputs/selectors to try first.
- `controls.ndjson`, `links.ndjson`, `forms.ndjson`, `dialogs.ndjson`, `frames.ndjson`: fuller structured indexes for fallback inspection.
- `dom.html`: full HTML for fallback inspection.
- `helpers.json`: helper commands available for the current URL.
- `diffs/*`: patches from the previous current snapshot to the latest snapshot.

`dump.txt` and the structured indexes redact sensitive hidden/password-like input values and omit script/template bodies. `dom.html` is intentionally raw and should be treated as a fallback artifact.

`current` is the agent orientation command. It reads the latest snapshot files from disk and reports the current directory, artifact paths, line counts, index counts, helper matches, suggested `rg` commands, and likely next commands:

```sh
cdp-cli current --target example.com
cdp-cli orient --target example.com
```

`current.data.current.refs.candidates` lists a small ranked set of refs from `visible-controls.ndjson` with scores and reasons such as `fillable`, `action text`, `input hint`, or `below fold`. The underlying files remain the source of truth; the ranking is just a quick starting point for the next grep/click/fill step.

Refs such as `n000017` are reusable by action commands until the next snapshot changes them:

```sh
rg 'Search|Login|Submit|selector=' .cdp-cli/targets/*/current/{dump.txt,visible-controls.ndjson,forms.ndjson}
cdp-cli click n000017
cdp-cli wait 1000
cdp-cli fill n000042 'agent query'
```

Use `wait` / `settle` after client-side transitions, fetches, timers, or popups. It records a no-op before/after run and writes diffs, making SPA changes visible in the filesystem without reaching for screenshots or raw JS first.

## Read-only evals

The built-in eval suite opens pages, snapshots them, records artifact sizes, and closes the tabs it created:

```sh
cdp-cli --no-screenshot evals readonly-sites
cdp-cli --no-screenshot evals readonly-sites \
  --site github=https://github.com/github/docs \
  --site webcomponents=https://mdn.github.io/web-components-examples/popup-info-box-web-component/
```

Use `--keep-open` to leave eval-created tabs open for manual inspection.

Each eval result includes a `quality` object with required artifact presence, useful counts from the files (`dumpLines`, `nodes`, `visibleControls`, `forms`, `dialogs`, `frames`, `openShadowRoots`), and warnings when a snapshot is too thin for an agent to navigate with normal shell tools.

## Site helpers

Helpers are built in and matched by URL. The initial registry includes:

- `generic`: links and forms on any HTTP(S) page.
- `x`: visible posts and bookmark candidate links on `x.com` / `twitter.com`.
- `github`: repository context and discussion item extraction on GitHub.

Run:

```sh
cdp-cli helpers list
cdp-cli helpers run x visible-posts --target x.com
```

Helper runs are recorded like any other eval: source script, result JSON, before snapshot, after snapshot, and diffs.

## Daemon

Chrome's live-profile remote debugging flow may show an approval dialog when a new client requests browser control. For agent workflows, use the daemon so Chrome only sees one long-lived browser connection:

```sh
cdp-cli --trace daemon start
cdp-cli --daemon list
cdp-cli --daemon eval 'document.title'
```

The daemon is a local CDP proxy. It reads Chrome's `DevToolsActivePort`, connects once to the browser WebSocket, and exposes classic CDP endpoints on `http://127.0.0.1:9339`:

```text
/json/version
/json/list
/json/new
/json/close/<target-id>
/devtools/page/<target-id>
```

Commands using `--daemon` automatically start or reuse the proxy and then talk to `http://127.0.0.1:9339`. Daemon state is stored at:

```text
.cdp-cli/daemon.json
```

Trace logs are JSONL files under:

```text
.cdp-cli/logs/
```

Useful events include `active_port.read.*`, `daemon.browser.connect.*`, `daemon.http.request`, `daemon.target.attach`, `daemon.target.detach`, and `daemon.target.close`.

## Notes for live Chrome

The live-profile Chrome flow requires a user permission step in Chrome. For automated tests or development, a temporary profile remains useful:

```sh
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9333 \
  --user-data-dir=/tmp/cdp-cli-dogfood-profile \
  --no-first-run \
  --no-default-browser-check \
  about:blank
```

Then:

```sh
cdp-cli --browser-url http://127.0.0.1:9333 open https://example.com
```
