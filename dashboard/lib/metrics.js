'use strict';

const cfg = require('./config');
const { customObjects } = require('./k8s');

let available = null;               // null = not yet probed
let lastProbe = 0;
const PROBE_INTERVAL_MS = 300000;

/**
 * metrics-server reports CPU in nanocores ("123456789n") or milli ("45m"),
 * and memory in Ki/Mi/Gi -- not the plain numbers the old `ps` walk produced.
 */
function parseCpuToMillicores(value) {
    const s = String(value || '0');
    const m = /^([0-9.]+)(n|u|m)?$/.exec(s);
    if (!m) return 0;
    const n = parseFloat(m[1]);
    switch (m[2]) {
        case 'n': return n / 1e6;
        case 'u': return n / 1e3;
        case 'm': return n;
        default: return n * 1000;
    }
}

function parseMemToMiB(value) {
    const m = /^([0-9.]+)(Ki|Mi|Gi|Ti|K|M|G|T)?$/.exec(String(value || '0'));
    if (!m) return 0;
    const unit = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40,
                   K: 1e3, M: 1e6, G: 1e9, T: 1e12 }[m[2]] ?? 1;
    return (parseFloat(m[1]) * unit) / 2 ** 20;
}

async function fetchPodMetrics() {
    const res = await customObjects.listNamespacedCustomObject({
        group: 'metrics.k8s.io',
        version: 'v1beta1',
        namespace: cfg.namespace,
        plural: 'pods',
        labelSelector: `app=${cfg.labels.app}`,
    });
    return res.items || [];
}

/**
 * metrics-server is optional on a small cluster. Probe once, cache the answer,
 * and re-probe occasionally -- but never turn its absence into a 500, or the UI
 * error-flashes on every poll.
 */
async function isAvailable() {
    const now = Date.now();
    if (available !== null && now - lastProbe < PROBE_INTERVAL_MS) return available;
    lastProbe = now;
    try {
        await fetchPodMetrics();
        available = true;
    } catch {
        available = false;
    }
    return available;
}

/**
 * @param sessions  session objects, used for per-pod limits (always available
 *                  from the pod spec, even when metrics-server is not).
 */
async function collect(sessions) {
    const limitsById = new Map(sessions.map((s) => [s.id, s.limits]));
    const totals = {
        cpuMillicores: 0,
        memMiB: 0,
        cpuLimitMillicores: 0,
        memLimitMiB: 0,
    };
    for (const s of sessions) {
        totals.cpuLimitMillicores += s.limits.cpuMillicores || 0;
        totals.memLimitMiB += s.limits.memMiB || 0;
    }

    if (!await isAvailable()) {
        return { source: 'unavailable', sessions: {}, totals };
    }

    try {
        const items = await fetchPodMetrics();
        const out = {};
        for (const item of items) {
            const id = item.metadata?.name;
            if (!id) continue;
            let cpu = 0;
            let mem = 0;
            for (const c of item.containers || []) {
                cpu += parseCpuToMillicores(c.usage?.cpu);
                mem += parseMemToMiB(c.usage?.memory);
            }
            const limits = limitsById.get(id) || {};
            out[id] = {
                cpuMillicores: Math.round(cpu),
                memMiB: Math.round(mem),
                cpuLimitMillicores: limits.cpuMillicores ?? null,
                memLimitMiB: limits.memMiB ?? null,
            };
            totals.cpuMillicores += cpu;
            totals.memMiB += mem;
        }
        totals.cpuMillicores = Math.round(totals.cpuMillicores);
        totals.memMiB = Math.round(totals.memMiB);
        return { source: 'metrics-server', sessions: out, totals, window: '30s' };
    } catch {
        available = false;
        return { source: 'unavailable', sessions: {}, totals };
    }
}

module.exports = { collect, isAvailable, parseCpuToMillicores, parseMemToMiB };
