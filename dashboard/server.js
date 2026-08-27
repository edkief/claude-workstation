'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const cfg = require('./lib/config');
const k8s = require('./lib/k8s');
const sessions = require('./lib/sessions');
const pvcs = require('./lib/pvcs');
const metrics = require('./lib/metrics');
const github = require('./lib/github');
const agent = require('./lib/agentClient');
const ttyProxy = require('./lib/ttyProxy');
const tokenCheck = require('./lib/tokenCheck');
const { ValidationError, validateRepoFullName } = require('./lib/validate');
const { isWorkspaceId } = require('./lib/naming');

const app = express();
app.use(express.json({ limit: '16kb' }));

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function fail(res, err) {
    if (err instanceof sessions.ConflictError) {
        return res.status(409).json({
            error: 'workspace_busy',
            message: err.message,
            session: err.session,
            actions: ['attach', 'replace'],
        });
    }
    if (err instanceof sessions.CapacityError) {
        return res.status(429).json({ error: 'capacity_reached', message: err.message });
    }
    if (err.name === 'ValidationError') {
        return res.status(400).json({ error: 'invalid_request', message: err.message });
    }

    // Surface Kubernetes API errors as themselves rather than a mute 500.
    // A missing Role is the most likely first-deploy failure, and "cannot list
    // pods" in the UI is the difference between a five-minute fix and a hunt
    // through container logs.
    const code = k8s.statusCode(err);
    if (code === 403) {
        return res.status(503).json({
            error: 'rbac_forbidden',
            message: `The dashboard's ServiceAccount lacks permission: ${k8s.apiMessage(err)}. ` +
                'Apply k8s/dashboard.yaml.',
        });
    }
    if (code) {
        return res.status(code >= 400 && code < 600 ? code : 500)
            .json({ error: 'kubernetes_error', message: k8s.apiMessage(err) });
    }

    res.status(err.statusCode || 500).json({ error: 'server_error', message: err.message });
}

// ---------------------------------------------------------------- tty proxy

// Registered before the API routes so a workspace id can never be shadowed.
app.use('/tty/:id', asyncRoute(async (req, res) => {
    const { id } = req.params;
    if (!isWorkspaceId(id)) return res.status(404).send(ttyProxy.notFoundPage(id));

    const target = await ttyProxy.resolveTarget(id);
    if (target.gone) {
        return res.status(404)
            .type('html').send(ttyProxy.notFoundPage(id));
    }
    if (target.notReady) {
        const session = sessions.describePod(target.pod, { agentHealth: target.agentHealth });
        return res.status(503).type('html').send(ttyProxy.notReadyPage(id, session));
    }
    // ttyd was started with -b /tty/<id>, so the full original path (which
    // app.use() strips down to the remainder) is passed through unchanged.
    req.url = req.originalUrl;
    ttyProxy.proxyRequest(req, res, target);
}));

// ------------------------------------------------------------------- config

// The config shell runs inside this pod, so it is a plain localhost hop --
// no Kubernetes round-trip, which is what keeps it feeling instant.
const CONFIG_TTY_PORT = Number(process.env.CONFIG_TTY_PORT || 7683);
app.use('/config-tty', (req, res) => {
    req.url = req.originalUrl;
    ttyProxy.proxyRequest(req, res, { id: '__config__', ip: '127.0.0.1', port: CONFIG_TTY_PORT });
});

function runConfigSync(args) {
    return new Promise((resolve) => {
        const child = spawn('claude-config-sync', args, { env: process.env });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c) => { stdout += c; });
        child.stderr.on('data', (c) => { stderr += c; });
        child.on('error', (err) => resolve({ code: 127, stdout, stderr: err.message }));
        child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
}

app.get('/api/config/status', asyncRoute(async (req, res) => {
    const result = await runConfigSync(['status', '--json']);
    let parsed = null;
    try { parsed = JSON.parse(result.stdout); } catch { /* fall through */ }
    if (!parsed) {
        return res.json({
            available: false,
            pushPolicy: cfg.configPushPolicy,
            message: (result.stderr || result.stdout || 'config sync unavailable').trim(),
        });
    }
    res.json({ available: true, pushPolicy: cfg.configPushPolicy, ...parsed });
}));

// The token watchdog's latest verdict. Served from cache: the check reads a
// file, but the UI polls this and there is no reason to stat it every second.
app.get('/api/config/token', (req, res) => {
    res.json(req.query.fresh === '1' ? tokenCheck.check() : tokenCheck.status());
});

