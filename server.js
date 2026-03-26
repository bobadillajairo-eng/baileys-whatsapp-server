// server.js — Complete version with sync endpoints
import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    Browsers
} from '@whiskeysockets/baileys';

import express from 'express';
import qrcode from 'qrcode';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import { Server } from 'socket.io';
import http from 'http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ────────────────────────────────────────────────────────────────
const PORT       = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET || 'changeme-set-this-in-railway-dashboard';
const AUTH_DIR   = path.join(__dirname, 'auth_state');

// Database configuration
const DB_CONFIG = {
    host: process.env.DB_HOST || 'db5019972151.hosting-data.io',
    user: process.env.DB_USER || 'dbu165976',
    password: process.env.DB_PASSWORD || 'J0528B1994?',
    database: process.env.DB_NAME || 'dbs15415260',
    waitForConnections: true,
    connectionLimit: 10
};

// ─── State ─────────────────────────────────────────────────────────────────
let sock          = null;
let currentQR     = null;
let sessionStatus = 'disconnected';
let isConnecting  = false;
let retryCount    = 0;
let db            = null;
let io            = null;
let syncInProgress = false;

// ─── Logger ────────────────────────────────────────────────────────────────
const logger = pino({ level: 'silent' });

// ─── Express & Socket.io Setup ─────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
io = new Server(server, {
    cors: {
        origin: process.env.CORS_ORIGIN || '*',
        methods: ["GET", "POST"]
    }
});

app.use(express.json());

