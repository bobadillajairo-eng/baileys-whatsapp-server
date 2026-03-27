// server.js — Complete WhatsApp Service with Railway MySQL Database
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
const API_SECRET = process.env.API_SECRET || 'mircalderon_wa_2026_xk9q';
const AUTH_DIR   = path.join(__dirname, 'auth_state');

// Database configuration - Use Railway MySQL variables
const DB_CONFIG = {
    host: process.env.MYSQL_HOST || process.env.DB_HOST || 'mysql.railway.internal',
    user: process.env.MYSQL_USER || process.env.DB_USER || 'root',
    password: process.env.MYSQL_PASSWORD || process.env.DB_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || process.env.DB_NAME || 'railway',
    port: parseInt(process.env.MYSQL_PORT || process.env.DB_PORT || '26761'),
    waitForConnections: true,
    connectionLimit: 10,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    connectTimeout: 30000,
    acquireTimeout: 30000
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

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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
    let retries = 5;
    while (retries > 0) {
        try {
            console.log(`[DB] Attempting to connect to Railway MySQL...`);
            console.log(`[DB] Host: ${DB_CONFIG.host}`);
            console.log(`[DB] Database: ${DB_CONFIG.database}`);
            
            db = await mysql.createPool(DB_CONFIG);
            
            // Test connection
            const [result] = await db.query('SELECT 1 as connected, NOW() as server_time');
            console.log(`[DB] ✓ Connected to MySQL at ${result[0].server_time}`);
            
            await ensureTablesExist();
            return true;
            
        } catch (err) {
            console.error(`[DB] Connection error: ${err.message}`);
            retries--;
            if (retries === 0) {
                console.error('[DB] Failed to connect after multiple attempts');
                return false;
            }
            console.log(`[DB] Retrying in 5 seconds... (${retries} attempts left)`);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
    return false;
}

async function ensureTablesExist() {
    // WhatsApp Contacts table
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
            INDEX idx_phone (phone_number),
            INDEX idx_customer (customer_id)
        )
    `);
    console.log('[DB] Table "whatsapp_contacts" verified');
    
    // WhatsApp Messages table with message_id for deduplication
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
            INDEX idx_contact (contact_id),
            INDEX idx_created (created_at),
            INDEX idx_message_id (message_id)
        )
    `);
    console.log('[DB] Table "whatsapp_messages" verified');
    
    // WhatsApp Conversations table
    await db.query(`
        CREATE TABLE IF NOT EXISTS whatsapp_conversations (
            id INT PRIMARY KEY AUTO_INCREMENT,
            contact_id INT NOT NULL,
            assigned_to INT,
            status ENUM('new', 'auto_replied', 'active', 'resolved') DEFAULT 'new',
            started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            resolved_at DATETIME,
            FOREIGN KEY (contact_id) REFERENCES whatsapp_contacts(id) ON DELETE CASCADE,
            INDEX idx_status (status),
            INDEX idx_assigned (assigned_to)
        )
    `);
    console.log('[DB] Table "whatsapp_conversations" verified');
    
    // Auto-reply Rules table
    await db.query(`
        CREATE TABLE IF NOT EXISTS whatsapp_auto_reply_rules (
            id INT PRIMARY KEY AUTO_INCREMENT,
            trigger_type ENUM('keyword', 'greeting', 'offline') NOT NULL,
            trigger_value TEXT,
            reply_message TEXT NOT NULL,
            priority INT DEFAULT 0,
            is_active BOOLEAN DEFAULT TRUE,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    console.log('[DB] Table "whatsapp_auto_reply_rules" verified');
    
    // Sync Log table
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
    console.log('[DB] Table "whatsapp_sync_log" verified');
    
    // Insert default auto-reply rules if none exist
    const [rules] = await db.query('SELECT COUNT(*) as count FROM whatsapp_auto_reply_rules');
    if (rules[0].count === 0) {
        await db.query(`
            INSERT INTO whatsapp_auto_reply_rules (trigger_type, trigger_value, reply_message, priority) VALUES
            ('greeting', NULL, 'Thank you for contacting us! A representative will assist you shortly.', 10),
            ('offline', NULL, 'We are currently offline. Our business hours are 9 AM - 6 PM. We will respond when we return.', 20),
            ('keyword', 'price,cost,how much', 'Our pricing information can be found on our website. Would you like a quote?', 30),
            ('keyword', 'hours,open,location', 'We are open Monday-Friday, 9 AM - 6 PM. Our address is 123 Business St.', 40)
        `);
        console.log('[DB] Default auto-reply rules inserted');
    }
    
    console.log('[DB] All tables verified');
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

async function saveMessageToDB(contactId, messageId, message, direction, rawMessage = null, timestamp = null) {
    if (!messageId) return null;
    
    // Check if message already exists (deduplication)
    const [existing] = await db.query(
        'SELECT id FROM whatsapp_messages WHERE message_id = ?',
        [messageId]
    );
    if (existing.length > 0) {
        return existing[0].id;
    }
    
    const [result] = await db.query(
        `INSERT INTO whatsapp_messages (contact_id, message_id, message, direction, raw_data, created_at) 
         VALUES (?, ?, ?, ?, ?, ?)`,
        [contactId, messageId, message, direction, rawMessage ? JSON.stringify(rawMessage) : null, timestamp || new Date()]
    );
    
    // Update contact's last message
    await db.query(
        `UPDATE whatsapp_contacts 
         SET last_message = ?, last_message_at = ? 
         WHERE id = ?`,
        [message, timestamp || new Date(), contactId]
    );
    
    return result.insertId;
}

// ─── Message History Sync Functions ───────────────────────────────────────
async function syncContactMessages(phoneNumber, limit = 100) {
    if (!sock || sessionStatus !== 'connected') {
        return { success: false, error: 'WhatsApp not connected' };
    }
    
    try {
        const jid = phoneNumber.replace(/\D/g, '') + '@s.whatsapp.net';
        
        // Fetch messages from WhatsApp
        const messages = await sock.loadMessages(jid, limit);
        
        if (!messages || messages.length === 0) {
            return { success: true, messages_synced: 0, total_messages: 0 };
        }
        
        // Get or create contact
        const contact = await getOrCreateContact(phoneNumber);
        let savedCount = 0;
        
        // Process messages in chronological order
        for (const msg of messages.reverse()) {
            // Extract message text
            let messageText = msg.message?.conversation || 
                             msg.message?.extendedTextMessage?.text || 
                             msg.message?.imageMessage?.caption || '';
            
            if (!messageText && msg.message?.imageMessage) {
                messageText = '📷 Image';
            } else if (!messageText && msg.message?.videoMessage) {
                messageText = '🎥 Video';
            } else if (!messageText && msg.message?.audioMessage) {
                messageText = '🎵 Audio';
            } else if (!messageText && msg.message?.documentMessage) {
                messageText = '📄 Document';
            } else if (!messageText && msg.message?.stickerMessage) {
                messageText = '🎨 Sticker';
            }
            
            if (!messageText) continue;
            
            const direction = msg.key.fromMe ? 'outgoing' : 'incoming';
            const messageId = msg.key.id;
            const timestamp = msg.messageTimestamp ? new Date(msg.messageTimestamp * 1000) : new Date();
            
            const saved = await saveMessageToDB(contact.id, messageId, messageText, direction, msg, timestamp);
            if (saved) savedCount++;
        }
        
        return { 
            success: true, 
            messages_synced: savedCount, 
            total_messages: messages.length 
        };
        
    } catch (error) {
        console.error(`Error syncing ${phoneNumber}:`, error.message);
        return { success: false, error: error.message };
    }
}

async function syncAllContacts(limitPerContact = 100) {
    if (syncInProgress) {
        return { success: false, error: 'Sync already in progress' };
    }
    
    syncInProgress = true;
    console.log('[Sync] Starting full sync for all contacts...');
    
    try {
        const [contacts] = await db.query('SELECT id, phone_number, name FROM whatsapp_contacts');
        let totalSynced = 0;
        let syncedContacts = 0;
        
        for (const contact of contacts) {
            console.log(`[Sync] Syncing ${contact.phone_number}...`);
            const result = await syncContactMessages(contact.phone_number, limitPerContact);
            
            if (result.success && result.messages_synced > 0) {
                totalSynced += result.messages_synced;
                syncedContacts++;
                console.log(`[Sync]   ✓ Synced ${result.messages_synced} messages`);
            } else if (!result.success) {
                console.log(`[Sync]   ✗ Failed: ${result.error}`);
            }
            
            // Rate limiting to avoid being blocked
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        // Log sync completion
        await db.query(
            `INSERT INTO whatsapp_sync_log (sync_type, messages_synced, contacts_synced, status) 
             VALUES ('full_history', ?, ?, 'completed')`,
            [totalSynced, syncedContacts]
        );
        
        console.log(`[Sync] Full sync completed! Synced ${totalSynced} messages from ${syncedContacts} contacts`);
        
        return { success: true, totalSynced, syncedContacts };
        
    } catch (error) {
        console.error('[Sync] Error during sync:', error);
        await db.query(
            `INSERT INTO whatsapp_sync_log (sync_type, messages_synced, contacts_synced, status, error_message) 
             VALUES ('full_history', 0, 0, 'failed', ?)`,
            [error.message]
        );
        return { success: false, error: error.message };
    } finally {
        syncInProgress = false;
    }
}

async function syncRecentContacts(limit = 30) {
    if (!sock || sessionStatus !== 'connected') {
        return { success: false, error: 'WhatsApp not connected' };
    }
    
    try {
        const [contacts] = await db.query(
            'SELECT id, phone_number FROM whatsapp_contacts ORDER BY last_message_at DESC LIMIT ?',
            [limit]
        );
        
        let totalSynced = 0;
        
        for (const contact of contacts) {
            const result = await syncContactMessages(contact.phone_number, 50);
            if (result.success) {
                totalSynced += result.messages_synced;
            }
            await new Promise(resolve => setTimeout(resolve, 300));
        }
        
        await db.query(
            `INSERT INTO whatsapp_sync_log (sync_type, messages_synced, contacts_synced, status) 
             VALUES ('recent', ?, ?, 'completed')`,
            [totalSynced, contacts.length]
        );
        
        return { success: true, totalSynced, contactsSynced: contacts.length };
        
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// ─── API Routes ────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        whatsapp: sessionStatus, 
        database: db ? 'connected' : 'disconnected',
        syncing: syncInProgress
    });
});

app.get('/status', authCheck, (req, res) => {
    res.json({ status: sessionStatus });
});

app.get('/qr', authCheck, (req, res) => {
    if (sessionStatus === 'connected') return res.json({ status: 'connected', qr: null });
    if (!currentQR) return res.json({ status: sessionStatus, qr: null });
    res.json({ status: 'scanning', qr: currentQR });
});

// Sync a single contact
app.post('/api/sync/contact', authCheck, async (req, res) => {
    if (sessionStatus !== 'connected') {
        return res.status(503).json({ error: 'WhatsApp not connected' });
    }
    
    const { phone, contact_id, limit = 100 } = req.body;
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
    
    if (!phoneNumber) {
        return res.status(400).json({ error: 'Phone number required' });
    }
    
    const result = await syncContactMessages(phoneNumber, limit);
    res.json(result);
});

// Sync all contacts
app.post('/api/sync/all', authCheck, async (req, res) => {
    if (sessionStatus !== 'connected') {
        return res.status(503).json({ error: 'WhatsApp not connected' });
    }
    
    const limit = req.body.limit || 100;
    
    // Run in background to avoid timeout
    syncAllContacts(limit).then(result => {
        console.log('[Sync] Background sync completed:', result);
        io.emit('sync_completed', result);
    }).catch(console.error);
    
    res.json({ 
        success: true, 
        message: 'Sync started in background. Check sync_log table for progress.' 
    });
});

// Sync recent contacts
app.post('/api/sync/recent', authCheck, async (req, res) => {
    if (sessionStatus !== 'connected') {
        return res.status(503).json({ error: 'WhatsApp not connected' });
    }
    
    const limit = req.body.limit || 30;
    const result = await syncRecentContacts(limit);
    res.json(result);
});

// Get sync status
app.get('/api/sync/status', authCheck, async (req, res) => {
    const [lastSync] = await db.query(
        'SELECT * FROM whatsapp_sync_log ORDER BY last_sync_at DESC LIMIT 1'
    );
    
    const [totalMessages] = await db.query(
        'SELECT COUNT(*) as total FROM whatsapp_messages'
    );
    
    const [totalContacts] = await db.query(
        'SELECT COUNT(*) as total FROM whatsapp_contacts'
    );
    
    res.json({
        syncing: syncInProgress,
        last_sync: lastSync[0] || null,
        total_messages: totalMessages[0].total,
        total_contacts: totalContacts[0].total
    });
});

// Get conversations
app.get('/api/conversations', authCheck, async (req, res) => {
    try {
        const [conversations] = await db.query(`
            SELECT 
                wc.id,
                wc.phone_number,
                wc.name,
                wc.customer_id,
                wc.last_message,
                wc.last_message_at,
                (
                    SELECT COUNT(*) 
                    FROM whatsapp_messages 
                    WHERE contact_id = wc.id 
                    AND direction = 'incoming' 
                    AND is_read = 0
                ) as unread_count
            FROM whatsapp_contacts wc
            WHERE wc.last_message_at IS NOT NULL
            ORDER BY wc.last_message_at DESC
            LIMIT 100
        `);
        res.json(conversations);
    } catch (err) {
        console.error('Conversations error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Get messages for a contact
app.get('/api/messages/:contactId', authCheck, async (req, res) => {
    try {
        const [messages] = await db.query(`
            SELECT * FROM whatsapp_messages 
            WHERE contact_id = ? 
            ORDER BY created_at ASC
        `, [req.params.contactId]);
        
        // Mark incoming messages as read
        await db.query(`
            UPDATE whatsapp_messages 
            SET is_read = 1 
            WHERE contact_id = ? AND direction = 'incoming' AND is_read = 0
        `, [req.params.contactId]);
        
        res.json(messages);
    } catch (err) {
        console.error('Messages error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Send message
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
        await saveMessageToDB(contact.id, result.key.id, message, 'outgoing', result);
        
        io.emit('message_sent', {
            contact_id: contact.id,
            phone_number: cleanPhone,
            message: message,
            direction: 'outgoing',
            timestamp: new Date()
        });
        
        res.json({ success: true, to: jid, contact_id: contact.id });
    } catch (err) {
        console.error('Send error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Logout
app.post('/logout', authCheck, async (req, res) => {
    try { if (sock) await sock.logout(); } catch (_) {}
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    sessionStatus = 'disconnected';
    currentQR = null;
    sock = null;
    isConnecting = false;
    retryCount = 0;
    syncInProgress = false;
    setTimeout(() => connectToWhatsApp(), 1000);
    res.json({ success: true, message: 'Logged out' });
});

// ─── Baileys WhatsApp Connection ───────────────────────────────────────────
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
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`[WA] Using WA version ${version.join('.')} — isLatest: ${isLatest}`);

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
            syncFullHistory: false,
            markOnlineOnConnect: false,
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                sessionStatus = 'scanning';
                currentQR = null;
                retryCount = 0;
                try {
                    currentQR = await qrcode.toDataURL(qr);
                    console.log('[WA] QR generated — waiting for scan');
                    io.emit('qr_updated', { qr: currentQR });
                } catch (e) {
                    console.error('[WA] QR error:', e.message);
                }
            }

            if (connection === 'open') {
                sessionStatus = 'connected';
                currentQR = null;
                isConnecting = false;
                retryCount = 0;
                console.log('[WA] Connected!');
                io.emit('whatsapp_status', { status: 'connected' });
                
                // Auto-sync recent messages after connection
                setTimeout(async () => {
                    console.log('[WA] Auto-syncing recent messages...');
                    await syncRecentContacts(20);
                }, 5000);
            }

            if (connection === 'close') {
                isConnecting = false;
                const code = lastDisconnect?.error?.output?.statusCode;
                console.log('[WA] Disconnected, code:', code);
                io.emit('whatsapp_status', { status: 'disconnected', code });

                if (code === DisconnectReason.loggedOut) {
                    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                    sessionStatus = 'disconnected';
                    currentQR = null;
                    retryCount = 0;
                    setTimeout(() => connectToWhatsApp(), 3000);
                } else {
                    const delay = getRetryDelay();
                    console.log(`[WA] Reconnecting in ${delay / 1000}s...`);
                    setTimeout(() => connectToWhatsApp(), delay);
                }
            }
        });

        // Handle incoming messages in real-time
        sock.ev.on('messages.upsert', async ({ messages }) => {
            for (const msg of messages) {
                // Skip messages we sent
                if (msg.key.fromMe) continue;
                
                // Extract message content
                let messageText = msg.message?.conversation || 
                                 msg.message?.extendedTextMessage?.text || 
                                 msg.message?.imageMessage?.caption || '';
                
                if (!messageText && msg.message?.imageMessage) {
                    messageText = '📷 Image';
                } else if (!messageText && msg.message?.videoMessage) {
                    messageText = '🎥 Video';
                } else if (!messageText && msg.message?.audioMessage) {
                    messageText = '🎵 Audio';
                }
                
                if (!messageText) continue;
                
                const phoneNumber = msg.key.remoteJid.split('@')[0];
                console.log(`[WA] Message from ${phoneNumber}: ${messageText.substring(0, 50)}`);
                
                // Get or create contact
                const contact = await getOrCreateContact(phoneNumber);
                
                // Save incoming message
                const timestamp = msg.messageTimestamp ? new Date(msg.messageTimestamp * 1000) : new Date();
                await saveMessageToDB(contact.id, msg.key.id, messageText, 'incoming', msg, timestamp);
                
                // Emit real-time message
                io.emit('new_message', {
                    contact_id: contact.id,
                    phone_number: phoneNumber,
                    message: messageText,
                    direction: 'incoming',
                    timestamp: timestamp
                });
            }
        });

    } catch (err) {
        isConnecting = false;
        const delay = getRetryDelay();
        console.error('[WA] Setup error:', err.message);
        setTimeout(() => connectToWhatsApp(), delay);
    }
}

// ─── Socket.io Connection Handling ─────────────────────────────────────────
io.on('connection', (socket) => {
    console.log('[Socket] Client connected:', socket.id);
    
    socket.on('authenticate', (token) => {
        if (token === API_SECRET) {
            socket.authenticated = true;
            socket.emit('authenticated', { status: 'success' });
            console.log('[Socket] Client authenticated');
        } else {
            socket.emit('authenticated', { status: 'error', message: 'Invalid token' });
            socket.disconnect();
        }
    });
    
    socket.on('join_conversation', (contactId) => {
        if (socket.authenticated) {
            socket.join(`conv_${contactId}`);
            console.log(`[Socket] Client joined conversation ${contactId}`);
        }
    });
    
    socket.on('disconnect', () => {
        console.log('[Socket] Client disconnected:', socket.id);
    });
});

// ─── Start Server ──────────────────────────────────────────────────────────
async function startServer() {
    console.log('[Server] Starting WhatsApp service...');
    console.log('[Server] Environment:');
    console.log(`  PORT: ${PORT}`);
    console.log(`  DB_HOST: ${DB_CONFIG.host}`);
    console.log(`  DB_NAME: ${DB_CONFIG.database}`);
    
    const dbConnected = await initDatabase();
    
    if (!dbConnected) {
        console.error('[FATAL] Could not connect to database. Exiting...');
        process.exit(1);
    }
    
    server.listen(PORT, () => {
        console.log(`[Server] Running on port ${PORT}`);
        console.log(`[Server] WebSocket available at ws://localhost:${PORT}`);
        connectToWhatsApp();
    });
}

startServer();