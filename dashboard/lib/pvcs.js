'use strict';

const k8s = require('@kubernetes/client-node');
const { core, isNotFound, isAlreadyExists, TtlCache } = require('./k8s');
const cfg = require('./config');

const ANN = {
    repoUrl: 'claude.kieffer.me/repo-url',
    repoFullName: 'claude.kieffer.me/repo-full-name',
    keyRaw: 'claude.kieffer.me/workspace-key-raw',
    createdAt: 'claude.kieffer.me/created-at',
    lastSeenAt: 'claude.kieffer.me/last-seen-at',
    lastUsedBytes: 'claude.kieffer.me/last-used-bytes',
};

const pvcCache = new TtlCache(cfg.pvcCacheMs);
const lastTouched = new Map();      // pvc name -> epoch ms

async function listWorkspacePvcs({ skipCache = false } = {}) {
    if (skipCache) pvcCache.invalidate();
    return pvcCache.get(async () => {
        const res = await core.listNamespacedPersistentVolumeClaim({
            namespace: cfg.namespace,
            labelSelector: `app=${cfg.labels.app}`,
        });
        return res.items || [];
    });
}

async function getPvc(name) {
    try {
        return await core.readNamespacedPersistentVolumeClaim({ name, namespace: cfg.namespace });
    } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
    }
}

/**
 * Create the repo's PVC if it is not already there. PVCs deliberately outlive
 * sessions, so on the warm path this is a no-op and the existing volume -- with
 * its checkouts, node_modules and uncommitted work -- is reused as-is.
 */
async function ensurePvc({ id, key, repoUrl, repoFullName }) {
    const existing = await getPvc(id);
    if (existing) return { pvc: existing, created: false };

    const body = {
        apiVersion: 'v1',
        kind: 'PersistentVolumeClaim',
        metadata: {
            name: id,
            namespace: cfg.namespace,
            labels: {
                app: cfg.labels.app,
                'app.kubernetes.io/managed-by': cfg.labels.managedBy,
                'claude.kieffer.me/workspace-key': id,
            },
            annotations: {
                [ANN.repoUrl]: repoUrl,
                [ANN.repoFullName]: repoFullName,
                [ANN.keyRaw]: key,
                [ANN.createdAt]: new Date().toISOString(),
            },
        },
        spec: {
            accessModes: ['ReadWriteOnce'],
            storageClassName: cfg.storageClass,
            resources: { requests: { storage: cfg.storageSize } },
        },
    };

    try {
        const pvc = await core.createNamespacedPersistentVolumeClaim({
            namespace: cfg.namespace, body,
        });
        pvcCache.invalidate();
        return { pvc, created: true };
    } catch (err) {
        // Two concurrent creates for the same repo: the loser just reuses it.
        if (isAlreadyExists(err)) return { pvc: await getPvc(id), created: false };
        throw err;
    }
}

/**
 * A PVC's last-use time is not observable from the API server, so the dashboard
 * records it. This annotation is both the disk display's fallback for unmounted
 * volumes and the pruner's "untouched for N days" clock. Rate-limited so we are
 * not writing to etcd on every UI poll.
 */
async function touchPvc(name, usedBytes) {
    const now = Date.now();
    if (now - (lastTouched.get(name) || 0) < cfg.pvcTouchMs) return false;
    lastTouched.set(name, now);

    const annotations = { [ANN.lastSeenAt]: new Date().toISOString() };
    if (Number.isFinite(usedBytes)) annotations[ANN.lastUsedBytes] = String(Math.round(usedBytes));

    try {
        await core.patchNamespacedPersistentVolumeClaim(
            { name, namespace: cfg.namespace, body: { metadata: { annotations } } },
            k8s.setHeaderOptions('Content-Type', k8s.PatchStrategy.MergePatch),
        );
        return true;
    } catch (err) {
        if (isNotFound(err)) return false;
        throw err;                  // a failing patch means the pruner clock is wrong
    }
}

async function deletePvc(name) {
    try {
        await core.deleteNamespacedPersistentVolumeClaim({ name, namespace: cfg.namespace });
        pvcCache.invalidate();
        return true;
    } catch (err) {
        if (isNotFound(err)) return false;
        throw err;
    }
}

function parseStorageToGi(quantity) {
    const m = /^([0-9.]+)\s*(Ki|Mi|Gi|Ti|K|M|G|T)?i?B?$/.exec(String(quantity || ''));
    if (!m) return null;
    const n = parseFloat(m[1]);
    const unit = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40,
                   K: 1e3, M: 1e6, G: 1e9, T: 1e12 }[m[2]] ?? 1;
    return (n * unit) / 2 ** 30;
}

/** Shape used by GET /api/workspaces and the pruner. */
function describePvc(pvc, { inUse = false, liveUsedBytes = null } = {}) {
    const ann = pvc.metadata?.annotations || {};
    const capacityGi = parseStorageToGi(
        pvc.status?.capacity?.storage || pvc.spec?.resources?.requests?.storage);
    const usedBytes = liveUsedBytes ?? (ann[ANN.lastUsedBytes] ? Number(ann[ANN.lastUsedBytes]) : null);
    const usedGi = Number.isFinite(usedBytes) ? usedBytes / 2 ** 30 : null;
    const lastSeenAt = ann[ANN.lastSeenAt] || ann[ANN.createdAt] || pvc.metadata?.creationTimestamp;

    return {
        name: pvc.metadata.name,
        workspaceKey: ann[ANN.keyRaw] || null,
        repoUrl: ann[ANN.repoUrl] || null,
        repoFullName: ann[ANN.repoFullName] || null,
        phase: pvc.status?.phase || 'Unknown',
        capacityGi: capacityGi === null ? null : Number(capacityGi.toFixed(2)),
        usedGi: usedGi === null ? null : Number(usedGi.toFixed(2)),
        usePercent: capacityGi && usedGi !== null ? Math.round((usedGi / capacityGi) * 100) : null,
        live: liveUsedBytes !== null,
        inUse,
        lastSeenAt: lastSeenAt || null,
        ageDays: lastSeenAt
            ? Math.floor((Date.now() - new Date(lastSeenAt).getTime()) / 86400000) : null,
    };
}

module.exports = {
    ANN, listWorkspacePvcs, getPvc, ensurePvc, touchPvc, deletePvc,
    describePvc, parseStorageToGi, pvcCache,
};
