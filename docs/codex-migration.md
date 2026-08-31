# Switching the workspace agent from Claude Code to Codex

> **Implementation update (2026-08-31):** the repository now takes the dual
> support route without replacing the workspace agent. Every workspace runs
> `@edkief/codexapp@0.1.87` on port 7684 with
> `--base-path /codex/<workspace-id>`. The dashboard proxies its HTTP and
> App Server WebSocket traffic, and persistent Codex state lives at
> `/workspace/_home/codex`. Codex runs with `danger-full-access` and approval
> policy `never` because the workspace is designed for unattended remote work;
> the pod boundary provides containment. The assessment below remains useful background for
> a future Codex-only mode and shared-credential work, but its statement that
> only a web TTY is available has been superseded by this implementation.

An assessment of what it would take to run OpenAI's Codex CLI in the workspace
pods instead of (or alongside) Claude Code. Written 2026-08-29 against Codex's
published documentation; nothing here has been tried against a live Codex
install.

**Summary.** The pod, storage, proxy and Kubernetes layers are agent-agnostic
and survive untouched — roughly 70% of the stack. Three things do not port: the
`claude remote` control channel has no headless equivalent, the readiness probe
loses the marker it matches on, and the shared-OAuth machinery collides with
Codex's documented "one `auth.json` per machine" rule. The recommended path is
dual support with API-key authentication for Codex, which deletes the token
machinery rather than reimplementing it.

## 1. Remote control has no equivalent

Codex Remote is not the same feature as `claude remote`. It pairs the **ChatGPT
mobile app** to a **ChatGPT desktop app** running on a macOS or Windows host, by
QR code, over an authenticated relay. The documentation describes no Linux
support, no headless or container host, and no CLI command that starts a
remote-controllable session. The one cloud-host option provisions a DigitalOcean
droplet through an OpenAI plugin — OpenAI's container, not ours.

