'use strict';

/**
 * These values become pod env vars, label values and annotations. The dashboard
 * no longer builds shell strings, so this is defence in depth rather than the
 * only barrier -- but rejecting exotic git transports here still matters:
 * `ext::sh -c ...` remote helpers are a live git RCE class.
 */

const REPO_URL_RE =
    /^(?:git@github\.com:|https:\/\/github\.com\/)[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:\.git)?$/;

class ValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ValidationError';
        this.statusCode = 400;
    }
}

function validateRepoUrl(value) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new ValidationError('project is required');
    }
    const url = value.trim();
    if (url.length > 300) throw new ValidationError('project URL is too long');
    if (!REPO_URL_RE.test(url)) {
        throw new ValidationError(
            'project must be a GitHub URL of the form git@github.com:owner/repo.git ' +
            'or https://github.com/owner/repo');
    }
    return url;
}

/** Mirrors the rules in `git check-ref-format`. */
function validateBranch(value, field = 'branch') {
    if (typeof value !== 'string' || !value.trim()) {
        throw new ValidationError(`${field} is required`);
    }
    const ref = value.trim();
    const reject = (why) => { throw new ValidationError(`invalid ${field}: ${why}`); };

    if (ref.length > 200) reject('too long');
    if (ref.startsWith('-')) reject('must not start with "-"');
    if (ref.startsWith('/') || ref.endsWith('/')) reject('must not start or end with "/"');
    if (ref.endsWith('.') || ref.endsWith('.lock')) reject('must not end with "." or ".lock"');
    if (ref.includes('..') || ref.includes('//') || ref.includes('@{')) reject('contains an illegal sequence');
    if (/[\x00-\x20\x7f~^:?*[\\]/.test(ref)) reject('contains an illegal character');
    return ref;
}

function validateOptionalBranch(value, field) {
    if (value === undefined || value === null || value === '') return null;
    return validateBranch(value, field);
}

/** owner/name, as accepted by GET /api/branches. */
function validateRepoFullName(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value.trim())) {
        throw new ValidationError('repo must be of the form owner/name');
    }
    return value.trim();
}

module.exports = {
    ValidationError,
    validateRepoUrl,
    validateBranch,
    validateOptionalBranch,
    validateRepoFullName,
};
