'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const cfg = require('./config');

const HOME = process.env.HOME || os.homedir();
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const CREDENTIALS_FILE = path.join(CLAUDE_DIR, '.credentials.json');

/**
 * Is the shared Claude login still good?
 *
 * This is the credentials file that `claude-config-sync push` distributes and
 * every *new* workspace pulls at bootstrap, so when it goes bad the failure
 * mode is "every session started from now on cannot log in" -- previously
 * visible only as a workspace stuck on "starting Claude…".
 *
 * Deliberately an offline check of the token's own expiry claim rather than a
 * live call to Anthropic:
 *  - the OAuth token here is not an API key; there is no documented, stable
 *    "validate me" endpoint that does not either spend tokens or rotate the
 *    credential (a refresh call issues a new token and invalidates this one,
 *    which would be a genuinely destructive health check);
 *  - a network probe turns any upstream blip into a false alarm on a page whose
 *    whole job is to be trusted.
 *
 * An expired access token with a refresh token is `stale`, not `expired`:
 * claude renews it by itself, and the renewal never makes it back into S3
 * unless somebody pushes. That is worth a nudge, not an alarm.
 */
function readCredentials(file = CREDENTIALS_FILE) {
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
        return err.code === 'ENOENT'
            ? { state: 'missing', message: `no shared Claude credentials at ${file}` }
            : { state: 'unreadable', message: `cannot read ${file}: ${err.message}` };
    }

    let doc;
    try {
        doc = JSON.parse(raw);
    } catch {
        return { state: 'unreadable', message: `${file} is not valid JSON` };
    }

    const oauth = doc.claudeAiOauth || doc.oauth || null;
    if (!oauth || !(oauth.accessToken || oauth.refreshToken)) {
        return { state: 'missing', message: 'credentials file holds no OAuth token' };
    }
    return { oauth };
}

/** Classify a parsed credentials doc. `now` is injectable for tests. */
function classify(parsed, { now = Date.now(), warnMs = cfg.tokenWarnMs } = {}) {
    if (parsed.state) return { ...parsed, checkedAt: new Date(now).toISOString() };

    const { oauth } = parsed;
    const expiresAt = Number(oauth.expiresAt) || null;
    const hasRefreshToken = Boolean(oauth.refreshToken);
    const base = {
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        expiresInMs: expiresAt ? expiresAt - now : null,
        hasRefreshToken,
        subscriptionType: oauth.subscriptionType || null,
        scopes: Array.isArray(oauth.scopes) ? oauth.scopes : [],
        checkedAt: new Date(now).toISOString(),
    };

    if (expiresAt === null) {
        // No expiry claim: nothing to check, and saying "valid" would be a lie.
        return { ...base, state: 'unknown', message: 'token carries no expiry' };
    }
    if (expiresAt <= now) {
        return hasRefreshToken
            // Refresh tokens rotate: whichever pod last renewed this login may
            // already have consumed the one in this copy, so a new workspace
            // pulling it can fail to log in. Worth a nudge, not an alarm.
            ? { ...base,
                state: 'stale',
                message: 'the shared token is expired; its refresh token may already have been '
                    + 'rotated by a running workspace — run `claude-config-sync push` from the '
                    + 'config shell to distribute a current one' }
            : { ...base,
                state: 'expired',
                message: 'shared Claude token expired and has no refresh token; new workspaces '
                    + 'cannot log in — run /login, then push the config' };
    }
    // Only warn ahead of expiry when nothing can renew it. An access token
    // with hours left and a refresh token beside it is the *normal* state --
    // warning on that would leave the banner up permanently, which is the
    // fastest way to teach someone to ignore it.
    if (!hasRefreshToken && expiresAt - now <= warnMs) {
        return { ...base,
            state: 'expiring',
            message: `shared Claude token expires ${new Date(expiresAt).toISOString()} and has `
                + 'no refresh token; run /login and push the config before then' };
    }
    return { ...base, state: 'valid', message: null };
}

const OK_STATES = new Set(['valid', 'unknown']);

let last = null;
let timer = null;

function check({ now = Date.now(), file = CREDENTIALS_FILE } = {}) {
    last = classify(readCredentials(file), { now });
    if (!OK_STATES.has(last.state)) {
        console.warn(`[dashboard] claude token check: ${last.state} — ${last.message}`);
    }
    return last;
}

/** Cached result; checks on first call and whenever the cron has not run yet. */
function status() {
    return last || check();
}

/**
 * The "cron" the dashboard runs. An in-process interval rather than a
 * Kubernetes CronJob: a CronJob would need somewhere to write its verdict, and
 * the dashboard already holds the working copy of the shared config.
 */
function start(intervalMs = cfg.tokenCheckMs) {
    if (timer || intervalMs <= 0) return timer;
    check();
    timer = setInterval(check, intervalMs);
    timer.unref?.();
    return timer;
}

function stop() {
    if (timer) clearInterval(timer);
    timer = null;
}

module.exports = { classify, readCredentials, check, status, start, stop,
                   CREDENTIALS_FILE, OK_STATES };
