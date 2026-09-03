'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'workspace', 'bootstrap',
                         'link-shared-skills.sh');

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-skills-'));
    const claude = path.join(root, 'claude');
    const codex = path.join(root, 'codex');
    fs.mkdirSync(claude);
    fs.mkdirSync(codex);
    return { root, claude, codex };
}

function run({ root, claude, codex }) {
    execFileSync('bash', [SCRIPT], {
        env: {
            ...process.env,
            HOME: root,
            CLAUDE_CONFIG_DIR: claude,
            CODEX_HOME: codex,
        },
    });
}

test('links the Codex skill discovery path to the S3-backed Claude skills', () => {
    const dirs = fixture();
    try {
        run(dirs);
        const link = path.join(dirs.codex, 'skills');
        assert.ok(fs.lstatSync(link).isSymbolicLink());
        assert.equal(fs.readlinkSync(link), path.join(dirs.claude, 'skills'));

        fs.mkdirSync(path.join(dirs.claude, 'skills', 'shared'));
        fs.writeFileSync(path.join(dirs.claude, 'skills', 'shared', 'SKILL.md'), 'shared');
        assert.equal(fs.readFileSync(path.join(link, 'shared', 'SKILL.md'), 'utf8'), 'shared');

        // Restarting bootstrap is idempotent.
        run(dirs);
    } finally {
        fs.rmSync(dirs.root, { recursive: true, force: true });
    }
});

test('migrates Codex-only skills while preferring same-named synced skills', () => {
    const dirs = fixture();
    try {
        const claudeSkills = path.join(dirs.claude, 'skills');
        const codexSkills = path.join(dirs.codex, 'skills');
        fs.mkdirSync(path.join(claudeSkills, 'collision'), { recursive: true });
        fs.writeFileSync(path.join(claudeSkills, 'collision', 'SKILL.md'), 'synced');
        fs.mkdirSync(path.join(codexSkills, 'collision'), { recursive: true });
        fs.mkdirSync(path.join(codexSkills, 'codex-only'));
        fs.writeFileSync(path.join(codexSkills, 'collision', 'SKILL.md'), 'local');
        fs.writeFileSync(path.join(codexSkills, 'codex-only', 'SKILL.md'), 'migrated');

        run(dirs);

        assert.ok(fs.lstatSync(codexSkills).isSymbolicLink());
        assert.equal(fs.readFileSync(path.join(claudeSkills, 'collision', 'SKILL.md'), 'utf8'),
            'synced');
        assert.equal(fs.readFileSync(path.join(claudeSkills, 'codex-only', 'SKILL.md'), 'utf8'),
            'migrated');
    } finally {
        fs.rmSync(dirs.root, { recursive: true, force: true });
    }
});
