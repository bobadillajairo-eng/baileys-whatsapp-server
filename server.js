// server.js — Baileys WhatsApp microservice (ESM)
import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    Browsers
} from '@whiskeysockets/baileys';

import express from 'express';
import qrcode  from 'qrcode';
import pino    from 'pino';
import fs      from 'fs';
import path    from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ────────────────────────────────────────────────────────────────
const PORT       = process.env.PORT       || 3000;
const API_SECRET = process.env.API_SECRET || 'changeme-set-this-in-railway-dashboard';
const AUTH_DIR   = path.join(__dirname, 'auth_state');

// ─── State ─────────────────────────────────────────────────────────────────
let sock          = null;
let currentQR     = null;
let sessionStatus = 'disconnected';
let isConnecting  = false;
let retryCount    = 0;

// ─── Message queue (in-memory) ─────────────────────────────────────────────
// PHP polls GET /messages to pick these up, then ACKs them
let messageQueue = [];
let messageSeq   = 0; // ever-incrementing ID so PHP can dedup

// ─── Logger ────────────────────────────────────────────────────────────────
const logger = pino({ level: 'silent' });

// ─── Express ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

function authCheck(req, res, next) {
    if (req.headers['x-api-secret'] !== API_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// ─── Routes ────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
    res.json({ status: 'ok', whatsapp: sessionStatus, queued: messageQueue.length });
});

app.get('/qr', authCheck, (req, res) => {
    if (sessionStatus === 'connected') return res.json({ status: 'connected', qr: null });
    if (!currentQR)                    return res.json({ status: sessionStatus, qr: null });
    res.json({ status: 'scanning', qr: currentQR });
});

app.get('/status', authCheck, (req, res) => {
    res.json({ status: sessionStatus });
});

// PHP polls this to get pending inbound messages
app.get('/messages', authCheck, (req, res) => {
    res.json({ messages: messageQueue });
});

// PHP calls this after processing messages to clear the queue
// Body: { ids: [1, 2, 3] }
app.post('/messages/ack', authCheck, (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids)) {
        return res.status(400).json({ error: 'ids must be an array' });
    }
    const before = messageQueue.length;
    messageQueue = messageQueue.filter(m => !ids.includes(m.seq));
    res.json({ removed: before - messageQueue.length, remaining: messageQueue.length });
});

app.post('/send', authCheck, async (req, res) => {
    if (sessionStatus !== 'connected') {
        return res.status(503).json({ error: 'WhatsApp not connected', status: sessionStatus });
    }
    const { phone, message } = req.body;
    if (!phone || !message) {
        return res.status(400).json({ error: 'phone and message are required' });
    }
    try {
        const jid = phone.replace(/\D/g, '') + '@s.whatsapp.net';
        await sock.sendMessage(jid, { text: message });
        res.json({ success: true, to: jid });
    } catch (err) {
        console.error('Send error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/logout', authCheck, async (req, res) => {
    try { if (sock) await sock.logout(); } catch (_) {}
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    sessionStatus = 'disconnected';
    currentQR     = null;
    sock          = null;
    isConnecting  = false;
    retryCount    = 0;
    messageQueue  = [];
    setTimeout(() => connectToWhatsApp(), 1000);
    res.json({ success: true, message: 'Logged out. New QR will be generated.' });
});

// ─── Retry delay ───────────────────────────────────────────────────────────
function getRetryDelay() {
    const delay = Math.min(1000 * Math.pow(2, retryCount), 30000);
    retryCount++;
    return delay;
}

// ─── Baileys ───────────────────────────────────────────────────────────────
async function connectToWhatsApp() {
    if (isConnecting) return;
    isConnecting = true;

    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

    try {
        const { state, saveCreds }  = await useMultiFileAuthState(AUTH_DIR);
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`[WA] Using WA version ${version.join('.')} — isLatest: ${isLatest}`);

        sock = makeWASocket({
            version,
            logger,
            auth:                  state,
            printQRInTerminal:     false,
            browser:               Browsers.ubuntu('Chrome'),
            connectTimeoutMs:      60_000,
            defaultQueryTimeoutMs: 60_000,
            keepAliveIntervalMs:   10_000,
            retryRequestDelayMs:   2_000,
            maxMsgRetryCount:      3,
            syncFullHistory:       false,
            markOnlineOnConnect:   false,
        });

        sock.ev.on('creds.update', saveCreds);

        // ── Incoming messages → queue ───────────────────────────────────────
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;

            for (const msg of messages) {
                if (msg.key.fromMe) continue;

                const jid = msg.key.remoteJid;
                if (!jid || jid.endsWith('@g.us')) continue;

                const phone = jid.replace('@s.whatsapp.net', '').replace(/[^0-9]/g, '');

                const body =
                    msg.message?.conversation ||
                    msg.message?.extendedTextMessage?.text ||
                    msg.message?.imageMessage?.caption ||
                    msg.message?.videoMessage?.caption ||
                    '[media]';

                let msgType = 'text';
                if (msg.message?.imageMessage)    msgType = 'image';
                if (msg.message?.audioMessage)    msgType = 'audio';
                if (msg.message?.videoMessage)    msgType = 'video';
                if (msg.message?.documentMessage) msgType = 'document';

                messageSeq++;
                const queueItem = {
                    seq:          messageSeq,
                    baileys_id:   msg.key.id,
                    phone,
                    contact_name: msg.pushName || '',
                    body,
                    msg_type:     msgType,
                    timestamp:    msg.messageTimestamp,
                };

                messageQueue.push(queueItem);

                // Keep queue from growing unbounded (max 200 messages)
                if (messageQueue.length > 200) {
                    messageQueue = messageQueue.slice(-200);
                }

                console.log(`[WA] Queued inbound from ${phone}: ${body.substring(0, 60)} (seq:${messageSeq})`);
            }
        });

        // ── Connection state ────────────────────────────────────────────────
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                sessionStatus = 'scanning';
                currentQR     = null;
                retryCount    = 0;
                try {
                    currentQR = await qrcode.toDataURL(qr);
                    console.log('[WA] QR generated — waiting for scan');
                } catch (e) {
                    console.error('[WA] QR error:', e.message);
                }
            }

            if (connection === 'open') {
                sessionStatus = 'connected';
                currentQR     = null;
                isConnecting  = false;
                retryCount    = 0;
                console.log('[WA] Connected!');
            }

            if (connection === 'close') {
                isConnecting = false;
                const code   = lastDisconnect?.error?.output?.statusCode;
                console.log('[WA] Disconnected, code:', code);

                if (code === DisconnectReason.loggedOut) {
                    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                    sessionStatus = 'disconnected';
                    currentQR     = null;
                    retryCount    = 0;
                    setTimeout(() => connectToWhatsApp(), 3000);
                } else {
                    sessionStatus = 'disconnected';
                    const delay   = getRetryDelay();
                    console.log(`[WA] Reconnecting in ${delay / 1000}s...`);
                    setTimeout(() => connectToWhatsApp(), delay);
                }
            }
        });

    } catch (err) {
        isConnecting = false;
        const delay  = getRetryDelay();
        console.error('[WA] Setup error:', err.message);
        setTimeout(() => connectToWhatsApp(), delay);
    }
}

// ─── Start ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`[Server] Running on port ${PORT}`);
    console.log(`[Server] Pull-mode queue active — PHP polls /messages to fetch inbound`);
    connectToWhatsApp();
});