'use strict';

const fs = require('fs/promises');
const path = require('path');
const cfg = require('./config');
const { ValidationError } = require('./validate');

const PROFILE_ID_RE = /^[a-z0-9](?:[-a-z0-9]{0,30}[a-z0-9])?$/;
const CPU_RE = /^(?:[0-9]+(?:\.[0-9]+)?|[0-9]+m)$/;
const BYTES_RE = /^[0-9]+(?:\.[0-9]+)?(?:Ki|Mi|Gi|Ti|Pi|Ei|K|M|G|T|P|E)?$/;
const RESOURCE_NAMES = ['cpu', 'memory', 'ephemeral-storage'];

const seedProfile = Object.freeze({
    id: 'default',
    name: 'Default',
    description: 'Dashboard environment defaults',
    resources: cfg.workspaceResources,
});

let writeQueue = Promise.resolve();

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function cpuValue(value) {
    const text = String(value);
    return text.endsWith('m') ? Number(text.slice(0, -1)) : Number(text) * 1000;
}

function bytesValue(value) {
    const match = /^([0-9]+(?:\.[0-9]+)?)(Ki|Mi|Gi|Ti|Pi|Ei|K|M|G|T|P|E)?$/.exec(String(value));
    if (!match) return NaN;
    const binary = { Ki: 1, Mi: 2, Gi: 3, Ti: 4, Pi: 5, Ei: 6 };
    const decimal = { K: 1, M: 2, G: 3, T: 4, P: 5, E: 6 };
    const unit = match[2];
    const multiplier = unit in binary ? 1024 ** binary[unit]
        : unit in decimal ? 1000 ** decimal[unit] : 1;
    return Number(match[1]) * multiplier;
}

function quantity(value, field, pattern) {
    if (typeof value !== 'string' || value.length > 32 || !pattern.test(value)
        || Number.parseFloat(value) <= 0) {
        throw new ValidationError(`${field} must be a positive Kubernetes quantity`);
    }
    return value;
}

function validateProfile(id, input) {
    if (!PROFILE_ID_RE.test(String(id || ''))) {
        throw new ValidationError('profile id must be 1-32 lowercase letters, numbers, or hyphens');
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new ValidationError('profile body is required');
    }
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 60) throw new ValidationError('profile name must be 1-60 characters');
    const description = typeof input.description === 'string' ? input.description.trim() : '';
    if (description.length > 160) throw new ValidationError('profile description is too long');

    const requests = input.resources?.requests;
    const limits = input.resources?.limits;
    if (!requests || !limits) throw new ValidationError('profile requests and limits are required');

    const resources = { requests: {}, limits: {} };
    for (const key of RESOURCE_NAMES) {
        const pattern = key === 'cpu' ? CPU_RE : BYTES_RE;
        resources.requests[key] = quantity(requests[key], `requests.${key}`, pattern);
        resources.limits[key] = quantity(limits[key], `limits.${key}`, pattern);
        const parser = key === 'cpu' ? cpuValue : bytesValue;
        const requested = parser(resources.requests[key]);
        const limited = parser(resources.limits[key]);
        if (!Number.isFinite(requested) || !Number.isFinite(limited)) {
            throw new ValidationError(`${key} quantity is too large`);
        }
        if (requested > limited) {
            throw new ValidationError(`requests.${key} cannot exceed limits.${key}`);
        }
    }
    return { id, name, description, resources };
}

function initialState() {
    return { version: 1, defaultProfileId: seedProfile.id, profiles: [clone(seedProfile)] };
}

function validateState(value) {
    if (!value || value.version !== 1 || !Array.isArray(value.profiles) || !value.profiles.length) {
        throw new Error(`resource profile store at ${cfg.resourceProfilesPath} has an invalid shape`);
    }
    const profiles = value.profiles.map((profile) => validateProfile(profile.id, profile));
    const defaultProfileId = profiles.some((profile) => profile.id === value.defaultProfileId)
        ? value.defaultProfileId : profiles[0].id;
    return { version: 1, defaultProfileId, profiles };
}

async function writeState(state) {
    const target = cfg.resourceProfilesPath;
    await fs.mkdir(path.dirname(target), { recursive: true });
    const nonce = Math.random().toString(16).slice(2);
    const temporary = `${target}.${process.pid}.${Date.now()}.${nonce}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, target);
}

async function readState() {
    try {
        return validateState(JSON.parse(await fs.readFile(cfg.resourceProfilesPath, 'utf8')));
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        const state = initialState();
        await writeState(state);
        return state;
    }
}

function mutate(fn) {
    const operation = writeQueue.then(async () => {
        const state = await readState();
        const result = await fn(state);
        await writeState(state);
        return result;
    });
    writeQueue = operation.catch(() => {});
    return operation;
}

async function list() {
    await writeQueue;
    const state = await readState();
    return {
        profiles: clone(state.profiles).sort((a, b) => a.name.localeCompare(b.name)),
        defaultProfileId: state.defaultProfileId,
        persistence: 'pvc',
    };
}

async function get(id) {
    const state = await list();
    const profileId = id || state.defaultProfileId;
    const profile = state.profiles.find((item) => item.id === profileId);
    if (!profile) throw new ValidationError(`unknown resource profile "${profileId}"`);
    return clone(profile);
}

async function put(id, input) {
    const profile = validateProfile(id, input);
    return mutate((state) => {
        const index = state.profiles.findIndex((item) => item.id === id);
        if (index === -1) state.profiles.push(profile);
        else state.profiles[index] = profile;
        return clone(profile);
    });
}

async function setDefault(id) {
    return mutate((state) => {
        const profile = state.profiles.find((item) => item.id === id);
        if (!profile) throw new ValidationError(`unknown resource profile "${id}"`);
        state.defaultProfileId = id;
        return clone(profile);
    });
}

async function remove(id) {
    return mutate((state) => {
        const index = state.profiles.findIndex((profile) => profile.id === id);
        if (index === -1) return false;
        if (state.profiles.length === 1) {
            throw new ValidationError('at least one resource profile is required');
        }
        state.profiles.splice(index, 1);
        if (state.defaultProfileId === id) state.defaultProfileId = state.profiles[0].id;
        return true;
    });
}

module.exports = { list, get, put, setDefault, remove, validateProfile };
