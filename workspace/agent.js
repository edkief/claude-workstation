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
const { execFileSync, execFile } = require('child_process');

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
const HOME = process.env.HOME || '/home/ubuntu';
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || `${HOME}/.claude`;
const CREDENTIALS_FILE = `${CLAUDE_DIR}/.credentials.json`;

// How long claude may take to appear in /proc after the pane launch before we
// call it a failed launch rather than a slow one. npm install + first run on a
// cold container layer is the slow case this has to clear.
const LAUNCH_TIMEOUT_MS = Number(process.env.WORKSPACE_LAUNCH_TIMEOUT_MS || 180000);

// Self-heal knobs. Claude is launched by entrypoint.sh with `send-keys` into
// the tmux pane, NOT by supervisord -- so nothing respawns it when it dies.
// The agent does: relaunch in place a few times, then fail /livez so the
// kubelet restarts the container (restartPolicy: Always, PVC stays attached).
const SELF_HEAL = process.env.WORKSPACE_SELF_HEAL !== '0';
const RELAUNCH_MAX = Number(process.env.WORKSPACE_RELAUNCH_MAX || 3);
const RELAUNCH_BACKOFF_MS = Number(process.env.WORKSPACE_RELAUNCH_BACKOFF_MS || 30000);

// Shared-login sync. See maintainToken().
const TOKEN_SYNC = process.env.WORKSPACE_TOKEN_SYNC !== '0';
const TOKEN_SYNC_MS = Number(process.env.WORKSPACE_TOKEN_SYNC_MS || 300000);
// Floor for the forced sync an auth failure asks for, so a pod that cannot log
// in spawns rclone every 30s rather than on every probe.
const TOKEN_SYNC_FORCE_MS = 30000;

let missingSince = null;   // first probe that saw the session gone
let relaunches = 0;
let lastRelaunchAt = 0;
let launchingSince = null; // first probe that saw stage=starting without claude
let tokenSyncAt = 0;
let tokenSyncRunning = false;
let tokenSyncError = null;
let lastTokenSync = { at: null, adopted: false, published: false, error: null };

/**
 * Terminal failures a *login* fixes. Claude prints these and exits (or sits at
 * a prompt), so the process is simply absent from /proc -- indistinguishable
 * from "still starting" unless the pane is read. Reporting them as
 * "starting Claude..." forever is the bug these patterns exist to fix.
 *
 * Kept narrow on purpose: a false positive marks a healthy workspace failed.
 */
const AUTH_PATTERNS = [
    /invalid api key/i,
    /please run\s*\/login/i,
    /run\s*`?\/login`?/i,
    /\blogin required\b/i,
    /authentication (failed|error|required)/i,
    /oauth (token )?(expired|revoked|invalid)/i,
    /(session|token|credentials) (has |have )?expired/i,
    /refresh token (is )?(expired|invalid)/i,
    /401 unauthorized/i,
    /\bunauthorized\b.*\b(token|api|auth)/i,
    /credit balance is too low/i,
];

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

/** Is ttyd up? Once it is, the terminal is reachable even if claude is not --
 * which is the only way a user can run /login to fix an expired token. */
function ttydRunning() {
    let entries;
    try { entries = fs.readdirSync('/proc'); } catch { return false; }
    for (const pid of entries) {
        if (!/^\d+$/.test(pid)) continue;
        let cmdline;
        try { cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; }
        if (/(^|\/)ttyd\0/.test(cmdline)) return true;
    }
    return false;
}

/**
 * The OAuth token as this pod sees it. Expiry is read, never validated against
 * the API: claude refreshes the token itself, and a network probe from a
 * readiness path would make the probe fail on an unrelated outage.
 */
function credentials() {
    let raw;
    try { raw = fs.readFileSync(CREDENTIALS_FILE, 'utf8'); } catch {
        return { present: false, expiresAt: null, expired: false };
    }
    let doc;
    try { doc = JSON.parse(raw); } catch {
        return { present: true, parseError: true, expiresAt: null, expired: false };
    }
    const oauth = doc.claudeAiOauth || doc.oauth || {};
    const expiresAt = Number(oauth.expiresAt) || null;
    return {
        present: true,
        expiresAt,
        expired: expiresAt !== null && expiresAt <= Date.now(),
        subscriptionType: oauth.subscriptionType || null,
        // A refresh token is what lets claude renew an expired access token on
        // its own, so "expired" alone is not yet a login failure.
        hasRefreshToken: Boolean(oauth.refreshToken),
    };
}

