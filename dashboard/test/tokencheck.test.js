'use strict';

// The shared-login watchdog. An expired token here breaks every workspace
// started from now on, so the classification has to distinguish "claude will
// renew this itself" from "nobody can log in".

const test = require('node:test');
const assert = require('node:assert');

process.env.NAMESPACE = 'dev';

const { classify } = require('../lib/tokenCheck');

const NOW = Date.UTC(2026, 7, 27, 12, 0, 0);
const HOUR = 3600_000;
const DAY = 24 * HOUR;

function creds(oauth) { return { oauth }; }

test('a token with time left is valid and says nothing', () => {
    const r = classify(creds({ accessToken: 'a', refreshToken: 'r', expiresAt: NOW + 10 * DAY }),
                       { now: NOW });
    assert.equal(r.state, 'valid');
    assert.equal(r.message, null);
});

test('an expired token with a refresh token is stale, not broken', () => {
    // claude renews it inside each pod; what is stale is the copy in S3.
    const r = classify(creds({ accessToken: 'a', refreshToken: 'r', expiresAt: NOW - HOUR }),
                       { now: NOW });
    assert.equal(r.state, 'stale');
    assert.match(r.message, /push/);
});

test('an expired token with no refresh token blocks every new workspace', () => {
    const r = classify(creds({ accessToken: 'a', expiresAt: NOW - HOUR }), { now: NOW });
    assert.equal(r.state, 'expired');
    assert.match(r.message, /\/login/);
});

test('expiry inside the warning window warns early, only without a refresh token', () => {
    const soon = NOW + 2 * HOUR;
    assert.equal(classify(creds({ accessToken: 'a', expiresAt: soon }),
                          { now: NOW, warnMs: DAY }).state, 'expiring');
    // The renewable case is the normal one -- an access token always expires
    // within hours. Warning on it would pin the banner up forever.
    assert.equal(classify(creds({ accessToken: 'a', refreshToken: 'r', expiresAt: soon }),
                          { now: NOW, warnMs: DAY }).state, 'valid');
});

test('no expiry claim is unknown, never a confident "valid"', () => {
    const r = classify(creds({ accessToken: 'a' }), { now: NOW });
    assert.equal(r.state, 'unknown');
});

test('missing and unreadable credentials pass through as-is', () => {
    for (const state of ['missing', 'unreadable']) {
        const r = classify({ state, message: 'x' }, { now: NOW });
        assert.equal(r.state, state);
        assert.equal(r.checkedAt, new Date(NOW).toISOString());
    }
});

test('the verdict never carries the token itself', () => {
    const r = classify(creds({ accessToken: 'sk-secret', refreshToken: 'rt-secret',
                              expiresAt: NOW + DAY * 5 }), { now: NOW });
    assert.equal(JSON.stringify(r).includes('secret'), false);
    assert.equal(r.hasRefreshToken, true);
});
