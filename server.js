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
import axios from 'axios';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ────────────────────────────────────────────────────────────────
const PORT       = process.env.PORT       || 3000;
const API_SECRET = process.env.API_SECRET || 'mircalderon_wa_2026_xk9q';
const AUTH_DIR   = path.join(__dirname, 'auth_state');
const PHP_WEBHOOK_URL = process.env.PHP_WEBHOOK_URL || 'https://bodega.mircalderonmayoreo.com/api/webhook.php';

// ─── State ─────────────────────────────────────────────────────────────────
let sock          = null;
let currentQR     = null;
let sessionStatus = 'disconnected';
let isConnecting  = false;
let retryCount    = 0;

// ─── Message queue (inbound — PHP polls this) ──────────────────────────────
let messageQueue = [];
let messageSeq   = 0;

// ─── History store ─────────────────────────────────────────────────────────
const historyStore = {};
let totalStored    = 0;
let totalSkipped   = 0;

// ─── Keep-alive timer ──────────────────────────────────────────────────────
let lastPingTime = Date.now();
let pingCount = 0;

function extractBody(msg) {
    const m = msg.message;
    if (!m) return null;

    const inner = m.ephemeralMessage?.message
               || m.viewOnceMessage?.message
               || m.viewOnceMessageV2?.message
               || m;

    return inner.conversation
        || inner.extendedTextMessage?.text
        || inner.imageMessage?.caption
        || inner.videoMessage?.caption
        || inner.buttonsResponseMessage?.selectedDisplayText
        || inner.listResponseMessage?.title
        || inner.templateButtonReplyMessage?.selectedDisplayText
        || null;
}

function extractType(msg) {
    const m = msg.message || {};
    if (m.imageMessage)    return 'image';
    if (m.audioMessage)    return 'audio';
    if (m.videoMessage)    return 'video';
    if (m.documentMessage) return 'document';
    return 'text';
}

// Improved phone number formatter
function formatPhoneNumber(rawJid) {
    try {
        let phone = rawJid.replace('@s.whatsapp.net', '');
        let digits = phone.replace(/[^0-9]/g, '');
        
        if (!digits) return rawJid;
        
        digits = digits.replace(/^0+/, '');
        
        if (digits.length === 10) {
            digits = '52' + digits;
        }
        
        if (digits.length > 13) {
            digits = digits.slice(-13);
        }
        
        if (digits.startsWith('52')) {
            return '+' + digits;
        }
        
        return '+' + digits;
    } catch (error) {
        console.error('[WA] Phone formatting error:', error);
        return rawJid;
    }
}

function storeMessage(phone, msg) {
    const body = extractBody(msg);

    if (!body) {
        totalSkipped++;
        return;
    }

    if (!historyStore[phone]) historyStore[phone] = [];

    historyStore[phone].push({
        baileys_id:   msg.key?.id || null,
        phone,
        contact_name: msg.pushName || '',
        body,
        msg_type:     extractType(msg),
        from_me:      msg.key?.fromMe ? 1 : 0,
        timestamp:    msg.messageTimestamp || Math.floor(Date.now() / 1000),
    });

    totalStored++;

    if (historyStore[phone].length > 1000) {
        historyStore[phone] = historyStore[phone].slice(-1000);
    }
}

// ─── Send inbound message to PHP webhook ───────────────────────────────────
async function sendToPHPWebhook(messageData) {
    try {
        console.log(`[Webhook] Sending to: ${PHP_WEBHOOK_URL}`);
        const response = await axios.post(PHP_WEBHOOK_URL, messageData, {
            headers: {
                'Content-Type': 'application/json',
                'X-API-Secret': API_SECRET
            },
            timeout: 10000
        });
        
        console.log(`[Webhook] Success: ${response.data?.message || 'Logged'}`);
        return true;
    } catch (error) {
        console.error(`[Webhook] ERROR:`, error.message);
        if (error.response) {
            console.error(`[Webhook] Response status: ${error.response.status}`);
        }
        return false;
    }
}

