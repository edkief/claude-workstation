'use strict';

const test = require('node:test');
const assert = require('node:assert');

process.env.NAMESPACE = 'dev';
process.env.KUBERNETES_SERVICE_HOST = '';

const { deriveStatus, describePod, parseCpuLimit, parseMemLimit } = require('../lib/sessions');
const { buildWorkspacePodManifest } = require('../lib/podTemplate');

function pod(overrides = {}) {
    return {
        metadata: {
            name: 'claude-ws-edkief-repo-0badf00d',
            annotations: {
                'claude.kieffer.me/repo-full-name': 'edkief/repo',
                'claude.kieffer.me/branch': 'feature/x',
                'claude.kieffer.me/repo-url': 'git@github.com:edkief/repo.git',
            },
            ...overrides.metadata,
        },
        spec: {
            containers: [{ resources: { limits: { cpu: '2', memory: '4Gi' } } }],
            volumes: [{ name: 'ws', persistentVolumeClaim: { claimName: 'claude-ws-edkief-repo-0badf00d' } }],
        },
        status: { phase: 'Running', ...overrides.status },
    };
}

const ready = { conditions: [{ type: 'Ready', status: 'True' }] };

test('deriveStatus: a ready running pod is running', () => {
    assert.equal(deriveStatus(pod({ status: { phase: 'Running', ...ready } })), 'running');
});

test('deriveStatus: pending is starting, not failed', () => {
    assert.equal(deriveStatus(pod({
        status: { phase: 'Pending', containerStatuses: [{ state: { waiting: { reason: 'ContainerCreating' } } }] },
    })), 'starting');
});

test('deriveStatus: an unpullable image is terminal, not a spinner', () => {
    for (const reason of ['ImagePullBackOff', 'ErrImagePull', 'CreateContainerConfigError']) {
        assert.equal(deriveStatus(pod({
            status: { phase: 'Pending', containerStatuses: [{ state: { waiting: { reason } } }] },
        })), 'failed', reason);
    }
});

test('deriveStatus: a pod that came back from an OOMKill is degraded', () => {
    const p = pod({
        status: {
            phase: 'Running',
            ...ready,
            containerStatuses: [{
                restartCount: 2,
                lastState: { terminated: { reason: 'OOMKilled' } },
            }],
        },
    });
    assert.equal(deriveStatus(p), 'degraded');
    const s = describePod(p);
    assert.equal(s.restartCount, 2);
    assert.equal(s.lastTerminationReason, 'OOMKilled');
    assert.match(s.message, /out of memory/);
});

test('deriveStatus: an OOMKilled pod still restarting is starting, not degraded', () => {
    assert.equal(deriveStatus(pod({
        status: {
            phase: 'Running',
            conditions: [{ type: 'Ready', status: 'False' }],
            containerStatuses: [{ lastState: { terminated: { reason: 'OOMKilled' } } }],
        },
    })), 'starting');
});

test('deriveStatus: deletion beats every other signal', () => {
    assert.equal(deriveStatus(pod({
        metadata: { name: 'x', deletionTimestamp: '2026-08-26T00:00:00Z' },
        status: { phase: 'Running', ...ready },
    })), 'terminating');
});

test('deriveStatus: Failed phase is failed', () => {
    assert.equal(deriveStatus(pod({ status: { phase: 'Failed' } })), 'failed');
});

test('describePod exposes a per-session terminal URL and real limits', () => {
    const s = describePod(pod({ status: { phase: 'Running', ...ready } }));
    assert.equal(s.terminalUrl, '/tty/claude-ws-edkief-repo-0badf00d/');
    assert.equal(s.displayName, 'repo · feature/x');
    assert.deepEqual(s.limits, { cpuMillicores: 2000, memMiB: 4096 });
    assert.equal(s.ready, true);
});

test('limit parsing covers the forms k8s accepts', () => {
    assert.equal(parseCpuLimit('2'), 2000);
    assert.equal(parseCpuLimit('500m'), 500);
    assert.equal(parseMemLimit('4Gi'), 4096);
    assert.equal(parseMemLimit('512Mi'), 512);
});

