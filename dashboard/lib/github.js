'use strict';

const cfg = require('./config');

function headers() {
    const h = { 'User-Agent': 'berth-dashboard', Accept: 'application/vnd.github+json' };
    if (cfg.githubToken) h.Authorization = `Bearer ${cfg.githubToken}`;
    return h;
}

/** Follow pagination until a short page comes back. */
async function paginate(urlFor, map) {
    const out = [];
    for (let page = 1; page <= 20; page++) {
        const res = await fetch(urlFor(page), { headers: headers() });
        if (!res.ok) {
            if (page === 1) {
                throw new Error(`GitHub API returned ${res.status} ${res.statusText}`);
            }
            break;                  // partial results beat an error mid-listing
        }
        const data = await res.json();
        if (!Array.isArray(data) || !data.length) break;
        out.push(...data.map(map));
        if (data.length < 100) break;
    }
    return out;
}

/**
 * With a token: every repo the token can reach. Without: that user's public repos.
 */
async function listRepos() {
    const authed = !!cfg.githubToken;
    return paginate(
        (page) => (authed
            ? 'https://api.github.com/user/repos?per_page=100&sort=pushed' +
              `&affiliation=owner,collaborator,organization_member&page=${page}`
            : `https://api.github.com/users/${cfg.githubUser}/repos?per_page=100&sort=pushed&page=${page}`),
        (repo) => ({
            name: repo.name,
            fullName: repo.full_name,
            sshUrl: repo.ssh_url,
            private: repo.private,
            description: repo.description,
            defaultBranch: repo.default_branch,
        }),
    );
}

async function listBranches(repoFullName) {
    return paginate(
        (page) => `https://api.github.com/repos/${encodeURI(repoFullName)}/branches?per_page=100&page=${page}`,
        (b) => b.name,
    );
}

module.exports = { listRepos, listBranches };
