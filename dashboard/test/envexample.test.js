'use strict';

// A .env.example that has drifted from the code is worse than none: it
// documents settings that silently do nothing. These tests keep it honest.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.NAMESPACE = 'dev';

const ROOT = path.join(__dirname, '..', '..');

function parseEnvFile(file) {
    const out = new Map();
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
        if (m) out.set(m[1], m[2]);
    }
    return out;
}

// Variables the dashboard reads outside config.js, or indirectly via
// claude-config-sync, which it shells out to.
const EXTRA_READS = [
    'CONFIG_TTY_PORT',
    'S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_BUCKET',
    'S3_REGION', 'S3_PROVIDER', 'S3_FORCE_PATH_STYLE', 'S3_PREFIX',
    'AUTH_S3_BUCKET', 'AUTH_S3_KEY',
];

test('dashboard/.env.example documents exactly what the code reads', () => {
    const documented = parseEnvFile(path.join(ROOT, 'dashboard', '.env.example'));
    const source = fs.readFileSync(path.join(ROOT, 'dashboard', 'lib', 'config.js'), 'utf8');

    const read = new Set(EXTRA_READS);
    for (const m of source.matchAll(/(?:intEnv|boolEnv|env)\('([A-Z0-9_]+)'/g)) read.add(m[1]);

    const undocumented = [...read].filter((v) => !documented.has(v));
    const unused = [...documented.keys()].filter((v) => !read.has(v));

    assert.deepEqual(undocumented, [], 'read by config.js but missing from .env.example');
    assert.deepEqual(unused, [], 'in .env.example but never read');
});

test('dashboard/.env.example defaults match the code defaults', () => {
    const documented = parseEnvFile(path.join(ROOT, 'dashboard', '.env.example'));
    const cfg = require('../lib/config.js');

    const expected = {
        PORT: cfg.port,
        NAMESPACE: cfg.namespace,
        GITHUB_USER: cfg.githubUser,
        GITHUB_SECRET_NAME: cfg.githubSecretName,
        WORKSPACE_IMAGE: cfg.workspaceImage,
        WORKSPACE_IMAGE_PULL_POLICY: cfg.imagePullPolicy,
        CLAUDE_CODE_VERSION: cfg.claudeCodeVersion,
        WORKSPACE_STORAGE_CLASS: cfg.storageClass,
        WORKSPACE_STORAGE_SIZE: cfg.storageSize,
        WORKSPACE_CPU_REQUEST: cfg.workspaceResources.requests.cpu,
        WORKSPACE_MEM_REQUEST: cfg.workspaceResources.requests.memory,
        WORKSPACE_EPHEMERAL_REQUEST: cfg.workspaceResources.requests['ephemeral-storage'],
        WORKSPACE_CPU_LIMIT: cfg.workspaceResources.limits.cpu,
        WORKSPACE_MEM_LIMIT: cfg.workspaceResources.limits.memory,
        WORKSPACE_EPHEMERAL_LIMIT: cfg.workspaceResources.limits['ephemeral-storage'],
        MAX_WORKSPACES: cfg.maxWorkspaces,
        SESSIONS_CACHE_MS: cfg.sessionsCacheMs,
        PVC_CACHE_MS: cfg.pvcCacheMs,
        TARGET_CACHE_MS: cfg.targetCacheMs,
        PVC_TOUCH_MS: cfg.pvcTouchMs,
        TOKEN_CHECK_MS: cfg.tokenCheckMs,
        TOKEN_WARN_MS: cfg.tokenWarnMs,
        TOKEN_TRIGGER_MS: cfg.tokenTriggerMs,
        TOKEN_REFRESH_LEAD_MS: cfg.tokenRefreshLeadMs,
        TOKEN_REFRESH_DEADLINE_MS: cfg.tokenRefreshDeadlineMs,
        TOKEN_TRIGGER_TIMEOUT_MS: cfg.tokenTriggerTimeoutMs,
        CONFIG_PUSH_POLICY: cfg.configPushPolicy,
        AUTH_S3_BUCKET: cfg.authS3Bucket,
        AUTH_S3_KEY: cfg.authS3Key,
        CONFIG_S3_SECRET_RW: cfg.s3SecretRw,
        CONFIG_S3_SECRET_RO: cfg.s3SecretRo,
    };

    for (const [key, value] of Object.entries(expected)) {
        assert.equal(documented.get(key), String(value), `${key} default drifted`);
    }
});

test('workspace/.env.example documents every var the pod template injects', () => {
    const documented = parseEnvFile(path.join(ROOT, 'workspace', '.env.example'));
    const { buildWorkspacePodManifest } = require('../lib/podTemplate');

    const manifest = buildWorkspacePodManifest({
        id: 'claude-ws-x-0badf00d', key: 'github.com/e/r',
        repoUrl: 'git@github.com:e/r.git', repoFullName: 'e/r',
        branch: 'main', baseBranch: 'main', sessionName: 'r-main',
        pvcName: 'claude-ws-x-0badf00d',
    });

    const injected = manifest.spec.containers[0].env.map((e) => e.name);
    const undocumented = injected.filter((v) => !documented.has(v));
    assert.deepEqual(undocumented, [], 'injected into workspace pods but undocumented');
});

test('.env.example files carry no real secrets', () => {
    for (const f of ['dashboard/.env.example', 'workspace/.env.example']) {
        const documented = parseEnvFile(path.join(ROOT, f));
        for (const key of ['S3_SECRET_ACCESS_KEY', 'S3_ACCESS_KEY_ID', 'GITHUB_TOKEN']) {
            const value = documented.get(key);
            if (value === undefined) continue;
            assert.equal(value, '', `${f}: ${key} must be left empty`);
        }
    }
});
