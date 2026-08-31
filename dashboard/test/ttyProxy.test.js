'use strict';

const test = require('node:test');
const assert = require('node:assert');

process.env.NAMESPACE = 'dev';
process.env.KUBERNETES_SERVICE_HOST = '';

const {
    TTY_PORT, CODEX_PORT, isSameOriginUpgrade, matchWorkspaceUpgrade,
} = require('../lib/ttyProxy');

test('workspace WebSocket paths select the correct service and port', () => {
    assert.deepEqual(matchWorkspaceUpgrade('/tty/claude-ws-demo-0badf00d/ws'), {
        service: 'tty', id: 'claude-ws-demo-0badf00d', port: TTY_PORT,
    });
    assert.deepEqual(
        matchWorkspaceUpgrade('/codex/claude-ws-demo-0badf00d/codex-api/ws?token=x'),
        {
            service: 'codex', id: 'claude-ws-demo-0badf00d', port: CODEX_PORT,
            healthPath: '/codex/claude-ws-demo-0badf00d/',
        },
    );
});

test('Codex upgrades are accepted only at its prefixed RPC WebSocket path', () => {
    assert.equal(matchWorkspaceUpgrade('/codex/claude-ws-demo-0badf00d/'), null);
    assert.equal(matchWorkspaceUpgrade('/codex/claude-ws-demo-0badf00d/not-a-websocket'), null);
});

test('browser WebSocket upgrades must be same-origin', () => {
    assert.equal(isSameOriginUpgrade({
        headers: { host: 'work.example.test', origin: 'https://work.example.test' },
    }), true);
    assert.equal(isSameOriginUpgrade({
        headers: { host: 'work.example.test', origin: 'https://evil.example.test' },
    }), false);
    assert.equal(isSameOriginUpgrade({ headers: { host: 'work.example.test' } }), true);
    assert.equal(isSameOriginUpgrade({
        headers: { host: 'work.example.test', origin: 'not a URL' },
    }), false);
});
