# claude-workstation

A Kubernetes-deployed container that provides a browser-accessible Claude Code development environment. It combines a web terminal ([ttyd](https://github.com/tsl0922/ttyd)) with a small Express API that manages Claude Code remote sessions inside byobu/tmux.

## How it works

```
Browser
  ├── /              → ttyd (port 7681) — full bash terminal
  ├── /api/*         → Express API (port 3000) — session management
  └── /sessions/*    → Express API (port 3000) — session management
```

Both services are managed by supervisord and started by `entrypoint.sh`. The web UI (served by the API) lets you browse your GitHub repos, pick a branch, and launch a Claude Code session — all from your browser. Once a session is running you hit **Terminal** and land inside that session's byobu window.

## Repository layout

```
.
├── Dockerfile                          # Ubuntu 24.04 image
├── entrypoint.sh                       # Container startup script
├── supervisord.conf                    # Process manager config
├── docker-push.sh                      # Build-and-push helper
├── claude-pod.yaml                     # Kubernetes manifests (Deployment, PVC, Service, Ingress)
├── github-credentials-secret.example.yaml  # Template for the GitHub credentials Secret
└── api/
    ├── package.json
    ├── server.js                       # Express REST API
    └── public/
        └── index.html                  # Single-page web UI
```

## Prerequisites

- Docker
- A Kubernetes cluster with:
  - [Traefik](https://traefik.io/) ingress controller
  - [cert-manager](https://cert-manager.io/) with a `letsencrypt-production` ClusterIssuer
  - An auth-proxy middleware (`authz-proxy-authz-reverse-proxy`) configured as a Traefik CRD
  - A StorageClass named `truenas-iscsi-ssd` (or edit the PVC in `claude-pod.yaml` to match your environment)
- A GitHub SSH key and Personal Access Token (PAT)

> The Kubernetes-specific pieces (ingress class, storage class, auth middleware) are all customizable in `claude-pod.yaml`.

## Installation

### 1. Create the GitHub credentials secret

Copy the example and fill in your base64-encoded values:

```bash
cp github-credentials-secret.example.yaml github-credentials-secret.yaml
```

Encode your key and token:

```bash
# Base64-encode your SSH private key
base64 -w0 ~/.ssh/id_rsa

# Base64-encode your GitHub PAT
echo -n 'ghp_yourtoken' | base64 -w0
```

Paste both values into `github-credentials-secret.yaml`, then apply:

```bash
kubectl apply -f github-credentials-secret.yaml
```

`github-credentials-secret.yaml` is listed in `.gitignore` and must never be committed.

### 2. Build and push the image

```bash
./docker-push.sh
```

By default the image is tagged `registry.kieffer.me/claude-workstation:latest`. Override with env vars:

```bash
IMAGE=my-registry.example.com/claude-workstation TAG=v1.0.0 ./docker-push.sh
```

### 3. Update `claude-pod.yaml` for your environment

At minimum, replace these values in `claude-pod.yaml`:

| Field | Default | Description |
|---|---|---|
| `spec.rules[].host` | `claude-workstation.kieffer.me` | Your public hostname |
| `spec.tls[].hosts[]` | `claude-workstation.kieffer.me` | Same hostname for TLS cert |
| `image` | `registry.kieffer.me/claude-workstation:latest` | Your registry/tag |
| `storageClassName` | `truenas-iscsi-ssd` | Your StorageClass |
| `traefik.ingress.kubernetes.io/router.middlewares` | `authz-proxy-authz-reverse-proxy@kubernetescrd` | Your auth middleware (or remove if not needed) |

### 4. Deploy

```bash
kubectl apply -f claude-pod.yaml
```

The Deployment uses `strategy: Recreate` — Kubernetes will terminate any existing pod before starting a new one, which is required because the PVC uses `ReadWriteOnce`.

### 5. Access the UI

Navigate to your configured hostname (e.g. `https://claude-workstation.kieffer.me`). The web UI lets you:

- Browse GitHub repos and branches
- Launch new Claude Code sessions
- Open a terminal attached to any running session
- Terminate sessions

## Session lifecycle

1. Select a repo and branch in the web UI (or paste a Git SSH URL manually).
2. `POST /api/sessions` clones the repo into `~/workspace/<session-name>`, creates a byobu session, and runs `claude remote --name <session-name> --spawn=same-dir` inside it.
3. The API polls `tmux capture-pane` until it sees `Connected` or `Ready` (up to 30 s timeout).
4. Session state is persisted to `~/.claude-sessions/state.json` (atomic write via temp file + rename).
5. Clicking **Terminal** calls `POST /api/sessions/:name/activate`, writing `~/.claude-session` so the next bash login auto-attaches to the byobu session.
6. Clicking **Terminate** calls `DELETE /api/sessions/:name`, which kills the tmux session and removes it from state.

## Persistent storage

The PVC (`claude-workspace-pvc`, 20 Gi, ReadWriteOnce) is mounted at multiple sub-paths so that workspace data, Claude Code config, and session state all survive pod restarts:

| Mount path | PVC sub-path |
|---|---|
| `/home/ubuntu/workspace` | (root) |
| `/home/ubuntu/.claude` | `.claude-config` |
| `/home/ubuntu/.claude.json` | `.claude.json` |
| `/home/ubuntu/.claude-sessions` | `.claude-sessions` |

> Deleting the PVC destroys all workspace data permanently.

## API reference

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/info` | Returns `{ podName }` |
| `GET` | `/api/repos` | Lists GitHub repos (authenticated: all; unauthenticated: public only) |
| `GET` | `/api/branches?repo=owner/name` | Lists branches for a repo |
| `GET` | `/api/sessions` | Lists sessions with live tmux status check |
| `POST` | `/api/sessions` | Starts a new session (body: `{ project, branch, newBranch?, force? }`) |
| `POST` | `/api/sessions/:name/activate` | Writes `~/.claude-session` for next-login auto-attach |
| `DELETE` | `/api/sessions/:name` | Terminates a session |

### POST /api/sessions body

| Field | Type | Required | Description |
|---|---|---|---|
| `project` | string | yes | Git SSH URL (e.g. `git@github.com:user/repo.git`) |
| `branch` | string | yes | Existing branch to clone from |
| `newBranch` | string | no | Create and checkout this branch after clone |
| `force` | boolean | no | If `true`, reset an existing workspace instead of cloning fresh |

## Environment variables

These are set by supervisord (see `supervisord.conf`) and can be overridden:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | API listen port |
| `STATE_FILE` | `/home/ubuntu/.claude-sessions/state.json` | Session state path |
| `WORKSPACE_ROOT` | `/home/ubuntu/workspace` | Root for cloned repos |
| `GITHUB_USER` | `edkief` | Fallback username for unauthenticated repo listing |
| `GITHUB_TOKEN` | — | GitHub PAT for authenticated API calls (injected from Secret) |
| `POD_NAME` | `unknown` | Injected by Kubernetes Downward API, shown in the UI |

## Local development

Run the API server locally (no Kubernetes required):

```bash
cd api
npm install
node server.js
```

The API listens on port 3000 and serves the web UI at `http://localhost:3000`. Session management commands (byobu, tmux, claude) won't function outside the container, but the UI and GitHub API calls work fine for development.

## Key design decisions

- **`Recreate` deployment strategy** — required by the `ReadWriteOnce` PVC; only one pod can mount the volume at a time.
- **Atomic state writes** — session state is written to a `.tmp` file and renamed to avoid partial reads on crash.
- **supervisord runs as root, spawns services as `ubuntu`** — Node and npm binaries are symlinked to `/usr/local/bin` so supervisord (which has no `.bashrc`) can find them.
- **byobu pre-configured for tmux keybindings** — the `~/.byobu` symlink sets `ctrl+b` as the prefix and suppresses the first-run prompt.
- **Auto-attach on login** — the bash profile checks `~/.claude-session` (written by the activate endpoint within the last 10 s) and attaches to the named byobu session automatically.
