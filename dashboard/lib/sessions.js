'use strict';

const cfg = require('./config');
const k8s = require('./k8s');
const pvcs = require('./pvcs');
const { workspaceKey, repoFullName } = require('./workspaceKey');
const { workspaceId, sessionName: buildSessionName } = require('./naming');
const { buildWorkspacePodManifest, ANN } = require('./podTemplate');
const { validateRepoUrl, validateBranch, validateOptionalBranch } = require('./validate');
const agent = require('./agentClient');

const FATAL_WAITING = new Set([
    'ImagePullBackOff', 'ErrImagePull', 'InvalidImageName',
    'CreateContainerConfigError', 'CreateContainerError',
]);

const sessionsCache = new k8s.TtlCache(cfg.sessionsCacheMs);

/** Statuses that are still settling, and so must never be served from cache. */
const UNSETTLED = new Set(['starting', 'terminating']);

/**
 * Map a Pod to a UI status. This replaces the old heuristic of scraping
 * `tmux capture-pane` output for the strings "Connected" or "Ready".
 */
function deriveStatus(pod) {
    if (pod.metadata?.deletionTimestamp) return 'terminating';

    const phase = pod.status?.phase;
    if (phase === 'Failed' || phase === 'Succeeded') return 'failed';

    const cs = (pod.status?.containerStatuses || [])[0];

    if (phase === 'Pending') {
        const waiting = cs?.state?.waiting?.reason;
        if (waiting && FATAL_WAITING.has(waiting)) return 'failed';
        return 'starting';
    }

    if (phase === 'Running') {
        const ready = (pod.status?.conditions || [])
            .some((c) => c.type === 'Ready' && c.status === 'True');
        // A container that came back from an OOMKill is running again, but the
        // user lost their tmux session -- surface that rather than hiding it.
        if (cs?.lastState?.terminated?.reason === 'OOMKilled') return ready ? 'degraded' : 'starting';
        return ready ? 'running' : 'starting';
    }

    return 'starting';
}

function podReason(pod) {
    const cs = (pod.status?.containerStatuses || [])[0];
    const waiting = cs?.state?.waiting;
    if (waiting?.reason) return waiting.reason;
    if (pod.status?.reason) return pod.status.reason;
    const unschedulable = (pod.status?.conditions || [])
        .find((c) => c.type === 'PodScheduled' && c.status === 'False');
    if (unschedulable?.reason) return unschedulable.reason;
    return null;
}

function limitsFromPod(pod) {
    const limits = pod.spec?.containers?.[0]?.resources?.limits || {};
    return {
        cpuMillicores: parseCpuLimit(limits.cpu),
        memMiB: parseMemLimit(limits.memory),
    };
}

function parseCpuLimit(value) {
    if (!value) return null;
    const s = String(value);
    return s.endsWith('m') ? parseInt(s, 10) : Math.round(parseFloat(s) * 1000);
}

function parseMemLimit(value) {
    if (!value) return null;
    const m = /^([0-9.]+)(Ki|Mi|Gi|Ti|K|M|G|T)?$/.exec(String(value));
    if (!m) return null;
    const unit = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40,
                   K: 1e3, M: 1e6, G: 1e9, T: 1e12 }[m[2]] ?? 1;
    return Math.round((parseFloat(m[1]) * unit) / 2 ** 20);
}

