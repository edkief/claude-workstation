'use strict';

// The auto-refresh loop. What matters here is not that it renews -- that needs
// a real expiring token and a real backend -- but that its failure modes are
// the safe ones: the kill switch spawns nothing, the token-spending rung stays
// a fallback, and a mistuned interval cannot skip the refresh window.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

process.env.NAMESPACE = 'dev';

const LIB = path.join(__dirname, '..', 'lib');

function inChild(script, env) {
    return execFileSync(process.execPath, ['-e', script], {
        encoding: 'utf8',
        env: { ...process.env, NAMESPACE: 'dev', ...env },
    }).trim();
}

test('the free trigger comes first; only the fallback rung spends tokens', () => {
    const { RUNGS } = require('../lib/tokenRefresh');

    // `claude -p /usage` reaches the backend without invoking a model, so the
    // routine path costs nothing. The prompt rung exists only for the case
    // where /usage turns out not to exercise the auth path.
    assert.equal(RUNGS[0].name, 'usage');
    assert.equal(RUNGS[0].costsTokens, false);
    assert.deepEqual(RUNGS[0].args, ['-p', '/usage']);

    assert.equal(RUNGS.length, 2);
    assert.equal(RUNGS[1].costsTokens, true);
    assert.equal(RUNGS.filter((r) => r.costsTokens).length, 1);
});

test('TOKEN_AUTO_REFRESH=0 restores the report-only watchdog and spawns nothing', () => {
    // PATH is emptied: if the loop tried to run claude or claude-config-sync
    // despite the kill switch, the spawn would fail and the action would be
    // anything but "disabled".
    const out = inChild(
        `require(${JSON.stringify(path.join(LIB, 'tokenRefresh'))})`
        + '.maintain().then((r) => console.log(JSON.stringify(r)));',
        { TOKEN_AUTO_REFRESH: '0', PATH: '/nonexistent' });

    const result = JSON.parse(out);
    assert.equal(result.action, 'disabled');
    assert.equal(result.ok, true);
});

test('the refresh lead is clamped so the window cannot fall between two ticks', () => {
    const read = (env) => JSON.parse(inChild(
        `const c = require(${JSON.stringify(path.join(LIB, 'config'))});`
        + 'console.log(JSON.stringify({ lead: c.tokenRefreshLeadMs, tick: c.tokenTriggerMs }));',
        env));

    // A lead shorter than two ticks would let a token slide from "not yet due"
    // straight to expired without ever being seen as due.
    assert.deepEqual(read({ TOKEN_TRIGGER_MS: '600000', TOKEN_REFRESH_LEAD_MS: '60000' }),
        { lead: 1_200_000, tick: 600_000 });

    // A generous lead is left alone.
    assert.deepEqual(read({ TOKEN_TRIGGER_MS: '600000', TOKEN_REFRESH_LEAD_MS: '7200000' }),
        { lead: 7_200_000, tick: 600_000 });
});

test('the reported state never carries the token itself', () => {
    const { state } = require('../lib/tokenRefresh');
    const json = JSON.stringify(state());
    for (const leak of ['accessToken', 'refreshToken', 'sk-ant', 'credentials']) {
        assert.ok(!json.includes(leak), `${leak} must not appear in the refresh state`);
    }
});
