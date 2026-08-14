async function init(router) {
    router.get('/health', (req, res) => {
        res.json({
            ok: true,
            plugin: 'background-generation',
            version: '0.1.0',
            time: new Date().toISOString(),
        });
    });

    console.log('[Background Generation] Server plugin loaded');
}

async function exit() {
    console.log('[Background Generation] Server plugin stopped');
}

module.exports = {
    init,
    exit,
    info: {
        id: 'background-generation',
        name: 'Background Generation',
        description: 'Runs SillyTavern generations independently of the browser connection.',
    },
};
