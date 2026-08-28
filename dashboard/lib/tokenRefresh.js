'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const cfg = require('./config');
const tokenCheck = require('./tokenCheck');

/**
 * Keep the shared Claude login fresh, and publish every renewal.
 *
 * `tokenCheck` answers "is the shared login still good?" and stops there, on
 * the grounds that a refresh call rotates the credential and so is a
 * destructive health check. That is right for a watchdog and wrong as a
 * conclusion: rotation is not a reason to avoid refreshing, it is a reason
 * that whoever refreshes must publish the result. Without that, the loop was
 * a human one -- open a pod, refresh by hand, push the config.
 *
 * The renewal is performed by Claude Code itself, not by calling the OAuth
 * endpoint directly. The direct call's only advantage is choosing the moment,
 * which would matter if the dashboard had to win a race against pods; it does
 * not, because the invariant is "whoever refreshes publishes, everyone adopts
 * the newest" and nobody needs to be first. What is left of the direct call is
 * an undocumented endpoint and a hardcoded client id guarding a credential
 * whose corruption locks every workspace out at once.
 *
 * So the trigger is a two-rung ladder of supported surfaces:
 *
 *   1. `claude -p /usage` -- reaches the backend (it returns live plan-usage
 *      figures, which cannot come from a cache: `claude auth status` by
 *      contrast is served from .claude.json's cached oauthAccount and never
 *      touches the network) while invoking no model, so it spends no tokens
 *      and consumes none of the session quota it reports.
 *   2. a one-line prompt -- an unambiguous model call, for the case where
 *      /usage turns out not to exercise the auth path. It costs a handful of
 *      tokens, so it only fires inside the deadline window.
 *
 * Nothing here writes the credentials file. It runs a trigger and then looks
 * at whether `expiresAt` advanced; the write is Claude Code's own. That is
 * what makes a failed trigger harmless -- the previous credential is still
 * there, and the watchdog's banner is still the fallback.
 */

const HOME = process.env.HOME || os.homedir();
const CLAUDE_JSON = process.env.CLAUDE_JSON_PATH || path.join(HOME, '.claude.json');

const RUNGS = [
    { name: 'usage', args: ['-p', '/usage'], costsTokens: false },
    { name: 'prompt', args: ['-p', 'Reply with the single word: ok'], costsTokens: true },
];

let last = { action: 'never-run', ok: null, at: null };
let running = false;
let timer = null;

function record(entry) {
    last = { ...entry, at: new Date().toISOString() };
    if (last.ok === false) {
        console.warn(`[dashboard] token refresh: ${last.action} — ${last.message || ''}`);
    } else if (last.action !== 'fresh' && last.action !== 'disabled') {
        console.log(`[dashboard] token refresh: ${last.action}`
            + (last.generation ? ` (generation ${last.generation})` : ''));
    }
    return last;
}

function run(file, args, { cwd } = {}) {
    return new Promise((resolve) => {
        execFile(file, args, {
            cwd,
            timeout: cfg.tokenTriggerTimeoutMs,
            killSignal: 'SIGKILL',
            encoding: 'utf8',
            maxBuffer: 4 * 1024 * 1024,
        }, (err, stdout, stderr) => resolve({
            code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
            timedOut: Boolean(err && err.killed),
            stdout: stdout || '',
            stderr: stderr || '',
        }));
    });
}

async function configSync(args) {
    const result = await run('claude-config-sync', args);
    let parsed = null;
    try { parsed = JSON.parse(result.stdout); } catch { /* not JSON: use the text */ }
    return { ...result, parsed };
}

function detail(result) {
    if (result.timedOut) return `timed out after ${cfg.tokenTriggerTimeoutMs}ms`;
    return (result.stderr || result.stdout || `exit ${result.code}`).trim().slice(0, 400);
}

/** Local expiry and renewability. Never returns the token itself. */
function localToken() {
    const parsed = tokenCheck.readCredentials();
    if (parsed.state) return null;
    return {
        expiresAt: Number(parsed.oauth.expiresAt) || 0,
        hasRefreshToken: Boolean(parsed.oauth.refreshToken),
    };
}

/**
 * `claude -p` in an untrusted directory blocks on the trust dialog, which
 * non-interactively is a hang until the timeout. Seed the trust entry the way
 * workspace pods do; `mergeClaudeJson` preserves `projects` across a config
 * pull, so this survives every sync.
 *
 * Written only when actually missing: .claude.json is also written by claude
 * itself, and this process has no business racing it every ten minutes.
 */
