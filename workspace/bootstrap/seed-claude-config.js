#!/usr/bin/env node
'use strict';

/**
 * Mark this pod's checkout as trusted so `claude` starts without the
 * interactive trust dialog.
 *
 * This is the old trustProject() from api/server.js, moved into the workspace
 * pod. The dashboard no longer has -- and cannot have -- a shared filesystem
 * with the workspace, so it must not touch ~/.claude.json.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = process.env.HOME || os.homedir();
const CONFIG = path.join(HOME, '.claude.json');

const STATE_DIR = process.env.WORKSPACE_STATE_DIR || '/home/ubuntu/.workspace-state';

const dir = (() => {
    try { return fs.readFileSync(path.join(STATE_DIR, 'dir'), 'utf8').trim(); } catch { return null; }
})();

if (!dir) {
    console.error(`[seed] ${STATE_DIR}/dir missing; did clone.sh run?`);
    process.exit(1);
}

let config = {};
try { config = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { /* first boot */ }

config.projects = config.projects || {};
const existing = config.projects[dir] || {};

config.projects[dir] = {
    allowedTools: [],
    mcpContextUris: [],
    mcpServers: {},
    enabledMcpjsonServers: [],
    disabledMcpjsonServers: [],
    projectOnboardingSeenCount: 0,
    hasClaudeMdExternalIncludesApproved: false,
    hasClaudeMdExternalIncludesWarningShown: false,
    ...existing,
    hasTrustDialogAccepted: true,
    remoteControlSpawnMode: 'same-dir',
};

const tmp = `${CONFIG}.tmp-${process.pid}`;
fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
fs.renameSync(tmp, CONFIG);

console.log(`[seed] trusted ${dir}`);
