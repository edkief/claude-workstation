'use strict';

const express = require('express');
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const STATE_FILE = process.env.STATE_FILE || '/home/ubuntu/.claude-sessions/state.json';
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || '/home/ubuntu/workspace';
const SESSIONS_ROOT = path.join(WORKSPACE_ROOT, 'sessions');
const GITHUB_USER = process.env.GITHUB_USER || 'edkief';

function readState() {
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch {
        return [];
    }
}

function writeState(sessions) {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(sessions, null, 2));
    fs.renameSync(tmp, STATE_FILE);
}

function sessionAlive(byobuSession) {
    const result = spawnSync('tmux', ['has-session', '-t', byobuSession], { stdio: 'pipe' });
    return result.status === 0;
}

function repoNameFromUrl(url) {
    return path.basename(url, '.git').replace(/[^a-zA-Z0-9_-]/g, '-');
}

function timestamp() {
    return new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
}

function buildProcessTree() {
    // rss is in KB; %cpu is percentage of one core (100% = 1000m)
    const r = spawnSync('ps', ['-e', '-o', 'pid=,ppid=,%cpu=,rss=', '--no-headers'], { stdio: 'pipe' });
    const processMap = new Map();
    const children = new Map();
    if (r.status !== 0) return { processMap, children };
    for (const line of r.stdout.toString().split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 4) continue;
        const pid = parseInt(parts[0], 10);
        const ppid = parseInt(parts[1], 10);
        const cpu = parseFloat(parts[2]);
        const rssKb = parseInt(parts[3], 10);
        if (isNaN(pid) || isNaN(ppid)) continue;
        processMap.set(pid, { cpu, rssKb });
        if (!children.has(ppid)) children.set(ppid, []);
        children.get(ppid).push(pid);
    }
    return { processMap, children };
}

function subtreeSum(rootPid, processMap, children) {
    let cpu = 0, rssKb = 0;
    const stack = [rootPid];
    while (stack.length) {
        const pid = stack.pop();
        const proc = processMap.get(pid);
        if (proc) { cpu += proc.cpu; rssKb += proc.rssKb; }
        const kids = children.get(pid);
        if (kids) stack.push(...kids);
    }
    return { cpu: +cpu.toFixed(2), rssKb };
}

function getSessionPids(byobuSession) {
    const r = spawnSync('tmux', ['list-panes', '-s', '-t', byobuSession, '-F', '#{pane_pid}'], { stdio: 'pipe' });
    if (r.status !== 0) return [];
    return r.stdout.toString().trim().split('\n').map(Number).filter(n => !isNaN(n) && n > 0);
}

// GET /api/info — static workstation metadata
app.get('/api/info', (req, res) => {
    res.json({ podName: process.env.POD_NAME || 'unknown' });
});

// GET /api/repos — list all repos accessible to the authenticated user.
// With GITHUB_TOKEN: uses /user/repos (all personal + org repos the token can access).
// Without token: falls back to /users/{user}/repos (public repos only).
app.get('/api/repos', async (req, res) => {
    try {
        const headers = { 'User-Agent': 'claude-workstation' };
        const authed = !!process.env.GITHUB_TOKEN;
        if (authed) headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;

        const repos = [];
        let page = 1;
        while (true) {
            const url = authed
                ? `https://api.github.com/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member&page=${page}`
                : `https://api.github.com/users/${GITHUB_USER}/repos?per_page=100&sort=pushed&page=${page}`;
            const r = await fetch(url, { headers });
            if (!r.ok) break;
            const data = await r.json();
            if (!data.length) break;
            repos.push(...data.map(repo => ({
                name: repo.name,
                fullName: repo.full_name,
                sshUrl: repo.ssh_url,
                private: repo.private,
                description: repo.description,
                defaultBranch: repo.default_branch,
            })));
            if (data.length < 100) break;
            page++;
        }
        res.json(repos);
    } catch (err) {
        res.status(500).json({ error: 'failed to fetch repos', detail: err.message });
    }
});

// GET /api/branches?repo=owner/name — list branches for a repo
app.get('/api/branches', async (req, res) => {
    const repo = req.query.repo;
    if (!repo) return res.status(400).json({ error: 'repo query param required' });
    try {
        const headers = { 'User-Agent': 'claude-workstation' };
        if (process.env.GITHUB_TOKEN) headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
        const branches = [];
        let page = 1;
        while (true) {
            const url = `https://api.github.com/repos/${repo}/branches?per_page=100&page=${page}`;
            const r = await fetch(url, { headers });
            if (!r.ok) break;
            const data = await r.json();
            if (!data.length) break;
            branches.push(...data.map(b => b.name));
            if (data.length < 100) break;
            page++;
        }
        res.json(branches);
    } catch (err) {
        res.status(500).json({ error: 'failed to fetch branches', detail: err.message });
    }
});

