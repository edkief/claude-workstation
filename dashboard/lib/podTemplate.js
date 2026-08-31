'use strict';

const cfg = require('./config');
const { slug } = require('./naming');

const LABEL = {
    workspaceKey: 'claude.kieffer.me/workspace-key',
    repo: 'claude.kieffer.me/repo',
    branch: 'claude.kieffer.me/branch',
};

const ANN = {
    repoUrl: 'claude.kieffer.me/repo-url',
    repoFullName: 'claude.kieffer.me/repo-full-name',
    branch: 'claude.kieffer.me/branch',
    baseBranch: 'claude.kieffer.me/base-branch',
    keyRaw: 'claude.kieffer.me/workspace-key-raw',
    sessionName: 'claude.kieffer.me/session-name',
    startedAt: 'claude.kieffer.me/started-at',
};

/**
 * Build the Pod manifest for a workspace.
 *
 * Kept as code rather than a ConfigMap-mounted YAML template: nearly every
 * field is computed, so a template would need a placeholder per field and could
 * drift out from under the code. The tunable parts come from dashboard env vars
 * (see config.js), so retuning is a Deployment edit, not an image rebuild.
 *
 * Pure function -- unit-testable with no cluster.
 */
function buildWorkspacePodManifest({
    id, key, repoUrl, repoFullName, branch, baseBranch,
    newBranch = null, sessionName, pvcName, resetHard = false,
}) {
    const branchSlug = slug(branch, 40);

    return {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: {
            name: id,
            namespace: cfg.namespace,
            labels: {
                app: cfg.labels.app,
                'app.kubernetes.io/managed-by': cfg.labels.managedBy,
                [LABEL.workspaceKey]: id,
                [LABEL.repo]: slug(repoFullName.split('/').pop(), 63),
                [LABEL.branch]: branchSlug,
            },
            annotations: {
                [ANN.repoUrl]: repoUrl,
                [ANN.repoFullName]: repoFullName,
                [ANN.branch]: branch,
                [ANN.baseBranch]: baseBranch,
                [ANN.keyRaw]: key,
                [ANN.sessionName]: sessionName,
                [ANN.startedAt]: new Date().toISOString(),
            },
        },
        spec: {
            // The pod name is the storage identity (repo + hash), which is what
            // the shell prompt and any hostname-derived UI would otherwise show.
            // Name the host after the session instead: "my-repo-main".
            hostname: slug(sessionName, 63),
            // OOMKill restarts the container in place: same pod IP (so the tty
            // proxy target cache stays valid), PVC stays attached, checkout
            // survives. That is the whole point of a bare Pod here.
            restartPolicy: 'Always',
            terminationGracePeriodSeconds: 30,
            // Workspaces run agent-authored code and must not hold a token that
            // could create more pods.
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            securityContext: {
                runAsUser: 1000,
                runAsGroup: 1000,
                fsGroup: 1000,
                fsGroupChangePolicy: 'OnRootMismatch',
            },
            containers: [{
                name: 'workspace',
                image: cfg.workspaceImage,
                imagePullPolicy: cfg.imagePullPolicy,
                ports: [
                    { containerPort: 7681, name: 'tty' },
                    { containerPort: 7682, name: 'agent' },
                    { containerPort: 7684, name: 'codex-ui' },
                ],
                env: [
                    { name: 'WORKSPACE_ID', value: id },
                    { name: 'REPO_URL', value: repoUrl },
                    { name: 'GIT_REF', value: baseBranch },
                    { name: 'BRANCH', value: branch },
                    { name: 'BRANCH_SLUG', value: branchSlug },
                    { name: 'NEW_BRANCH', value: newBranch || '' },
                    { name: 'FORCE_RESET', value: resetHard ? 'true' : 'false' },
                    { name: 'CLAUDE_SESSION_NAME', value: sessionName },
                    // ttyd bakes its base path into the JS it serves, so the
                    // dashboard hands it the exact prefix it is proxied under.
                    { name: 'TTY_BASE_PATH', value: `/tty/${id}` },
                    // codexapp gets its base path as a CLI argument in
                    // supervisord. CODEX_HOME stays on the repo PVC across
                    // pod swaps.
                    { name: 'CODEX_HOME', value: '/workspace/_home/codex' },
                    { name: 'CLAUDE_CODE_VERSION', value: cfg.claudeCodeVersion },
                    { name: 'CONFIG_PUSH_POLICY', value: cfg.configPushPolicy },
                    // Where the shared OAuth token lives. Propagated rather
                    // than defaulted per-pod: a dashboard pointing at a
                    // separate auth bucket and pods still reading the config
                    // one would silently split the login in two.
                    { name: 'AUTH_S3_BUCKET', value: cfg.authS3Bucket },
                    { name: 'AUTH_S3_KEY', value: cfg.authS3Key },
                    { name: 'POD_NAME', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } },
                    {
                        name: 'GITHUB_TOKEN',
                        valueFrom: {
                            secretKeyRef: { name: cfg.githubSecretName, key: 'github_token' },
                        },
                    },
                ],
                envFrom: [
                    // Read-write or read-only S3 credentials depending on
                    // CONFIG_PUSH_POLICY, so the policy is enforced by the
                    // credentials themselves rather than by convention.
                    { secretRef: { name: cfg.workspaceS3Secret() } },
                ],
                resources: cfg.workspaceResources,
                volumeMounts: [
                    { name: 'ws', mountPath: '/workspace' },
                    { name: 'ws', mountPath: '/home/ubuntu/.claude', subPath: '_home/claude' },
                    { name: 'github-ssh', mountPath: '/run/secrets/github-ssh', readOnly: true },
                ],
                // Replaces the old 30s `tmux capture-pane` poll in the API.
                // failureThreshold is generous: a cold start pulls a large
                // image, syncs config and clones a repo.
                readinessProbe: {
                    httpGet: { path: '/healthz', port: 7682 },
                    initialDelaySeconds: 5,
                    periodSeconds: 3,
                    failureThreshold: 60,
                },
                // /livez is not "is the agent up" -- that is always yes. It
                // reports whether the workspace is salvageable in place: it
                // fails only after the pod was ready, claude died, and in-pane
                // relaunch was exhausted. Readiness gates nothing but the UI
                // here, so this is the only thing that can restart a wedged
                // workspace.
                livenessProbe: {
                    httpGet: { path: '/livez', port: 7682 },
                    initialDelaySeconds: 120,
                    periodSeconds: 30,
                    failureThreshold: 4,
                },
            }],
            volumes: [
                { name: 'ws', persistentVolumeClaim: { claimName: pvcName } },
                { name: 'github-ssh', secret: { secretName: cfg.githubSecretName, defaultMode: 0o400 } },
            ],
        },
    };
}

module.exports = { buildWorkspacePodManifest, LABEL, ANN };
