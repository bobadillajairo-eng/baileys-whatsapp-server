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
const API_SECRET = process.env.API_SECRET || 'mircalderon_wa_2026_xk9q';
const AUTH_DIR   = path.join(__dirname, 'auth_state');

// ─── State ─────────────────────────────────────────────────────────────────
let sock          = null;
let currentQR     = null;
let sessionStatus = 'disconnected';
let isConnecting  = false;
let retryCount    = 0;

// ─── Message queue (inbound — PHP polls this) ──────────────────────────────
let messageQueue = [];
let messageSeq   = 0;

// ─── Simple history store (replaces makeInMemoryStore) ────────────────────
// key: phone number, value: array of message objects
const historyStore = {};

function storeMessage(phone, msg, fromMe) {
    if (!historyStore[phone]) historyStore[phone] = [];

    const body =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        null;

    if (!body) return; // skip media with no caption

    let msgType = 'text';
    if (msg.message?.imageMessage)    msgType = 'image';
    if (msg.message?.audioMessage)    msgType = 'audio';
    if (msg.message?.videoMessage)    msgType = 'video';
    if (msg.message?.documentMessage) msgType = 'document';

    historyStore[phone].push({
        baileys_id:   msg.key.id,
        phone,
        contact_name: msg.pushName || '',
        body,
        msg_type:     msgType,
        from_me:      fromMe ? 1 : 0,
        timestamp:    msg.messageTimestamp,
    });

    // Cap per-contact history at 1000 messages
    if (historyStore[phone].length > 1000) {
        historyStore[phone] = historyStore[phone].slice(-1000);
    }
}

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
    const phones  = Object.keys(historyStore).length;
    const total   = Object.values(historyStore).reduce((s, a) => s + a.length, 0);
    res.json({ status: 'ok', whatsapp: sessionStatus, queued: messageQueue.length, stored_chats: phones, stored_msgs: total });
});

app.get('/qr', authCheck, (req, res) => {
    if (sessionStatus === 'connected') return res.json({ status: 'connected', qr: null });
    if (!currentQR)                    return res.json({ status: sessionStatus, qr: null });
    res.json({ status: 'scanning', qr: currentQR });
});

app.get('/status', authCheck, (req, res) => {
    res.json({ status: sessionStatus });
});

// PHP polls this for live inbound messages
app.get('/messages', authCheck, (req, res) => {
    res.json({ messages: messageQueue });
});

// PHP ACKs processed messages
app.post('/messages/ack', authCheck, (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids must be an array' });
    const before = messageQueue.length;
    messageQueue = messageQueue.filter(m => !ids.includes(m.seq));
    res.json({ removed: before - messageQueue.length, remaining: messageQueue.length });
});

// Full history sync — PHP calls this once to import all stored messages
app.get('/sync', authCheck, (req, res) => {
    if (sessionStatus !== 'connected') {
        return res.status(503).json({ error: 'WhatsApp not connected' });
    }

    const offset = parseInt(req.query.offset) || 0;
    const limit  = parseInt(req.query.limit)  || 200;

    // Flatten all messages from all chats, sort oldest first
    const all = [];
    for (const msgs of Object.values(historyStore)) {
        for (const m of msgs) all.push(m);
    }
    all.sort((a, b) => a.timestamp - b.timestamp);

    const total   = all.length;
    const sliced  = all.slice(offset, offset + limit);
    const hasMore = (offset + limit) < total;

    res.json({ total, offset, limit, has_more: hasMore, messages: sliced });
});

app.post('/send', authCheck, async (req, res) => {
    if (sessionStatus !== 'connected') {
        return res.status(503).json({ error: 'WhatsApp not connected', status: sessionStatus });
    }
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'phone and message are required' });
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
            syncFullHistory:       true,
            markOnlineOnConnect:   false,
        });

        sock.ev.on('creds.update', saveCreds);

        // ── Capture ALL messages (history + live) into historyStore ─────────
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            for (const msg of messages) {
                const jid = msg.key.remoteJid;
                if (!jid || jid.endsWith('@g.us') || jid.endsWith('@broadcast')) continue;
                if (!msg.message) continue;

                const phone   = jid.replace('@s.whatsapp.net', '').replace(/[^0-9]/g, '');
                const fromMe  = msg.key.fromMe;

                // Store every message (history + live) for /sync
                storeMessage(phone, msg, fromMe);

                // Only queue LIVE inbound messages for real-time processing
                if (type === 'notify' && !fromMe) {
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
                    messageQueue.push({
                        seq:          messageSeq,
                        baileys_id:   msg.key.id,
                        phone,
                        contact_name: msg.pushName || '',
                        body,
                        msg_type:     msgType,
                        timestamp:    msg.messageTimestamp,
                    });

                    if (messageQueue.length > 200) messageQueue = messageQueue.slice(-200);
                    console.log(`[WA] Live inbound from ${phone}: ${body.substring(0, 60)}`);
                }
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
                console.log('[WA] Connected! Syncing history into store...');
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
    connectToWhatsApp();
});