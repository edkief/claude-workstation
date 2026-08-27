# claude-workstation

Browser-accessible Claude Code development environments on Kubernetes. A small
dashboard app manages **one pod per workspace**: pick a repo and branch, get a
web terminal with Claude attached, a per-repo persistent volume, and a scratch
Postgres.

## Architecture

```
Browser
  │
  ▼  (Traefik ingress, authz-proxy middleware, one host/cert)
┌─────────────────────────────────────────┐
│ claude-dashboard (1 replica)            │
│   /api/*        session + PVC control   │──── Kubernetes API (namespaced Role)
│   /tty/<id>/*   HTTP+WS reverse proxy   │────┐
│   /config-tty/  shared-config shell     │    │
└─────────────────────────────────────────┘    │
                                               ▼
                        ┌──────────────────────────────────────┐
                        │ claude-workspace pod (one per repo)  │
                        │   :7681 ttyd  → byobu → claude remote│
                        │   :7682 agent → /healthz /disk       │
                        │   :5432 postgres (scratch)           │
                        │   /workspace ← per-repo PVC          │
                        └──────────────────────────────────────┘
```

The dashboard creates Kubernetes objects; it never shells out. A runaway agent
now OOMs its own pod instead of taking down every session and the UI with it —
which is the reason this design replaced the previous single-pod one.

### Components

| Path | Purpose |
|---|---|
| `dashboard/server.js` | Express app, routes, and the raw `upgrade` handler for WebSockets |
| `dashboard/lib/workspaceKey.js` | **The one place that defines storage granularity** (see below) |
| `dashboard/lib/naming.js` | `workspaceId()` — deterministic, DNS-safe, ≤63 chars |
| `dashboard/lib/podTemplate.js` | `buildWorkspacePodManifest()` — pure function, unit-tested |
| `dashboard/lib/sessions.js` | Lifecycle + `deriveStatus()` (pod → UI status) |
| `dashboard/lib/pvcs.js` | Per-repo PVC create/describe/prune, `touchPvc()` |
| `dashboard/lib/ttyProxy.js` | Pod-IP resolution + HTTP/WebSocket proxying |
| `dashboard/lib/k8s.js` | Client, `TtlCache`, error helpers |
| `dashboard/lib/metrics.js` | `metrics.k8s.io` with graceful degradation |
| `dashboard/prune-pvcs.js` | PVC pruner, run by a CronJob |
| `dashboard/public/index.html` | Single-file UI, no build step |
| `workspace/entrypoint.sh` | Bootstrap: secrets → config pull → clone → seed → supervisord |
| `workspace/agent.js` | In-pod health/disk endpoint (this is why we need no `pods/exec`) |
| `workspace/bootstrap/clone.sh` | Clone/refresh into `/workspace/<branch-slug>` |
| `shared/claude-config-sync/` | S3 sync CLI, copied into **both** images |
| `k8s/dashboard.yaml` | SA, Role, RoleBinding, PVC, ResourceQuota, Deployment, Service, Ingress |
| `dashboard/.env.example` | Every dashboard setting; a test asserts it matches `lib/config.js` |
| `workspace/.env.example` | The dashboard→pod env contract; a test asserts it matches `lib/podTemplate.js` |

## Session lifecycle

1. `POST /api/sessions {project, branch, newBranch?, replace?, resetHard?}`.
2. The dashboard validates the inputs, derives `key = workspaceKey({repoUrl})`
   and `id = workspaceId(key)`, and checks whether a pod named `id` exists.
   - Exists and `replace` is not set → **409** with the running session and
     `actions: ["attach","replace"]`. The UI offers *Open terminal* or *Replace*.
   - Exists and `replace` is set → delete, wait for the pod to go (the RWO
     volume must detach), then recreate on the **same PVC**.
3. `ensurePvc()` creates the repo's PVC if absent; otherwise it is reused warm.
4. The Pod is created and the API returns **202** immediately. A cold start
   pulls a multi-GB image and clones a repo — 60–180 s is normal, far past any
   browser or ingress timeout, so the UI polls instead (2 s while anything is
   starting, 10 s otherwise).
5. Inside the pod, `entrypoint.sh` runs to completion *before* supervisord, so
   the readiness probe reports not-ready for the whole bootstrap and each phase
   is visible in the UI as text (`syncing Claude config…`, `cloning repository…`).
