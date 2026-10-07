# instinct-bridge (public source copy)

Poll-out bridge: your machine polls a queue, a supervising AI pushes tasks, and a coding agent does the work on a per-task git branch.

Queue transport needs no inbound ports. The daemon also serves a loopback-only HTTP ingress on `127.0.0.1:8787` (see `src/core.js`).

## Requirements

- Node `>=18` (see `engines` in `package.json`)
- `npm install` (installs the `express` dependency)
- `opencode` on `PATH` plus completed `opencode auth login`
- A free Upstash Redis REST URL + token
- `git`

## Install

```sh
npm install
node bin/bridge.js init    # prompts for Upstash URL/token, tests them, adds repos, writes bridge.config.json (chmod 600)
node bin/bridge.js start  # runs the daemon
```

`bridge.config.json` is local-only state created by `init`. Never commit it. It holds `upstash_url`, `upstash_token`, `bridge_secret`, optional `opencodeServerPassword`, plus `source`, `executor`, `poll_seconds`, `task_timeout_minutes`, `opencode_bin`, `model`, and `repos` (`{name: absolutePath}`).

CLI (see `bin/bridge.js`):

```sh
node bin/bridge.js push <repo> "<task>" [session_id]
node bin/bridge.js result [secs]
```

## How it works

- Source adapter (`adapters/source-upstash.js`) uses Upstash REST: `RPUSH bridge:tasks` to enqueue, `BLPOP bridge:tasks` (default 25s) to receive; `RPUSH`/`BLPOP bridge:results` for results. `ping()` uses `PING`.
- Each task runs on branch `bridge/<task-id>` (sanitized). Tasks run one at a time (serialized in `src/core.js`) so branches and the shared session directory do not race.
- Executor contract: `run({task, cwd, sessionId, timeoutMs}) -> {sessionId, summary, questions[]}`.
  - `adapters/executor-opencode.js`: runs `opencode run --auto --format json [--session ...] [--model ...]` in `cwd` with an appended branch rule. `--format json` output is parsed defensively for text and session ID.
  - `adapters/executor-opencode-server.js`: uses `opencode serve` on `127.0.0.1:4199` (`POST /api/session`, `POST /api/session/<id>/prompt`, `GET /api/session/<id>/message`). It reuses an already-running server when auth matches. Completion waits for an `idle` message before accepting assistant text. Wait floor is 120 minutes even if `task_timeout_minutes` is smaller; larger `timeoutMs` values are honored.
- Result shape: `{id, status, branch, session_id, open_command, summary, diffstat, questions[]}`. `status` is `done`, `needs_input`, `still_running`, or `error`.
- Wait exhaustion returns `still_running` with the session ID and `open with: opencode --session <id>`, not a bare timeout. Reconnect with a NEW task id plus that `session_id` for multi-turn work.
- Local HTTP ingress (`src/core.js`, `127.0.0.1:8787`): `GET /tasks/new` form, `POST /tasks` (secret-gated, rejects duplicate ids), `GET /results`, `POST /results/view`, `GET /results/:id`. Results are appended to `results.jsonl` (local runtime file, git-ignored).

## Guardrails (as implemented)

- Per-task `bridge_secret` check; unknown repo, missing id/task rejected.
- After the run, `HEAD` is verified against the task branch; landing on `main`/`master` or another branch marks `error`.
- The bridge itself never pushes to a remote.
- The executor prompt rule (“stay on the current branch…”) is a soft prompt rule, not a hard guarantee.
- Secret scrubbing is a `HOOK` placeholder in `src/core.js`, not an implemented sanitizer.
- Dirty-tree refusal is NOT enforced: the check in `src/core.js` is commented out.

## Permissions

- Command and file permissions are controlled by OpenCode's own `opencode.json`, not by this bridge - the bridge runs whatever the user's OpenCode config allows, and there are no bridge-level prompts.
- Recommended starting example:

```json
{
  "permission": {
    "read": {
      "*": "allow",
      ".env": "deny",
      ".env.*": "deny",
      "*.env": "deny",
      "*.env.*": "deny",
      "*.env.example": "allow"
    },
    "glob": "allow",
    "grep": "allow",
    "list": "allow",
    "edit": {
      "*": "deny",
      "adapters/*": "allow",
      "src/*": "allow",
      "bin/*": "allow",
      "test/*": "allow",
      "LICENSE": "allow",
      "README.md": "allow",
      "package.json": "allow",
      "bridge.config.json": "deny",
      "opencode.json": "deny",
      ".env": "deny",
      ".env.*": "deny",
      "*.env": "deny",
      "*.env.*": "deny",
      "*.log": "deny",
      "results.jsonl": "deny"
    },
    "bash": {
      "*": "ask",
      "git": "allow",
      "git *": "allow",
      "npm": "allow",
      "npm *": "allow",
      "node": "allow",
      "node *": "allow",
      "npx": "allow",
      "npx *": "allow",
      "git push": "deny",
      "git push *": "deny",
      "sudo": "deny",
      "sudo *": "deny",
      "rm -rf *": "deny"
    },
    "external_directory": {
      "*": "deny"
    },
    "webfetch": "ask",
    "websearch": "ask"
  }
}
```

- A full-allow config (`"*": "allow"` everywhere) is an option for users who want zero prompts, and each user picks what fits their risk comfort.

## Verify on your machine

- If summaries or session IDs come back empty, run your opencode command once by hand and adjust the defensive JSON parsing in the executor.
- `needs_input` is a heuristic: the last paragraph contains a line ending in `?`.