// ─── Send outbound message to PHP webhook ──────────────────────────────────
async function logOutboundToPHP(phone, message, status, invoiceId = null, customerId = null, messageId = null, response = null) {
    try {
        const webhookData = {
            outbound: true,
            phone: phone,
            message: message,
            status: status,
            invoice_id: invoiceId,
            customer_id: customerId,
            message_id: messageId,
            message_type: 'text',
            response: response,
            timestamp: new Date().toISOString()
        };
        
        await axios.post(PHP_WEBHOOK_URL, webhookData, {
            headers: {
                'Content-Type': 'application/json',
                'X-API-Secret': API_SECRET
            },
            timeout: 5000
        });
        
        console.log(`[Webhook] Outbound logged: ${phone} (${status})`);
        return true;
    } catch (error) {
        console.error(`[Webhook] Outbound log error:`, error.message);
        return false;
    }
}

// ─── Logger ────────────────────────────────────────────────────────────────
const logger = pino({ level: 'silent' });

// ─── Express ───────────────────────────────────────────────────────────────
const app = express();

// ─── CORS Middleware ─────────────────────────────────────────────────────────
app.use((req, res, next) => {
    const allowedOrigins = [
        'https://bodega.mircalderonmayoreo.com',
        'http://bodega.mircalderonmayoreo.com',
        'https://www.bodega.mircalderonmayoreo.com',
        'http://localhost:3000',
        'http://localhost:80',
        'http://localhost'
    ];
    
    const origin = req.headers.origin;
    
    if (allowedOrigins.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin);
    }
    
    res.header('Access-Control-Allow-Credentials', true);
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, X-API-Secret');
    
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    
    next();
});

app.use(express.json());

