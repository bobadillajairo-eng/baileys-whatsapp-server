// server.js — Baileys WhatsApp microservice with real-time sync & scheduled messages (ESM)
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ────────────────────────────────────────────────────────────────
const PORT       = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET || 'mircalderon_wa_2026_xk9q';
const AUTH_DIR   = path.join(__dirname, 'auth_state');
const DATA_DIR   = process.env.DATA_PATH || path.join(__dirname, 'data');
const SCHEDULED_FILE = path.join(DATA_DIR, 'scheduled_messages.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── State ─────────────────────────────────────────────────────────────────
let sock          = null;
let currentQR     = null;
let sessionStatus = 'disconnected';
let isConnecting  = false;
let retryCount    = 0;
let scheduledMessages = [];
let messageHistory = []; // Store recent messages for context
let connectedUser = null;

// ─── Logger ────────────────────────────────────────────────────────────────
const logger = pino({ level: 'silent' });

// ─── Scheduled Messages Functions ──────────────────────────────────────────
function loadScheduledMessages() {
    try {
        if (fs.existsSync(SCHEDULED_FILE)) {
            const data = fs.readFileSync(SCHEDULED_FILE, 'utf8');
            scheduledMessages = JSON.parse(data);
            console.log(`[SCHEDULER] Loaded ${scheduledMessages.length} scheduled messages`);
        } else {
            scheduledMessages = [];
            console.log('[SCHEDULER] No existing scheduled messages found');
        }
    } catch (err) {
        console.error('[SCHEDULER] Error loading:', err.message);
        scheduledMessages = [];
    }
}

function saveScheduledMessages() {
    try {
        fs.writeFileSync(SCHEDULED_FILE, JSON.stringify(scheduledMessages, null, 2));
        console.log(`[SCHEDULER] Saved ${scheduledMessages.length} messages`);
    } catch (err) {
        console.error('[SCHEDULER] Error saving:', err.message);
    }
}

async function sendMessageWithRetry(jid, text, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            if (sock && sessionStatus === 'connected') {
                const result = await sock.sendMessage(jid, { text: text });
                console.log(`[SEND] Message sent to ${jid}: ${text.substring(0, 50)}...`);
                return result;
            } else {
                console.log(`[SEND] Cannot send: session status = ${sessionStatus}`);
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        } catch (err) {
            console.error(`[SEND] Attempt ${i + 1} failed:`, err.message);
            if (i < retries - 1) await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
    return false;
}

async function checkScheduledMessages() {
    if (sessionStatus !== 'connected') {
        console.log('[SCHEDULER] Waiting for connection...');
        return;
    }
    
    const now = new Date();
    let executed = false;
    
    for (const scheduled of scheduledMessages) {
        if (!scheduled.executed && new Date(scheduled.time) <= now) {
            console.log(`[SCHEDULER] Executing: ${scheduled.id}`);
            const success = await sendMessageWithRetry(scheduled.jid, scheduled.message);
            
            if (success) {
                scheduled.executed = true;
                scheduled.executedAt = new Date().toISOString();
                executed = true;
            }
        }
    }
    
    if (executed) saveScheduledMessages();
    
    // Clean up old messages (older than 7 days)
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const beforeCount = scheduledMessages.length;
    scheduledMessages = scheduledMessages.filter(msg => 
        !msg.executed || new Date(msg.time) > cutoff
    );
    if (beforeCount !== scheduledMessages.length) {
        console.log(`[SCHEDULER] Cleaned up ${beforeCount - scheduledMessages.length} old messages`);
        saveScheduledMessages();
    }
}

// ─── Command Handler with Full Control ─────────────────────────────────────
async function handleCommand(jid, command, originalMsg, msgInfo) {
    const parts = command.slice(1).split(' ');
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);
    
    console.log(`[CMD] Processing: ${cmd} from ${jid}`);
    
    switch(cmd) {
        case 'schedule':
            // !schedule [time] [message]
            if (args.length < 2) {
                await sock.sendMessage(jid, { 
                    text: `📅 *Schedule a Message*\n\n` +
                          `Usage: !schedule [time] [message]\n\n` +
                          `Examples:\n` +
                          `• !schedule 2024-12-31T23:59 Happy New Year!\n` +
                          `• !schedule in 30m Remind me\n` +
                          `• !schedule tomorrow 9am Meeting\n\n` +
                          `Use !help for more commands`
                });
                return;
            }
            
            let scheduleTime;
            let messageText;
            
            // Parse natural language times
            if (args[0] === 'in' && args[1]) {
                const duration = args[1];
                const amount = parseInt(duration);
                const unit = duration.replace(amount.toString(), '');
                scheduleTime = new Date();
                
                if (unit === 'm') scheduleTime.setMinutes(scheduleTime.getMinutes() + amount);
                else if (unit === 'h') scheduleTime.setHours(scheduleTime.getHours() + amount);
                else if (unit === 'd') scheduleTime.setDate(scheduleTime.getDate() + amount);
                else scheduleTime = new Date(args[0]);
                
                messageText = args.slice(2).join(' ');
            } else if (args[0] === 'tomorrow') {
                scheduleTime = new Date();
                scheduleTime.setDate(scheduleTime.getDate() + 1);
                const timePart = args[1] || '09:00';
                const [hours, minutes] = timePart.split(':');
                scheduleTime.setHours(parseInt(hours), parseInt(minutes), 0);
                messageText = args.slice(2).join(' ');
            } else {
                scheduleTime = new Date(args[0]);
                messageText = args.slice(1).join(' ');
            }
            
            if (isNaN(scheduleTime.getTime())) {
                await sock.sendMessage(jid, { text: '❌ Invalid time format. Use: YYYY-MM-DDTHH:MM or "in 30m" or "tomorrow 9am"' });
                return;
            }
            
            if (scheduleTime <= new Date()) {
                await sock.sendMessage(jid, { text: '❌ Schedule time must be in the future!' });
                return;
            }
            
            const scheduledId = Date.now().toString() + '_' + Math.random().toString(36).substr(2, 6);
            scheduledMessages.push({
                id: scheduledId,
                jid: jid,
                message: messageText,
                time: scheduleTime.toISOString(),
                executed: false,
                created: new Date().toISOString(),
                from: connectedUser?.id || 'unknown'
            });
            saveScheduledMessages();
            
            await sock.sendMessage(jid, { 
                text: `✅ *Message Scheduled!*\n\n📝 "${messageText.substring(0, 100)}"\n⏰ ${scheduleTime.toLocaleString()}\n🆔 ID: \`${scheduledId}\`\n\nUse !list to see all schedules or !cancel ${scheduledId} to cancel` 
            });
            break;
            
        case 'list':
            const pending = scheduledMessages.filter(m => !m.executed && m.jid === jid);
            if (pending.length === 0) {
                await sock.sendMessage(jid, { text: '📭 No pending scheduled messages.' });
            } else {
                let listText = `📅 *Your Scheduled Messages* (${pending.length})\n\n`;
                pending.forEach((msg, idx) => {
                    const date = new Date(msg.time);
                    const timeStr = date.toLocaleString();
                    listText += `${idx + 1}. *${timeStr}*\n   📝 ${msg.message.substring(0, 60)}${msg.message.length > 60 ? '...' : ''}\n   🆔 \`${msg.id}\`\n\n`;
                });
                await sock.sendMessage(jid, { text: listText });
            }
            break;
            
        case 'cancel':
            if (args.length === 0) {
                await sock.sendMessage(jid, { text: 'Usage: !cancel [message_id]\n\nGet IDs from !list command' });
                return;
            }
            
            const cancelId = args[0];
            const index = scheduledMessages.findIndex(m => m.id === cancelId && m.jid === jid);
            if (index !== -1) {
                const removed = scheduledMessages.splice(index, 1)[0];
                saveScheduledMessages();
                await sock.sendMessage(jid, { text: `✅ *Cancelled*: "${removed.message.substring(0, 100)}"` });
            } else {
                await sock.sendMessage(jid, { text: '❌ Message ID not found. Use !list to see your scheduled messages.' });
            }
            break;
            
        case 'reply':
            // !reply [message-id] [response] - Reply to a specific message
            if (args.length < 2) {
                await sock.sendMessage(jid, { text: 'Usage: !reply [message-id] [your reply]' });
                return;
            }
            
            const msgId = args[0];
            const replyText = args.slice(1).join(' ');
            const targetMsg = messageHistory.find(m => m.id === msgId && m.from === jid);
            
            if (targetMsg) {
                await sock.sendMessage(jid, { 
                    text: replyText,
                    edit: targetMsg.key // This replies to the specific message
                });
            } else {
                await sock.sendMessage(jid, { text: '❌ Message not found in recent history.' });
            }
            break;
            
        case 'ping':
            await sock.sendMessage(jid, { 
                text: `🏓 Pong! Connected since: ${new Date().toLocaleString()}\n📊 Status: ${sessionStatus}` 
            });
            break;
            
        case 'status':
            const stats = {
                connected: sessionStatus === 'connected',
                scheduled: scheduledMessages.filter(m => !m.executed).length,
                uptime: process.uptime(),
                user: connectedUser?.id || 'Unknown'
            };
            await sock.sendMessage(jid, { 
                text: `📊 *Bot Status*\n\n✅ Connected: ${stats.connected}\n⏰ Scheduled: ${stats.scheduled}\n👤 User: ${stats.user}\n⏱️ Uptime: ${Math.floor(stats.uptime / 60)} minutes` 
            });
            break;
            
        case 'help':
            await sock.sendMessage(jid, { 
                text: `🤖 *WhatsApp Bot Commands*\n\n` +
                      `📅 *Schedule*\n` +
                      `!schedule [time] [msg] - Schedule a message\n` +
                      `!list - Show your scheduled messages\n` +
                      `!cancel [id] - Cancel a scheduled message\n\n` +
                      `💬 *Responses*\n` +
                      `!reply [msg-id] [reply] - Reply to a specific message\n` +
                      `!ping - Check if bot is alive\n` +
                      `!status - Show bot status\n` +
                      `!help - Show this menu\n\n` +
                      `⏰ *Time Formats*\n` +
                      `• 2024-12-31T23:59 - Specific date/time\n` +
                      `• in 30m - In 30 minutes\n` +
                      `• in 2h - In 2 hours\n` +
                      `• tomorrow 9am - Tomorrow at 9 AM\n\n` +
                      `🔗 *API Access*\n` +
                      `POST /send - Send via API\n` +
                      `GET /status - Check bot status\n` +
                      `POST /schedule - Schedule via API`
            });
            break;
            
        default:
            await sock.sendMessage(jid, { text: '❓ Unknown command. Use !help for available commands.' });
    }
}

// ─── Express Server ───────────────────────────────────────────────────────
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
    res.json({ 
        status: 'ok', 
        whatsapp: sessionStatus,
        scheduledCount: scheduledMessages.filter(m => !m.executed).length,
        timestamp: new Date().toISOString()
    });
});

