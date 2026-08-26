'use strict';

const crypto = require('crypto');

const PREFIX = 'claude-ws-';
const MAX_NAME = 63;          // DNS-1123 label AND k8s label-value limit
const HASH_LEN = 8;

/** Lowercase, [a-z0-9-] only, no leading/trailing dash, capped at `max`. */
function slug(value, max = MAX_NAME) {
    const s = String(value == null ? '' : value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+/, '')
        .slice(0, max)
        .replace(/-+$/, '');
    return s || 'x';
}

function hash8(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, HASH_LEN);
}

/**
 * Deterministic, collision-resistant object name for a workspace key.
 * Always <= 63 chars and valid as both a DNS-1123 name and a label value,
 * so it can be used verbatim as the PVC name, the Pod name, the /tty/<id>
 * route segment and the workspace-key label value.
 */
function workspaceId(key) {
    const room = MAX_NAME - PREFIX.length - HASH_LEN - 1;
    // Drop the host ("github.com/") so the readable part is owner-repo.
    const readable = slug(String(key).replace(/^[^/]+\//, ''), room);
    return `${PREFIX}${readable}-${hash8(key)}`;
}

const WORKSPACE_ID_RE = new RegExp(`^${PREFIX}[a-z0-9-]+-[0-9a-f]{${HASH_LEN}}$`);

function isWorkspaceId(value) {
    return typeof value === 'string' && value.length <= MAX_NAME && WORKSPACE_ID_RE.test(value);
}

/** Human-facing session name, e.g. "my-repo-feature-x". */
function sessionName(repoFullName, branch) {
    return `${slug(repoFullName.split('/').pop(), 30)}-${slug(branch, 30)}`;
}

module.exports = { slug, hash8, workspaceId, isWorkspaceId, sessionName, MAX_NAME };
