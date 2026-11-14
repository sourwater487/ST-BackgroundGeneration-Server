const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('../../../node_modules/express');
const plugin = require('../index.js');

test('real HTTP disconnect retains generation; incomplete SSE fails; explicit stop cancels', async () => {
    const originalCwd = process.cwd();
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-regression-'));
    process.chdir(temp);
    const app = express(); app.use(express.json());
    let requests = 0;
    app.post(['/api/backends/chat-completions/generate', '/api/plugins/vertex-paygo/native-gemini/generate'], (req, res) => {
        requests++;
        res.type('text/event-stream');
        res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
        const timer = setTimeout(() => {
            if (req.body.test === 'vertex') {
                res.write('data: {"candidates":[{"content":{"parts":[{"text":"world","thoughtSignature":"fixture"}]},"finishReason":"STOP"}]}\n\n');
            } else if (req.body.test !== 'incomplete') res.write('data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
            res.end();
        }, 120);
        res.on('close', () => clearTimeout(timer));
    });
    const router = express.Router();
    await plugin.init(router); app.use('/plugin', router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/plugin`;
    const get = async id => (await (await fetch(`${base}/jobs/${id}`)).json()).job;
    const wait = async id => {
        for (let i = 0; i < 50; i++) {
            const job = await get(id); if (job.status !== 'running') return job;
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        throw Error('Job did not finish');
    };
    try {
        const abort = new AbortController();
        const response = await fetch(`${base}/generate`, { method: 'POST', signal: abort.signal,
            headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestBody: { stream: true } }) });
        const id = response.headers.get('x-background-job-id');
        assert.equal((await fetch(`${base}/jobs/${id}`, { method: 'DELETE' })).status, 409);
        abort.abort();
        const job = await wait(id);
        assert.equal(job.status, 'completed'); assert.equal(job.deliveryRequired, true);
        assert.equal(job.clientDisconnected, true); assert.match(job.result, /world/);
        assert.equal(requests, 1);
        const truncated = await fetch(`${base}/generate`, { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ requestBody: { stream: true, test: 'incomplete' } }) });
        await truncated.text();
        assert.equal((await get(truncated.headers.get('x-background-job-id'))).status, 'failed');
        for (const targetPath of ['/api/backends/chat-completions/generate', '/api/plugins/vertex-paygo/native-gemini/generate']) {
            const native = await fetch(`${base}/generate`, { method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ targetPath, requestBody: { stream: true, test: 'vertex' } }) });
            await native.text();
            const nativeJob = await get(native.headers.get('x-background-job-id'));
            assert.equal(nativeJob.status, 'completed');
            assert.match(nativeJob.result, /thoughtSignature/);
        }
        const invalid = await fetch(`${base}/generate`, { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ targetPath: 'https://external.invalid', requestBody: {} }) });
        assert.equal(invalid.status, 400);
        const stopped = await fetch(`${base}/generate`, { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ requestBody: { stream: true } }) });
        const stopId = stopped.headers.get('x-background-job-id');
        await fetch(`${base}/jobs/${stopId}/cancel`, { method: 'POST' });
        const cancelled = await wait(stopId);
        assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.deliveryRequired, false);
    } finally {
        await plugin.exit();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        process.chdir(originalCwd);
        fs.rmSync(temp, { recursive: true, force: true });
    }
});
