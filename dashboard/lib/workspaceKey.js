'use strict';

/**
 * Canonical identity of a workspace.
 *
 * TODAY: one PVC per repo, shared across branches.
 * To move to one PVC per repo+branch, change the return of workspaceKey() to
 *   `${repoId(repoUrl)}#${branch}`
 * and nothing else in the codebase needs to change: the key flows into
 * naming.workspaceId(), which names the PVC, the Pod, and the /tty/<id> route.
 */

/**
 * Normalise a git remote to a stable, lowercase identity.
 *   git@github.com:Edkief/My.Repo.git   -> github.com/edkief/my.repo
 *   https://github.com/Edkief/My.Repo   -> github.com/edkief/my.repo
 */
function repoId(repoUrl) {
    const url = String(repoUrl).trim();
    let host;
    let path;

    const scp = /^(?:([^@]+)@)?([^:/]+):(.+)$/.exec(url);
    if (scp && !url.includes('://')) {
        host = scp[2];
        path = scp[3];
    } else {
        const m = /^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(url);
        if (!m) throw new Error(`unrecognised git URL: ${repoUrl}`);
        host = m[1];
        path = m[2];
    }

    path = path.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
    return `${host.toLowerCase()}/${path.toLowerCase()}`;
}

function workspaceKey({ repoUrl /* , branch */ }) {
    return repoId(repoUrl);
}

/** owner/name, preserving the original casing, for display. */
function repoFullName(repoUrl) {
    const id = repoId(repoUrl);
    return id.split('/').slice(1).join('/');
}

module.exports = { repoId, workspaceKey, repoFullName };
