#!/usr/bin/env node
'use strict';

/**
 * Tiny in-pod agent. Zero dependencies, binds 0.0.0.0:7682.
 *
 * This exists so the dashboard never needs `pods/exec` RBAC -- exec is a root
 * shell into every workspace, held by an internet-facing service. A ~100 line
 * HTTP endpoint behind a NetworkPolicy gets the same data.
 *
 *   GET /livez    the workspace is salvageable in place (see live())
 *   GET /healthz  readiness: bootstrap finished AND `claude remote` is running
 *   GET /disk     df of the workspace volume
 *   GET /session  what this pod is working on
 */

const http = require('http');
const fs = require('fs');
const { execFileSync } = require('child_process');

const PORT = Number(process.env.AGENT_PORT || 7682);
// Bootstrap state lives in a uid-1000-owned dir on the container layer:
// /run is root-owned, and this must not land on the PVC.
const STATE_DIR = process.env.WORKSPACE_STATE_DIR || '/home/ubuntu/.workspace-state';
const STAGE_FILE = `${STATE_DIR}/stage`;
const DIR_FILE = `${STATE_DIR}/dir`;
const ERROR_FILE = `${STATE_DIR}/error`;
const READY_FILE = `${STATE_DIR}/ready`;
const TMUX_SESSION = 'claude';
const SESSION_NAME = process.env.CLAUDE_SESSION_NAME || '';

// Self-heal knobs. Claude is launched by entrypoint.sh with `send-keys` into
// the tmux pane, NOT by supervisord -- so nothing respawns it when it dies.
// The agent does: relaunch in place a few times, then fail /livez so the
// kubelet restarts the container (restartPolicy: Always, PVC stays attached).
const SELF_HEAL = process.env.WORKSPACE_SELF_HEAL !== '0';
const RELAUNCH_MAX = Number(process.env.WORKSPACE_RELAUNCH_MAX || 3);
const RELAUNCH_BACKOFF_MS = Number(process.env.WORKSPACE_RELAUNCH_BACKOFF_MS || 30000);

let missingSince = null;   // first probe that saw the session gone
let relaunches = 0;
let lastRelaunchAt = 0;

function readFile(file) {
    try { return fs.readFileSync(file, 'utf8').trim(); } catch { return null; }
}

function sh(cmd, args) {
    try {
        return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
        return null;
    }
}

