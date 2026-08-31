'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('codexapp receives its workspace base path as a CLI argument', () => {
    const source = fs.readFileSync(
        path.join(__dirname, '..', '..', 'workspace', 'supervisord.conf'),
        'utf8',
    );
    const command = source.split('\n').find((line) => line.startsWith('command=codexapp '));

    assert.ok(command, 'codexapp supervisor command is missing');
    assert.match(command, /--base-path "\/codex\/%\(ENV_WORKSPACE_ID\)s"/);
    assert.doesNotMatch(source, /CODEXUI_BASE_PATH/);
});
