// server.js — Enhanced Baileys WhatsApp microservice with CRM integration
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

// Database configuration (add these to Railway environment variables)
const DB_CONFIG = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'crm_db',
    waitForConnections: true,
    connectionLimit: 10,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
};

// ─── State ─────────────────────────────────────────────────────────────────
let sock          = null;
let currentQR     = null;
let sessionStatus = 'disconnected';
let isConnecting  = false;
let retryCount    = 0;
let db            = null;
let io            = null;

// ─── Logger ────────────────────────────────────────────────────────────────
const logger = pino({ level: 'silent' });

// ─── Database Initialization ───────────────────────────────────────────────
async function initDatabase() {
    try {
        db = await mysql.createPool(DB_CONFIG);
        
        // Test connection
        await db.query('SELECT 1');
        console.log('[DB] Connected to MySQL');
        
        // Ensure tables exist
        await ensureTablesExist();
        
        return true;
    } catch (err) {
        console.error('[DB] Connection error:', err.message);
        return false;
    }
}

async function ensureTablesExist() {
    // WhatsApp Contacts
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
    
    // WhatsApp Messages
    await db.query(`
        CREATE TABLE IF NOT EXISTS whatsapp_messages (
            id INT PRIMARY KEY AUTO_INCREMENT,
            contact_id INT NOT NULL,
            message TEXT,
            direction ENUM('incoming', 'outgoing') NOT NULL,
            is_read BOOLEAN DEFAULT FALSE,
            raw_data JSON,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (contact_id) REFERENCES whatsapp_contacts(id) ON DELETE CASCADE,
            INDEX idx_contact (contact_id),
            INDEX idx_created (created_at)
        )
    `);
    
    // WhatsApp Conversations (for staff assignment)
    await db.query(`
        CREATE TABLE IF NOT EXISTS whatsapp_conversations (
            id INT PRIMARY KEY AUTO_INCREMENT,
            contact_id INT NOT NULL,
            assigned_to INT,
            status ENUM('new', 'auto_replied', 'active', 'resolved') DEFAULT 'new',
            started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            resolved_at DATETIME,
            FOREIGN KEY (contact_id) REFERENCES whatsapp_contacts(id),
            INDEX idx_status (status),
            INDEX idx_assigned (assigned_to)
        )
    `);
    
    // Auto-reply Rules
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
    
    console.log('[DB] Tables verified');
}

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

// ─── Helper Functions ──────────────────────────────────────────────────────
async function getOrCreateContact(phoneNumber, name = null) {
    const cleanPhone = phoneNumber.replace(/\D/g, '');
    
    // Check if contact exists
    const [contacts] = await db.query(
        'SELECT * FROM whatsapp_contacts WHERE phone_number = ?',
        [cleanPhone]
    );
    
    if (contacts.length > 0) {
        // Update last_seen
        await db.query(
            'UPDATE whatsapp_contacts SET last_seen = NOW() WHERE id = ?',
            [contacts[0].id]
        );
        return contacts[0];
    }
    
    // Create new contact
    const [result] = await db.query(
        'INSERT INTO whatsapp_contacts (phone_number, name, created_at) VALUES (?, ?, NOW())',
        [cleanPhone, name || cleanPhone]
    );
    
    const newContact = {
        id: result.insertId,
        phone_number: cleanPhone,
        name: name || cleanPhone
    };
    
    // Auto-link to existing customer if phone matches
    await autoLinkToCustomer(newContact.id, cleanPhone);
    
    // Emit new contact event
    io.emit('new_contact', newContact);
    
    return newContact;
}

async function autoLinkToCustomer(contactId, phoneNumber) {
    try {
        // Try to find customer with this phone number
        // Adjust table/column names based on your existing CRM structure
        const [customers] = await db.query(`
            SELECT id FROM your_customers_table 
            WHERE phone = ? OR mobile = ? OR whatsapp = ?
            LIMIT 1
        `, [phoneNumber, phoneNumber, phoneNumber]);
        
        if (customers.length > 0) {
            await db.query(
                'UPDATE whatsapp_contacts SET customer_id = ? WHERE id = ?',
                [customers[0].id, contactId]
            );
            console.log(`[CRM] Auto-linked contact ${phoneNumber} to customer ${customers[0].id}`);
        }
    } catch (err) {
        console.error('[CRM] Auto-link error:', err.message);
    }
}

async function saveMessage(contactId, message, direction, rawMessage = null) {
    const [result] = await db.query(
        `INSERT INTO whatsapp_messages (contact_id, message, direction, raw_data, created_at) 
         VALUES (?, ?, ?, ?, NOW())`,
        [contactId, message, direction, rawMessage ? JSON.stringify(rawMessage) : null]
    );
    
    // Update last message in contact
    await db.query(
        `UPDATE whatsapp_contacts 
         SET last_message = ?, last_message_at = NOW() 
         WHERE id = ?`,
        [message, contactId]
    );
    
    return result.insertId;
}

