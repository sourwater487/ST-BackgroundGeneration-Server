const { randomUUID } = require('node:crypto');

const jobs = new Map();
const GENERATE_PATH = '/api/backends/chat-completions/generate';

function jobView(job, includeResult = false) {
    const data = {
        id: job.id,
        status: job.status,
        metadata: job.metadata,
        createdAt: job.createdAt,
        finishedAt: job.finishedAt,
        responseStatus: job.responseStatus,
        error: job.error,
        clientDisconnected: job.clientDisconnected,
        deliveryRequired: job.deliveryRequired,
    };

    if (includeResult) {
        data.contentType = job.contentType;
        data.result = job.result;
    }

    return data;
}

function getUpstreamHeaders(req) {
    const headers = {
        'content-type': 'application/json',
        accept: req.headers.accept || '*/*',
    };

    for (const name of ['authorization', 'cookie', 'x-csrf-token']) {
        const value = req.headers[name];

        if (typeof value === 'string') {
            headers[name] = value;
        }
    }

    return headers;
}

async function init(router) {
    router.get('/health', (req, res) => {
        res.json({
            ok: true,
            plugin: 'background-generation',
            version: '0.3.0',
            jobs: jobs.size,
            time: new Date().toISOString(),
        });
    });

    router.get('/jobs', (req, res) => {
        const list = Array.from(jobs.values())
            .map(job => jobView(job))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

        res.json({ ok: true, jobs: list });
    });

    router.get('/jobs/:id', (req, res) => {
        const job = jobs.get(req.params.id);

        if (!job) {
            return res.status(404).json({
                ok: false,
                error: 'Job not found',
            });
        }

        res.json({
            ok: true,
            job: jobView(job, true),
        });
    });

    router.delete('/jobs/:id', (req, res) => {
        const deleted = jobs.delete(req.params.id);

        if (!deleted) {
            return res.status(404).json({
                ok: false,
                error: 'Job not found',
            });
        }

        res.json({ ok: true });
    });

    router.post('/generate', async (req, res) => {
        const requestBody = req.body?.requestBody;
        const metadata = req.body?.metadata || {};

        if (!requestBody || typeof requestBody !== 'object') {
            return res.status(400).json({
                ok: false,
                error: 'requestBody is required',
            });
        }

        const id = randomUUID();
        const job = {
            id,
            status: 'running',
            metadata,
            createdAt: new Date().toISOString(),
            finishedAt: null,
            responseStatus: null,
            contentType: null,
            result: null,
            error: null,
            clientDisconnected: false,
            deliveryRequired: false,
        };

        jobs.set(id, job);

        let clientConnected = true;

        res.on('close', () => {
            if (!res.writableEnded) {
                clientConnected = false;
                job.clientDisconnected = true;
                job.deliveryRequired = true;
            }
        });

        try {
            const localPort = req.socket.localPort;
            const upstreamUrl =
                `http://127.0.0.1:${localPort}${GENERATE_PATH}`;

            const upstream = await fetch(upstreamUrl, {
                method: 'POST',
                headers: getUpstreamHeaders(req),
                body: JSON.stringify(requestBody),
            });

            job.responseStatus = upstream.status;
            job.contentType =
                upstream.headers.get('content-type') ||
                'application/octet-stream';

            if (clientConnected && !res.destroyed) {
                res.status(upstream.status);
                res.setHeader('content-type', job.contentType);
                res.setHeader('x-background-job-id', id);
                res.setHeader('x-accel-buffering', 'no');
                res.flushHeaders();
            }

            const chunks = [];
            const reader = upstream.body.getReader();

            while (true) {
                const { done, value } = await reader.read();

                if (done) {
                    break;
                }

                const chunk = Buffer.from(value);
                chunks.push(chunk);

                if (clientConnected && !res.destroyed) {
                    try {
                        res.write(chunk);
                    } catch {
                        clientConnected = false;
                        job.clientDisconnected = true;
                        job.deliveryRequired = true;
                    }
                }
            }

            job.result = Buffer.concat(chunks).toString('utf8');
            job.status = upstream.ok ? 'completed' : 'failed';
            job.finishedAt = new Date().toISOString();

            if (!upstream.ok) {
                job.error = `Upstream returned HTTP ${upstream.status}`;
            }

            if (clientConnected && !res.destroyed && !res.writableEnded) {
                res.end();
            }
        } catch (error) {
            job.status = 'failed';
            job.error = error?.message || String(error);
            job.finishedAt = new Date().toISOString();

            if (!res.destroyed && !res.writableEnded) {
                if (!res.headersSent) {
                    res.status(502).json({
                        ok: false,
                        jobId: id,
                        error: job.error,
                    });
                } else {
                    res.end();
                }
            }
        }
    });

    console.log('[Background Generation] Server plugin loaded');
}

async function exit() {
    jobs.clear();
    console.log('[Background Generation] Server plugin stopped');
}

module.exports = {
    init,
    exit,
    info: {
        id: 'background-generation',
        name: 'Background Generation',
        description: 'Keeps SillyTavern generations running after the browser disconnects.',
    },
};
