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

test('describePod exposes per-session terminal and Codex URLs and real limits', () => {
    const s = describePod(pod({ status: { phase: 'Running', ...ready } }));
    assert.equal(s.terminalUrl, '/tty/claude-ws-edkief-repo-0badf00d/');
    assert.equal(s.codexUrl, '/codex/claude-ws-edkief-repo-0badf00d/');
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

test('pod manifest: ttyd and Codex base paths match their proxy routes', () => {
    const id = 'claude-ws-x-0badf00d';
    const m = buildWorkspacePodManifest({
        id, key: 'github.com/e/r', repoUrl: 'git@github.com:e/r.git',
        repoFullName: 'e/r', branch: 'main', baseBranch: 'main',
        sessionName: 'r-main', pvcName: id,
    });
    const env = Object.fromEntries(m.spec.containers[0].env
        .filter((e) => e.value !== undefined).map((e) => [e.name, e.value]));
    assert.equal(env.TTY_BASE_PATH, `/tty/${id}`);
    assert.equal(env.CODEXUI_BASE_PATH, `/codex/${id}`);
    assert.equal(env.CODEX_HOME, '/workspace/_home/codex');
    assert.equal(env.BRANCH_SLUG, 'main');
    assert.equal(env.FORCE_RESET, 'false');
    assert.deepEqual(m.spec.containers[0].ports.find((p) => p.name === 'codex-ui'), {
        containerPort: 7684,
        name: 'codex-ui',
    });
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

test('a failed stage carries the agent detail, not just the label', () => {
    const p = pod({
        status: {
            phase: 'Running',
            podIP: '10.1.2.3',
            conditions: [{ type: 'Ready', status: 'False' }],
            containerStatuses: [{ state: { running: {} } }],
        },
    });
    const s = describePod(p, {
        agentHealth: {
            ready: false,
            stage: 'failed',
            detail: 'bash: claude: command not found',
        },
    });
    assert.equal(s.status, 'failed');
    assert.match(s.message, /workspace bootstrap failed/);
    assert.match(s.message, /claude: command not found/);
});

test('a progress stage stays a clean label even when the agent sends a pane tail', () => {
    const p = pod({
        status: {
            phase: 'Running',
            podIP: '10.1.2.3',
            conditions: [{ type: 'Ready', status: 'False' }],
            containerStatuses: [{ state: { running: {} } }],
        },
    });
    const s = describePod(p, {
        agentHealth: { ready: false, stage: 'starting', detail: 'ubuntu@pod:~$ ' },
    });
    assert.equal(s.message, 'starting Claude…');
});

test('without an agent, the pod Warning event explains a stuck Pending', () => {
    const p = pod({ status: { phase: 'Pending', containerStatuses: [{ state: { waiting: {} } }] } });
    const s = describePod(p, {
        warning: { reason: 'FailedAttachVolume', message: 'Multi-Attach error for volume' },
    });
    assert.match(s.message, /FailedAttachVolume: Multi-Attach/);
});

// --- agent-reported failures ------------------------------------------------
// Kubernetes sees a happy Running pod in all of these; only the agent knows
// claude never came up. Before this, an expired login read as "starting…".

const starting = { phase: 'Running', conditions: [{ type: 'Ready', status: 'False' }] };

test('an auth failure is a failure, not a permanent spinner', () => {
    const s = describePod(pod({ status: starting }), {
        agentHealth: {
            stage: 'auth-failed',
            reason: 'Claude OAuth token expired',
            terminalReady: true,
        },
    });
    assert.equal(s.status, 'failed');
    assert.equal(s.authFailed, true);
    assert.match(s.message, /login required/i);
    assert.match(s.message, /OAuth token expired/);
});

test('a claude that never starts times out into a failure', () => {
    const s = describePod(pod({ status: starting }), {
        agentHealth: { stage: 'launch-failed', reason: 'claude did not start within 190s' },
    });
    assert.equal(s.status, 'failed');
    assert.equal(s.authFailed, false);
});

test('the terminal stays reachable after an auth failure', () => {
    const s = describePod(pod({ status: starting }), {
        agentHealth: { stage: 'auth-failed', terminalReady: true },
    });
    // ready is still false -- claude is not running -- but /login has to be
    // typeable somewhere.
    assert.equal(s.ready, false);
    assert.equal(s.terminalReady, true);
});

test('a bootstrap still in progress is not turned into a failure', () => {
    for (const stage of ['syncing-config', 'cloning', 'starting', 'session-lost']) {
        const s = describePod(pod({ status: starting }), { agentHealth: { stage } });
        assert.equal(s.status, 'starting', stage);
        assert.equal(s.authFailed, false, stage);
    }
});

// A dashboard pointing at a separate auth bucket while pods still read the
// config one would split the shared login in two: the dashboard's renewals
// would never reach a workspace, and a workspace's would never reach the
// dashboard. Both sides must be told the same place.
test('pod manifest: the auth object location is propagated, never re-defaulted', () => {
    const cfg = require('../lib/config');
    const manifest = buildWorkspacePodManifest({
        id: 'claude-ws-x-0badf00d', key: 'github.com/e/r',
        repoUrl: 'git@github.com:e/r.git', repoFullName: 'e/r',
        branch: 'main', baseBranch: 'main', sessionName: 'r-main',
        pvcName: 'claude-ws-x-0badf00d',
    });
    const env = Object.fromEntries(
        manifest.spec.containers[0].env.filter((e) => 'value' in e).map((e) => [e.name, e.value]));

    assert.equal(env.AUTH_S3_BUCKET, cfg.authS3Bucket);
    assert.equal(env.AUTH_S3_KEY, cfg.authS3Key);
});

// --------------------------------------------------- the in-card health panel

// The panel exists to explain a workspace the badge cannot. So its three
// "nothing to show" cases must stay distinguishable: collapsing them is how
// you get back the permanent spinner this whole surface was built to kill.
test('an unreachable agent explains itself instead of rendering as empty', () => {
    const { healthEnvelope } = require('../lib/agentClient');

    // Still scheduling, or waiting on an RWO volume to attach.
    const noIp = healthEnvelope({ podIP: null, probe: null });
    assert.equal(noIp.available, false);
    assert.match(noIp.message, /no IP yet/);

    // Has an IP but nothing answered: agent down, or NetworkPolicy said no.
    const noAnswer = healthEnvelope({ podIP: '10.1.2.3', probe: null });
    assert.equal(noAnswer.available, false);
    assert.match(noAnswer.message, /10\.1\.2\.3:7682/);
    assert.notEqual(noAnswer.message, noIp.message);

    // Answered, but not with JSON -- something else is on that port.
    const garbage = healthEnvelope({ podIP: '10.1.2.3', probe: { status: 200, body: null } });
    assert.equal(garbage.available, false);
    assert.match(garbage.message, /not JSON/);
});

// 503 with ready:false is the *normal* shape of a starting workspace, so the
// probe status travels with the body: seeing both is what tells you the probe
// itself is working rather than the pod being broken.
test('a real probe is passed through untouched, status included', () => {
    const { healthEnvelope } = require('../lib/agentClient');

    const body = { ready: false, stage: 'auth-failed', terminalReady: true,
                   reason: 'Claude OAuth token expired', detail: 'run /login' };
    const env = healthEnvelope({ podIP: '10.1.2.3', probe: { status: 503, body } });

    assert.equal(env.available, true);
    assert.equal(env.probeStatus, 503);
    assert.equal(env.podIP, '10.1.2.3');
    // Untouched: the agent owns this schema and grows it, and anything the
    // dashboard reshapes here is a field the panel silently stops showing.
    assert.deepEqual(env.health, body);
});