/** The session object returned by every endpoint. */
function describePod(pod, { agentHealth = null, warning = null } = {}) {
    const ann = pod.metadata?.annotations || {};
    const status = deriveStatus(pod);
    const cs = (pod.status?.containerStatuses || [])[0];
    const branch = ann[ANN.branch] || 'unknown';
    const repo = ann[ANN.repoFullName] || 'unknown';

    let message = null;
    if (status === 'starting') {
        message = agentHealth?.stage
            ? stageMessage(agentHealth)
            : (warning ? `${warning.reason}: ${warning.message}` : podReason(pod));
    } else if (status === 'failed') {
        message = warning ? `${warning.reason}: ${warning.message}`
            : (cs?.state?.waiting?.message || cs?.state?.terminated?.reason || podReason(pod));
    } else if (status === 'degraded') {
        message = 'container restarted after running out of memory';
    }

    return {
        id: pod.metadata.name,
        displayName: `${repo.split('/').pop()} · ${branch}`,
        repoUrl: ann[ANN.repoUrl] || null,
        repoFullName: repo,
        branch,
        baseBranch: ann[ANN.baseBranch] || null,
        workspaceKey: ann[ANN.keyRaw] || null,
        sessionName: ann[ANN.sessionName] || pod.metadata.name,
        pvcName: pod.spec?.volumes?.find((v) => v.persistentVolumeClaim)
            ?.persistentVolumeClaim?.claimName || null,
        status,
        phase: pod.status?.phase || 'Unknown',
        ready: status === 'running' || status === 'degraded',
        reason: podReason(pod),
        message: message || null,
        startedAt: ann[ANN.startedAt] || pod.metadata?.creationTimestamp || null,
        restartCount: cs?.restartCount ?? 0,
        lastTerminationReason: cs?.lastState?.terminated?.reason || null,
        terminalUrl: `/tty/${pod.metadata.name}/`,
        limits: limitsFromPod(pod),
    };
}

/** Stages whose whole point is the reason, so the detail is the message. */
const DETAILED_STAGES = new Set(['failed', 'session-lost']);

/**
 * The stage label, plus whatever the agent knows about *why*.
 *
 * The label alone is a dead end for the failure stages: "workspace bootstrap
 * failed" with no detail sends you to `kubectl exec` to read the pane the agent
 * had already captured. The agent's `detail` is a tail of that pane (or of the
 * entrypoint's error file), so pass it through.
 */
function stageMessage({ stage, detail }) {
    const label = stageLabel(stage);
    // Progress stages are self-explanatory, and their detail is a live tail of
    // the pane -- appending it would make the message flicker every poll.
    if (!detail || !DETAILED_STAGES.has(stage)) return label;
    const line = String(detail).split('\n').filter(Boolean).pop();
    return line ? `${label} — ${line}` : label;
}

function stageLabel(stage) {
    return {
        'syncing-config': 'syncing Claude config…',
        cloning: 'cloning repository…',
        starting: 'starting Claude…',
        // The agent reports this when claude died after the pod was ready; it
        // relaunches in the pane, then fails /livez so the kubelet restarts.
        'session-lost': 'Claude session lost; relaunching…',
        failed: 'workspace bootstrap failed',
    }[stage] || stage;
}

/**
 * Enrich a pod with the context that explains *why* it is not ready yet.
 *
 * Two sources, in order of usefulness:
 *  - the in-pod agent, once it has an IP, which knows the bootstrap phase
 *    ("cloning repository…") -- far more useful than "ContainerCreating";
 *  - the pod's newest Warning event, which is the only place a stuck Pending
 *    explains itself (Unschedulable, FailedAttachVolume/Multi-Attach).
 */
async function describeWithContext(pod) {
    const status = deriveStatus(pod);
    if (status !== 'starting' && status !== 'failed') return describePod(pod);

    const [agentHealth, warning] = await Promise.all([
        pod.status?.podIP ? agent.health(pod.status.podIP) : null,
        k8s.latestWarning(pod.metadata.name),
    ]);
    return describePod(pod, { agentHealth, warning });
}

async function listSessions({ skipCache = false } = {}) {
    if (skipCache) sessionsCache.invalidate();
    const pods = await sessionsCache.get(
        () => k8s.listWorkspacePods(),
        // Anything mid-transition is exactly what the UI is polling for, so
        // never hand back a cached copy of it.
        (cached) => cached.some((p) => UNSETTLED.has(deriveStatus(p))),
    );
    return Promise.all(pods.map(describeWithContext));
}