/** First pane line matching a known auth failure, or null. */
function paneAuthFailure(pane) {
    for (const line of pane.split('\n')) {
        if (AUTH_PATTERNS.some((re) => re.test(line))) return line.trim();
    }
    return null;
}

/**
 * Why claude is not running, when it should be. Returns an auth-failed result
 * or null. Checked before the relaunch ladder: retyping the launch command, or
 * restarting the container, cannot fix an expired login, and looping on it just
 * buries the one message the user needs to see.
 *
 * A pane message is conclusive immediately. The credentials file is only
 * circumstantial -- claude may simply not have started yet, and an
 * ANTHROPIC_API_KEY setup has no OAuth file at all -- so those verdicts wait
 * out a grace period and stand down entirely when an API key is present.
 */
const CRED_GRACE_MS = 30000;

/**
 * Keep this pod's copy of the shared login in step with S3.
 *
 * Two directions, and the second is the one that matters. Refresh tokens
 * rotate: when claude in *this* pod renews, the copy every other holder has --
 * including the one every new workspace bootstraps from -- is dead. Publishing
 * the renewal is what repairs that. Preventing pods from refreshing is not an
 * option; claude renews on its own schedule, inside a session we do not drive.
 * So the rule is the same everywhere: whoever refreshes publishes, and
 * everyone else adopts the newest.
 *
 * Driven off the readiness probe rather than its own timer -- the kubelet is
 * already calling every few seconds, and a second clock is one more thing to
 * get wrong. Fire-and-forget, so a slow bucket never delays a probe.
 *
 * `token push` is a no-op unless this pod's copy is strictly fresher, so the
 * usual cost of a pass is two reads. Under a read-only S3 key the push fails;
 * that is logged once per distinct error rather than every five minutes, and
 * is the reason AUTH_S3_BUCKET exists as a separate bucket.
 */
function maintainToken(force = false) {
    if (!TOKEN_SYNC || !process.env.S3_ENDPOINT) return;
    if (tokenSyncRunning) return;
    if (Date.now() - tokenSyncAt < (force ? TOKEN_SYNC_FORCE_MS : TOKEN_SYNC_MS)) return;
    tokenSyncAt = Date.now();
    tokenSyncRunning = true;

    const parse = (out) => { try { return JSON.parse(out); } catch { return {}; } };
    const opts = { timeout: 60000, encoding: 'utf8' };

    execFile('claude-config-sync', ['token', 'pull', '--json'], opts, (pullErr, pullOut) => {
        const adopted = Boolean(parse(pullOut).adopted);
        if (adopted) console.log('[agent] adopted a newer shared token from S3');

        execFile('claude-config-sync', ['token', 'push', '--json'], opts, (pushErr, pushOut) => {
            tokenSyncRunning = false;
            const published = Boolean(parse(pushOut).pushed);
            if (published) console.log('[agent] published this pod\'s token refresh to S3');

            const err = pullErr || pushErr;
            const message = err ? String(err.message).split('\n')[0].slice(0, 200) : null;
            // Same failure every five minutes is noise; a new one is news.
            if (message && message !== tokenSyncError) {
                console.warn(`[agent] token sync: ${message}`);
            }
            tokenSyncError = message;
            lastTokenSync = { at: new Date().toISOString(), adopted, published, error: message };
        });
    });
}

