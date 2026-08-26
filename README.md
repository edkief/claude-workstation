# claude-workstation

Browser-accessible Claude Code development environments on Kubernetes, plugged
directly into Claude remote connect.

A small **dashboard** app lets you browse your GitHub repos, pick a branch, and
launch a workspace. Each workspace is **its own Kubernetes pod** with a web
terminal ([ttyd](https://github.com/tsl0922/ttyd)), a persistent per-repo volume,
and a scratch Postgres. Once running, it is reachable as a Claude Code remote
session, and the dashboard proxies a terminal straight into it.

## How it works

```
Browser
  │  https://claude-workstation.example.com   (one host, one cert, one auth middleware)
  ▼
┌─────────────────────────────────────────┐
│ claude-dashboard                        │
│   /api/*        session + storage API   │──── Kubernetes API
│   /tty/<id>/*   reverse proxy (HTTP+WS) │────┐
│   /config-tty/  shared-config shell     │    │
└─────────────────────────────────────────┘    ▼
                        ┌──────────────────────────────────────┐
                        │ claude-workspace pod (one per repo)  │
                        │   ttyd → byobu → claude remote       │
                        │   agent (health/disk), postgres      │
                        │   /workspace ← per-repo PVC          │
                        └──────────────────────────────────────┘
```

The dashboard creates Kubernetes objects rather than shelling out. One workspace
can no longer exhaust the memory of every other one — the motivation for this
design.

## Repository layout

```
.
├── dashboard/          # control plane + UI (slim image)
│   ├── Dockerfile  server.js  prune-pvcs.js
│   ├── lib/        k8s client, pod template, proxy, metrics, validation
│   ├── public/     single-file UI, no build step
│   └── test/       pure-function tests (no cluster required)
├── workspace/          # the dev environment (fat image)
│   ├── Dockerfile  entrypoint.sh  supervisord.conf  agent.js
│   └── bootstrap/  clone.sh, seed-claude-config.js
├── shared/claude-config-sync/   # S3 config sync CLI, used by both images
├── k8s/                # manifests
└── docker-push.sh
```

## Prerequisites

- Docker, `kubectl`
- A Kubernetes cluster with:
  - [Traefik](https://traefik.io/) ingress controller
  - [cert-manager](https://cert-manager.io/) with a `letsencrypt-production` ClusterIssuer
  - An auth-proxy middleware configured as a Traefik CRD
  - A `ReadWriteOnce` StorageClass (default here: `truenas-iscsi-ssd`)
  - Optionally [metrics-server](https://github.com/kubernetes-sigs/metrics-server)
    — the UI degrades gracefully without it
- An S3-compatible bucket for the shared Claude config
- A GitHub SSH key and Personal Access Token

## Installation

### 1. Secrets

```bash
cp k8s/secrets.example.yaml k8s/secrets.yaml   # gitignored
```

Fill in the GitHub key/PAT and both sets of S3 credentials, then apply. Or
create them directly:

```bash
kubectl create secret generic github-ssh-key -n dev \
  --from-file=id_rsa=$HOME/.ssh/id_rsa \
  --from-literal=github_token=ghp_yourtoken

kubectl create secret generic claude-config-s3-rw -n dev \
  --from-literal=S3_ENDPOINT=https://s3.example.com \
  --from-literal=S3_BUCKET=claude-config \
  --from-literal=S3_ACCESS_KEY_ID=... \
  --from-literal=S3_SECRET_ACCESS_KEY=...
# ...and claude-config-s3-ro with a read-only key.
```

Both S3 users are created up front so `CONFIG_PUSH_POLICY` can be changed later
without new cluster objects.

### 2. Build and push

Pushing to a branch builds both images through the cluster's Tekton pipeline —
see `.k8s-build.yaml`. For local or out-of-band builds:

```bash
./docker-push.sh                       # both images
./docker-push.sh dashboard             # just one
```

Both paths produce the same references, following the cluster convention
`<registry>/<repo>/<name>`:

| Image | Reference |
|---|---|
| Dashboard | `registry.kieffer.me/claude-workstation/dashboard` |
| Workspace | `registry.kieffer.me/claude-workstation/workspace` |

Each is tagged `git-<sha>` and `<branch>-<sha>`; `latest` is added only from the
default branch. Override with `REGISTRY=...` / `REPO_NAME=...`.

### 3. Adjust the manifests

| Field | Default | Where |
|---|---|---|
| Ingress host / TLS host | `claude-workstation.kieffer.me` | `k8s/dashboard.yaml` |
| Auth middleware | `authz-proxy-authz-reverse-proxy@kubernetescrd` | `k8s/dashboard.yaml` |
| `WORKSPACE_STORAGE_CLASS` | `truenas-iscsi-ssd` | dashboard env |
| `WORKSPACE_IMAGE` | `registry.kieffer.me/claude-workstation/workspace:latest` | dashboard env |
| `REPO_NAME` | `claude-workstation` | `docker-push.sh` (must match the repo name) |
| `MAX_WORKSPACES` | `4` | dashboard env |

### 4. Deploy

```bash
kubectl apply -f k8s/dashboard.yaml \
               -f k8s/networkpolicy.yaml \
               -f k8s/cleanup-cronjob.yaml
```

Verify RBAC before anything else — a missing Role is the most common first
failure (the UI will tell you, but this is faster):

```bash
kubectl auth can-i create pods -n dev \
  --as=system:serviceaccount:dev:claude-dashboard
```

### 5. Seed the shared Claude config

Migrating from the single-pod version? Use `k8s/seed-config-job.yaml` instead —
see *Migrating* below.

Otherwise, open `/config-tty/` from the dashboard, run `claude` and log in, then:

```bash
claude-config-sync push
```

Every workspace created afterwards inherits that config on first boot.

The bucket and keys need to exist in Garage first:

```bash
garage bucket create claude-config
garage key create claude-config-rw
garage key create claude-config-ro
garage bucket allow --read --write claude-config --key claude-config-rw
garage bucket allow --read        claude-config --key claude-config-ro
```

`S3_REGION` must match Garage's configured `s3_region` (default `garage` here):
it is part of the SigV4 credential scope, so a mismatch surfaces as a signature
error rather than an obvious misconfiguration.

## Using it

- **Start a session** — pick a repo and branch, press *Start Session*. The card
  shows `starting` with live progress, then `running`.
- **Already running?** Storage is per repo and only one pod may hold it, so
  starting a second session for the same repo returns a conflict and the UI
  offers **Open terminal** or **Replace**.
- **Terminate** stops the pod but **keeps the storage**, so the next session on
  that repo starts warm. Storage is reclaimed by the nightly prune (30 days) or
  explicitly from the *Workspace Storage* card.
- **`degraded`** with a `restarted N× (OOMKilled)` chip means that workspace hit
  its memory limit and restarted — on its own, without touching anything else.

## Migrating from the single-pod version

The old 20 Gi `claude-workspace-pvc` holds your existing checkouts and
`~/.claude`. Nothing here deletes it.

1. **Seed S3 from the legacy volume first**, or new workspaces will start
   unauthenticated and need an interactive `claude login`.

   The legacy image has neither `rclone` nor `claude-config-sync`, so
   `kubectl exec` into the old pod cannot do this. `k8s/seed-config-job.yaml`
   runs the *new* dashboard image against the *old* volume instead — mounted
   read-only, staged through an emptyDir, so nothing on it is modified and the
   Job is safe to re-run:

   ```bash
   kubectl scale deploy/claude-workstation -n dev --replicas=0     # release the RWO volume
   kubectl wait --for=delete pod -l app=claude-workstation -n dev --timeout=120s
   kubectl apply -f k8s/seed-config-job.yaml
   kubectl logs -n dev job/claude-seed-config -f
   kubectl delete -f k8s/seed-config-job.yaml
   ```

   It copies only the portable set (settings, credentials, skills, plugins,
   agents, commands, and a stripped `.claude.json`) — not the ~71 MB of
   transcripts.

2. Inventory uncommitted work — the new topology does not read those
   directories:
   ```bash
   kubectl exec -n dev deploy/claude-workstation -- bash -lc \
     'for d in ~/workspace/sessions/*/; do git -C "$d" status --porcelain | head -1 | sed "s|^|$d |"; done'
   ```
3. Build and push both images; apply the RBAC and verify it.
4. `kubectl scale deploy/claude-workstation -n dev --replicas=0` — the cutover
   point, instantly reversible, and required before the old PVC can be remounted.
5. Apply `k8s/dashboard.yaml`. It reuses the Ingress name, host, TLS secret and
   auth middleware, so cert-manager is a no-op and there is no DNS window.
6. Smoke-test, then soak. Only after that, delete the old Deployment, Service and
   PVC — manually, as a deliberate separate act.

To roll back at any point: re-apply `k8s/legacy-claude-pod.yaml` and scale the
dashboard to 0. The new per-repo PVCs are independent and survive.

## Local development

```bash
cd dashboard
npm install
npm test                        # pure-function tests, no cluster
NAMESPACE=dev node server.js    # runs against your kubeconfig
```

Unlike the previous version (which needed tmux and a live byobu), the dashboard
runs anywhere a kubeconfig does. The UI is served at `http://localhost:3000`.

## Further reading

`AGENTS.md` covers the design in depth: the workspace-key abstraction and how to
switch to per-branch storage, the config allowlist and merge rules, the RBAC
omissions and why, and the constraints around RWO volumes and bare Pods.