async function checkAndProcessAutoReply(contactId, phoneNumber, message) {
    try {
        // Check if there's an active conversation assigned to human
        const [activeConv] = await db.query(
            `SELECT * FROM whatsapp_conversations 
             WHERE contact_id = ? AND status = 'active' AND assigned_to IS NOT NULL`,
            [contactId]
        );
        
        if (activeConv.length > 0) {
            return null; // Human is handling, don't auto-reply
        }
        
        // Check offline hours
        const currentHour = new Date().getHours();
        const isOffline = currentHour < 9 || currentHour > 18;
        
        // Get auto-reply rules
        const [rules] = await db.query(
            `SELECT * FROM whatsapp_auto_reply_rules 
             WHERE is_active = 1 
             ORDER BY priority ASC`
        );
        
        let replyMessage = null;
        let ruleType = null;
        
        for (const rule of rules) {
            if (rule.trigger_type === 'offline' && isOffline) {
                replyMessage = rule.reply_message;
                ruleType = 'offline';
                break;
            }
            
            if (rule.trigger_type === 'greeting') {
                // Check if first message
                const [msgCount] = await db.query(
                    `SELECT COUNT(*) as count FROM whatsapp_messages 
                     WHERE contact_id = ? AND direction = 'outgoing'`,
                    [contactId]
                );
                
                if (msgCount[0].count === 0) {
                    replyMessage = rule.reply_message;
                    ruleType = 'greeting';
                    break;
                }
            }
            
            if (rule.trigger_type === 'keyword' && rule.trigger_value) {
                const keywords = rule.trigger_value.split(',');
                if (keywords.some(kw => message.toLowerCase().includes(kw.toLowerCase()))) {
                    replyMessage = rule.reply_message;
                    ruleType = 'keyword';
                    break;
                }
            }
        }
        
        if (replyMessage && sock && sessionStatus === 'connected') {
            // Send auto-reply
            const jid = phoneNumber + '@s.whatsapp.net';
            await sock.sendMessage(jid, { text: replyMessage });
            
            // Save outgoing auto-reply
            await saveMessage(contactId, replyMessage, 'outgoing');
            
            // Create conversation record if not exists
            const [conv] = await db.query(
                `SELECT id FROM whatsapp_conversations WHERE contact_id = ?`,
                [contactId]
            );
            
            if (conv.length === 0) {
                await db.query(
                    `INSERT INTO whatsapp_conversations (contact_id, status, started_at) 
                     VALUES (?, 'auto_replied', NOW())`,
                    [contactId]
                );
            }
            
            console.log(`[AutoReply] Sent ${ruleType} reply to ${phoneNumber}`);
            return replyMessage;
        }
        
        return null;
    } catch (err) {
        console.error('[AutoReply] Error:', err.message);
        return null;
    }
}

// ─── Routes ────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        whatsapp: sessionStatus,
        database: db ? 'connected' : 'disconnected'
    });
});

app.get('/qr', authCheck, (req, res) => {
    if (sessionStatus === 'connected') return res.json({ status: 'connected', qr: null });
    if (!currentQR) return res.json({ status: sessionStatus, qr: null });
    res.json({ status: 'scanning', qr: currentQR });
});

app.get('/status', authCheck, (req, res) => {
    res.json({ status: sessionStatus });
});

