'use strict';

const k8s = require('@kubernetes/client-node');
const cfg = require('./config');

const kc = new k8s.KubeConfig();
try {
    kc.loadFromCluster();
} catch {
    kc.loadFromDefault();          // local development against a kubeconfig
}

const core = kc.makeApiClient(k8s.CoreV1Api);
const customObjects = kc.makeApiClient(k8s.CustomObjectsApi);

/**
 * Small TTL cache. Kubernetes is the source of truth, but the UI polls every
 * few seconds and we do not want to hammer the API server. Two escape hatches
 * matter: `invalidate()` after a write, and `skipIf()` so pods that are still
 * settling are always read live.
 */
class TtlCache {
    constructor(ttlMs, { dirtyMs = 10000 } = {}) {
        this.ttlMs = ttlMs;
        this.dirtyMs = dirtyMs;
        this.value = undefined;
        this.expiresAt = 0;
        this.dirtyUntil = 0;
        this.inflight = null;
    }

    invalidate() {
        this.value = undefined;
        this.expiresAt = 0;
        // A just-created pod may not appear in a list read immediately; bypass
        // the cache entirely for a short window after any write.
        this.dirtyUntil = Date.now() + this.dirtyMs;
    }

    /**
     * @param loader   async () => value
     * @param skipIf   (cachedValue) => boolean -- force a live read
     */
    async get(loader, skipIf) {
        const now = Date.now();
        const fresh = this.value !== undefined && this.expiresAt > now && now >= this.dirtyUntil;
        if (fresh && !(skipIf && skipIf(this.value))) return this.value;

        // Collapse concurrent misses into a single API call.
        if (this.inflight) return this.inflight;
        this.inflight = (async () => {
            try {
                const value = await loader();
                this.value = value;
                this.expiresAt = Date.now() + this.ttlMs;
                return value;
            } finally {
                this.inflight = null;
            }
        })();
        return this.inflight;
    }
}

/** The client throws typed errors; normalise the bits we branch on. */
function statusCode(err) {
    return err?.code ?? err?.statusCode ?? err?.response?.statusCode ?? err?.body?.code;
}

function isNotFound(err) { return statusCode(err) === 404; }
function isAlreadyExists(err) { return statusCode(err) === 409; }

/**
 * Pull the human-readable reason out of a client error. The generated client
 * puts the API's Status object in `body` as a JSON *string*, so without parsing
 * it you get the whole exception dump (headers, stack) instead of a sentence.
 */
function apiMessage(err) {
    const body = err?.body;
    if (body && typeof body === 'object' && body.message) return body.message;
    if (typeof body === 'string') {
        try {
            const parsed = JSON.parse(body);
            if (parsed?.message) return parsed.message;
        } catch { /* not JSON; fall through */ }
    }
    return err?.message || String(err);
}

const workspaceSelector = `app=${cfg.labels.app}`;

async function listWorkspacePods() {
    const res = await core.listNamespacedPod({
        namespace: cfg.namespace,
        labelSelector: workspaceSelector,
    });
    return res.items || [];
}

async function getPod(name) {
    try {
        return await core.readNamespacedPod({ name, namespace: cfg.namespace });
    } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
    }
}

async function createPod(manifest) {
    return core.createNamespacedPod({ namespace: cfg.namespace, body: manifest });
}

async function deletePod(name, gracePeriodSeconds = 30) {
    try {
        await core.deleteNamespacedPod({ name, namespace: cfg.namespace, gracePeriodSeconds });
        return true;
    } catch (err) {
        if (isNotFound(err)) return false;
        throw err;
    }
}

/** Poll until the pod name is free again -- Replace must not race the create. */
async function waitForPodGone(name, timeoutMs = 60000, pollMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!(await getPod(name))) return true;
        await new Promise((r) => setTimeout(r, pollMs));
    }
    return false;
}

async function readPodLogs(name, tailLines = 200) {
    return core.readNamespacedPodLog({
        name, namespace: cfg.namespace, tailLines, container: 'workspace',
    });
}

/**
 * Newest Warning event for a pod. This is how "FailedAttachVolume: Multi-Attach"
 * and "Unschedulable" reach the user instead of a mute spinner.
 */
async function latestWarning(podName) {
    try {
        const res = await core.listNamespacedEvent({
            namespace: cfg.namespace,
            fieldSelector: `involvedObject.name=${podName},type=Warning`,
        });
        const events = (res.items || []).slice().sort((a, b) => {
            const ta = new Date(a.lastTimestamp || a.eventTime || 0).getTime();
            const tb = new Date(b.lastTimestamp || b.eventTime || 0).getTime();
            return tb - ta;
        });
        if (!events.length) return null;
        return { reason: events[0].reason, message: events[0].message };
    } catch {
        return null;                // events are advisory; never fail a list on them
    }
}

module.exports = {
    kc, core, customObjects, TtlCache,
    isNotFound, isAlreadyExists, statusCode, apiMessage,
    listWorkspacePods, getPod, createPod, deletePod, waitForPodGone,
    readPodLogs, latestWarning, workspaceSelector,
};