app.post('/api/config/push', asyncRoute(async (req, res) => {
    const result = await runConfigSync(['push', '--json']);
    if (result.code === 0) return res.json({ ok: true, detail: result.stdout.trim() });
    // Exit 3 is the ETag precondition: someone else pushed since our last pull.
    const status = result.code === 3 ? 409 : 500;
    res.status(status).json({
        error: result.code === 3 ? 'stale_config' : 'push_failed',
        message: (result.stderr || result.stdout || 'push failed').trim(),
    });
}));

// --------------------------------------------------------------------- info

app.get('/api/info', asyncRoute(async (req, res) => {
    res.json({
        dashboardPod: cfg.podName,
        namespace: cfg.namespace,
        workspaceImage: cfg.workspaceImage,
        metricsAvailable: await metrics.isAvailable(),
        maxWorkspaces: cfg.maxWorkspaces,
        configPushPolicy: cfg.configPushPolicy,
        defaults: {
            cpuLimitMillicores: sessions.parseCpuLimit(cfg.workspaceResources.limits.cpu),
            memLimitMiB: sessions.parseMemLimit(cfg.workspaceResources.limits.memory),
            storage: cfg.storageSize,
        },
    });
}));

// ------------------------------------------------------------------- github

app.get('/api/repos', asyncRoute(async (req, res) => {
    try {
        res.json(await github.listRepos());
    } catch (err) {
        res.status(500).json({ error: 'failed to fetch repos', message: err.message });
    }
}));

app.get('/api/branches', asyncRoute(async (req, res) => {
    try {
        const repo = validateRepoFullName(req.query.repo);
        res.json(await github.listBranches(repo));
    } catch (err) {
        if (err instanceof ValidationError) return fail(res, err);
        res.status(500).json({ error: 'failed to fetch branches', message: err.message });
    }
}));

// ----------------------------------------------------------------- sessions

app.get('/api/sessions', asyncRoute(async (req, res) => {
    res.json(await sessions.listSessions({ skipCache: req.query.fresh === '1' }));
}));

app.get('/api/sessions/:id', asyncRoute(async (req, res) => {
    const session = await sessions.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'not_found', message: 'session not found' });
    res.json(session);
}));

// 202, not 201: a cold start pulls a large image and clones a repo, which runs
// well past any browser or ingress idle timeout. The UI polls for readiness.
app.post('/api/sessions', asyncRoute(async (req, res) => {
    try {
        const session = await sessions.createSession(req.body || {});
        res.status(202).json(session);
    } catch (err) {
        fail(res, err);
    }
}));

app.delete('/api/sessions/:id', asyncRoute(async (req, res) => {
    const removed = await sessions.deleteSession(req.params.id, {
        deletePvc: req.query.deletePvc === 'true',
    });
    if (!removed) return res.status(404).json({ error: 'not_found', message: 'session not found' });
    ttyProxy.invalidateTarget(req.params.id);
    res.status(202).end();
}));

app.post('/api/sessions/:id/restart', asyncRoute(async (req, res) => {
    try {
        const session = await sessions.restartSession(req.params.id);
        if (!session) return res.status(404).json({ error: 'not_found', message: 'session not found' });
        ttyProxy.invalidateTarget(req.params.id);
        res.status(202).json(session);
    } catch (err) {
        fail(res, err);
    }
}));

app.get('/api/sessions/:id/logs', asyncRoute(async (req, res) => {
    const tail = Math.min(Math.max(parseInt(req.query.tail, 10) || 200, 1), 5000);
    try {
        const logs = await k8s.readPodLogs(req.params.id, tail);
        res.type('text/plain').send(logs);
    } catch (err) {
        if (k8s.isNotFound(err)) {
            return res.status(404).type('text/plain').send('session not found');
        }
        res.status(500).type('text/plain').send(k8s.apiMessage(err));
    }
}));

// --------------------------------------------------------------- workspaces

