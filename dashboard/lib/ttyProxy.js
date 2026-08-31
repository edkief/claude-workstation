'use strict';

const http = require('http');
const cfg = require('./config');
const { getPod } = require('./k8s');
const agent = require('./agentClient');

const TTY_PORT = 7681;
const CODEX_PORT = 7684;
const targetCache = new Map();       // workspace id + port -> { ip, port, expiresAt }

const cacheKey = (id, port) => `${id}:${port}`;

function invalidateTarget(id) {
    for (const key of targetCache.keys()) {
        if (key.startsWith(`${id}:`)) targetCache.delete(key);
    }
}

/** Any HTTP answer below 500 proves that the prefixed service is listening. */
function probeHttp(ip, port, path, timeoutMs = 2000) {
    return new Promise((resolve) => {
        const req = http.request({ host: ip, port, path, method: 'GET', timeout: timeoutMs }, (res) => {
            res.resume();
            resolve(res.statusCode >= 200 && res.statusCode < 500);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end();
    });
}

/**
 * Resolve a workspace id to its pod IP.
 *
 * Hand-rolled on node:http rather than http-proxy: because ttyd is told its own
 * base path (TTY_BASE_PATH), the proxy never rewrites anything, so a proxy
 * library would buy nothing while widening the dependency surface of an image
 * that holds a Kubernetes token.
 */
async function resolveTarget(id, { port = TTY_PORT, healthPath = null } = {}) {
    const key = cacheKey(id, port);
    const hit = targetCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit;

    const pod = await getPod(id);
    if (!pod) {
        invalidateTarget(id);
        return { gone: true };
    }

    const ready = (pod.status?.conditions || [])
        .some((c) => c.type === 'Ready' && c.status === 'True');
    if (!pod.status?.podIP) return { notReady: true, pod };

    let agentHealth = null;
    if (healthPath) {
        // Codex UI starts beside the Claude-centric readiness agent. Probe it
        // directly so a Claude login failure does not hide a healthy Codex UI.
        if (!await probeHttp(pod.status.podIP, port, healthPath)) {
            return { notReady: true, pod };
        }
    } else if (!ready) {
        // Readiness here means "claude is running", which is stricter than
        // "the terminal works". An expired login makes the pod not-ready
        // forever, and the terminal is the only place to run /login -- so ask
        // the agent whether ttyd is up rather than refusing outright.
        agentHealth = await agent.health(pod.status.podIP);
        if (!agentHealth?.terminalReady) return { notReady: true, pod, agentHealth };
    }

    const target = {
        id,
        ip: pod.status.podIP,
        port,
        expiresAt: Date.now() + cfg.targetCacheMs,
    };
    targetCache.set(key, target);
    return target;
}

/** Browser WebSockets must originate from the host whose ingress authenticated them. */
function isSameOriginUpgrade(req) {
    const origin = req.headers.origin;
    if (!origin) return true; // Preserve CLI/non-browser clients.
    try {
        return new URL(origin).host === req.headers.host;
    } catch {
        return false;
    }
}

/** Parse only the WebSocket paths understood by the two workspace services. */
function matchWorkspaceUpgrade(url) {
    let match = /^\/tty\/([a-z0-9-]+)(?:\/|\?|$)/.exec(url);
    if (match) return { service: 'tty', id: match[1], port: TTY_PORT };

    match = /^\/codex\/([a-z0-9-]+)\/codex-api\/ws(?:\/|\?|$)/.exec(url);
    if (match) {
        return {
            service: 'codex', id: match[1], port: CODEX_PORT,
            healthPath: `/codex/${match[1]}/`,
        };
    }
    return null;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function page({ title, body, refresh = 0 }) {
    return `<!doctype html><html><head><meta charset="utf-8">` +
        `<title>${escapeHtml(title)}</title>` +
        (refresh ? `<meta http-equiv="refresh" content="${refresh}">` : '') +
        `<style>body{background:#0d1117;color:#c9d1d9;font:14px/1.6 ui-sans-serif,system-ui,sans-serif;` +
        `display:flex;align-items:center;justify-content:center;height:100vh;margin:0}` +
        `.box{max-width:32rem;text-align:center}h1{font-size:1.1rem;font-weight:600}` +
        `code{background:#161b22;padding:.15rem .35rem;border-radius:4px}` +
        `a{color:#58a6ff}</style></head><body><div class="box">${body}</div></body></html>`;
}

function notFoundPage(id) {
    return page({
        title: 'Workspace terminated',
        body: `<h1>This workspace has been terminated</h1>` +
            `<p><code>${escapeHtml(id)}</code> is no longer running.</p>` +
            `<p><a href="/">Back to the dashboard</a></p>`,
    });
}

function notReadyPage(id, session) {
    const detail = session?.message || session?.reason || 'starting…';
    return page({
        title: 'Workspace starting',
        refresh: 2,
        body: `<h1>Workspace is starting</h1><p>${escapeHtml(detail)}</p>` +
            `<p style="opacity:.6">This page refreshes automatically.</p>` +
            `<p><a href="/">Back to the dashboard</a></p>`,
    });
}

function proxyRequest(req, res, target) {
    const upstream = http.request({
        host: target.ip,
        port: target.port,
        method: req.method,
        path: req.url,
        headers: req.headers,
    }, (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
        upstreamRes.pipe(res);
    });

    upstream.on('error', (err) => {
        // The pod may have restarted with a new IP; force a re-resolve.
        invalidateTarget(target.id);
        if (!res.headersSent) {
            res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
        }
        res.end(page({
            title: 'Workspace unreachable',
            body: `<h1>Workspace unreachable</h1><p><code>${escapeHtml(err.code || err.message)}</code></p>` +
                `<p><a href="/">Back to the dashboard</a></p>`,
        }));
    });

    req.pipe(upstream);
}

/** WebSocket upgrade, proxied by hand on the raw socket. Express never sees it. */
function proxyUpgrade(req, socket, head, target) {
    socket.on('error', () => socket.destroy());

    const upstream = http.request({
        host: target.ip,
        port: target.port,
        method: req.method,
        path: req.url,
        headers: req.headers,
    });

    upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
        const headers = Object.entries(upstreamRes.headers)
            .map(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`).join('\r\n') : `${k}: ${v}`))
            .join('\r\n');
        socket.write(
            `HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage}\r\n${headers}\r\n\r\n`);

        if (upstreamHead && upstreamHead.length) upstreamSocket.unshift(upstreamHead);
        if (head && head.length) upstreamSocket.write(head);

        upstreamSocket.on('error', () => socket.destroy());
        upstreamSocket.pipe(socket);
        socket.pipe(upstreamSocket);
    });

    // ttyd answered without upgrading -- pass the status back and close.
    upstream.on('response', (upstreamRes) => {
        socket.end(`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage}\r\n\r\n`);
    });

    upstream.on('error', () => {
        invalidateTarget(target.id);
        socket.destroy();
    });

    upstream.end();
}

module.exports = {
    resolveTarget, invalidateTarget, proxyRequest, proxyUpgrade,
    notFoundPage, notReadyPage, targetCache, TTY_PORT, CODEX_PORT,
    probeHttp, isSameOriginUpgrade, matchWorkspaceUpgrade,
};
