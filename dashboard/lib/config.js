'use strict';

const fs = require('fs');

function env(name, fallback) {
    const v = process.env[name];
    return v === undefined || v === '' ? fallback : v;
}

function intEnv(name, fallback) {
    const n = parseInt(env(name, ''), 10);
    return Number.isFinite(n) ? n : fallback;
}

function boolEnv(name, fallback) {
    const v = env(name, '');
    if (v === '') return fallback;
    return !['0', 'false', 'no', 'off'].includes(v.toLowerCase());
}

// In-cluster, the namespace is on disk; fall back to env for local dev.
function detectNamespace() {
    try {
        return fs.readFileSync(
            '/var/run/secrets/kubernetes.io/serviceaccount/namespace', 'utf8').trim();
    } catch {
        return env('NAMESPACE', 'dev');
    }
}

// The trigger has to fire at least twice inside the window it is watching, or
// a token can slide from "not yet due" to expired between two ticks. Clamped
// rather than rejected: a too-short lead is a tuning mistake, not a typo worth
// refusing to boot over.
const tokenTriggerMs = intEnv('TOKEN_TRIGGER_MS', 600_000);
const configuredLeadMs = intEnv('TOKEN_REFRESH_LEAD_MS', 3_600_000);
const tokenRefreshLeadMs = Math.max(configuredLeadMs, tokenTriggerMs * 2);
if (tokenRefreshLeadMs !== configuredLeadMs) {
    console.warn(`[dashboard] TOKEN_REFRESH_LEAD_MS raised to ${tokenRefreshLeadMs}ms `
        + `(twice TOKEN_TRIGGER_MS), or the refresh window could be missed entirely`);
}

const PUSH_POLICIES = ['any', 'dashboard', 'additive'];
const configPushPolicy = env('CONFIG_PUSH_POLICY', 'any');
if (!PUSH_POLICIES.includes(configPushPolicy)) {
    throw new Error(
        `CONFIG_PUSH_POLICY must be one of ${PUSH_POLICIES.join('|')}, got "${configPushPolicy}"`);
}

module.exports = {
    port: intEnv('PORT', 3000),
    namespace: detectNamespace(),
    podName: env('POD_NAME', 'unknown'),

    githubUser: env('GITHUB_USER', 'edkief'),
    githubToken: env('GITHUB_TOKEN', ''),

    workspaceImage: env('WORKSPACE_IMAGE', 'registry.kieffer.me/claude-workstation/workspace:latest'),
    imagePullPolicy: env('WORKSPACE_IMAGE_PULL_POLICY', 'Always'),
    claudeCodeVersion: env('CLAUDE_CODE_VERSION', 'latest'),

    storageClass: env('WORKSPACE_STORAGE_CLASS', 'truenas-iscsi-ssd'),
    storageSize: env('WORKSPACE_STORAGE_SIZE', '20Gi'),

    workspaceResources: {
        requests: {
            cpu: env('WORKSPACE_CPU_REQUEST', '250m'),
            memory: env('WORKSPACE_MEM_REQUEST', '1Gi'),
            'ephemeral-storage': env('WORKSPACE_EPHEMERAL_REQUEST', '2Gi'),
        },
        limits: {
            cpu: env('WORKSPACE_CPU_LIMIT', '2'),
            memory: env('WORKSPACE_MEM_LIMIT', '4Gi'),
            'ephemeral-storage': env('WORKSPACE_EPHEMERAL_LIMIT', '12Gi'),
        },
    },

    maxWorkspaces: intEnv('MAX_WORKSPACES', 4),

    githubSecretName: env('GITHUB_SECRET_NAME', 'github-ssh-key'),
    // Two S3 users are provisioned up front so CONFIG_PUSH_POLICY can be
    // flipped without creating new cluster objects.
    s3SecretRw: env('CONFIG_S3_SECRET_RW', 'claude-config-s3-rw'),
    s3SecretRo: env('CONFIG_S3_SECRET_RO', 'claude-config-s3-ro'),
    configPushPolicy,

    // Which S3 credentials a workspace pod gets. Only `any` grants write.
    workspaceS3Secret() {
        return configPushPolicy === 'any' ? this.s3SecretRw : this.s3SecretRo;
    },

    // Shared-login watchdog. Offline expiry check of the credentials the
    // config shell holds and every new workspace pulls; 0 disables it.
    tokenCheckMs: intEnv('TOKEN_CHECK_MS', 1800000),
    tokenWarnMs: intEnv('TOKEN_WARN_MS', 86400000),

    // Auto-refresh. The watchdog above only reports; this renews the shared
    // login by running claude itself, and publishes the result so every other
    // holder can adopt it. Off leaves exactly the previous report-only
    // behaviour, which is the fallback whenever a trigger stops working.
    tokenAutoRefresh: boolEnv('TOKEN_AUTO_REFRESH', true),
    tokenTriggerMs,
    // How much life left before a renewal is attempted at all.
    tokenRefreshLeadMs,
    // ...and below which the token-spending fallback rung is allowed to fire.
    tokenRefreshDeadlineMs: intEnv('TOKEN_REFRESH_DEADLINE_MS', 1800000),
    tokenTriggerTimeoutMs: intEnv('TOKEN_TRIGGER_TIMEOUT_MS', 120000),
    // A directory claude is run from, pre-trusted so `-p` cannot block on the
    // trust dialog. Never a repo: this runs unattended.
    tokenRefreshDir: env('TOKEN_REFRESH_DIR',
        `${process.env.HOME || '/home/node'}/.token-refresh`),

    sessionsCacheMs: intEnv('SESSIONS_CACHE_MS', 30000),
    pvcCacheMs: intEnv('PVC_CACHE_MS', 60000),
    targetCacheMs: intEnv('TARGET_CACHE_MS', 60000),
    pvcTouchMs: intEnv('PVC_TOUCH_MS', 600000),

    labels: {
        app: 'claude-workspace',
        managedBy: 'claude-dashboard',
    },
};
