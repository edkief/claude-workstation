'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { extractClaudeUrl } = require('../../workspace/agent');

test('extractClaudeUrl selects the newest remote-control URL from tmux history', () => {
    const oldUrl = 'https://claude.ai/code/session_01OLD';
    const newUrl = 'https://claude.ai/code/session_01UjNkFrRYNWcm23fPhzsoJ6';
    assert.equal(extractClaudeUrl(`Connected: ${oldUrl}\nrelaunching\nOpen ${newUrl}\n`), newUrl);
});

test('extractClaudeUrl ignores unrelated and malformed URLs', () => {
    assert.equal(extractClaudeUrl('Open https://claude.ai/code when ready'), null);
    assert.equal(extractClaudeUrl('https://evil.example/session_01NOPE'), null);
});
