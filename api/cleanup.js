#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || '/home/ubuntu/workspace';
const STATE_FILE = process.env.STATE_FILE || '/home/ubuntu/.claude-sessions/state.json';
const SESSIONS_ROOT = path.join(WORKSPACE_ROOT, 'sessions');

const args = process.argv.slice(2);
const daysIdx = args.indexOf('--days');
const olderThanDays = daysIdx !== -1 ? parseInt(args[daysIdx + 1], 10) : 7;

if (!olderThanDays || olderThanDays < 1) {
    console.error('Usage: cleanup.js [--days N]  (default: 7)');
    process.exit(1);
}

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

if (!fs.existsSync(SESSIONS_ROOT)) {
    console.log(`Sessions root ${SESSIONS_ROOT} does not exist — nothing to clean.`);
    process.exit(0);
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

if (!toDelete.length) {
    console.log(`No workspaces older than ${olderThanDays} day(s) found.`);
    process.exit(0);
}

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
        deleted.push({ name, dirPath, ageDays, sizeMb });
        totalFreedMb += sizeMb;
        console.log(`Deleted ${name} (${ageDays} days old, ${sizeMb} MB)`);
    } catch (err) {
        console.error(`Failed to delete ${name}: ${err.message}`);
    }
}

if (deleted.length > 0) {
    const deletedPaths = new Set(deleted.map(d => d.dirPath));
    writeState(sessions.filter(s => !deletedPaths.has(s.workspacePath)));
}

console.log(`Done: deleted ${deleted.length} workspace(s), freed ${totalFreedMb} MB.`);
