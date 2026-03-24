// server.js — Baileys WhatsApp microservice
// Deploy this to Render as a Node.js web service

const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeInMemoryStore
} = require('@whiskeysockets/baileys');

const express = require('express');
const qrcode  = require('qrcode');
const pino    = require('pino');
const fs      = require('fs');
const path    = require('path');

// ─── Config ────────────────────────────────────────────────────────────────
const PORT       = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET || 'changeme-set-this-in-render-dashboard';
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

// ─── Baileys connection logic ───────────────────────────────────────────────
async function connectToWhatsApp() {
    if (isConnecting) return;
    isConnecting = true;

    // Ensure auth directory exists
    if (!fs.existsSync(AUTH_DIR)) {
        fs.mkdirSync(AUTH_DIR, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version }          = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        logger,
        auth:            state,
        printQRInTerminal: false,       // we handle QR ourselves
        browser:         ['CRM', 'Chrome', '110.0.0'],
        connectTimeoutMs: 60_000,
        defaultQueryTimeoutMs: 60_000,
        keepAliveIntervalMs:   25_000,  // keep WS alive inside Render
    });

    // Save credentials whenever they update
    sock.ev.on('creds.update', saveCreds);

    // Handle QR generation
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            sessionStatus = 'scanning';
            currentQR     = null;
            try {
                // Convert QR string to base64 PNG for easy display in browser
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
            console.log('[WA] Connected successfully!');
        }

        if (connection === 'close') {
            isConnecting  = false;
            const code    = lastDisconnect?.error?.output?.statusCode;
            const reason  = DisconnectReason;

            console.log('[WA] Disconnected, code:', code);

            if (code === reason.loggedOut) {
                // Phone explicitly logged out — clear keys, show new QR
                console.log('[WA] Logged out by phone. Clearing session.');
                if (fs.existsSync(AUTH_DIR)) {
                    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                }
                sessionStatus = 'disconnected';
                currentQR     = null;
                setTimeout(() => connectToWhatsApp(), 3000);
            } else {
                // Temporary disconnect — reconnect automatically
                sessionStatus = 'disconnected';
                console.log('[WA] Reconnecting in 5s...');
                setTimeout(() => connectToWhatsApp(), 5000);
            }
        }
    });
}

// ─── Start ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`[Server] Running on port ${PORT}`);
    connectToWhatsApp();
});