function ensureWorkdir() {
    const dir = cfg.tokenRefreshDir;
    fs.mkdirSync(dir, { recursive: true });

    let doc = {};
    try { doc = JSON.parse(fs.readFileSync(CLAUDE_JSON, 'utf8')); } catch { /* new file */ }
    if (doc.projects?.[dir]?.hasTrustDialogAccepted) return dir;

    doc.projects = doc.projects || {};
    doc.projects[dir] = { ...(doc.projects[dir] || {}), hasTrustDialogAccepted: true };
    const tmp = `${CLAUDE_JSON}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
    fs.renameSync(tmp, CLAUDE_JSON);
    return dir;
}

/** Publish our copy if it is the fresher one. Idempotent: the CLI re-checks. */
async function publish(action, expiresAt) {
    const pushed = await configSync(['token', 'push', '--json']);
    tokenCheck.check();
    if (pushed.code !== 0) {
        return record({ ok: false, action, published: false,
                        expiresAt: new Date(expiresAt).toISOString(),
                        message: `token push failed: ${detail(pushed)}` });
    }
    return record({ ok: true, action,
                    published: Boolean(pushed.parsed?.pushed),
                    generation: pushed.parsed?.generation ?? null,
                    expiresAt: new Date(expiresAt).toISOString() });
}

async function cycle(reason, force) {
    // Adopt anything newer somebody else published -- the "everyone else
    // adopts" half of the invariant. A pod that was forced to refresh has
    // already rotated our refresh token, so its copy is the only live one.
    const pulled = await configSync(['token', 'pull', '--json']);
    if (pulled.parsed?.adopted) {
        tokenCheck.check();
        return record({ ok: true, action: 'adopted', reason,
                        generation: pulled.parsed.generation });
    }
    if (pulled.code !== 0) {
        // Not fatal: a remote we cannot read is no reason to let our own copy
        // expire. Refresh anyway and try to publish at the end.
        console.warn(`[dashboard] token pull failed: ${detail(pulled)}`);
    }

    const local = localToken();
    if (!local) {
        return record({ ok: false, action: 'no-credentials', reason,
                        message: 'no shared credentials to refresh; run /login in the config shell' });
    }
    // Nothing here can renew a token with no refresh token. That is a /login,
    // and the watchdog already says so.
    if (!local.hasRefreshToken) {
        return record({ ok: true, action: 'not-renewable', reason });
    }

    const remaining = local.expiresAt - Date.now();
    if (!force && remaining > cfg.tokenRefreshLeadMs) {
        // Too early to renew -- but our copy may still be ahead of the remote,
        // e.g. a refresh last tick whose publish failed. Retry that.
        const status = await configSync(['token', 'status', '--json']);
        if (status.parsed?.ahead) return publish('republish', local.expiresAt);
        return record({ ok: true, action: 'fresh', reason,
                        expiresAt: new Date(local.expiresAt).toISOString() });
    }

    const attempts = [];
    for (const rung of RUNGS) {
        // The token-spending rung is the fallback, not the routine path.
        if (rung.costsTokens && !force && remaining > cfg.tokenRefreshDeadlineMs) break;

        const result = await run('claude', rung.args, { cwd: ensureWorkdir() });
        const after = localToken();
        if (after && after.expiresAt > local.expiresAt) {
            return publish(`refreshed:${rung.name}`, after.expiresAt);
        }
        attempts.push(`${rung.name}: ${result.code === 0 ? 'no renewal' : detail(result)}`);
    }

    return record({ ok: false, action: 'refresh-failed', reason,
                    expiresAt: new Date(local.expiresAt).toISOString(),
                    message: `the shared token was not renewed (${attempts.join('; ')})` });
}

/** One maintenance pass. Serialised: a slow trigger must not stack up. */
async function maintain({ reason = 'tick', force = false } = {}) {
    // `force` is the manual button: renew even when the token is not yet due,
    // and let the fallback rung fire. Never taken by the timer.
    if (!cfg.tokenAutoRefresh && !force) {
        return record({ ok: true, action: 'disabled', reason });
    }
    if (running) return last;
    running = true;
    try {
        return await cycle(reason, force);
    } catch (err) {
        return record({ ok: false, action: 'error', reason, message: err.message });
    } finally {
        running = false;
    }
}

function state() {
    return {
        enabled: cfg.tokenAutoRefresh,
        running,
        intervalMs: cfg.tokenTriggerMs,
        leadMs: cfg.tokenRefreshLeadMs,
        last,
    };
}

function start(intervalMs = cfg.tokenTriggerMs) {
    if (timer || !cfg.tokenAutoRefresh || intervalMs <= 0) return timer;
    maintain({ reason: 'boot' });
    timer = setInterval(() => maintain({ reason: 'tick' }), intervalMs);
    timer.unref?.();
    return timer;
}

function stop() {
    if (timer) clearInterval(timer);
    timer = null;
}

module.exports = { maintain, state, start, stop, RUNGS };
