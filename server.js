// server.js — Baileys WhatsApp microservice
// Deploy this to Railway as a Node.js web service

const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    Browsers
} = require('@whiskeysockets/baileys');

const express = require('express');
const qrcode  = require('qrcode');
const pino    = require('pino');
const fs      = require('fs');
const path    = require('path');

// ─── Config ────────────────────────────────────────────────────────────────
const PORT       = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET || 'changeme-set-this-in-railway-dashboard';
const AUTH_DIR   = path.join(__dirname, 'auth_state');

// ─── State ─────────────────────────────────────────────────────────────────
let sock          = null;
let currentQR     = null;   // base64 PNG string
let sessionStatus = 'disconnected'; // 'disconnected' | 'scanning' | 'connected'
let isConnecting  = false;

// ─── Logger (quiet — Render logs will be cleaner) ──────────────────────────
const logger = pino({ level: 'silent' });

// ─── Express app ───────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Auth middleware — every route except /health requires the secret header
function authCheck(req, res, next) {
    const secret = req.headers['x-api-secret'];
    if (secret !== API_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// ─── Routes ────────────────────────────────────────────────────────────────

// UptimeRobot pings this every 5 min to keep Render alive — no auth needed
app.get('/health', (req, res) => {
    res.json({ status: 'ok', whatsapp: sessionStatus });
});

// Returns current QR code as base64 PNG (or null if already connected)
app.get('/qr', authCheck, (req, res) => {
    if (sessionStatus === 'connected') {
        return res.json({ status: 'connected', qr: null });
    }
    if (!currentQR) {
        return res.json({ status: sessionStatus, qr: null });
    }
    res.json({ status: 'scanning', qr: currentQR });
});

// Returns connection status
app.get('/status', authCheck, (req, res) => {
    res.json({ status: sessionStatus });
});

// Send a WhatsApp message
// Body: { phone: "521234567890", message: "Hello" }
app.post('/send', authCheck, async (req, res) => {
    if (sessionStatus !== 'connected') {
        return res.status(503).json({ error: 'WhatsApp not connected', status: sessionStatus });
    }

    const { phone, message } = req.body;
    if (!phone || !message) {
        return res.status(400).json({ error: 'phone and message are required' });
    }

    try {
        // Baileys expects JID format: number@s.whatsapp.net
        // Strip any non-digit characters then format
        const digits = phone.replace(/\D/g, '');
        const jid    = digits + '@s.whatsapp.net';

        await sock.sendMessage(jid, { text: message });
        res.json({ success: true, to: jid });
    } catch (err) {
        console.error('Send error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Clear session and force a new QR scan
app.post('/logout', authCheck, async (req, res) => {
    try {
        if (sock) {
            await sock.logout();
        }
    } catch (_) {}

    // Delete saved auth keys so next connect generates a fresh QR
    if (fs.existsSync(AUTH_DIR)) {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }

    sessionStatus = 'disconnected';
    currentQR     = null;
    sock          = null;
    isConnecting  = false;

    // Reconnect to show a fresh QR
    setTimeout(() => connectToWhatsApp(), 1000);

    res.json({ success: true, message: 'Logged out. New QR will be generated.' });
});

// ─── Retry delay (exponential backoff, max 30s) ────────────────────────────
let retryCount = 0;
function getRetryDelay() {
    const delay = Math.min(1000 * Math.pow(2, retryCount), 30000);
    retryCount++;
    return delay;
}

// ─── Baileys connection logic ───────────────────────────────────────────────
async function connectToWhatsApp() {
    if (isConnecting) return;
    isConnecting = true;

    // Ensure auth directory exists
    if (!fs.existsSync(AUTH_DIR)) {
        fs.mkdirSync(AUTH_DIR, { recursive: true });
    }

    try {
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

        // Use a fixed known-good WA version instead of fetching latest
        // fetchLatestBaileysVersion can fail on cloud servers with no browser
        const version = [2, 3000, 1015901307];

        sock = makeWASocket({
            version,
            logger,
            auth:               state,
            printQRInTerminal:  false,
            // Use Baileys built-in Ubuntu browser fingerprint — less likely to be blocked
            browser:            Browsers.ubuntu('Chrome'),
            connectTimeoutMs:   60_000,
            defaultQueryTimeoutMs: 60_000,
            keepAliveIntervalMs:   10_000,
            retryRequestDelayMs:   2_000,
            maxMsgRetryCount:      3,
            // Prevent Baileys from trying to sync full message history on cloud
            syncFullHistory:    false,
            markOnlineOnConnect: false,
        });

        // Save credentials whenever they update
        sock.ev.on('creds.update', saveCreds);

        // Handle QR generation and connection state
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                sessionStatus = 'scanning';
                currentQR     = null;
                retryCount    = 0; // reset backoff on successful QR
                try {
                    currentQR = await qrcode.toDataURL(qr);
                    console.log('[WA] New QR generated — waiting for phone scan');
                } catch (e) {
                    console.error('[WA] QR generation error:', e.message);
                }
            }

            if (connection === 'open') {
                sessionStatus = 'connected';
                currentQR     = null;
                isConnecting  = false;
                retryCount    = 0;
                console.log('[WA] Connected successfully!');
            }

            if (connection === 'close') {
                isConnecting = false;
                const code   = lastDisconnect?.error?.output?.statusCode;

                console.log('[WA] Disconnected, code:', code);

                if (code === DisconnectReason.loggedOut) {
                    console.log('[WA] Logged out by phone. Clearing session.');
                    if (fs.existsSync(AUTH_DIR)) {
                        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                    }
                    sessionStatus = 'disconnected';
                    currentQR     = null;
                    retryCount    = 0;
                    setTimeout(() => connectToWhatsApp(), 3000);
                } else {
                    sessionStatus = 'disconnected';
                    const delay   = getRetryDelay();
                    console.log(`[WA] Reconnecting in ${delay / 1000}s... (attempt ${retryCount})`);
                    setTimeout(() => connectToWhatsApp(), delay);
                }
            }
        });

    } catch (err) {
        isConnecting  = false;
        const delay   = getRetryDelay();
        console.error('[WA] Setup error:', err.message);
        console.log(`[WA] Retrying in ${delay / 1000}s...`);
        setTimeout(() => connectToWhatsApp(), delay);
    }
}

// ─── Start ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`[Server] Running on port ${PORT}`);
    connectToWhatsApp();
});