async function getSession(id) {
    const pod = await k8s.getPod(id);
    if (!pod) return null;
    return describeWithContext(pod);
}

class ConflictError extends Error {
    constructor(message, session) {
        super(message);
        this.name = 'ConflictError';
        this.statusCode = 409;
        this.session = session;
    }
}

class CapacityError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CapacityError';
        this.statusCode = 429;
    }
}

/**
 * Create a workspace. Returns immediately once the Pod is accepted by the API
 * server -- readiness is the caller's problem, reported via GET /api/sessions.
 */
async function createSession({ project, branch, newBranch, replace = false, resetHard = false }) {
    const repoUrl = validateRepoUrl(project);
    const baseBranch = validateBranch(branch, 'branch');
    const created = validateOptionalBranch(newBranch, 'newBranch');
    const effectiveBranch = created || baseBranch;

    const key = workspaceKey({ repoUrl, branch: effectiveBranch });
    const id = workspaceId(key);
    const repo = repoFullName(repoUrl);

    const existing = await k8s.getPod(id);
    if (existing) {
        const session = describePod(existing);
        if (!replace) {
            throw new ConflictError(
                `A workspace for ${session.repoFullName} is already running on branch ` +
                `${session.branch}.`, session);
        }
        await k8s.deletePod(id, 30);
        // The RWO volume must fully detach before the replacement can attach.
        const gone = await k8s.waitForPodGone(id, 60000);
        if (!gone) {
            throw new Error(
                'the existing workspace did not terminate within 60s; try again shortly');
        }
    } else {
        const running = (await k8s.listWorkspacePods())
            .filter((p) => !p.metadata?.deletionTimestamp);
        if (running.length >= cfg.maxWorkspaces) {
            throw new CapacityError(
                `workspace limit reached (${cfg.maxWorkspaces}); terminate one first`);
        }
    }

    await pvcs.ensurePvc({ id, key, repoUrl, repoFullName: repo });

    const manifest = buildWorkspacePodManifest({
        id, key, repoUrl, repoFullName: repo,
        branch: effectiveBranch, baseBranch,
        newBranch: created, resetHard,
        sessionName: buildSessionName(repo, effectiveBranch),
        pvcName: id,
    });

    const pod = await k8s.createPod(manifest);
    sessionsCache.invalidate();
    return describePod(pod);
}

/** Terminating frees compute but deliberately keeps the PVC (warm restarts). */
async function deleteSession(id, { deletePvc = false } = {}) {
    const removed = await k8s.deletePod(id, 30);
    if (!removed) return false;
    sessionsCache.invalidate();
    if (deletePvc) {
        await k8s.waitForPodGone(id, 60000);
        await pvcs.deletePvc(id);
    }
    return true;
}

async function restartSession(id) {
    const pod = await k8s.getPod(id);
    if (!pod) return null;
    const ann = pod.metadata?.annotations || {};
    await k8s.deletePod(id, 30);
    if (!await k8s.waitForPodGone(id, 60000)) {
        throw new Error('the workspace did not terminate within 60s; try again shortly');
    }
    const created = await k8s.createPod(buildWorkspacePodManifest({
        id,
        key: ann[ANN.keyRaw],
        repoUrl: ann[ANN.repoUrl],
        repoFullName: ann[ANN.repoFullName],
        branch: ann[ANN.branch],
        baseBranch: ann[ANN.baseBranch] || ann[ANN.branch],
        sessionName: ann[ANN.sessionName],
        pvcName: id,
    }));
    sessionsCache.invalidate();
    return describePod(created);
}

module.exports = {
    deriveStatus, describePod, describeWithContext, listSessions, getSession,
    createSession, deleteSession, restartSession,
    ConflictError, CapacityError, sessionsCache,
    parseCpuLimit, parseMemLimit,
};