// ─── Authentication Middleware ────────────────────────────────────────────
function authCheck(req, res, next) {
    const token = req.headers['x-api-secret'] || req.query.api_secret;
    if (token !== API_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// ─── Database Functions ───────────────────────────────────────────────────
async function initDatabase() {
    try {
        db = await mysql.createPool(DB_CONFIG);
        await db.query('SELECT 1');
        console.log('[DB] Connected to MySQL');
        await ensureTablesExist();
        return true;
    } catch (err) {
        console.error('[DB] Connection error:', err.message);
        return false;
    }
}

async function ensureTablesExist() {
    await db.query(`
        CREATE TABLE IF NOT EXISTS whatsapp_contacts (
            id INT PRIMARY KEY AUTO_INCREMENT,
            phone_number VARCHAR(20) UNIQUE NOT NULL,
            name VARCHAR(255),
            customer_id INT,
            last_message TEXT,
            last_message_at DATETIME,
            last_seen DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_phone (phone_number)
        )
    `);
    
    await db.query(`
        CREATE TABLE IF NOT EXISTS whatsapp_messages (
            id INT PRIMARY KEY AUTO_INCREMENT,
            contact_id INT NOT NULL,
            message_id VARCHAR(100) UNIQUE,
            message TEXT,
            direction ENUM('incoming', 'outgoing') NOT NULL,
            is_read BOOLEAN DEFAULT FALSE,
            raw_data JSON,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (contact_id) REFERENCES whatsapp_contacts(id) ON DELETE CASCADE,
            INDEX idx_contact (contact_id)
        )
    `);
    
    await db.query(`
        CREATE TABLE IF NOT EXISTS whatsapp_sync_log (
            id INT PRIMARY KEY AUTO_INCREMENT,
            sync_type VARCHAR(50),
            last_sync_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            messages_synced INT DEFAULT 0,
            contacts_synced INT DEFAULT 0,
            status VARCHAR(20) DEFAULT 'completed',
            error_message TEXT,
            INDEX idx_sync_type (sync_type)
        )
    `);
    
    console.log('[DB] Tables verified');
}

async function getOrCreateContact(phoneNumber, name = null) {
    const cleanPhone = phoneNumber.replace(/\D/g, '');
    
    const [contacts] = await db.query(
        'SELECT * FROM whatsapp_contacts WHERE phone_number = ?',
        [cleanPhone]
    );
    
    if (contacts.length > 0) {
        await db.query(
            'UPDATE whatsapp_contacts SET last_seen = NOW() WHERE id = ?',
            [contacts[0].id]
        );
        return contacts[0];
    }
    
    const [result] = await db.query(
        'INSERT INTO whatsapp_contacts (phone_number, name, created_at) VALUES (?, ?, NOW())',
        [cleanPhone, name || cleanPhone]
    );
    
    const [newContact] = await db.query(
        'SELECT * FROM whatsapp_contacts WHERE id = ?',
        [result.insertId]
    );
    
    return newContact[0];
}

async function saveMessage(contactId, messageId, message, direction, rawMessage = null, timestamp = null) {
    if (messageId) {
        const [existing] = await db.query(
            'SELECT id FROM whatsapp_messages WHERE message_id = ?',
            [messageId]
        );
        if (existing.length > 0) {
            return existing[0].id;
        }
    }
    
    const [result] = await db.query(
        `INSERT INTO whatsapp_messages (contact_id, message_id, message, direction, raw_data, created_at) 
         VALUES (?, ?, ?, ?, ?, ?)`,
        [contactId, messageId, message, direction, rawMessage ? JSON.stringify(rawMessage) : null, timestamp || new Date()]
    );
    
    await db.query(
        `UPDATE whatsapp_contacts SET last_message = ?, last_message_at = ? WHERE id = ?`,
        [message, timestamp || new Date(), contactId]
    );
    
    return result.insertId;
}

async function syncRecentMessages(limit = 30) {
    if (!sock || sessionStatus !== 'connected') {
        return { success: false, error: 'WhatsApp not connected' };
    }
    
    console.log(`[Sync] Syncing recent messages (limit: ${limit})...`);
    let synced = 0;
    let contactsProcessed = 0;
    
    try {
        const chats = sock.chats || {};
        const chatList = Object.values(chats);
        const recentChats = chatList.slice(0, limit);
        
        for (const chat of recentChats) {
            try {
                const jid = chat.id;
                if (jid.includes('@g.us')) continue;
                
                const phoneNumber = jid.split('@')[0];
                const messages = await sock.loadMessages(jid, 50);
                
                if (messages && messages.length > 0) {
                    const contact = await getOrCreateContact(phoneNumber, chat.name);
                    contactsProcessed++;
                    
                    for (const msg of messages) {
                        const messageText = msg.message?.conversation || 
                                           msg.message?.extendedTextMessage?.text || '';
                        
                        if (messageText) {
                            const direction = msg.key.fromMe ? 'outgoing' : 'incoming';
                            await saveMessage(contact.id, msg.key.id, messageText, direction, msg);
                            synced++;
                        }
                    }
                }
                await new Promise(resolve => setTimeout(resolve, 200));
            } catch (chatError) {
                console.error(`[Sync] Error:`, chatError.message);
            }
        }
        
        await db.query(
            `INSERT INTO whatsapp_sync_log (sync_type, messages_synced, contacts_synced, status) 
             VALUES ('recent', ?, ?, 'completed')`,
            [synced, contactsProcessed]
        );
        
        return { success: true, messages_synced: synced, contacts_synced: contactsProcessed };
        
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// ─── API Routes ────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({ status: 'ok', whatsapp: sessionStatus, database: db ? 'connected' : 'disconnected' });
});

app.get('/status', authCheck, (req, res) => {
    res.json({ status: sessionStatus });
});

app.get('/qr', authCheck, (req, res) => {
    if (sessionStatus === 'connected') return res.json({ status: 'connected', qr: null });
    if (!currentQR) return res.json({ status: sessionStatus, qr: null });
    res.json({ status: 'scanning', qr: currentQR });
});

// SYNC ENDPOINTS - ADD THESE
app.post('/sync/recent', authCheck, async (req, res) => {
    if (sessionStatus !== 'connected') {
        return res.status(503).json({ error: 'WhatsApp not connected' });
    }
    
    const limit = req.body.limit || 30;
    const result = await syncRecentMessages(limit);
    res.json(result);
});

app.get('/sync/status', authCheck, async (req, res) => {
    try {
        const [lastSync] = await db.query(
            "SELECT * FROM whatsapp_sync_log ORDER BY last_sync_at DESC LIMIT 1"
        );
        res.json({
            syncing: syncInProgress,
            last_sync: lastSync[0] || null
        });
    } catch (err) {
        res.json({ syncing: false, last_sync: null });
    }
});

app.get('/api/conversations', authCheck, async (req, res) => {
    try {
        const [conversations] = await db.query(`
            SELECT 
                wc.id,
                wc.phone_number,
                wc.name,
                wc.last_message,
                wc.last_message_at,
                (
                    SELECT COUNT(*) FROM whatsapp_messages 
                    WHERE contact_id = wc.id AND direction = 'incoming' AND is_read = 0
                ) as unread_count
            FROM whatsapp_contacts wc
            WHERE wc.last_message_at IS NOT NULL
            ORDER BY wc.last_message_at DESC
            LIMIT 100
        `);
        res.json(conversations);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/messages/:contactId', authCheck, async (req, res) => {
    try {
        const [messages] = await db.query(
            'SELECT * FROM whatsapp_messages WHERE contact_id = ? ORDER BY created_at ASC',
            [req.params.contactId]
        );
        res.json(messages);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/send', authCheck, async (req, res) => {
    if (sessionStatus !== 'connected') {
        return res.status(503).json({ error: 'WhatsApp not connected' });
    }
    
    const { phone, message, contact_id } = req.body;
    if ((!phone && !contact_id) || !message) {
        return res.status(400).json({ error: 'phone or contact_id, and message are required' });
    }
    
    try {
        let phoneNumber = phone;
        
        if (contact_id && !phone) {
            const [contacts] = await db.query(
                'SELECT phone_number FROM whatsapp_contacts WHERE id = ?',
                [contact_id]
            );
            if (contacts.length === 0) {
                return res.status(404).json({ error: 'Contact not found' });
            }
            phoneNumber = contacts[0].phone_number;
        }
        
        const cleanPhone = phoneNumber.replace(/\D/g, '');
        const jid = cleanPhone + '@s.whatsapp.net';
        
        const result = await sock.sendMessage(jid, { text: message });
        const contact = await getOrCreateContact(cleanPhone);
        await saveMessage(contact.id, result.key.id, message, 'outgoing', result);
        
        res.json({ success: true, to: jid, contact_id: contact.id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/logout', authCheck, async (req, res) => {
    try { if (sock) await sock.logout(); } catch (_) {}
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    sessionStatus = 'disconnected';
    currentQR = null;
    sock = null;
    setTimeout(() => connectToWhatsApp(), 1000);
    res.json({ success: true });
});

// ─── Baileys Connection ───────────────────────────────────────────────────
function getRetryDelay() {
    const delay = Math.min(1000 * Math.pow(2, retryCount), 30000);
    retryCount++;
    return delay;
}

async function connectToWhatsApp() {
    if (isConnecting) return;
    isConnecting = true;

    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

    try {
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            logger,
            auth: state,
            printQRInTerminal: false,
            browser: Browsers.ubuntu('Chrome'),
            connectTimeoutMs: 60000,
            syncFullHistory: false,
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                sessionStatus = 'scanning';
                retryCount = 0;
                try {
                    currentQR = await qrcode.toDataURL(qr);
                    console.log('[WA] QR generated');
                    io.emit('qr_updated', { qr: currentQR });
                } catch (e) {
                    console.error('[WA] QR error:', e.message);
                }
            }

            if (connection === 'open') {
                sessionStatus = 'connected';
                isConnecting = false;
                retryCount = 0;
                console.log('[WA] Connected!');
                io.emit('whatsapp_status', { status: 'connected' });
            }

            if (connection === 'close') {
                isConnecting = false;
                const code = lastDisconnect?.error?.output?.statusCode;
                console.log('[WA] Disconnected, code:', code);

                if (code === DisconnectReason.loggedOut) {
                    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                    sessionStatus = 'disconnected';
                    setTimeout(() => connectToWhatsApp(), 3000);
                } else {
                    setTimeout(() => connectToWhatsApp(), getRetryDelay());
                }
            }
        });

        sock.ev.on('messages.upsert', async ({ messages }) => {
            for (const msg of messages) {
                if (msg.key.fromMe) continue;
                
                let messageText = msg.message?.conversation || 
                                 msg.message?.extendedTextMessage?.text || '';
                
                if (!messageText) continue;
                
                const phoneNumber = msg.key.remoteJid.split('@')[0];
                const contact = await getOrCreateContact(phoneNumber);
                await saveMessage(contact.id, msg.key.id, messageText, 'incoming', msg);
                
                io.emit('new_message', {
                    contact_id: contact.id,
                    phone_number: phoneNumber,
                    message: messageText,
                    direction: 'incoming'
                });
            }
        });

    } catch (err) {
        isConnecting = false;
        setTimeout(() => connectToWhatsApp(), getRetryDelay());
    }
}

// ─── Socket.io ────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
    console.log('[Socket] Client connected');
    
    socket.on('authenticate', (token) => {
        if (token === API_SECRET) {
            socket.authenticated = true;
            socket.emit('authenticated', { status: 'success' });
        } else {
            socket.disconnect();
        }
    });
});

// ─── Start Server ──────────────────────────────────────────────────────────
async function startServer() {
    const dbConnected = await initDatabase();
    if (!dbConnected) {
        console.error('[FATAL] Could not connect to database');
        process.exit(1);
    }
    
    server.listen(PORT, () => {
        console.log(`[Server] Running on port ${PORT}`);
        connectToWhatsApp();
    });
}

startServer();