app.get('/qr', authCheck, (req, res) => {
    if (sessionStatus === 'connected') return res.json({ status: 'connected', qr: null });
    if (!currentQR) return res.json({ status: sessionStatus, qr: null });
    res.json({ status: 'scanning', qr: currentQR });
});

app.get('/status', authCheck, (req, res) => {
    res.json({ 
        status: sessionStatus,
        user: connectedUser,
        scheduledCount: scheduledMessages.filter(m => !m.executed).length,
        uptime: process.uptime()
    });
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
        res.json({ success: true, to: jid, timestamp: new Date().toISOString() });
    } catch (err) {
        console.error('Send error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/schedule', authCheck, async (req, res) => {
    if (sessionStatus !== 'connected') {
        return res.status(503).json({ error: 'WhatsApp not connected' });
    }
    
    const { jid, message, time } = req.body;
    if (!jid || !message || !time) {
        return res.status(400).json({ error: 'jid, message, and time required' });
    }
    
    const scheduleTime = new Date(time);
    if (isNaN(scheduleTime.getTime())) {
        return res.status(400).json({ error: 'Invalid time format' });
    }
    
    if (scheduleTime <= new Date()) {
        return res.status(400).json({ error: 'Schedule time must be in the future' });
    }
    
    const scheduledId = Date.now().toString() + '_' + Math.random().toString(36).substr(2, 6);
    scheduledMessages.push({
        id: scheduledId,
        jid,
        message,
        time: scheduleTime.toISOString(),
        executed: false,
        created: new Date().toISOString(),
        from: 'api'
    });
    saveScheduledMessages();
    
    res.json({ 
        id: scheduledId, 
        scheduled: true, 
        time: scheduleTime.toISOString(),
        message: message.substring(0, 100)
    });
});

app.get('/scheduled', authCheck, (req, res) => {
    res.json({
        total: scheduledMessages.length,
        pending: scheduledMessages.filter(m => !m.executed),
        executed: scheduledMessages.filter(m => m.executed).slice(-10)
    });
});

app.delete('/scheduled/:id', authCheck, (req, res) => {
    const { id } = req.params;
    const index = scheduledMessages.findIndex(m => m.id === id);
    if (index !== -1) {
        const removed = scheduledMessages.splice(index, 1)[0];
        saveScheduledMessages();
        res.json({ deleted: true, message: removed.message });
    } else {
        res.status(404).json({ error: 'Message not found' });
    }
});

app.post('/broadcast', authCheck, async (req, res) => {
    if (sessionStatus !== 'connected') {
        return res.status(503).json({ error: 'WhatsApp not connected' });
    }
    
    const { message, groups } = req.body;
    if (!message) {
        return res.status(400).json({ error: 'message required' });
    }
    
    try {
        let targets = [];
        if (groups && groups.length > 0) {
            targets = groups;
        } else {
            // Get all groups
            const groupList = await sock.groupFetchAllParticipating();
            targets = Object.keys(groupList);
        }
        
        const results = [];
        for (const target of targets) {
            try {
                await sock.sendMessage(target, { text: message });
                results.push({ jid: target, success: true });
            } catch (err) {
                results.push({ jid: target, success: false, error: err.message });
            }
            await new Promise(resolve => setTimeout(resolve, 1000)); // Rate limit
        }
        
        res.json({ success: true, results });
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
    isConnecting = false;
    retryCount = 0;
    setTimeout(() => connectToWhatsApp(), 1000);
    res.json({ success: true, message: 'Logged out. New QR will be generated.' });
});

// ─── Baileys Connection with Real-time Message Sync ────────────────────────
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
            syncFullHistory: true, // Enable full history sync
            markOnlineOnConnect: true, // Show as online
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
                } catch (e) {
                    console.error('[WA] QR error:', e.message);
                }
            }

            if (connection === 'open') {
                sessionStatus = 'connected';
                currentQR = null;
                isConnecting = false;
                retryCount = 0;
                
                // Get connected user info
                if (sock.user) {
                    connectedUser = sock.user;
                    console.log(`[WA] Connected as: ${sock.user.id} (${sock.user.name || 'Unknown'})`);
                }
                
                console.log('[WA] Connected! Loading scheduled messages...');
                loadScheduledMessages();
                
                // Start scheduled message checker
                if (global.scheduleInterval) clearInterval(global.scheduleInterval);
                global.scheduleInterval = setInterval(checkScheduledMessages, 30000);
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

        // REAL-TIME MESSAGE SYNC - This is the key addition
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type === 'notify') {
                for (const msg of messages) {
                    if (!msg.message) continue;
                    
                    const jid = msg.key.remoteJid;
                    const isGroup = jid.includes('@g.us');
                    const sender = isGroup ? msg.key.participant : jid;
                    
                    // Extract message text
                    let messageText = '';
                    let messageType = 'text';
                    
                    if (msg.message.conversation) {
                        messageText = msg.message.conversation;
                    } else if (msg.message.extendedTextMessage?.text) {
                        messageText = msg.message.extendedTextMessage.text;
                    } else if (msg.message.imageMessage?.caption) {
                        messageText = msg.message.imageMessage.caption;
                        messageType = 'image';
                    } else if (msg.message.videoMessage?.caption) {
                        messageText = msg.message.videoMessage.caption;
                        messageType = 'video';
                    } else {
                        // Skip non-text messages for command processing
                        continue;
                    }
                    
                    // Store in message history (keep last 100)
                    messageHistory.unshift({
                        id: msg.key.id,
                        from: jid,
                        sender: sender,
                        text: messageText,
                        type: messageType,
                        timestamp: new Date(),
                        isGroup: isGroup
                    });
                    messageHistory = messageHistory.slice(0, 100);
                    
                    console.log(`\n📨 [${isGroup ? 'GROUP' : 'PRIVATE'}] From: ${sender}`);
                    console.log(`   Message: ${messageText.substring(0, 100)}`);
                    
                    // Check if it's a command
                    if (messageText.startsWith('!')) {
                        console.log(`[CMD] Processing command: ${messageText}`);
                        try {
                            await handleCommand(jid, messageText, msg, { isGroup, sender });
                        } catch (err) {
                            console.error('[CMD] Error:', err.message);
                            await sock.sendMessage(jid, { text: '❌ Error processing command. Please try again.' });
                        }
                    }
                }
            }
        });
        
        // Handle message updates (edits, deletions)
        sock.ev.on('messages.update', async (updates) => {
            for (const update of updates) {
                if (update.update?.edited) {
                    console.log(`[EDIT] Message ${update.key.id} was edited`);
                }
            }
        });
        
        // Handle group updates if needed
        sock.ev.on('group-participants.update', (update) => {
            console.log(`[GROUP] ${update.id}: ${update.action} for ${update.participants.join(', ')}`);
        });

    } catch (err) {
        isConnecting = false;
        const delay = getRetryDelay();
        console.error('[WA] Setup error:', err.message);
        setTimeout(() => connectToWhatsApp(), delay);
    }
}

