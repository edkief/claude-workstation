'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

test('an atomic write follows a symlink instead of replacing it', () => {
    // ~/.claude.json is a symlink onto the PVC. rename(2) replaces the link,
    // so a naive atomic write leaves a container-layer file and the pulled
    // auth is lost on the next pod start.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'configsync-'));
    const target = path.join(dir, 'claude.json');
    const link = path.join(dir, '.claude.json');
    fs.writeFileSync(target, '{}');
    fs.symlinkSync(target, link);

    sync.writeJsonAtomic(link, { oauthAccount: { emailAddress: 'a@b.c' } });

    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the symlink must survive');
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')),
        { oauthAccount: { emailAddress: 'a@b.c' } });
    fs.rmSync(dir, { recursive: true, force: true });
});

test('additive push policy covers exactly the extension directories', () => {
    assert.deepEqual([...sync.ADDITIVE].sort(), ['agents', 'commands', 'skills']);
});

test('rclone config targets S3-compatible servers, not AWS', () => {
    const saved = { ...process.env };
    Object.assign(process.env, {
        S3_ENDPOINT: 'https://garage.kieffer.me',
        S3_ACCESS_KEY_ID: 'GK123',
        S3_SECRET_ACCESS_KEY: 'shh',
    });
    delete process.env.S3_REGION;
    delete process.env.S3_PROVIDER;
    delete process.env.S3_FORCE_PATH_STYLE;

    const cfg = sync.rcloneConfigBody();
    assert.match(cfg, /^\[cfg\]$/m);
    assert.match(cfg, /^type = s3$/m);
    assert.match(cfg, /^endpoint = https:\/\/garage\.kieffer\.me$/m);
    assert.match(cfg, /^access_key_id = GK123$/m);
    assert.match(cfg, /^secret_access_key = shh$/m);
    // Garage serves endpoint/bucket/key, not bucket.endpoint/key.
    assert.match(cfg, /^force_path_style = true$/m);
    // rclone has no `Garage` provider value; `Other` is the generic one.
    assert.match(cfg, /^provider = Other$/m);
    // Region is part of the SigV4 credential scope and must match garage.toml.
    assert.match(cfg, /^region = garage$/m);
    assert.match(cfg, /^env_auth = false$/m);

    process.env = saved;
});

test('every S3 setting is overridable', () => {
    const saved = { ...process.env };
    Object.assign(process.env, {
        S3_ENDPOINT: 'http://minio:9000',
        S3_ACCESS_KEY_ID: 'k',
        S3_SECRET_ACCESS_KEY: 's',
        S3_REGION: 'eu-central',
        S3_PROVIDER: 'Minio',
        S3_FORCE_PATH_STYLE: 'false',
    });
    const cfg = sync.rcloneConfigBody();
    assert.match(cfg, /^region = eu-central$/m);
    assert.match(cfg, /^location_constraint = eu-central$/m);
    assert.match(cfg, /^provider = Minio$/m);
    assert.match(cfg, /^force_path_style = false$/m);
    process.env = saved;
});

test('the three mandatory S3 settings are enforced', () => {
    const saved = { ...process.env };
    for (const missing of ['S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) {
        Object.assign(process.env, {
            S3_ENDPOINT: 'http://x', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's',
        });
        delete process.env[missing];
        assert.equal(sync.isConfigured(), false, `${missing} should be required`);
        assert.throws(() => sync.rcloneConfigBody(), /must be set/, missing);
    }
    process.env = saved;
});

// A bucket that says "no" and a bucket that is empty must never look alike:
// conflating them made `pull` print "nothing to pull" and exit 0 on an auth
// failure, and made `push` skip its version check and clobber the remote.
test('only rclone not-found is treated as a missing object', () => {
    assert.equal(sync.isMissing(3, 'directory not found'), true);
    assert.equal(sync.isMissing(4, 'object not found'), true);
    assert.equal(sync.isMissing(1, "Failed to cat: the object doesn't exist"), true);

    assert.equal(sync.isMissing(1, 'SignatureDoesNotMatch: request signature mismatch'), false);
    assert.equal(sync.isMissing(1, 'AccessDenied: forbidden'), false);
    assert.equal(sync.isMissing(5, 'temporary error: connection refused'), false);
    assert.equal(sync.isMissing(7, 'fatal error'), false);
    assert.equal(sync.isMissing(null, 'spawn rclone ENOENT'), false);
});
