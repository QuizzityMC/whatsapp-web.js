const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const Client = require('../../src/Client');
const LocalAuth = require('../../src/authStrategies/LocalAuth');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const HEADLESS = process.env.HEADLESS !== 'false';
const MAX_CHAT_COUNT = Number(process.env.MAX_CHAT_COUNT || 100);
const CHROME_EXECUTABLE_PATH = process.env.CHROME_EXECUTABLE_PATH;

const appState = {
    status: 'starting',
    qr: null,
    info: null,
    authFailure: null,
    disconnectedReason: null,
    lastUpdateAt: new Date().toISOString()
};

const sseClients = new Set();

const publicState = () => ({
    status: appState.status,
    qr: appState.qr,
    info: appState.info,
    authFailure: appState.authFailure,
    disconnectedReason: appState.disconnectedReason,
    lastUpdateAt: appState.lastUpdateAt
});

const updateState = (partial) => {
    Object.assign(appState, partial, { lastUpdateAt: new Date().toISOString() });
    broadcast('state', publicState());
};

const broadcast = (event, data) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
        res.write(payload);
    }
};

const safeJson = (res, statusCode, data) => {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
};

const readBody = (req) => new Promise((resolve, reject) => {
    let body = '';

    req.on('data', chunk => {
        body += chunk;
        if (body.length > 1_000_000) {
            reject(new Error('Payload too large'));
        }
    });

    req.on('end', () => {
        if (!body) {
            resolve({});
            return;
        }

        try {
            resolve(JSON.parse(body));
        } catch (error) {
            reject(new Error('Invalid JSON payload'));
        }
    });

    req.on('error', reject);
});

const serializeChat = (chat) => ({
    id: chat.id._serialized,
    name: chat.name || chat.formattedTitle || chat.id.user,
    isGroup: Boolean(chat.isGroup),
    unreadCount: chat.unreadCount || 0,
    timestamp: chat.timestamp || null,
    lastMessageBody: chat.lastMessage?.body || '',
    archived: Boolean(chat.archived),
    pinned: Boolean(chat.pinned)
});

const serializeMessage = (message) => ({
    id: message.id._serialized,
    chatId: message.fromMe ? message.to : message.from,
    body: message.body || '',
    type: message.type,
    from: message.from,
    to: message.to,
    author: message.author || null,
    notifyName: message.notifyName || null,
    fromMe: Boolean(message.fromMe),
    timestamp: message.timestamp,
    hasMedia: Boolean(message.hasMedia),
    ack: message.ack
});

const client = new Client({
    authStrategy: new LocalAuth({ clientId: process.env.CLIENT_ID || 'codespace-web-client' }),
    puppeteer: {
        headless: HEADLESS,
        executablePath: CHROME_EXECUTABLE_PATH,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage'
        ]
    }
});

client.on('qr', (qr) => {
    updateState({ status: 'qr', qr, authFailure: null, disconnectedReason: null });
});

client.on('authenticated', () => {
    updateState({ status: 'authenticated', qr: null, authFailure: null });
});

client.on('ready', () => {
    const info = client.info
        ? {
            pushname: client.info.pushname,
            wid: client.info.wid?._serialized,
            platform: client.info.platform
        }
        : null;

    updateState({ status: 'ready', qr: null, info, authFailure: null, disconnectedReason: null });
});

client.on('auth_failure', (message) => {
    updateState({ status: 'auth_failure', authFailure: message || 'Authentication failed' });
});

client.on('disconnected', (reason) => {
    updateState({ status: 'disconnected', disconnectedReason: reason || 'Unknown reason' });
});

client.on('message_create', (message) => {
    broadcast('message', serializeMessage(message));
});

const indexHtmlPath = path.join(__dirname, 'public', 'index.html');

const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    if (req.method === 'GET' && pathname === '/') {
        const html = fs.readFileSync(indexHtmlPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
    }

    if (req.method === 'GET' && pathname === '/events') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive'
        });

        res.write('retry: 2000\n\n');
        sseClients.add(res);
        res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);

        const keepAlive = setInterval(() => {
            res.write(': keep-alive\n\n');
        }, 15000);

        req.on('close', () => {
            clearInterval(keepAlive);
            sseClients.delete(res);
        });
        return;
    }

    if (req.method === 'GET' && pathname === '/api/state') {
        safeJson(res, 200, publicState());
        return;
    }

    if (req.method === 'GET' && pathname === '/api/chats') {
        if (appState.status !== 'ready') {
            safeJson(res, 409, { error: 'Client is not ready yet.' });
            return;
        }

        try {
            const chats = await client.getChats();
            const sortedChats = chats
                .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
                .slice(0, MAX_CHAT_COUNT)
                .map(serializeChat);
            safeJson(res, 200, { chats: sortedChats });
        } catch (error) {
            safeJson(res, 500, { error: error.message });
        }
        return;
    }

    const messagePathMatch = pathname.match(/^\/api\/chats\/([^/]+)\/messages$/);
    if (req.method === 'GET' && messagePathMatch) {
        if (appState.status !== 'ready') {
            safeJson(res, 409, { error: 'Client is not ready yet.' });
            return;
        }

        const chatId = decodeURIComponent(messagePathMatch[1]);
        const requestedLimit = Number(parsedUrl.searchParams.get('limit') || 40);
        const limit = Number.isFinite(requestedLimit)
            ? Math.max(1, Math.min(requestedLimit, 100))
            : 40;

        try {
            const chat = await client.getChatById(chatId);
            const messages = await chat.fetchMessages({ limit });
            safeJson(res, 200, {
                chat: serializeChat(chat),
                messages: messages
                    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
                    .map(serializeMessage)
            });
        } catch (error) {
            safeJson(res, 500, { error: error.message });
        }
        return;
    }

    if (req.method === 'POST' && pathname === '/api/send') {
        if (appState.status !== 'ready') {
            safeJson(res, 409, { error: 'Client is not ready yet.' });
            return;
        }

        try {
            const { chatId, message } = await readBody(req);

            if (!chatId || typeof chatId !== 'string') {
                safeJson(res, 400, { error: 'chatId is required.' });
                return;
            }

            if (!message || typeof message !== 'string') {
                safeJson(res, 400, { error: 'message is required.' });
                return;
            }

            const sentMessage = await client.sendMessage(chatId, message);
            safeJson(res, 200, { ok: true, message: serializeMessage(sentMessage) });
        } catch (error) {
            const statusCode = error.message.includes('JSON') ? 400 : 500;
            safeJson(res, statusCode, { error: error.message });
        }
        return;
    }

    if (req.method === 'GET' && pathname === '/health') {
        safeJson(res, 200, { ok: true });
        return;
    }

    safeJson(res, 404, { error: 'Not found' });
});

const shutdown = async (signal) => {
    console.log(`\nReceived ${signal}. Shutting down...`);
    server.close();
    for (const res of sseClients) {
        res.end();
    }

    try {
        await client.destroy();
    } catch (error) {
        console.error('Failed to destroy WhatsApp client cleanly:', error.message);
    }

    process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(PORT, HOST, () => {
    console.log(`Codespaces WhatsApp dashboard listening on http://${HOST}:${PORT}`);
    console.log('Open this port in your Codespace and browse to it to authenticate.');
    client.initialize().catch((error) => {
        console.error('Failed to initialize WhatsApp client:', error.message);
        updateState({
            status: 'launch_error',
            authFailure: error.message,
            qr: null
        });
    });
});