/** Live disk numbers where a pod is running; annotation fallback otherwise. */
async function describeWorkspaces() {
    const [claims, pods] = await Promise.all([
        pvcs.listWorkspacePvcs(),
        k8s.listWorkspacePods(),
    ]);
    const podsByPvc = new Map();
    for (const pod of pods) {
        const claim = pod.spec?.volumes?.find((v) => v.persistentVolumeClaim)
            ?.persistentVolumeClaim?.claimName;
        if (claim) podsByPvc.set(claim, pod);
    }

    return Promise.all(claims.map(async (pvc) => {
        const pod = podsByPvc.get(pvc.metadata.name);
        let liveUsedBytes = null;
        if (pod?.status?.podIP && sessions.deriveStatus(pod) !== 'starting') {
            const stats = await agent.disk(pod.status.podIP);
            if (stats && Number.isFinite(stats.usedBytes)) {
                liveUsedBytes = stats.usedBytes;
                pvcs.touchPvc(pvc.metadata.name, stats.usedBytes).catch(() => {});
            }
        }
        return pvcs.describePvc(pvc, { inUse: !!pod, liveUsedBytes });
    }));
}

app.get('/api/workspaces', asyncRoute(async (req, res) => {
    res.json(await describeWorkspaces());
}));

app.delete('/api/workspaces/:name', asyncRoute(async (req, res) => {
    const pod = await k8s.getPod(req.params.name);
    if (pod) {
        return res.status(409).json({
            error: 'workspace_in_use',
            message: 'terminate the running session before deleting its storage',
        });
    }
    const removed = await pvcs.deletePvc(req.params.name);
    if (!removed) return res.status(404).json({ error: 'not_found', message: 'workspace not found' });
    res.status(204).end();
}));

app.post('/api/workspaces/prune', asyncRoute(async (req, res) => {
    const days = parseInt(req.body?.olderThanDays, 10);
    if (!Number.isInteger(days) || days < 0) {
        return res.status(400).json({
            error: 'invalid_request', message: 'olderThanDays must be an integer >= 0',
        });
    }
    const items = await describeWorkspaces();
    const deleted = [];
    let freedGi = 0;
    for (const w of items) {
        if (w.inUse || w.ageDays === null || w.ageDays < days) continue;
        await pvcs.deletePvc(w.name);
        deleted.push({ name: w.name, repoFullName: w.repoFullName, ageDays: w.ageDays, usedGi: w.usedGi });
        freedGi += w.usedGi || 0;
    }
    res.json({ deleted, totalFreedGi: Number(freedGi.toFixed(2)) });
}));

// ---------------------------------------------------------------- resources

app.get('/api/resources', asyncRoute(async (req, res) => {
    const list = await sessions.listSessions();
    res.json(await metrics.collect(list));
}));

app.get('/api/disk', asyncRoute(async (req, res) => {
    const items = await describeWorkspaces();
    res.json({
        pvcCount: items.length,
        totalCapacityGi: Number(items.reduce((a, w) => a + (w.capacityGi || 0), 0).toFixed(2)),
        totalUsedGi: Number(items.reduce((a, w) => a + (w.usedGi || 0), 0).toFixed(2)),
        items,
    });
}));

// ------------------------------------------------------------------ static

app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => {          // eslint-disable-line no-unused-vars
    const code = k8s.statusCode(err);
    // Expected, recurring API errors log one line; anything unexpected keeps
    // its stack.
    if (code) console.error(`[dashboard] kubernetes ${code}: ${k8s.apiMessage(err)}`);
    else console.error('[dashboard]', err);
    fail(res, err);
});

// ------------------------------------------------------------------- server

const server = http.createServer(app);

// WebSocket upgrades bypass Express entirely.
server.on('upgrade', async (req, socket, head) => {
    try {
        const configMatch = /^\/config-tty(\/|$)/.test(req.url);
        if (configMatch) {
            return ttyProxy.proxyUpgrade(req, socket, head, {
                id: '__config__', ip: '127.0.0.1', port: CONFIG_TTY_PORT,
            });
        }

        const m = /^\/tty\/([a-z0-9-]+)(?:\/|$)/.exec(req.url);
        if (!m || !isWorkspaceId(m[1])) return socket.destroy();

        const target = await ttyProxy.resolveTarget(m[1]);
        if (target.gone) return socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
        if (target.notReady) return socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');
        ttyProxy.proxyUpgrade(req, socket, head, target);
    } catch {
        socket.destroy();
    }
});

tokenCheck.start();

server.listen(cfg.port, () => {
    console.log(`[dashboard] listening on ${cfg.port}, namespace=${cfg.namespace}, ` +
        `pushPolicy=${cfg.configPushPolicy}`);
});

module.exports = { app, server };