// ─── Start Server ─────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
    console.log(`\n🚀 =====================================`);
    console.log(`[Server] Running on port ${PORT}`);
    console.log(`[API] Endpoints available:`);
    console.log(`   GET  /health - Health check`);
    console.log(`   GET  /status - Bot status`);
    console.log(`   POST /send - Send message (requires API_SECRET)`);
    console.log(`   POST /schedule - Schedule message`);
    console.log(`   GET  /scheduled - List scheduled messages`);
    console.log(`   POST /broadcast - Broadcast to groups`);
    console.log(`=====================================\n`);
    connectToWhatsApp();
});

// ─── SELF-PING TO KEEP RAILWAY AWAKE ──────────────────────────────────────
// This pings your own server every 4 minutes to prevent Railway from sleeping
// Railway free tier puts apps to sleep after 5 minutes of inactivity
// This keeps the bot alive by generating consistent traffic

const SELF_PING_INTERVAL = 4 * 60 * 1000; // 4 minutes (240,000 ms)
let pingCount = 0;
let lastPingStatus = 'unknown';

// Function to ping the health endpoint
async function selfPing() {
    try {
        const url = `http://localhost:${PORT}/health`;
        const response = await fetch(url);
        
        if (response.ok) {
            const data = await response.json();
            pingCount++;
            lastPingStatus = 'success';
            console.log(`💓 [SELF-PING #${pingCount}] Success at ${new Date().toISOString()} - Status: ${data.whatsapp}, Scheduled: ${data.scheduledCount}`);
        } else {
            lastPingStatus = `failed (${response.status})`;
            console.warn(`⚠️ [SELF-PING] Health check failed with status: ${response.status}`);
        }
    } catch (err) {
        lastPingStatus = `error: ${err.message}`;
        console.error(`❌ [SELF-PING] Error: ${err.message}`);
    }
}