The nearest programmatic surface is `codex app-server`, a bidirectional JSON-RPC
protocol intended for IDE embedding. Exposing it over a network transport so a
remote client can attach is an open feature request
([openai/codex#11166](https://github.com/openai/codex/issues/11166)), not a
shipped capability.

So a Codex process inside a workspace pod cannot publish itself to a web control
plane the way `claude remote --name $CLAUDE_SESSION_NAME` does today.

The practical loss is smaller than it sounds. This stack already ships its own
browser access path — ttyd on `:7681`, behind `/tty/<id>/`, attached to a byobu
session that `entrypoint.sh` creates whether or not a browser is connected. A
Codex workspace would run plain `codex` in that pane and be driven from the same
URL. What disappears is the phone and claude.ai route into a session, which was
never something this repo implemented.

## 2. The readiness probe needs a new anchor

`claudeRemoteRunning()` in `workspace/agent.js:121` scans `/proc` for a process
whose argv contains `remote` **and** `--name <CLAUDE_SESSION_NAME>`. Matching the
session name rather than "any claude" is deliberate: it stops a user's own second
`claude`, started in another window, from holding the pod ready after the
bootstrap session has died.

Codex has no `--name` flag, so that discriminator has to be rebuilt — a wrapper
script on the launch path, or a marker argument the agent can match. Matching
bare `codex` would reintroduce exactly the false-ready case the current code was
written to avoid.

Everything downstream of the match — the stage ladder, the in-pane relaunch
budget, the `/healthz` vs `/livez` split, `terminalReady` reported separately —
is agent-independent and keeps working once the match is correct.

## 3. Authentication is the real risk

| | Claude Code | Codex |
|---|---|---|
| credentials file | `~/.claude/.credentials.json` | `~/.codex/auth.json` |
| storage default | file | keyring; needs `cli_auth_credentials_store = "file"` in `config.toml` |
| shape | `claudeAiOauth.expiresAt`, `refreshToken` | `auth_mode: "chatgpt"`, `tokens.{access_token,refresh_token,id_token}`, `last_refresh` |
| expiry claim | explicit `expiresAt` | **none** — decode `exp` from the `id_token` JWT, or infer from `last_refresh` |
| rotation cadence | hours | staleness at roughly 8 days |

The expiry difference alone rewrites `dashboard/lib/tokenCheck.js`, whose whole
premise is an offline read of the token's own expiry claim. With Codex that claim
lives inside a JWT and has to be decoded, or approximated from `last_refresh`
plus the staleness window — an approximation, not a claim.

The blocker is bigger than that. Codex's CI/CD authentication guide states
plainly: use one `auth.json` per runner or per serialized workflow stream, and do
not share the same file across concurrent jobs or multiple machines. The
"whoever refreshes publishes, everyone else adopts the newest" invariant in
`dashboard/lib/tokenRefresh.js` and `workspace/agent.js` is precisely the pattern
that text warns against. It may well work — Codex rotates refresh tokens the same
way, and adoption here is ordered by expiry rather than by write order — but it
would be running against the vendor's documented constraint, and the failure mode
is every workspace locked out at once.

There is also no confirmed zero-cost refresh trigger. The current design leans on
`claude -p /usage`, which reaches the backend without invoking a model. Whether
`codex exec` has an equivalent that exercises the auth path without spending
tokens is unverified.

**The cheap escape:** issue workspaces an `OPENAI_API_KEY` instead of ChatGPT
OAuth. API keys do not rotate on their own, so `tokenCheck.js`, `tokenRefresh.js`,
the `token pull|push|status` subcommands, the separate `AUTH_S3_BUCKET` object
with its generation counter, the adoption rules, and the agent's token-sync path
off the readiness probe all delete outright. The credential becomes an ordinary
Kubernetes Secret. That is a large net simplification, and it is the reason the
recommendation below prefers it.

## 4. Config sync is a rewrite, not a port

| Claude | Codex |
|---|---|
| `~/.claude` | `~/.codex` |
| `settings.json` (JSON) | `config.toml` (**TOML** — different merge code) |
| `CLAUDE.md` | `AGENTS.md` |
| `commands/` | `prompts/` |
| `skills/`, `plugins/`, `agents/` | no equivalent; MCP servers are declared in `config.toml` |
| `.claude.json`, stripped and merged (61 keys → ~19) | no analog |

The merge semantics are the substantive part. `.claude.json` merging exists
because that file mixes shared settings with machine-specific state and a
per-directory trust map that each pod must keep. Codex's `config.toml` has no
such split, so the strip list and the `projects` preservation rule go away — but
merging TOML while preserving comments and table ordering is its own problem, and
`CONFIG_PUSH_POLICY`'s `additive` mode loses the directories it currently names.

Everything in `shared/claude-config-sync/` below the allowlist is agent-agnostic
and stays: the rclone transport and its 0600 config file, the root-level
`manifest.json`, the optimistic version check and exit 3, `catMaybe()` folding an
empty body into missing, the missing-vs-failed distinction, and `status` never
throwing on an unreachable remote.

## 5. What does not move

The Kubernetes layer, PVC-per-repo storage and `workspaceKey`/`workspaceId`,
`buildWorkspacePodManifest()`, the ttyd reverse proxy including the WebSocket
upgrade path and `TTY_BASE_PATH`, byobu/tmux session creation, `clone.sh`, the
scratch Postgres, metrics, the PVC pruner, the replace/409 flow with its
Multi-Attach window, and the shape of the `/healthz` → relaunch → `/livez` ladder.

## 6. Effort

**Codex with an API key — roughly 2 to 4 days.**

| Area | Work |
|---|---|
| `workspace/entrypoint.sh` | install `@openai/codex`, change the launch line, register MCP servers via `config.toml` rather than `claude mcp add` |
| `workspace/agent.js` | process match and its marker, `AUTH_PATTERNS`, credentials path and shape, relaunch command — ~150 lines |
| `shared/claude-config-sync/` | allowlist, TOML merge, drop the `.claude.json` path |
| `dashboard/lib/` | delete `tokenCheck.js` and `tokenRefresh.js`, and the `/api/config/token*` routes and UI banner |
| env contract | `dashboard/.env.example`, `workspace/.env.example`, and the two tests asserting they match the code |
| `CLAUDE.md` | substantial rewrite |

**Codex with shared ChatGPT OAuth — add about a week**, plus the unsupported
credential-sharing risk in §3 and the unverified refresh trigger.

**Dual support — add about 2 days** over a single switch. Divergence is confined
to three places: the launch line in `entrypoint.sh`, the process match in
`agent.js`, and the allowlist in config-sync. A per-session `AGENT` field would
select between them.

## 7. Recommendation

Build dual support with API-key authentication for Codex first. It leaves the
working Claude path intact, avoids the credential-sharing question entirely, and
proves the pieces that are genuinely uncertain — the readiness marker and the
TOML merge — before anything is removed. Revisit shared ChatGPT OAuth only if
per-workspace API keys turn out to be unacceptable on cost or plan grounds.

Accept that remote control does not come along. If driving a session from a phone
matters, it is a separate problem from this migration, and `codex app-server`
behind the existing authenticated ingress is the shape it would take.

## Sources

- [Codex Remote](https://learn.chatgpt.com/docs/remote)
- [Maintain Codex account auth in CI/CD](https://learn.chatgpt.com/docs/auth/ci-cd-auth)
- [Codex configuration reference](https://developers.openai.com/codex/config-reference)
- [Codex CLI reference](https://developers.openai.com/codex/cli/reference)
- [openai/codex#11166 — expose app-server over network transport](https://github.com/openai/codex/issues/11166)
- [Work with Codex from anywhere](https://openai.com/index/work-with-codex-from-anywhere/)
