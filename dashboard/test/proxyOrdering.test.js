'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('workspace proxies are registered before the JSON body parser', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const parser = source.indexOf("app.use(express.json({ limit: '16kb' }))");

    assert.ok(parser > source.indexOf("app.use('/tty/:id'"));
    assert.ok(parser > source.indexOf("app.use('/codex/:id'"));
    assert.ok(parser > source.indexOf("app.use('/config-tty'"));
    assert.ok(parser < source.indexOf("app.get('/api/config/status'"));
});