6. Readiness is the agent's `/healthz`: bootstrap done **and** the bootstrap
   `claude remote --name $CLAUDE_SESSION_NAME` present in `/proc`. Never a
   `tmux capture-pane` match — the pane is a scrolling transcript, so any banner
   it looks for leaves the viewport and the pod flaps to not-ready while claude
   is fine. Matching on the session name, not on "any claude", keeps a user's
   own second `claude` from holding the pod ready.
7. Nothing supervises claude: `entrypoint.sh` types it into the tmux pane, and
   supervisord runs only ttyd, the agent and Postgres. So the agent self-heals —
   see below.

`POST /api/sessions/:id/activate` **no longer exists**, and must not come back:
terminals are per-session URLs now, not a global singleton with a 10-second
race window.

### Health, self-heal and restart

`/healthz` (readiness) and `/livez` (liveness) answer different questions, and
the split is the point:

| | fails when | consequence |
|---|---|---|
| `/healthz` | bootstrap unfinished, or the named `claude remote` is gone | UI shows the stage; **nothing restarts** |
| `/livez` | pod was ready once, claude is gone, and in-pane relaunch is exhausted | kubelet restarts the container |

Readiness gates only the UI here (a workspace Pod backs no Service), so a
readiness failure alone is *forever*: a pod once sat 503 for 8 h and 10 421
Unhealthy events without ever restarting. Liveness is the only lever, so it must
carry real meaning — never `{ok:true}` for "the agent process is alive".

The ladder, after `$WORKSPACE_STATE_DIR/ready` exists:

1. `/healthz` → 503, stage `session-lost` (surfaced as *Claude session lost;
   relaunching…*).
2. The agent retypes the launch command into the pane, `WORKSPACE_RELAUNCH_MAX`
   times (default 3), one per `WORKSPACE_RELAUNCH_BACKOFF_MS` (default 30 s).
   Cheap: pod, PVC, checkout and tmux session all survive.
3. Still gone → `/livez` 503 → container restart → `entrypoint.sh` reruns.
   `ready` lives on the container layer, so readiness is re-proved from scratch.

`/livez` never fails while `ready` is absent, so a slow clone is never shot, and
a claude that has *never* started stays 503 for a human rather than looping the
bootstrap. `WORKSPACE_SELF_HEAL=0` disables steps 2 and 3.

### Terminal failures: never a permanent spinner

A pod whose claude cannot start is Running, its container is happy, and
Kubernetes has nothing to report — so a login failure used to render as
*starting Claude…* forever. The agent therefore classifies the absence of
claude instead of just reporting it, and `describePod()` promotes those stages
to status `failed`:

| stage | detected by | UI |
|---|---|---|
| `auth-failed` | a known auth line in the pane, or (after 30 s, and never with `ANTHROPIC_API_KEY` set) missing / expired-without-refresh `~/.claude/.credentials.json` | *Claude login required (open the terminal and run /login)* + the reason |
| `launch-failed` | claude absent for `WORKSPACE_LAUNCH_TIMEOUT_MS` (default 180 s) with nothing in the pane explaining why | *Claude failed to start* + the pane tail |

Two rules keep this honest:

- **An auth failure stops the self-heal ladder.** Retyping the launch command
  cannot log anybody in, and a container restart re-runs a bootstrap that will
  fail the same way — so `/livez` stays 200 and the pod is left up, carrying its
  message, instead of crash-looping over it.
- **The terminal must stay reachable.** ttyd outlives claude, so `/healthz`
  reports `terminalReady` separately from `ready`, and `resolveTarget()` proxies
  a not-ready pod whose ttyd is up. Gating the terminal on readiness would lock
  the user out of the one place `/login` can be typed. The UI's Terminal button
  follows `terminalReady`, not `ready`.

The pane patterns are deliberately narrow (`AUTH_PATTERNS` in `agent.js`): a
false positive marks a healthy workspace failed. They are only ever consulted
while the bootstrap's `claude remote` is absent.

## Storage

**One PVC per repo**, named `workspaceId(key)`, holding every branch:

```
/workspace/                 ← the repo's PVC
  _home/claude/             ← mounted at ~/.claude (subPath)
  _home/claude.json         ← ~/.claude.json symlinks here
  main/                     ← checkout
  feature-x/                ← checkout
```