function tmuxSessionExists() {
    try {
        execFileSync('tmux', ['has-session', '-t', TMUX_SESSION], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

// The launch command itself never ran: a missing binary, or a claude too old
// for `remote` / `--spawn`. Deliberately does NOT match a generic `Error:`.
const LAUNCH_FAILURE_RE = /command not found|unknown (?:option|command)|error: unknown/i;

function capturePane() {
    return sh('tmux', ['capture-pane', '-t', TMUX_SESSION, '-p']) || '';
}

/**
 * Is the bootstrap-launched `claude remote` running?
 *
 * Matched on `remote` + `--name <CLAUDE_SESSION_NAME>`, not on "any claude":
 * a user running their own `claude` in a second window must not hold the pod
 * ready, and quitting that instance must not take the pod out of service.
 *
 * Read from /proc rather than pgrep: procps is not an explicit image
 * dependency, and this needs no child process on a 3s probe.
 */
function claudeRemoteRunning() {
    let entries;
    try { entries = fs.readdirSync('/proc'); } catch { return false; }
    for (const pid of entries) {
        if (!/^\d+$/.test(pid)) continue;
        let cmdline;
        try { cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; }
        const argv = cmdline.split('\0').filter(Boolean);
        if (!argv.some((a) => /claude/.test(a))) continue;
        if (!argv.includes('remote')) continue;
        if (SESSION_NAME && !argv.includes(SESSION_NAME)) continue;
        return true;
    }
    return false;
}

function wasReadyOnce() {
    return readFile(READY_FILE) !== null;
}

function markReady() {
    try { fs.writeFileSync(READY_FILE, String(Date.now())); } catch { /* best effort */ }
}

/**
 * Tier 1 self-heal: retype the launch command into the pane. Cheap -- the pod,
 * the checkout and the tmux session all survive. Rate-limited, and capped, so
 * a claude that cannot start becomes a liveness failure instead of a loop.
 */
function tryRelaunch() {
    if (!SELF_HEAL || relaunches >= RELAUNCH_MAX) return;
    if (Date.now() - lastRelaunchAt < RELAUNCH_BACKOFF_MS) return;
    lastRelaunchAt = Date.now();
    relaunches += 1;
    console.log(`[agent] claude session gone; relaunch attempt ${relaunches}/${RELAUNCH_MAX}`);
    sh('tmux', [
        'send-keys', '-t', TMUX_SESSION,
        `claude remote --name '${SESSION_NAME}' --spawn=same-dir`, 'Enter',
    ]);
}

/**
 * Readiness. The bootstrap writes a stage marker; once it reports `starting`,
 * we additionally require the bootstrap `claude remote` to be running.
 *
 * Readiness must NOT be a scrape of the visible tmux pane. The pane is a
 * scrolling transcript: claude's connect banner leaves the viewport as soon as
 * the agent produces output, so a pane match flips ready -> not-ready on a
 * healthy pod and the pod gets marked unhealthy while claude is fine. (It also
 * never matched `Reconnected after 3s`, which is what a live remote prints.)
 */
function health() {
    const stage = readFile(STAGE_FILE) || 'starting';

    if (stage === 'failed') {
        return { ready: false, stage: 'failed', detail: tail(readFile(ERROR_FILE) || '') };
    }
    if (stage !== 'starting') {
        return { ready: false, stage, detail: null };
    }
    if (!tmuxSessionExists()) {
        return { ready: false, stage: 'starting', detail: 'tmux session not created yet' };
    }

    if (claudeRemoteRunning()) {
        missingSince = null;
        relaunches = 0;
        if (!wasReadyOnce()) markReady();
        return { ready: true, stage: 'ready', detail: null };
    }

    // Ready once, gone now: a real regression. Not-ready immediately, and the
    // self-heal ladder starts. READY_FILE lives on the container layer, so a
    // container restart clears it and the pod re-proves readiness from scratch.
    if (wasReadyOnce()) {
        if (missingSince === null) missingSince = Date.now();
        tryRelaunch();
        const secs = Math.round((Date.now() - missingSince) / 1000);
        return {
            ready: false,
            stage: 'session-lost',
            detail: `claude remote (--name ${SESSION_NAME || '?'}) not running for ${secs}s; `
                + `relaunch attempts ${relaunches}/${RELAUNCH_MAX}`,
        };
    }

    // Pre-ready only: the pane is still the bootstrap/launch transcript here,
    // so it is a usable failure signal and a usable progress message.
    //
    // The pattern must stay narrow. A bare /Error:/ matches any line claude
    // prints while starting (an MCP server that failed to attach, a warning
    // from a plugin), and a pre-ready 'failed' is terminal -- nothing clears
    // it, so a healthy pod that logged one scary line is stuck forever. Only
    // match the launch command never running at all, which self-heal cannot
    // fix either.
    const pane = capturePane();
    if (LAUNCH_FAILURE_RE.test(pane)) {
        return { ready: false, stage: 'failed', detail: tail(pane) };
    }
    return { ready: false, stage: 'starting', detail: tail(pane) };
}

/**
 * Liveness. Deliberately NOT "the agent process is up" -- that answer is always
 * yes, which is why a workspace could sit 503 on readiness for 8 hours without
 * ever being restarted. Readiness gates Endpoints; only liveness restarts.
 *
 * Fails only once the pod was ready, claude is gone, and in-pane relaunch has
 * been exhausted. Never fails during bootstrap: a slow clone must not be shot.
 */
function live() {
    if (!SELF_HEAL) return { ok: true, reason: 'self-heal disabled' };
    if (!wasReadyOnce()) return { ok: true, reason: 'bootstrap in progress' };
    if (claudeRemoteRunning()) return { ok: true };
    if (relaunches < RELAUNCH_MAX) {
        return { ok: true, reason: `relaunching (${relaunches}/${RELAUNCH_MAX})` };
    }
    return {
        ok: false,
        reason: `claude remote gone; ${relaunches} in-pane relaunches failed -- restarting container`,
    };
}

function tail(text, lines = 8) {
    return text.split('\n').filter(Boolean).slice(-lines).join('\n') || null;
}

function disk() {
    const out = sh('df', ['-B1', '--output=size,used,avail', '/workspace']);
    if (!out) return null;
    const row = out.trim().split('\n').pop().trim().split(/\s+/);
    if (row.length < 3) return null;
    return {
        capacityBytes: Number(row[0]),
        usedBytes: Number(row[1]),
        availBytes: Number(row[2]),
    };
}

function session() {
    return {
        workspaceId: process.env.WORKSPACE_ID || null,
        workspaceDir: readFile(DIR_FILE),
        branch: process.env.BRANCH || null,
        sessionName: process.env.CLAUDE_SESSION_NAME || null,
        stage: readFile(STAGE_FILE) || 'starting',
        claudeConnected: health().ready,
    };
}

function send(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
    });
    res.end(payload);
}

http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];

    if (path === '/livez') {
        const l = live();
        return send(res, l.ok ? 200 : 503, l);
    }

    if (path === '/healthz') {
        const h = health();
        return send(res, h.ready ? 200 : 503, h);
    }

    if (path === '/disk') {
        const d = disk();
        return d ? send(res, 200, d) : send(res, 503, { error: 'df failed' });
    }

    if (path === '/session') return send(res, 200, session());

    send(res, 404, { error: 'not found' });
}).listen(PORT, '0.0.0.0', () => {
    console.log(`[agent] listening on ${PORT}`);
});
