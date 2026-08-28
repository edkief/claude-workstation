'use strict';

const http = require('http');

const AGENT_PORT = 7682;

/** Small JSON GET against a workspace pod's in-pod agent. */
function agentGet(ip, path, timeoutMs = 2000) {
    return new Promise((resolve) => {
        const req = http.request(
            { host: ip, port: AGENT_PORT, path, method: 'GET', timeout: timeoutMs },
            (res) => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (c) => { body += c; });
                res.on('end', () => {
                    try {
                        resolve({ status: res.statusCode, body: JSON.parse(body || '{}') });
                    } catch {
                        resolve({ status: res.statusCode, body: null });
                    }
                });
            });
        // The agent is advisory: never let it fail a dashboard request.
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.end();
    });
}

async function health(ip) {
    const res = await agentGet(ip, '/healthz');
    return res ? res.body : null;
}

async function disk(ip) {
    const res = await agentGet(ip, '/disk');
    return res && res.status === 200 ? res.body : null;
}

/**
 * Shape a raw /healthz probe for the UI.
 *
 * The three "nothing to show" cases must stay distinguishable, for the same
 * reason the terminal is never gated on readiness: a workspace that cannot
 * explain itself renders as a permanent spinner. No IP means the pod is still
 * scheduling or attaching its volume; an IP with no answer means the agent is
 * down or a NetworkPolicy said no; an answer is the agent's own verdict,
 * passed through untouched.
 */
function healthEnvelope({ podIP, probe }) {
    if (!podIP) {
        return {
            available: false,
            message: 'the pod has no IP yet — still scheduling, or attaching its volume',
        };
    }
    if (!probe) {
        return {
            available: false,
            message: `no answer from the in-pod agent at ${podIP}:${AGENT_PORT} `
                + '(still bootstrapping, or the container is restarting)',
        };
    }
    if (!probe.body) {
        return {
            available: false,
            message: `the agent at ${podIP}:${AGENT_PORT} answered ${probe.status} `
                + 'with a body that is not JSON',
        };
    }
    // probeStatus is kept alongside the body: 503 with ready:false is the
    // normal shape of a workspace that is still starting, and seeing the two
    // together is what tells you the probe itself is working.
    return { available: true, podIP, probeStatus: probe.status, health: probe.body };
}

module.exports = { agentGet, health, disk, healthEnvelope, AGENT_PORT };
