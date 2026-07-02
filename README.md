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
cdp-cli eval 'document.title'
```

Every command prints JSON with filesystem paths and suggested next actions.

## Commands

```sh
cdp-cli status
cdp-cli list
cdp-cli open https://example.com
cdp-cli snapshot [label]
cdp-cli eval 'document.title'
cdp-cli eval --file ./scratch.js
cdp-cli click 'a[href]'
cdp-cli type 'input[name="q"]' 'search text'
cdp-cli press Enter
cdp-cli helpers list
cdp-cli helpers run generic links
```

Global options:

```sh
--browser-url http://127.0.0.1:9222
--out-dir .cdp-cli
--target <target-id-title-or-url-fragment>
--timeout 5000
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
        text.md
        dom.html
        accessibility.json
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
- `text.md`: readable page text.
- `dom.html`: full HTML for fallback inspection.
- `helpers.json`: helper commands available for the current URL.
- `diffs/*`: patches from the previous current snapshot to the latest snapshot.

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
