'use strict';

const test = require('node:test');
const assert = require('node:assert');

const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MODULE = path.join(__dirname, '..', '..', 'shared', 'claude-config-sync',
                         'claude-config-sync');
const sync = require(MODULE);

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

// ---------------------------------------------------------------- the token

// The OAuth token used to be entry #3 of the bundle. It rotates every few
// hours on its own, so every refresh bumped manifest.json's version and made
// everyone else's push fail the staleness check for a change they did not
// make. Keeping it out is the point of the split.
test('the config bundle no longer carries the OAuth token', () => {
    const names = sync.FILES.map((f) => f.remote);
    assert.deepEqual(names, ['claude.json', 'settings.json', 'CLAUDE.md']);
    assert.ok(!names.includes(sync.LEGACY_CREDENTIALS_ENTRY),
        'credentials must not ride in the version-counted bundle');
});

// Expiry, not the generation counter, decides adoption: expiry is monotone
// under refresh, so a newer generation carrying an older token is a
// regression. Equal is a no-op, never a rewrite of the shared login.
test('only a strictly fresher token is adopted or published', () => {
    assert.equal(sync.isFresher(2000, 1000), true);
    assert.equal(sync.isFresher(1000, 1000), false);
    assert.equal(sync.isFresher(1000, 2000), false);
    // No local token at all: anything real beats nothing.
    assert.equal(sync.isFresher(1000, undefined), true);
    assert.equal(sync.isFresher(1000, null), true);
    // A malformed candidate never wins.
    assert.equal(sync.isFresher(undefined, 1000), false);
    assert.equal(sync.isFresher('nonsense', 1000), false);
});

test('a token object without a usable access token is rejected, not adopted', () => {
    const good = {
        generation: 4, expiresAt: 1700,
        credentials: { claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: 1700 } },
    };
    const parsed = sync.parseTokenObject(good, 'test');
    assert.equal(parsed.generation, 4);
    assert.equal(parsed.expiresAt, 1700);
    assert.equal(parsed.hasRefreshToken, true);

    for (const bad of [{}, { credentials: {} }, { credentials: { claudeAiOauth: {} } },
        { credentials: { claudeAiOauth: { refreshToken: 'r' } } }]) {
        assert.throws(() => sync.parseTokenObject(bad, 'test'), /no OAuth access token/);
    }
});

test('expiresAt falls back to the token claim when the envelope omits it', () => {
    const parsed = sync.parseTokenObject(
        { credentials: { claudeAiOauth: { accessToken: 'a', expiresAt: 99 } } }, 'test');
    assert.equal(parsed.expiresAt, 99);
    assert.equal(parsed.generation, 0);
    assert.equal(parsed.hasRefreshToken, false);
});

test('the auth object defaults into the config bucket and is redirectable', () => {
    const run = (env) => execFileSync(process.execPath,
        ['-e', "process.stdout.write(require(process.argv[1]).authPath())", MODULE],
        { encoding: 'utf8', env: { ...process.env, ...env } });

    // Default: same bucket, so an existing deployment keeps working with the
    // credentials it already has.
    assert.equal(run({ S3_BUCKET: 'claude-config', AUTH_S3_BUCKET: '', AUTH_S3_KEY: '' }),
        'cfg:claude-config/auth/token.json');

    // Garage grants key permissions per bucket, not per prefix -- a separate
    // bucket is the only way to let workspaces publish a token refresh while
    // staying read-only on the config.
    assert.equal(run({ S3_BUCKET: 'claude-config', AUTH_S3_BUCKET: 'claude-auth' }),
        'cfg:claude-auth/auth/token.json');
});