function authFailure(absentForMs = Infinity, pane = capturePane()) {
    const hit = paneAuthFailure(pane);
    if (hit) {
        return { reason: hit, detail: tail(pane) };
    }
    if (absentForMs < CRED_GRACE_MS || process.env.ANTHROPIC_API_KEY) return null;

    const creds = credentials();
    if (!creds.present) {
        // Step 0 of the ladder: another holder may have published a login
        // since this pod bootstrapped. Ask for it now -- the next probe
        // re-evaluates, and an adopted token clears this without a restart.
        maintainToken(true);
        return {
            reason: 'no Claude credentials in this workspace',
            detail: `${CREDENTIALS_FILE} is missing; run /login in the terminal, then `
                + '`claude-config-sync push` from the config shell.',
        };
    }
    if (creds.expired && !creds.hasRefreshToken) {
        maintainToken(true);
        return {
            reason: 'Claude OAuth token expired',
            detail: `token expired ${new Date(creds.expiresAt).toISOString()} and carries no `
                + 'refresh token; run /login in the terminal.',
        };
    }
    return null;
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
    const terminalReady = ttydRunning();

    if (stage === 'failed') {
        return { ready: false, stage: 'failed', terminalReady,
                 detail: tail(readFile(ERROR_FILE) || '') };
    }
    if (stage !== 'starting') {
        return { ready: false, stage, terminalReady, detail: null };
    }
    if (!tmuxSessionExists()) {
        return { ready: false, stage: 'starting', terminalReady,
                 detail: 'tmux session not created yet' };
    }

    if (claudeRemoteRunning()) {
        missingSince = null;
        launchingSince = null;
        relaunches = 0;
        if (!wasReadyOnce()) markReady();
        return { ready: true, stage: 'ready', terminalReady, detail: null };
    }

    // Claude is not running. Time the absence first, then ask whether a login
    // would fix it -- an auth failure is terminal, and neither relaunching in
    // the pane nor restarting the container clears it.
    if (wasReadyOnce()) {
        if (missingSince === null) missingSince = Date.now();
    } else if (launchingSince === null) {
        launchingSince = Date.now();
    }
    const absentSince = wasReadyOnce() ? missingSince : launchingSince;
    // One capture, reused: this runs on every 3s probe while claude is absent.
    const pane = capturePane();
    const auth = authFailure(Date.now() - absentSince, pane);
    if (auth) {
        return {
            ready: false,
            stage: 'auth-failed',
            terminalReady,
            reason: auth.reason,
            detail: auth.detail,
        };
    }

    // Ready once, gone now: a real regression. Not-ready immediately, and the
    // self-heal ladder starts. READY_FILE lives on the container layer, so a
    // container restart clears it and the pod re-proves readiness from scratch.
    if (wasReadyOnce()) {
        tryRelaunch();
        const secs = Math.round((Date.now() - missingSince) / 1000);
        return {
            ready: false,
            stage: 'session-lost',
            terminalReady,
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
    if (LAUNCH_FAILURE_RE.test(pane)) {
        return { ready: false, stage: 'failed', terminalReady, detail: tail(pane) };
    }

    // Claude has never come up and nothing in the pane says why. Left alone
    // this reads as "starting Claude..." indefinitely, so time it out into a
    // stage the UI shows as a failure with the pane attached.
    const waited = Date.now() - launchingSince;
    if (waited > LAUNCH_TIMEOUT_MS) {
        return {
            ready: false,
            stage: 'launch-failed',
            terminalReady,
            reason: `claude did not start within ${Math.round(waited / 1000)}s`,
            detail: tail(pane),
        };
    }
    return { ready: false, stage: 'starting', terminalReady, detail: tail(pane) };
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
    // A restart cannot log anybody in. Keep the container up so the user can
    // open the terminal and run /login; readiness already reports the failure.
    if (authFailure(Date.now() - (missingSince ?? 0))) {
        return { ok: true, reason: 'authentication required' };
    }
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
        credentials: credentials(),
        tokenSync: lastTokenSync,
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
        // Throttled and fire-and-forget: the probe answers from local state.
        maintainToken();
        const h = health();
        return send(res, h.ready ? 200 : 503, h);
    }

    if (path === '/disk') {
        const d = disk();
        return d ? send(res, 200, d) : send(res, 503, { error: 'df failed' });
    }

    if (path === '/session') return send(res, 200, session());

    // Token state only -- never the token. The dashboard polls this to warn
    // before a login expires rather than after a session mysteriously dies.
    if (path === '/auth') return send(res, 200, credentials());

    send(res, 404, { error: 'not found' });
}).listen(PORT, '0.0.0.0', () => {
    console.log(`[agent] listening on ${PORT}`);
});