// Send message
app.post('/send', authCheck, async (req, res) => {
    if (sessionStatus !== 'connected') {
        return res.status(503).json({ error: 'WhatsApp not connected', status: sessionStatus });
    }
    
    const { phone, message, contact_id } = req.body;
    if ((!phone && !contact_id) || !message) {
        return res.status(400).json({ error: 'phone or contact_id, and message are required' });
    }
    
    try {
        let phoneNumber = phone;
        
        // If contact_id provided, get phone number from database
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
        
        await sock.sendMessage(jid, { text: message });
        
        // Get or create contact and save message
        const contact = await getOrCreateContact(cleanPhone);
        await saveMessage(contact.id, message, 'outgoing');
        
        // Emit real-time update
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

// Get conversations list
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
                (SELECT COUNT(*) FROM whatsapp_messages 
                 WHERE contact_id = wc.id AND direction = 'incoming' AND is_read = 0) as unread_count,
                (SELECT status FROM whatsapp_conversations 
                 WHERE contact_id = wc.id ORDER BY started_at DESC LIMIT 1) as conversation_status
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

// Get contact details
app.get('/api/contact/:contactId', authCheck, async (req, res) => {
    try {
        const [contacts] = await db.query(`
            SELECT wc.*, 
                   c.name as customer_name,
                   c.email as customer_email
            FROM whatsapp_contacts wc
            LEFT JOIN your_customers_table c ON wc.customer_id = c.id
            WHERE wc.id = ?
        `, [req.params.contactId]);
        
        if (contacts.length === 0) {
            return res.status(404).json({ error: 'Contact not found' });
        }
        
        res.json(contacts[0]);
    } catch (err) {
        console.error('Contact error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Assign conversation to staff
app.post('/api/assign', authCheck, async (req, res) => {
    const { contact_id, staff_id } = req.body;
    
    try {
        // Check if conversation exists
        const [conv] = await db.query(
            `SELECT id FROM whatsapp_conversations 
             WHERE contact_id = ? AND status IN ('new', 'auto_replied')`,
            [contact_id]
        );
        
        if (conv.length === 0) {
            // Create new conversation
            await db.query(
                `INSERT INTO whatsapp_conversations (contact_id, assigned_to, status, started_at) 
                 VALUES (?, ?, 'active', NOW())`,
                [contact_id, staff_id]
            );
        } else {
            // Update existing conversation
            await db.query(
                `UPDATE whatsapp_conversations 
                 SET assigned_to = ?, status = 'active' 
                 WHERE contact_id = ?`,
                [staff_id, contact_id]
            );
        }
        
        res.json({ success: true });
    } catch (err) {
        console.error('Assign error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Get auto-reply rules
app.get('/api/auto-reply-rules', authCheck, async (req, res) => {
    try {
        const [rules] = await db.query(
            'SELECT * FROM whatsapp_auto_reply_rules ORDER BY priority ASC'
        );
        res.json(rules);
    } catch (err) {
        console.error('Auto-reply rules error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Create/Update auto-reply rule
app.post('/api/auto-reply-rules', authCheck, async (req, res) => {
    const { trigger_type, trigger_value, reply_message, priority, is_active } = req.body;
    
    try {
        await db.query(
            `INSERT INTO whatsapp_auto_reply_rules 
             (trigger_type, trigger_value, reply_message, priority, is_active) 
             VALUES (?, ?, ?, ?, ?)`,
            [trigger_type, trigger_value, reply_message, priority || 0, is_active !== false]
        );
        
        res.json({ success: true });
    } catch (err) {
        console.error('Create rule error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Delete auto-reply rule
app.delete('/api/auto-reply-rules/:id', authCheck, async (req, res) => {
    try {
        await db.query('DELETE FROM whatsapp_auto_reply_rules WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        console.error('Delete rule error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Logout
app.post('/logout', authCheck, async (req, res) => {
    try { 
        if (sock) await sock.logout(); 
    } catch (_) {}
    
    if (fs.existsSync(AUTH_DIR)) {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }
    
    sessionStatus = 'disconnected';
    currentQR = null;
    sock = null;
    isConnecting = false;
    retryCount = 0;
    
    setTimeout(() => connectToWhatsApp(), 1000);
    res.json({ success: true, message: 'Logged out. New QR will be generated.' });
});

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

// ─── Baileys WhatsApp Connection ───────────────────────────────────────────
function getRetryDelay() {
    const delay = Math.min(1000 * Math.pow(2, retryCount), 30000);
    retryCount++;
    return delay;
}

async function connectToWhatsApp() {
    if (isConnecting) return;
    isConnecting = true;

    if (!fs.existsSync(AUTH_DIR)) {
        fs.mkdirSync(AUTH_DIR, { recursive: true });
    }

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
            }

            if (connection === 'close') {
                isConnecting = false;
                const code = lastDisconnect?.error?.output?.statusCode;
                console.log('[WA] Disconnected, code:', code);
                io.emit('whatsapp_status', { status: 'disconnected', code });

                if (code === DisconnectReason.loggedOut) {
                    if (fs.existsSync(AUTH_DIR)) {
                        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                    }
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

        // Handle incoming messages
        sock.ev.on('messages.upsert', async ({ messages }) => {
            for (const msg of messages) {
                // Skip messages we sent
                if (msg.key.fromMe) continue;
                
                // Extract message content
                let messageText = msg.message?.conversation || 
                                 msg.message?.extendedTextMessage?.text || 
                                 msg.message?.imageMessage?.caption || '';
                
                if (!messageText) continue;
                
                const phoneNumber = msg.key.remoteJid.split('@')[0];
                
                console.log(`[WA] Message from ${phoneNumber}: ${messageText.substring(0, 50)}`);
                
                // Get or create contact
                const contact = await getOrCreateContact(phoneNumber);
                
                // Save incoming message
                const messageId = await saveMessage(contact.id, messageText, 'incoming', msg);
                
                // Emit real-time message to connected clients
                io.to(`conv_${contact.id}`).emit('new_message', {
                    id: messageId,
                    contact_id: contact.id,
                    phone_number: phoneNumber,
                    message: messageText,
                    direction: 'incoming',
                    timestamp: new Date()
                });
                
                // Broadcast to all clients (for inbox updates)
                io.emit('inbox_update', {
                    contact_id: contact.id,
                    last_message: messageText,
                    last_message_at: new Date(),
                    unread_count: 1
                });
                
                // Process auto-reply
                await checkAndProcessAutoReply(contact.id, phoneNumber, messageText);
            }
        });

    } catch (err) {
        isConnecting = false;
        const delay = getRetryDelay();
        console.error('[WA] Setup error:', err.message);
        setTimeout(() => connectToWhatsApp(), delay);
    }
}

// ─── Start Server ──────────────────────────────────────────────────────────
async function startServer() {
    // Initialize database first
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