// A first `token push` runs against a bucket with no auth object at all, and
// "missing" does not always arrive as rclone's exit 4: the server can answer
// the GET in a way rclone reports as an empty body with exit 0. Reading that
// as data made the very first push fail with "Unexpected end of JSON input",
// and the obvious workaround -- hand-creating `{}` on the bucket -- then failed
// forever with "carries no OAuth access token", since the shape check refused
// the one operation that could have repaired the object.
test('token push works against an empty and against a junk remote object', () => {
    const fs = require('node:fs');
    const os = require('node:os');

    const run = (remoteBody) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpush-'));
        const bin = path.join(dir, 'bin');
        fs.mkdirSync(bin);
        fs.mkdirSync(path.join(dir, '.claude'));
        fs.writeFileSync(path.join(dir, '.claude', '.credentials.json'), JSON.stringify(
            { claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: 9000 } }));
        // rclone stands in for the remote: `cat` replays a fixture, `copyto`
        // captures what would have been published.
        fs.writeFileSync(path.join(bin, 'rclone'), [
            '#!/bin/sh',
            // rclone is called as: rclone --config <f> <op> <args...>',
            'op=$3; src=$4',
            `[ "$op" = cat ] && printf '%s' "$REMOTE_BODY" && exit 0`,
            `[ "$op" = copyto ] && cp "$src" "${path.join(dir, 'published.json')}" && exit 0`,
            'exit 0',
        ].join('\n'), { mode: 0o755 });

        const out = execFileSync(process.execPath,
            ['-e', 'process.stdout.write(JSON.stringify(require(process.argv[1]).tokenPush({})))',
             MODULE],
            { encoding: 'utf8',
              env: { ...process.env, HOME: dir, CLAUDE_CONFIG_DIR: path.join(dir, '.claude'),
                     PATH: `${bin}:${process.env.PATH}`, REMOTE_BODY: remoteBody,
                     S3_ENDPOINT: 'http://s3.test', S3_ACCESS_KEY_ID: 'k',
                     S3_SECRET_ACCESS_KEY: 's' } });
        return { result: JSON.parse(out),
                 published: JSON.parse(fs.readFileSync(path.join(dir, 'published.json'), 'utf8')) };
    };

    for (const [label, body] of [['absent', ''], ['junk', '{}'], ['tokenless', '{"generation":7}']]) {
        const { result, published } = run(body);
        assert.equal(result.pushed, true, `${label} remote must not block the push`);
        assert.equal(published.credentials.claudeAiOauth.accessToken, 'a');
        // The counter stays monotone even across a document we could not read.
        assert.equal(result.generation, body === '{"generation":7}' ? 8 : 1, label);
    }
});

// The reader stays strict where the writer is lenient: adopting a document we
// cannot parse is how one bad login spreads to every workspace.
test('an unreadable auth object is absent to a pull, never adopted', () => {
    const fs = require('node:fs');
    const os = require('node:os');

    const run = (remoteBody) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpull-'));
        const bin = path.join(dir, 'bin');
        fs.mkdirSync(bin);
        fs.writeFileSync(path.join(bin, 'rclone'),
            `#!/bin/sh\nprintf '%s' "$REMOTE_BODY"\n`, { mode: 0o755 });
        return execFileSync(process.execPath,
            ['-e', `const s = require(process.argv[1]);
                    try { process.stdout.write(JSON.stringify(s.tokenPull({}))); }
                    catch (e) { process.stdout.write(JSON.stringify({ error: e.message })); }`,
             MODULE],
            { encoding: 'utf8',
              env: { ...process.env, HOME: dir, CLAUDE_CONFIG_DIR: path.join(dir, '.claude'),
                     PATH: `${bin}:${process.env.PATH}`, REMOTE_BODY: remoteBody,
                     S3_ENDPOINT: 'http://s3.test', S3_ACCESS_KEY_ID: 'k',
                     S3_SECRET_ACCESS_KEY: 's' } });
    };

    // Empty reads as "no object yet", which is what lets a bootstrap fall back
    // to the legacy bundled credentials instead of failing.
    assert.deepEqual(JSON.parse(run('')), { adopted: false, reason: 'no remote token object' });
    // Present but unusable is an error, not silent adoption of nothing.
    assert.match(JSON.parse(run('{}')).error, /no OAuth access token/);
    assert.match(JSON.parse(run('not json')).error, /not valid JSON/);
});