Terminating a session **deletes the pod and keeps the PVC**, so the next session
on that repo starts warm (checkout, `node_modules`, uncommitted work intact).
PVCs are reclaimed only by `prune-pvcs.js` (CronJob, 30 days) or an explicit
`DELETE /api/workspaces/:name`, which refuses while a pod holds the volume.

### Changing storage granularity

`dashboard/lib/workspaceKey.js` is the only file to touch. Today:

```js
function workspaceKey({ repoUrl, branch }) { return repoId(repoUrl); }
```

For one PVC per repo **and** branch, return `` `${repoId(repoUrl)}#${branch}` ``.
The `_home/` prefix and per-branch directory layout already match what that
change implies, so nothing else moves.

## Claude config (shared, via S3)

Each workspace has its own `~/.claude`, so config must be distributed. `~/.claude`
is ~80 MB, of which ~71 MB is `projects/` (transcripts) — a blind mirror is not
viable. A **curated allowlist** (~8 MB) is synced instead:

| Synced | Never synced |
|---|---|
| `.credentials.json`, `settings.json`, `CLAUDE.md` | `projects/`, `sessions/`, `session-env/`, `tasks/` |
| `skills/`, `plugins/`, `agents/`, `commands/` | `shell-snapshots/`, `history.jsonl`, `cache/` |
| `.claude.json` (**stripped**, see below) | `uploads/`, `telemetry/`, `backups/`, `file-history/` |

`.claude.json` is **merged, never overwritten**. On push, machine-specific and
cache keys are stripped (`projects`, `machineID`, `userID`, `cached*`, `*Cache`,
`last*`, …) — 61 keys reduce to ~19, 123 KB to ~3 KB. On pull, the remote doc is
merged *over* the local one and `projects` is preserved, so each pod keeps the
trust entry that lets Claude start without a dialog.

```bash
claude-config-sync pull     # workspace entrypoint, dashboard boot
claude-config-sync push     # after editing in the config shell
claude-config-sync status   # local vs remote divergence
```

Exit codes: `0` ok, `1` error, `3` stale (remote moved since your last pull),
`4` forbidden by `CONFIG_PUSH_POLICY`.

**Missing is not the same as failed.** rclone exits 3/4 for "not found";
everything else (SigV4 mismatch from a wrong `S3_REGION`, `AccessDenied`, TLS,
DNS, no such bucket) is a real error and must surface. Collapsing the two made
`pull` print *no remote config found; nothing to pull* and exit **0** on an auth
failure, and made `push` skip its version check — a null manifest reads as an
empty remote — and clobber whatever was there. Three rules follow:

- `manifest.json` lives at the bucket **root**, entries under `S3_PREFIX`.
  Objects under the prefix with no manifest is a broken remote, not an empty
  one: `pull` says so and exits 1 instead of reporting nothing to do.
- An entry listed in the manifest but absent from the bucket warns, and the pull
  **does not advance** `lastPullVersion` — otherwise the next `push` looks
  up-to-date and overwrites entries it never saw.
- `status` never throws on an unreachable remote: it prints `remote error` (and
  `orphan objects`). It is the command you run to find out why.

### S3 (Garage, not AWS)

Transport is rclone, configured from env into a 0600 config file — not
`RCLONE_CONFIG_<NAME>_*` env vars (remote-name casing is ambiguous) and not an
inline connection string (which would put the secret key in `ps` output).

| Variable | Required | Default | Notes |
|---|---|---|---|
| `S3_ENDPOINT` | yes | — | Garage S3 API endpoint |
| `S3_ACCESS_KEY_ID` | yes | — | |
| `S3_SECRET_ACCESS_KEY` | yes | — | |
| `S3_BUCKET` | no | `claude-config` | |
| `S3_REGION` | no | `garage` | **Must match Garage's `s3_region`** — it is part of the SigV4 credential scope, so a mismatch fails as a signature error |
| `S3_PROVIDER` | no | `Other` | rclone has **no** `Garage` provider value; `Other` is correct |
| `S3_FORCE_PATH_STYLE` | no | `true` | Garage serves `endpoint/bucket/key`, not `bucket.endpoint/key` |
| `S3_PREFIX` | no | `config` | |
| `CLAUDE_JSON_PATH` | no | `$HOME/.claude.json` | Override; used by the seed Job |