// Start the self-ping interval
console.log(`\n🔄 Self-ping system started - pinging every ${SELF_PING_INTERVAL / 1000} seconds to keep Railway awake`);
selfPing(); // Do an immediate ping on startup

const pingInterval = setInterval(selfPing, SELF_PING_INTERVAL);

// Optional: Add a more aggressive ping for the first few minutes to ensure app stays alive
// This helps during initial deployment when the app might be unstable
let initialPingsDone = 0;
const INITIAL_PING_COUNT = 3;
const INITIAL_PING_INTERVAL = 30 * 1000; // 30 seconds

const initialPingInterval = setInterval(() => {
    if (initialPingsDone < INITIAL_PING_COUNT) {
        selfPing();
        initialPingsDone++;
        console.log(`[INITIAL] Aggressive ping ${initialPingsDone}/${INITIAL_PING_COUNT} completed`);
    } else {
        clearInterval(initialPingInterval);
        console.log('[INITIAL] Aggressive ping phase completed, switching to normal interval');
    }
}, INITIAL_PING_INTERVAL);

// ─── Self-ping status endpoint ────────────────────────────────────────────
// This allows you to check the self-ping statistics
app.get('/ping-stats', authCheck, (req, res) => {
    res.json({
        selfPing: {
            enabled: true,
            intervalSeconds: SELF_PING_INTERVAL / 1000,
            totalPings: pingCount,
            lastStatus: lastPingStatus,
            lastPingTime: new Date().toISOString(),
            uptimeSeconds: process.uptime()
        },
        whatsapp: {
            status: sessionStatus,
            connected: sessionStatus === 'connected',
            user: connectedUser?.id || null
        },
        scheduled: {
            total: scheduledMessages.length,
            pending: scheduledMessages.filter(m => !m.executed).length
        }
    });
});

