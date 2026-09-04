'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { extractClaudeUrl } = require('../../workspace/agent');

test('extractClaudeUrl reads the environment URL claude remote prints', () => {
    const pane = [
        '· Connected · berth · main',
        '    Capacity: 1/32 · New sessions will be created in the current directory',
        '',
        'Continue coding in the Claude mobile app or '
            + 'https://claude.ai/code?environment=env_01HU1hDuzwnSKSL75Um5vukD',
        'space to show QR code · w to toggle spawn mode',
    ].join('\n');
    assert.equal(extractClaudeUrl(pane), 'https://claude.ai/code?environment=env_01HU1hDuzwnSKSL75Um5vukD');
});

test('extractClaudeUrl selects the newest remote-control URL from tmux history', () => {
    const oldUrl = 'https://claude.ai/code?environment=env_01OLD';
    const newUrl = 'https://claude.ai/code/session_01UjNkFrRYNWcm23fPhzsoJ6';
    assert.equal(extractClaudeUrl(`Connected: ${oldUrl}\nrelaunching\nOpen ${newUrl}\n`), newUrl);
});

test('extractClaudeUrl ignores unrelated and malformed URLs', () => {
    assert.equal(extractClaudeUrl('Open https://claude.ai/code when ready'), null);
    assert.equal(extractClaudeUrl('https://claude.ai/code?environment=nope'), null);
    assert.equal(extractClaudeUrl('https://evil.example/session_01NOPE'), null);
});