test('pod manifest: labels are k8s-legal and slashes live in annotations', () => {
    const m = buildWorkspacePodManifest({
        id: 'claude-ws-edkief-repo-0badf00d',
        key: 'github.com/edkief/repo',
        repoUrl: 'git@github.com:edkief/repo.git',
        repoFullName: 'edkief/repo',
        branch: 'feature/nested/name',
        baseBranch: 'main',
        sessionName: 'repo-feature-nested-name',
        pvcName: 'claude-ws-edkief-repo-0badf00d',
    });

    const labelRe = /^[a-z0-9A-Z]([-a-z0-9A-Z_.]*[a-z0-9A-Z])?$/;
    for (const [k, v] of Object.entries(m.metadata.labels)) {
        assert.ok(v.length <= 63, `${k} label too long`);
        assert.ok(labelRe.test(v), `${k}="${v}" is not a legal label value`);
    }
    // The branch has slashes, so it must survive intact only in the annotation.
    assert.equal(m.metadata.labels['claude.kieffer.me/branch'], 'feature-nested-name');
    assert.equal(m.metadata.annotations['claude.kieffer.me/branch'], 'feature/nested/name');
});

test('pod manifest: workspace pods get no API-server token', () => {
    const m = buildWorkspacePodManifest({
        id: 'claude-ws-x-0badf00d', key: 'github.com/e/r',
        repoUrl: 'git@github.com:e/r.git', repoFullName: 'e/r',
        branch: 'main', baseBranch: 'main', sessionName: 'r-main',
        pvcName: 'claude-ws-x-0badf00d',
    });
    assert.equal(m.spec.automountServiceAccountToken, false);
    assert.equal(m.spec.restartPolicy, 'Always');
});

test('pod manifest: ttyd base path matches the proxy route', () => {
    const id = 'claude-ws-x-0badf00d';
    const m = buildWorkspacePodManifest({
        id, key: 'github.com/e/r', repoUrl: 'git@github.com:e/r.git',
        repoFullName: 'e/r', branch: 'main', baseBranch: 'main',
        sessionName: 'r-main', pvcName: id,
    });
    const env = Object.fromEntries(m.spec.containers[0].env
        .filter((e) => e.value !== undefined).map((e) => [e.name, e.value]));
    assert.equal(env.TTY_BASE_PATH, `/tty/${id}`);
    assert.equal(env.BRANCH_SLUG, 'main');
    assert.equal(env.FORCE_RESET, 'false');
});

test('pod manifest: resetHard is what surfaces as FORCE_RESET', () => {
    const id = 'claude-ws-x-0badf00d';
    const m = buildWorkspacePodManifest({
        id, key: 'k', repoUrl: 'git@github.com:e/r.git', repoFullName: 'e/r',
        branch: 'main', baseBranch: 'main', sessionName: 'r-main',
        pvcName: id, resetHard: true,
    });
    const env = Object.fromEntries(m.spec.containers[0].env
        .filter((e) => e.value !== undefined).map((e) => [e.name, e.value]));
    assert.equal(env.FORCE_RESET, 'true');
});

test('agent bootstrap stage beats the raw k8s reason in the UI message', () => {
    const p = pod({
        status: {
            phase: 'Pending',
            podIP: '10.1.2.3',
            containerStatuses: [{ state: { waiting: { reason: 'ContainerCreating' } } }],
        },
    });
    const s = describePod(p, { agentHealth: { ready: false, stage: 'cloning' } });
    assert.equal(s.status, 'starting');
    assert.equal(s.message, 'cloning repository…');
});

test('without an agent, the pod Warning event explains a stuck Pending', () => {
    const p = pod({ status: { phase: 'Pending', containerStatuses: [{ state: { waiting: {} } }] } });
    const s = describePod(p, {
        warning: { reason: 'FailedAttachVolume', message: 'Multi-Attach error for volume' },
    });
    assert.match(s.message, /FailedAttachVolume: Multi-Attach/);
});