Verified against a live S3-compatible server: path-style addressing
(`GET /claude-config?...` with the bucket in the path), SigV4 scope picking up
`S3_REGION`, a full push→pull round-trip, the staleness refusal, and the
push-policy gate. Note rclone with `provider = Other` issues **ListObjects v1**,
which Garage supports.

The **config shell** runs inside the dashboard pod (`/config-tty/`, a localhost
hop, so it opens instantly) with its own 1 Gi PVC as the working copy. S3 is the
distribution artifact.

### The shared-login watchdog

`dashboard/lib/tokenCheck.js` re-reads the expiry of the config shell's
`.credentials.json` every `TOKEN_CHECK_MS` (default 30 min) and the UI shows a
banner for anything but a healthy verdict. This is the copy that every *new*
workspace pulls at bootstrap, so when it goes bad the symptom is "every session
I start from now on cannot log in".

It is an **offline check of the token's own expiry claim**, on purpose. There is
no stable endpoint that confirms an OAuth token without either spending tokens
or *rotating the credential* — a refresh call issues a new token and invalidates
this one, which would make the health check destructive. And a network probe
would turn any upstream blip into a false alarm.

| state | meaning |
|---|---|
| `valid` / `unknown` | nothing shown (`unknown` = no expiry claim to check) |
| `expiring` | inside `TOKEN_WARN_MS` (default 24 h) of expiry **and** with no refresh token — a renewable token always expires within hours, and warning on that would pin the banner up permanently |
| `stale` | expired but renewable: refresh tokens rotate, so the one in this copy may already have been consumed by a running pod and a new workspace pulling it can fail to log in — push from the config shell |
| `expired` | expired with no refresh token: new workspaces cannot log in |
| `missing` / `unreadable` | no credentials file, or not parseable |

The verdict never contains the token itself, only `hasRefreshToken`. Live
workspaces are covered separately by the agent's `auth-failed` stage, and by its
`/auth` endpoint.

### `CONFIG_PUSH_POLICY`

Set on the dashboard Deployment; propagated to workspace pods.

| Value | Effect |
|---|---|
| `any` (current) | Any pod may push |
| `dashboard` | Workspaces get read-only S3 credentials; only the config shell writes |
| `additive` | Pods may push `skills/`, `agents/`, `commands/` only |

Enforced in two layers, so it is not merely advisory: the CLI refuses, **and**
`buildWorkspacePodManifest()` hands out `claude-config-s3-ro` instead of
`claude-config-s3-rw` whenever the policy is not `any`. Both S3 users are
provisioned up front, so flipping the value and restarting the dashboard is the
whole change.

Pushes are per-entry and carry an optimistic version check against the remote
`manifest.json`: if the remote moved since your last pull, the push fails with
exit 3 rather than silently clobbering. Use `--force` to override. (This is a
compare-and-swap on a version counter, not an atomic S3 precondition — a
narrow TOCTOU window remains.)