// ─── Graceful Shutdown ─────────────────────────────────────────────────────
// Clean up intervals and close connections when shutting down

process.on('SIGINT', async () => {
    console.log('\n\n🛑 Received SIGINT - Shutting down gracefully...');
    
    // Clear all intervals
    if (pingInterval) clearInterval(pingInterval);
    if (initialPingInterval) clearInterval(initialPingInterval);
    if (global.scheduleInterval) clearInterval(global.scheduleInterval);
    
    // Logout from WhatsApp
    if (sock) {
        console.log('[SHUTDOWN] Logging out from WhatsApp...');
        try {
            await sock.logout();
            console.log('[SHUTDOWN] Successfully logged out');
        } catch (err) {
            console.error('[SHUTDOWN] Error during logout:', err.message);
        }
    }
    
    // Close express server
    server.close(() => {
        console.log('[SHUTDOWN] Express server closed');
        console.log('[SHUTDOWN] Goodbye! 👋');
        process.exit(0);
    });
    
    // Force exit after 5 seconds if graceful shutdown fails
    setTimeout(() => {
        console.error('[SHUTDOWN] Forced exit after timeout');
        process.exit(1);
    }, 5000);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('[FATAL] Uncaught Exception:', error);
    // Don't exit, let the process continue
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
    // Don't exit, let the process continue
});

console.log('[INIT] Server initialized, waiting for WhatsApp connection...');