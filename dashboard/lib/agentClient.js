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

module.exports = { agentGet, health, disk, AGENT_PORT };
