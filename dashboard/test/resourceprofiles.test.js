'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

process.env.NAMESPACE = 'dev';
const storeDir = path.join(os.tmpdir(), `claude-resource-profiles-${process.pid}`);
process.env.RESOURCE_PROFILES_PATH = path.join(storeDir, 'profiles.json');

const profiles = require('../lib/resourceProfiles');

const large = {
    name: 'Large',
    description: 'Memory-heavy builds',
    resources: {
        requests: { cpu: '500m', memory: '2Gi', 'ephemeral-storage': '4Gi' },
        limits: { cpu: '4', memory: '8Gi', 'ephemeral-storage': '16Gi' },
    },
};

test.beforeEach(() => fs.rm(storeDir, { recursive: true, force: true }));
test.after(() => fs.rm(storeDir, { recursive: true, force: true }));

test('environment resources seed the initial default profile', async () => {
    const state = await profiles.list();
    assert.equal(state.persistence, 'pvc');
    assert.equal(state.defaultProfileId, 'default');
    assert.equal(state.profiles[0].resources.limits.memory, '4Gi');
});

test('profiles can be saved, selected as default, and deleted', async () => {
    await profiles.put('large', large);
    await profiles.setDefault('large');
    let state = await profiles.list();
    assert.equal(state.defaultProfileId, 'large');
    assert.equal((await profiles.get()).resources.limits.memory, '8Gi');

    assert.equal(await profiles.remove('large'), true);
    state = await profiles.list();
    assert.equal(state.defaultProfileId, 'default');
});

test('profile validation rejects unsafe ids and inverted resources', () => {
    assert.throws(() => profiles.validateProfile('Large!', large), /profile id/);
    assert.throws(() => profiles.validateProfile('bad', {
        ...large,
        resources: {
            ...large.resources,
            requests: { ...large.resources.requests, memory: '12Gi' },
        },
    }), /cannot exceed/);
});
