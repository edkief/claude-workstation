# claude-workstation

A Kubernetes-deployed container that provides a browser-accessible Claude Code development environment. It combines a web terminal (ttyd) with a small Express API that manages Claude Code remote sessions inside byobu/tmux.

## Architecture

```
Browser
  ├── /              → ttyd (port 7681) — full bash terminal
  ├── /api/*         → Express API (port 3000) — session management
  └── /sessions/*    → Express API (port 3000) — session management
```

Both services are managed by supervisord and started by `entrypoint.sh`.

### Components

| File/Dir | Purpose |
|---|---|
| `Dockerfile` | Ubuntu 24.04 image; installs Node 24 (via nvm), Claude Code CLI, byobu, ttyd, supervisord |
| `entrypoint.sh` | Copies SSH keys from Kubernetes secret, initializes session state, exports env vars, starts supervisord |
| `supervisord.conf` | Defines `ttyd` (port 7681) and `api` (port 3000) programs |
| `api/server.js` | Express REST API — session lifecycle, GitHub repo/branch listing |
| `api/public/index.html` | Single-page web UI — lists sessions, launches new ones |
| `claude-pod.yaml` | Kubernetes Deployment, PVC (20 Gi), Service, and Ingress manifests |
| `docker-push.sh` | Build and push the image to the private registry |

### Session lifecycle

1. User selects a repo + branch in the web UI (or enters a Git URL manually).
2. `POST /api/sessions` clones the repo into `~/workspace/<session-name>`, creates a byobu session, and runs `claude remote --name <session-name> --spawn=same-dir` inside it.
3. The API polls `tmux capture-pane` until it sees `Connected` or `Ready` alongside the session name (≤ 30 s timeout).
4. Session state is persisted to `~/.claude-sessions/state.json` (atomic write via temp file + rename).
5. `POST /api/sessions/:name/activate` writes `~/.claude-session` so the next bash login auto-attaches to the byobu session.
6. `DELETE /api/sessions/:name` kills the tmux session and removes the entry from state.

### Persistent storage (Kubernetes PVC)

The PVC (`claude-workspace-pvc`, 20 Gi, ReadWriteOnce) is mounted at three paths:

| Mount path | PVC subPath |
|---|---|
| `/home/ubuntu/workspace` | (root) |
| `/home/ubuntu/.claude` | `.claude-config` |
| `/home/ubuntu/.claude-sessions` | `.claude-sessions` |
| `/home/ubuntu/.claude.json` | `.claude.json` |

This means workspace data, Claude Code config, and session state all survive pod restarts.

### Secrets

A Kubernetes Secret (`github-ssh-key`) provides:
- `id_rsa` — SSH key mounted at `/run/secrets/github-ssh/id_rsa`, copied to `~/.ssh/id_rsa` at startup for git operations
- `github_token` — GitHub PAT injected as `GITHUB_TOKEN` env var, used by the API for authenticated GitHub API calls

## API endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/info` | Returns `{ podName }` |
| `GET` | `/api/repos` | Lists GitHub repos (authenticated: all accessible; unauthenticated: public only) |
| `GET` | `/api/branches?repo=owner/name` | Lists branches for a repo |
| `GET` | `/api/sessions` | Lists sessions with live tmux status check |
| `POST` | `/api/sessions` | Starts a new session (body: `{ project, branch, newBranch?, force? }`) |
| `POST` | `/api/sessions/:name/activate` | Writes `~/.claude-session` for next login auto-attach |
| `DELETE` | `/api/sessions/:name` | Terminates a session |

## Development

### Build and deploy

```bash
# Build and push image
./docker-push.sh

# Apply Kubernetes manifests
kubectl apply -f claude-pod.yaml
```

### Running the API locally

```bash
cd api
npm install
node server.js
```

Environment variables used by `server.js`:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `STATE_FILE` | `/home/ubuntu/.claude-sessions/state.json` | Session state path |
| `WORKSPACE_ROOT` | `/home/ubuntu/workspace` | Root for cloned repos |
| `GITHUB_USER` | `edkief` | Fallback for unauthenticated repo listing |
| `GITHUB_TOKEN` | — | GitHub PAT for authenticated API calls |
| `POD_NAME` | `unknown` | Injected by Kubernetes Downward API |

## Key constraints

- The Deployment uses `strategy: Recreate` — only one pod runs at a time, enforced by the ReadWriteOnce PVC.
- `byobu` is pre-configured to use tmux-style keybindings (`ctrl+b`) via a symlink in `~/.byobu` so the first-run prompt never appears.
- `supervisord` runs as root but spawns `ttyd` and `api` as `ubuntu` (uid 1000). Node and npm binaries are symlinked into `/usr/local/bin` so supervisord (which has no `.bashrc`) can find them.
- The ingress is protected by an auth proxy middleware (`authz-proxy-authz-reverse-proxy`).