## API

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/info` | Namespace, workspace image, `metricsAvailable`, defaults |
| `GET` | `/api/repos`, `/api/branches?repo=` | GitHub listing |
| `GET` | `/api/sessions`, `/api/sessions/:id` | 30 s cache, skipped while anything is unsettled |
| `POST` | `/api/sessions` | **202** / 400 / **409** / 429 |
| `DELETE` | `/api/sessions/:id` | 202; keeps the PVC unless `?deletePvc=true` |
| `POST` | `/api/sessions/:id/restart` | 202 |
| `GET` | `/api/sessions/:id/logs?tail=N` | `text/plain`; the UI polls this into a per-card panel |
| `GET` | `/api/workspaces` · `DELETE /api/workspaces/:name` · `POST /api/workspaces/prune` | PVC view |
| `GET` | `/api/resources` | metrics-server, or `{source:"unavailable"}` with **200** |
| `GET` | `/api/disk` | Per-PVC; live via the agent, else the `last-used-bytes` annotation |
| `GET` | `/api/config/status` · `POST /api/config/push` | Config sync |
| `GET` | `/api/config/token` | Shared-login watchdog verdict; `?fresh=1` re-checks now |
| `ALL` | `/tty/:id/*`, `/config-tty/*` | Proxied (incl. WebSocket upgrade) |

## Kubernetes

Pods are labelled `app=claude-workspace` and carry the repo/branch as sanitised
label slugs plus full values in `claude.kieffer.me/*` annotations (label values
cannot hold a URL or a branch with slashes). **There is no `state.json`** —
Kubernetes is the source of truth, with a 30 s in-memory cache that is bypassed
whenever a pod is `starting`/`terminating` or a write just happened.

RBAC is a **namespaced Role** in `dev`. Two deliberate omissions:

- **`pods/exec`** — the obvious way to run `df` in a workspace, and also a root
  shell into every workspace held by an internet-facing service. The in-pod
  agent replaces it.
- **`pods/status`** — `get`/`list` on `pods` already returns `.status`; the
  subresource only matters for *writing* status.

`create` on pods is inherently escalation-adjacent (it can mount any Secret in
the namespace). Keep the Role namespaced, never a ClusterRole, and keep the
ingress auth middleware.

## Key constraints

- Workspaces are **bare Pods with `restartPolicy: Always`**, not Deployments. An
  OOMKill restarts the container in place: same pod IP (the proxy cache stays
  valid), PVC stays attached, checkout survives. A Deployment would try to
  reschedule, and the RWO iSCSI volume is node-bound, so that stalls on
  `Multi-Attach`.
- **Node loss leaves a workspace `Failed`, not rescheduled.** This is intended;
  the UI shows it with a Replace button.
- **Replace is slow.** iSCSI detach/attach can take 30–60 s, and `Pending:
  Multi-Attach error` during that window is normal. The pod's Warning events are
  surfaced as `session.message` so it does not look like a hang.
- `MAX_WORKSPACES` (default 4) returns **429**; a `ResourceQuota` is the backstop.
- ttyd is told its own base path (`TTY_BASE_PATH=/tty/<id>`) because it bakes
  that path into the JS it serves. The proxy therefore rewrites nothing — do not
  add prefix-stripping without also rewriting the response body.
- The dashboard runs **1 replica**: the TTL and proxy-target caches are
  in-process.
- Pin `WORKSPACE_IMAGE` to an immutable tag once the image settles; with
  `:latest` + `Always`, every workspace start can pay a multi-GB re-pull.

## Development

```bash
cd dashboard && npm install
npm test                                  # pure-function tests, no cluster needed
NAMESPACE=dev node server.js              # runs against your kubeconfig

./docker-push.sh                          # both images (local/out-of-band)
./docker-push.sh dashboard --rollout      # one, then restart the dashboard
kubectl apply -f k8s/dashboard.yaml -f k8s/networkpolicy.yaml -f k8s/cleanup-cronjob.yaml
```

### Images

CI builds run through the cluster's Tekton pipeline, configured by
`.k8s-build.yaml`. Names follow the cluster convention `<registry>/<repo>/<name>`:

| | |
|---|---|
| `registry.kieffer.me/claude-workstation/dashboard` | `dashboard/Dockerfile` |
| `registry.kieffer.me/claude-workstation/workspace` | `workspace/Dockerfile` |

Two things about the build that are easy to get wrong:

- **Both builds use the repo root as context** (`context: .`), because each
  `COPY`s `shared/claude-config-sync/`. Neither can be scoped to its own
  subdirectory. `.dockerignore` is what keeps that context small.
- **`shared/**` appears in both `paths` filters**, so a change to
  `claude-config-sync` rebuilds both images — it ships inside each.

`docker-push.sh` mirrors the same naming (`REGISTRY`, `REPO_NAME`) and the same
`:latest`-only-on-`main` policy, so a local build and a pipeline build are
interchangeable. Keep the two in sync if either changes.

Secrets: see `k8s/secrets.example.yaml` (`github-ssh-key`,
`claude-config-s3-rw`, `claude-config-s3-ro`).

## Postgres

Each workspace runs its own Postgres on `localhost:5432` (`postgres`/`postgres`),
`PGDATA=/home/ubuntu/pgdata` on the **container layer**, so every pod start gets
a fresh, empty cluster. Local socket: `psql -h /home/ubuntu/pgdata -U postgres`
(trust auth) — `/var/run/postgresql` is owned by the distro `postgres` user and
cannot be chowned in-container. Anything worth keeping belongs in the repo.
