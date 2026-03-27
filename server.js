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
const PHP_WEBHOOK_URL = process.env.PHP_WEBHOOK_URL || 'https://bodega.mircalderonmayoreo.com/webhook.php';

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
        const response = await axios.post(PHP_WEBHOOK_URL, messageData, {
            headers: {
                'Content-Type': 'application/json',
                'X-API-Secret': API_SECRET
            },
            timeout: 5000
        });
        
        console.log(`[Webhook] Inbound message logged to PHP: ${response.data?.message || 'Success'}`);
        return true;
    } catch (error) {
        console.error(`[Webhook] Failed to send inbound to PHP:`, error.message);
        if (error.response) {
            console.error(`[Webhook] Response status: ${error.response.status}`);
            console.error(`[Webhook] Response data:`, error.response.data);
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
        
        console.log(`[Webhook] Outbound message logged to PHP for ${phone} (${status})`);
        return true;
    } catch (error) {
        console.error(`[Webhook] Failed to log outbound message:`, error.message);
        return false;
    }
}

// ─── Logger ────────────────────────────────────────────────────────────────
const logger = pino({ level: 'silent' });

// ─── Express ───────────────────────────────────────────────────────────────
const app = express();

// ─── CORS Middleware ─────────────────────────────────────────────────────────
app.use((req, res, next) => {
    // Allow requests from your PHP domain
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
    
    // Allow credentials
    res.header('Access-Control-Allow-Credentials', true);
    
    // Allow specific methods
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    
    // Allow specific headers
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, X-API-Secret');
    
    // Handle preflight requests
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
app.get('/health', (req, res) => {
    res.json({
        status:       'ok',
        whatsapp:     sessionStatus,
        queued:       messageQueue.length,
        stored_chats: Object.keys(historyStore).length,
        stored_msgs:  totalStored,
        skipped_msgs: totalSkipped,
        webhook_url:  PHP_WEBHOOK_URL,
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

// ─── Test Webhook Endpoint ────────────────────────────────────────────────
app.get('/test-webhook', authCheck, (req, res) => {
    res.json({ 
        success: true, 
        message: 'Webhook test successful',
        status: sessionStatus,
        timestamp: new Date().toISOString(),
        endpoints: {
            health: '/health',
            status: '/status',
            webhook: PHP_WEBHOOK_URL
        }
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

// ─── Send message endpoint ────────────────────────────────────────────────
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
        
        console.log(`[Send] Message sent to ${phone}${invoice_id ? ` (Invoice: ${invoice_id})` : ''}`);
        
        logOutboundToPHP(phone, message, 'sent', invoice_id, customer_id, messageId, result).catch(err => {
            console.error('[Send] Failed to log to webhook:', err.message);
        });
        
        res.json({ 
            success: true, 
            to: jid,
            invoice_id: invoice_id || null,
            customer_id: customer_id || null,
            message_id: messageId
        });
    } catch (err) {
        console.error('[Send] Error:', err.message);
        
        logOutboundToPHP(phone, message, 'failed', invoice_id, customer_id, null, { error: err.message }).catch(err => {
            console.error('[Send] Failed to log error to webhook:', err.message);
        });
        
        res.status(500).json({ error: err.message });
    }
});

// ─── Bulk send endpoint ────────────────────────────────────────────────────
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
            
            results.push({
                phone: item.phone,
                success: true,
                invoice_id: item.invoice_id || null,
                message_id: messageId
            });
            
            console.log(`[Bulk Send] Sent to ${item.phone}`);
            
            await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (err) {
            console.error(`[Bulk Send] Failed to send to ${item.phone}:`, err.message);
            
            await logOutboundToPHP(item.phone, item.message, 'failed', item.invoice_id, item.customer_id, null, { error: err.message });
            
            results.push({
                phone: item.phone,
                success: false,
                error: err.message,
                invoice_id: item.invoice_id || null
            });
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

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            console.log(`[WA] messages.upsert type=${type} count=${messages.length}`);

            for (const msg of messages) {
                const jid = msg.key?.remoteJid;
                if (!jid || jid.endsWith('@g.us') || jid.endsWith('@broadcast')) continue;
                if (!msg.message) continue;

                global._lastRawMsg = {
                    type,
                    key:      msg.key,
                    pushName: msg.pushName,
                    msgKeys:  Object.keys(msg.message),
                    timestamp: msg.messageTimestamp,
                };

                const phone  = jid.replace('@s.whatsapp.net', '').replace(/[^0-9]/g, '');
                const fromMe = msg.key?.fromMe || false;

                storeMessage(phone, msg);

                if (type === 'notify' && !fromMe) {
                    const body = extractBody(msg);
                    if (!body) continue;

                    messageSeq++;
                    const queuedMsg = {
                        seq:          messageSeq,
                        baileys_id:   msg.key.id,
                        phone,
                        contact_name: msg.pushName || '',
                        body,
                        msg_type:     extractType(msg),
                        timestamp:    msg.messageTimestamp,
                    };
                    messageQueue.push(queuedMsg);

                    if (messageQueue.length > 200) messageQueue = messageQueue.slice(-200);
                    console.log(`[WA] Live inbound from ${phone}: ${body.substring(0, 60)}`);

                    const webhookData = {
                        message: {
                            id: msg.key.id,
                            from: phone,
                            text: body,
                            type: extractType(msg),
                            timestamp: msg.messageTimestamp,
                            pushName: msg.pushName || '',
                            fromMe: false
                        }
                    };
                    
                    sendToPHPWebhook(webhookData).catch(err => {
                        console.error('[WA] Webhook error:', err.message);
                    });
                }
                
                if (type === 'notify' && fromMe) {
                    const body = extractBody(msg);
                    if (body) {
                        console.log(`[WA] Outbound message sent to ${phone}: ${body.substring(0, 60)}`);
                        logOutboundToPHP(phone, body, 'sent', null, null, msg.key.id, { source: 'manual' }).catch(err => {
                            console.error('[WA] Failed to log outbound message:', err.message);
                        });
                    }
                }
            }

            console.log(`[WA] Store: ${totalStored} stored, ${totalSkipped} skipped`);
        });

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
                console.log('[WA] Connected! Ready to receive and send messages.');
                
                const startupData = {
                    event: 'startup',
                    status: 'connected',
                    timestamp: new Date().toISOString()
                };
                sendToPHPWebhook(startupData).catch(err => {
                    console.error('[WA] Startup webhook error:', err.message);
                });
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
    console.log(`[Server] PHP Webhook URL: ${PHP_WEBHOOK_URL}`);
    console.log(`[Server] API Secret: ${API_SECRET.substring(0, 10)}...`);
    console.log(`[Server] CORS enabled for: bodega.mircalderonmayoreo.com`);
    console.log(`[Server] Test endpoints:`);
    console.log(`  GET  /test-webhook - Test webhook connection`);
    console.log(`  GET  /health       - Health check`);
    console.log(`  GET  /status       - WhatsApp status`);
    connectToWhatsApp();
});