// GET /api/sessions — list sessions with live status check
app.get('/api/sessions', (req, res) => {
    const sessions = readState();
    let changed = false;
    for (const s of sessions) {
        const alive = sessionAlive(s.byobuSession);
        if (alive && s.status !== 'running') { s.status = 'running'; changed = true; }
        if (!alive && s.status === 'running') { s.status = 'dead'; changed = true; }
    }
    if (changed) writeState(sessions);
    res.json(sessions);
});

// POST /api/sessions — start a new session
app.post('/api/sessions', (req, res) => {
    // branch: existing branch to clone from; newBranch: optional new branch to create after clone
    const { project, branch, newBranch, force } = req.body;
    if (!project || !branch) {
        return res.status(400).json({ error: 'project and branch are required' });
    }

    const repoName = repoNameFromUrl(project);
    const ts = timestamp();
    const sessions = readState();

    // The effective branch for naming/tracking is newBranch if provided, else branch
    const effectiveBranch = newBranch || branch;

    let workspacePath;
    let sessionName;
    let existingEntry = null;

    if (force) {
        existingEntry = sessions.find(s => s.project === project && s.branch === effectiveBranch);
    }

    if (existingEntry) {
        workspacePath = existingEntry.workspacePath;
        sessionName = existingEntry.name;
        try {
            execSync(`git -C ${workspacePath} fetch --quiet`, { stdio: 'pipe' });
            execSync(`git -C ${workspacePath} reset --hard origin/${effectiveBranch}`, { stdio: 'pipe' });
        } catch (err) {
            return res.status(500).json({ error: 'git reset failed', detail: err.message });
        }
        const idx = sessions.indexOf(existingEntry);
        sessions.splice(idx, 1);
    } else {
        const safeBranch = effectiveBranch.replace(/\//g, '-');
        sessionName = `${repoName}-${safeBranch}-${ts}`;
        workspacePath = path.join(SESSIONS_ROOT, sessionName);
        try {
            execSync(`git clone --branch ${branch} ${project} ${workspacePath}`, { stdio: 'pipe' });
        } catch (err) {
            return res.status(500).json({ error: 'git clone failed', detail: err.message });
        }
        if (newBranch) {
            try {
                execSync(`git -C ${workspacePath} checkout -b ${newBranch}`, { stdio: 'pipe' });
            } catch (err) {
                return res.status(500).json({ error: 'git checkout -b failed', detail: err.message });
            }
        }
    }

    const byobuSession = `claude-${sessionName}`;

    // Kill any dead byobu session with the same name before creating
    spawnSync('tmux', ['kill-session', '-t', byobuSession], { stdio: 'pipe' });

    try {
        execSync(`byobu new-session -d -s ${byobuSession} -c ${workspacePath}`, { stdio: 'pipe' });
        execSync(`byobu send-keys -t ${byobuSession} "claude remote --name '${sessionName}' --spawn=same-dir" Enter`, { stdio: 'pipe' });
    } catch (err) {
        return res.status(500).json({ error: 'failed to start byobu session', detail: err.message });
    }

    // Poll the pane output until claude prints "Connected" and "Ready" (confirms successful startup).
    // Bail out after 30s and surface whatever the pane showed as an error.
    const TIMEOUT_MS = 30000;
    const POLL_MS = 500;
    const deadline = Date.now() + TIMEOUT_MS;
    let connected = false;
    let lastPane = '';
    while (Date.now() < deadline) {
        const result = spawnSync('tmux', ['capture-pane', '-t', byobuSession, '-p'], { stdio: 'pipe' });
        lastPane = result.stdout ? result.stdout.toString() : '';
        if (lastPane.includes('Connected') || lastPane.includes('Ready')) {
            connected = true;
            break;
        }
        // Detect obvious failures early (e.g. "command not found", "Error")
        if (lastPane.includes('command not found') || lastPane.includes('Error:')) {
            return res.status(500).json({ error: 'claude failed to start', detail: lastPane.trim() });
        }
        spawnSync('sleep', [String(POLL_MS / 1000)]);
    }

    if (!connected) {
        return res.status(500).json({ error: 'claude did not connect within 30s', detail: lastPane.trim() });
    }

    const entry = {
        name: sessionName,
        project,
        branch: effectiveBranch,
        workspacePath,
        byobuSession,
        startedAt: new Date().toISOString(),
        status: 'running',
    };

    sessions.push(entry);
    writeState(sessions);
    res.status(201).json(entry);
});

// POST /api/sessions/:name/activate — write ~/.claude-session so the next bash login attaches to it
app.post('/api/sessions/:name/activate', (req, res) => {
    const sessions = readState();
    const entry = sessions.find(s => s.name === req.params.name);
    if (!entry) return res.status(404).json({ error: 'session not found' });
    const payload = JSON.stringify({ byobuSession: entry.byobuSession, ts: Date.now() });
    fs.writeFileSync('/home/ubuntu/.claude-session', payload, 'utf8');
    res.status(204).end();
});

// DELETE /api/sessions/:name — terminate a session
app.delete('/api/sessions/:name', (req, res) => {
    const sessions = readState();
    const idx = sessions.findIndex(s => s.name === req.params.name);
    if (idx === -1) {
        return res.status(404).json({ error: 'session not found' });
    }
    const entry = sessions[idx];
    spawnSync('tmux', ['kill-session', '-t', entry.byobuSession], { stdio: 'pipe' });
    sessions.splice(idx, 1);
    writeState(sessions);
    res.status(204).end();
});

// GET /api/resources — per-session CPU (millicores) and memory (MiB)
app.get('/api/resources', (req, res) => {
    const sessions = readState();
    const { processMap, children } = buildProcessTree();
    const sessionStats = {};

    for (const s of sessions) {
        if (s.status !== 'running') continue;
        const panePids = getSessionPids(s.byobuSession);
        let cpu = 0, rssKb = 0;
        for (const pid of panePids) {
            const sums = subtreeSum(pid, processMap, children);
            cpu += sums.cpu;
            rssKb += sums.rssKb;
        }
        // cpu: %cpu sums where 100% = 1 core = 1000m
        const cpuMillicores = Math.round(cpu * 10);
        const memMiB = +(rssKb / 1024).toFixed(1);
        sessionStats[s.name] = { cpuMillicores, memMiB };
    }

    res.json({ sessions: sessionStats });
});

// POST /api/workspaces/cleanup — delete session workspace directories older than N days
app.post('/api/workspaces/cleanup', (req, res) => {
    const { olderThanDays } = req.body;
    if (typeof olderThanDays !== 'number' || !Number.isInteger(olderThanDays) || olderThanDays < 1) {
        return res.status(400).json({ error: 'olderThanDays must be an integer >= 1' });
    }

    if (!fs.existsSync(SESSIONS_ROOT)) {
        return res.json({ deleted: [], totalFreedMb: 0 });
    }

    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    const sessions = readState();

    const entries = fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => ({ dirPath: path.join(SESSIONS_ROOT, e.name), name: e.name }));

    const toDelete = entries.filter(({ dirPath }) => {
        const stateEntry = sessions.find(s => s.workspacePath === dirPath);
        const age = stateEntry ? new Date(stateEntry.startedAt) : fs.statSync(dirPath).mtime;
        return age < cutoff;
    });

    const deleted = [];
    let totalFreedMb = 0;

    for (const { dirPath, name } of toDelete) {
        let sizeMb = 0;
        try {
            const duOut = execSync(`du -sm "${dirPath}"`, { stdio: 'pipe' }).toString();
            sizeMb = parseInt(duOut.split('\t')[0], 10) || 0;
        } catch { /* ignore */ }

        try {
            const stateEntry = sessions.find(s => s.workspacePath === dirPath);
            const age = stateEntry ? new Date(stateEntry.startedAt) : fs.statSync(dirPath).mtime;
            const ageDays = Math.floor((Date.now() - age.getTime()) / (24 * 60 * 60 * 1000));
            fs.rmSync(dirPath, { recursive: true, force: true });
            deleted.push({ name, path: dirPath, ageDays, sizeMb });
            totalFreedMb += sizeMb;
        } catch { /* skip dirs that fail to delete */ }
    }

    if (deleted.length > 0) {
        const deletedPaths = new Set(deleted.map(d => d.path));
        writeState(sessions.filter(s => !deletedPaths.has(s.workspacePath)));
    }

    res.json({ deleted, totalFreedMb });
});

// Serve UI for all non-API paths
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

fs.mkdirSync(SESSIONS_ROOT, { recursive: true });

app.listen(PORT, () => {
    console.log(`claude-session-api listening on :${PORT}`);
});