function authCheck(req, res, next) {
    if (req.headers['x-api-secret'] !== API_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// ─── Routes ────────────────────────────────────────────────────────────────

// Keep-alive / ping endpoint - no authentication required
app.get('/ping', (req, res) => {
    lastPingTime = Date.now();
    pingCount++;
    
    res.json({ 
        status: 'alive', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        ping_count: pingCount,
        whatsapp_status: sessionStatus,
        memory: {
            rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + ' MB',
            heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + ' MB',
            heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB'
        }
    });
});

// Simple status endpoint without authentication (for quick checks)
app.get('/simple-status', (req, res) => {
    res.json({ 
        status: sessionStatus,
        connected: sessionStatus === 'connected',
        uptime: process.uptime(),
        last_ping: new Date(lastPingTime).toISOString(),
        ping_count: pingCount,
        timestamp: new Date().toISOString()
    });
});

// Root endpoint for quick check
app.get('/', (req, res) => {
    res.json({ 
        service: 'Baileys WhatsApp Service',
        status: sessionStatus,
        version: '1.0.0',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        endpoints: {
            health: '/health',
            status: '/status',
            ping: '/ping',
            simple_status: '/simple-status',
            qr: '/qr',
            send: '/send (POST)',
            send_bulk: '/send-bulk (POST)'
        }
    });
});

app.get('/health', (req, res) => {
    res.json({
        status:       'ok',
        whatsapp:     sessionStatus,
        queued:       messageQueue.length,
        stored_chats: Object.keys(historyStore).length,
        stored_msgs:  totalStored,
        skipped_msgs: totalSkipped,
        webhook_url:  PHP_WEBHOOK_URL,
        uptime:       process.uptime(),
        ping_count:   pingCount
    });
});

app.get('/qr', authCheck, (req, res) => {
    if (sessionStatus === 'connected') return res.json({ status: 'connected', qr: null });
    if (!currentQR)                    return res.json({ status: sessionStatus, qr: null });
    res.json({ status: 'scanning', qr: currentQR });
});

app.get('/status', authCheck, (req, res) => {
    res.json({ status: sessionStatus });
});

app.get('/messages', authCheck, (req, res) => {
    res.json({ messages: messageQueue });
});

app.post('/messages/ack', authCheck, (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids must be an array' });
    const before = messageQueue.length;
    messageQueue = messageQueue.filter(m => !ids.includes(m.seq));
    res.json({ removed: before - messageQueue.length, remaining: messageQueue.length });
});

app.get('/debug/last', authCheck, (req, res) => {
    res.json({ last_raw: global._lastRawMsg || null });
});

app.get('/sync', authCheck, (req, res) => {
    if (sessionStatus !== 'connected') {
        return res.status(503).json({ error: 'WhatsApp not connected' });
    }

    const offset = parseInt(req.query.offset) || 0;
    const limit  = parseInt(req.query.limit)  || 200;

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

app.get('/test-webhook', authCheck, (req, res) => {
    res.json({ 
        success: true, 
        message: 'Webhook test successful',
        status: sessionStatus,
        timestamp: new Date().toISOString()
    });
});

app.post('/test-webhook', authCheck, (req, res) => {
    res.json({ 
        success: true, 
        message: 'Webhook POST test successful',
        received: req.body,
        status: sessionStatus,
        timestamp: new Date().toISOString()
    });
});

app.post('/send', authCheck, async (req, res) => {
    if (sessionStatus !== 'connected') {
        return res.status(503).json({ error: 'WhatsApp not connected', status: sessionStatus });
    }
    
    const { phone, message, invoice_id, customer_id } = req.body;
    
    if (!phone || !message) {
        return res.status(400).json({ error: 'phone and message are required' });
    }
    
    try {
        let jid = phone.toString().replace(/\D/g, '');
        if (!jid.endsWith('@s.whatsapp.net')) {
            jid = jid + '@s.whatsapp.net';
        }
        
        const result = await sock.sendMessage(jid, { text: message });
        const messageId = result.key?.id;
        
        console.log(`[Send] Sent to ${phone}`);
        
        logOutboundToPHP(phone, message, 'sent', invoice_id, customer_id, messageId, result);
        
        res.json({ success: true, message_id: messageId });
    } catch (err) {
        console.error('[Send] Error:', err.message);
        logOutboundToPHP(phone, message, 'failed', invoice_id, customer_id, null, { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

app.post('/send-bulk', authCheck, async (req, res) => {
    if (sessionStatus !== 'connected') {
        return res.status(503).json({ error: 'WhatsApp not connected', status: sessionStatus });
    }
    
    const { messages } = req.body;
    
    if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: 'messages array is required' });
    }
    
    const results = [];
    
    for (const item of messages) {
        try {
            let jid = item.phone.toString().replace(/\D/g, '');
            if (!jid.endsWith('@s.whatsapp.net')) {
                jid = jid + '@s.whatsapp.net';
            }
            
            const result = await sock.sendMessage(jid, { text: item.message });
            const messageId = result.key?.id;
            
            await logOutboundToPHP(item.phone, item.message, 'sent', item.invoice_id, item.customer_id, messageId, result);
            
            results.push({ phone: item.phone, success: true, message_id: messageId });
            await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (err) {
            console.error(`[Bulk Send] Failed: ${item.phone}`, err.message);
            await logOutboundToPHP(item.phone, item.message, 'failed', item.invoice_id, item.customer_id, null, { error: err.message });
            results.push({ phone: item.phone, success: false, error: err.message });
        }
    }
    
    res.json({ 
        success: true, 
        total: messages.length,
        successful: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
        results 
    });
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
    res.json({ success: true, message: 'Logged out' });
});

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
        console.log(`[WA] Version ${version.join('.')}`);

        sock = makeWASocket({
            version,
            logger,
            auth: state,
            printQRInTerminal: false,
            browser: Browsers.ubuntu('Chrome'),
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 10000,
            retryRequestDelayMs: 2000,
            maxMsgRetryCount: 3,
            syncFullHistory: true,
            markOnlineOnConnect: false,
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            console.log(`[WA] messages.upsert type=${type} count=${messages.length}`);

            for (const msg of messages) {
                const jid = msg.key?.remoteJid;
                if (!jid || jid.endsWith('@g.us') || jid.endsWith('@broadcast')) continue;
                if (!msg.message) continue;

                const formattedPhone = formatPhoneNumber(jid);
                const fromMe = msg.key?.fromMe || false;
                
                console.log(`[WA] Original JID: ${jid}`);
                console.log(`[WA] Formatted phone: ${formattedPhone}`);

                storeMessage(formattedPhone, msg);

                if (type === 'notify' && !fromMe) {
                    const body = extractBody(msg);
                    if (!body) continue;

                    messageSeq++;
                    const queuedMsg = {
                        seq: messageSeq,
                        baileys_id: msg.key.id,
                        phone: formattedPhone,
                        contact_name: msg.pushName || '',
                        body: body,
                        msg_type: extractType(msg),
                        timestamp: msg.messageTimestamp,
                    };
                    messageQueue.push(queuedMsg);
                    
                    if (messageQueue.length > 200) messageQueue = messageQueue.slice(-200);
                    console.log(`[WA] Inbound from ${formattedPhone}: ${body.substring(0, 50)}`);

                    const webhookData = {
                        message: {
                            id: msg.key.id,
                            from: formattedPhone,
                            text: body,
                            type: extractType(msg),
                            timestamp: msg.messageTimestamp,
                            pushName: msg.pushName || '',
                            fromMe: false
                        }
                    };
                    
                    await sendToPHPWebhook(webhookData);
                }
                
                if (type === 'notify' && fromMe) {
                    const body = extractBody(msg);
                    if (body) {
                        console.log(`[WA] Outbound to ${formattedPhone}: ${body.substring(0, 50)}`);
                        await logOutboundToPHP(formattedPhone, body, 'sent', null, null, msg.key.id, { source: 'manual' });
                    }
                }
            }
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                sessionStatus = 'scanning';
                currentQR = null;
                retryCount = 0;
                try {
                    currentQR = await qrcode.toDataURL(qr);
                    console.log('[WA] QR generated');
                } catch (e) {
                    console.error('[WA] QR error:', e.message);
                }
            }

            if (connection === 'open') {
                sessionStatus = 'connected';
                currentQR = null;
                isConnecting = false;
                retryCount = 0;
                console.log('[WA] Connected! Ready to receive and send messages.');
            }

            if (connection === 'close') {
                isConnecting = false;
                const code = lastDisconnect?.error?.output?.statusCode;
                console.log('[WA] Disconnected, code:', code);

                if (code === DisconnectReason.loggedOut) {
                    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                    sessionStatus = 'disconnected';
                    currentQR = null;
                    retryCount = 0;
                    setTimeout(() => connectToWhatsApp(), 3000);
                } else {
                    sessionStatus = 'disconnected';
                    const delay = getRetryDelay();
                    console.log(`[WA] Reconnecting in ${delay / 1000}s...`);
                    setTimeout(() => connectToWhatsApp(), delay);
                }
            }
        });

    } catch (err) {
        isConnecting = false;
        const delay = getRetryDelay();
        console.error('[WA] Setup error:', err.message);
        setTimeout(() => connectToWhatsApp(), delay);
    }
}

// ─── Self-ping to prevent sleep (if deployed on Railway) ───────────────────
if (process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT) {
    const selfPing = async () => {
        try {
            const response = await axios.get(`http://localhost:${PORT}/ping`);
            console.log(`[Self-ping] Keep-alive ping sent - Status: ${response.status}`);
        } catch (err) {
            console.error(`[Self-ping] Failed:`, err.message);
        }
    };
    
    // Ping every 4 minutes
    setInterval(selfPing, 240000);
    console.log('[Self-ping] Enabled - pinging every 4 minutes');
}

// ─── Start ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`[Server] Running on port ${PORT}`);
    console.log(`[Server] Webhook URL: ${PHP_WEBHOOK_URL}`);
    console.log(`[Server] API Secret: ${API_SECRET.substring(0, 10)}...`);
    console.log(`[Server] Keep-alive endpoints:`);
    console.log(`  GET  /ping        - Keep-alive ping (no auth)`);
    console.log(`  GET  /simple-status - Quick status check (no auth)`);
    console.log(`  GET  /health      - Health check (requires auth)`);
    console.log(`  GET  /status      - WhatsApp status (requires auth)`);
    connectToWhatsApp();
});