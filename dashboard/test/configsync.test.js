'use strict';

const test = require('node:test');
const assert = require('node:assert');

const sync = require('../../shared/claude-config-sync/claude-config-sync');

test('push strips machine-specific and cache keys from .claude.json', () => {
    const local = {
        oauthAccount: { email: 'a@b.c' },
        mcpServers: { playwright: {} },
        hasCompletedOnboarding: true,
        installMethod: 'npm',
        projects: { '/workspace/main': { hasTrustDialogAccepted: true } },
        machineID: 'abc',
        remoteControlMachineId: 'def',
        userID: 'uid',
        numStartups: 41,
        cachedGrowthBookFeatures: { x: 1 },
        additionalModelCostsCache: {},
        passesUpsellSeenCount: 3,
        changelogLastFetched: 123,
    };
    const stripped = sync.stripClaudeJson(local);

    // Portable identity and settings travel.
    assert.deepEqual(stripped.oauthAccount, { email: 'a@b.c' });
    assert.deepEqual(stripped.mcpServers, { playwright: {} });
    assert.equal(stripped.hasCompletedOnboarding, true);
    assert.equal(stripped.installMethod, 'npm');

    // Machine-specific state and caches do not.
    for (const k of ['projects', 'machineID', 'remoteControlMachineId', 'userID',
        'numStartups', 'cachedGrowthBookFeatures', 'additionalModelCostsCache',
        'passesUpsellSeenCount', 'changelogLastFetched']) {
        assert.ok(!(k in stripped), `${k} must be stripped`);
    }
});

test('pull merges remote over local but never drops the local trust map', () => {
    const local = {
        projects: { '/workspace/feature-x': { hasTrustDialogAccepted: true } },
        machineID: 'local-machine',
        mcpServers: {},
    };
    const remote = { mcpServers: { playwright: { command: 'npx' } }, oauthAccount: { email: 'a@b.c' } };

    const merged = sync.mergeClaudeJson(local, remote);

    // The pod's own trust entry is what lets Claude start without a dialog.
    assert.deepEqual(merged.projects, { '/workspace/feature-x': { hasTrustDialogAccepted: true } });
    assert.equal(merged.machineID, 'local-machine');
    assert.deepEqual(merged.mcpServers, { playwright: { command: 'npx' } });
    assert.deepEqual(merged.oauthAccount, { email: 'a@b.c' });
});

test('a strip/merge round-trip is stable and keeps the local trust map', () => {
    const authoring = { mcpServers: { p: {} }, oauthAccount: { email: 'a@b.c' },
        projects: { '/authoring/dir': {} }, machineID: 'author' };
    const published = sync.stripClaudeJson(authoring);
    const consumer = { projects: { '/workspace/main': { hasTrustDialogAccepted: true } } };

    const merged = sync.mergeClaudeJson(consumer, published);
    assert.deepEqual(merged.projects, { '/workspace/main': { hasTrustDialogAccepted: true } });
    assert.ok(!('machineID' in merged), 'author machine id must not leak to consumers');
    assert.deepEqual(sync.stripClaudeJson(merged), published);
});

test('additive push policy covers exactly the extension directories', () => {
    assert.deepEqual([...sync.ADDITIVE].sort(), ['agents', 'commands', 'skills']);
});
