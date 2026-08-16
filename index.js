const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const jobs = new Map();
const GENERATE_PATH = '/api/backends/chat-completions/generate';

const PUSH_STATE_PATH = path.join(
    process.cwd(),
    'data',
    'default-user',
    'background-generation-push.json',
);

const VAPID_SUBJECT = 'mailto:webpush@lin-che.com';

let webPush = null;
let pushState = null;

function persistPushState() {
    const directory = path.dirname(PUSH_STATE_PATH);
    const temporaryPath = `${PUSH_STATE_PATH}.tmp`;

    fs.mkdirSync(directory, {
        recursive: true,
    });

    fs.writeFileSync(
        temporaryPath,
        JSON.stringify(pushState, null, 2),
        {
            encoding: 'utf8',
            mode: 0o600,
        },
    );

    fs.renameSync(temporaryPath, PUSH_STATE_PATH);
    fs.chmodSync(PUSH_STATE_PATH, 0o600);
}

async function initPush() {
    const module = await import('web-push');
    webPush = module.default || module;

    if (fs.existsSync(PUSH_STATE_PATH)) {
        pushState = JSON.parse(
            fs.readFileSync(PUSH_STATE_PATH, 'utf8'),
        );
    } else {
        pushState = {
            vapidKeys: webPush.generateVAPIDKeys(),
            subscriptions: [],
        };
    }

    if (
        !pushState?.vapidKeys?.publicKey
        || !pushState?.vapidKeys?.privateKey
    ) {
        pushState.vapidKeys = webPush.generateVAPIDKeys();
    }

    if (!Array.isArray(pushState.subscriptions)) {
        pushState.subscriptions = [];
    }

    webPush.setVapidDetails(
        VAPID_SUBJECT,
        pushState.vapidKeys.publicKey,
        pushState.vapidKeys.privateKey,
    );

    persistPushState();
}

async function sendCompletionPush(navigateUrl) {
    if (
        !webPush
        || !Array.isArray(pushState?.subscriptions)
        || pushState.subscriptions.length === 0
    ) {
        return;
    }

    let normalizedNavigateUrl;

    try {
        const url = new URL(navigateUrl);

        if (!['https:', 'http:'].includes(url.protocol)) {
            throw new Error('Invalid notification URL');
        }

        normalizedNavigateUrl = url.href;
    } catch {
        console.error(
            '[Background Generation] Push skipped: invalid navigate URL',
        );
        return;
    }

    /*
     * Declarative Web Push：
     * 仅包含固定通知文字与 ST 地址，不包含角色名、
     * 回复正文、聊天内容或消息预览。
     */
    const payload = JSON.stringify({
        web_push: 8030,
        notification: {
            title: '新消息已送达...ʢᴗ.ᴗʡᶻ',
            navigate: normalizedNavigateUrl,
            silent: false,
            tag: 'st-generation-complete',
        },
    });

    const expiredEndpoints = new Set();
    const subscriptions = pushState.subscriptions.slice();

    await Promise.all(
        subscriptions.map(async subscription => {
            try {
                await webPush.sendNotification(
                    subscription,
                    payload,
                    {
                        TTL: 300,
                        topic: 'st-generation-complete',
                    },
                );
            } catch (error) {
                const statusCode =
                    error?.statusCode
                    ?? error?.status;

                if (
                    statusCode === 404
                    || statusCode === 410
                ) {
                    expiredEndpoints.add(
                        subscription.endpoint,
                    );
                    return;
                }

                console.error(
                    '[Background Generation] Push failed:',
                    statusCode || error?.message || error,
                );
            }
        }),
    );

    if (expiredEndpoints.size > 0) {
        pushState.subscriptions =
            pushState.subscriptions.filter(
                subscription =>
                    !expiredEndpoints.has(
                        subscription.endpoint,
                    ),
            );

        persistPushState();
    }
}

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
        clientVisible: job.clientVisible,
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
    await initPush();

    router.get('/health', (req, res) => {
        res.json({
            ok: true,
            plugin: 'background-generation',
            version: '0.4.3',
            jobs: jobs.size,
            time: new Date().toISOString(),
        });
    });

    router.get('/push/public-key', (req, res) => {
        res.json({
            ok: true,
            publicKey: pushState.vapidKeys.publicKey,
        });
    });

    router.post('/push/subscribe', (req, res) => {
        const subscription =
            req.body?.subscription ?? req.body;

        if (
            !subscription
            || typeof subscription.endpoint !== 'string'
            || typeof subscription.keys?.p256dh !== 'string'
            || typeof subscription.keys?.auth !== 'string'
        ) {
            return res.status(400).json({
                ok: false,
                error: 'Invalid push subscription',
            });
        }

        const index = pushState.subscriptions.findIndex(
            item => item.endpoint === subscription.endpoint,
        );

        if (index >= 0) {
            pushState.subscriptions[index] = subscription;
        } else {
            pushState.subscriptions.push(subscription);
        }

        persistPushState();

        res.json({ ok: true });
    });

    router.post('/push/unsubscribe', (req, res) => {
        const endpoint = req.body?.endpoint;

        if (typeof endpoint !== 'string') {
            return res.status(400).json({
                ok: false,
                error: 'endpoint is required',
            });
        }

        pushState.subscriptions =
            pushState.subscriptions.filter(
                subscription =>
                    subscription.endpoint !== endpoint,
            );

        persistPushState();

        res.json({ ok: true });
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

    router.post('/jobs/:id/visibility', (req, res) => {
        const job = jobs.get(req.params.id);

        if (!job) {
            return res.status(404).json({
                ok: false,
                error: 'Job not found',
            });
        }

        const visible =
            req.body?.visible === true;

        job.clientVisible = visible;

        /*
         * iOS 切到其他 App 时可能冻结页面，却继续维持连接。
         * 一旦进入后台，该任务必须由服务端保留并等待回填；
         * 后续重新 visible 也不能撤销这个标记。
         */
        if (!visible) {
            job.deliveryRequired = true;
        }

        res.json({ ok: true });
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
            clientVisible:
                metadata.clientVisible !== false,
        };

        jobs.set(id, job);

        let clientConnected = true;

        res.on('close', () => {
            if (!res.writableEnded) {
                clientConnected = false;
                job.clientDisconnected = true;
                job.deliveryRequired = true;
                job.clientVisible = false;
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

            if (
                job.status === 'completed'
                && job.metadata?.notificationsEnabled === true
                && (
                    job.clientVisible === false
                    || job.clientDisconnected === true
                )
            ) {
                void sendCompletionPush(
                    job.metadata?.notificationUrl,
                );
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
