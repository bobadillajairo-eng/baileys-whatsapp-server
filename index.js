// index.js
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const Pino = require('pino');
const cron = require('node-cron');
const express = require('express');
const fs = require('fs');
const path = require('path');

// Store for scheduled messages
let scheduledMessages = [];
let sock = null;
let isConnected = false;

// Load scheduled messages from file
function loadScheduledMessages() {
    try {
        const data = fs.readFileSync('./scheduled_messages.json', 'utf8');
        scheduledMessages = JSON.parse(data);
        console.log(`Loaded ${scheduledMessages.length} scheduled messages`);
    } catch (err) {
        scheduledMessages = [];
    }
}

// Save scheduled messages to file
function saveScheduledMessages() {
    fs.writeFileSync('./scheduled_messages.json', JSON.stringify(scheduledMessages, null, 2));
}

// Send a message with retry logic
async function sendMessageWithRetry(jid, text, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            if (sock && isConnected) {
                await sock.sendMessage(jid, { text: text });
                console.log(`Message sent to ${jid}: ${text.substring(0, 50)}...`);
                return true;
            }
        } catch (err) {
            console.error(`Send attempt ${i + 1} failed:`, err);
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
    return false;
}

// Check and execute scheduled messages
async function checkScheduledMessages() {
    const now = new Date();
    
    for (const scheduled of scheduledMessages) {
        if (!scheduled.executed && new Date(scheduled.time) <= now) {
            console.log(`Executing scheduled message: ${scheduled.id}`);
            const success = await sendMessageWithRetry(scheduled.jid, scheduled.message);
            
            if (success) {
                scheduled.executed = true;
                scheduled.executedAt = new Date().toISOString();
                saveScheduledMessages();
            }
        }
    }
    
    // Clean up old messages (older than 24 hours)
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    scheduledMessages = scheduledMessages.filter(msg => 
        !msg.executed || new Date(msg.time) > cutoff
    );
    saveScheduledMessages();
}

// Initialize WhatsApp connection
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: Pino({ level: 'silent' }),
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        syncFullHistory: true, // Sync full message history
        markOnlineOnConnect: true,
    });
    
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('QR Code generated. Scan with WhatsApp:');
            // You can also serve QR via HTTP endpoint
        }
        
        if (connection === 'open') {
            isConnected = true;
            console.log('✅ Connected to WhatsApp!');
            console.log(`Logged in as: ${sock.user.id}`);
            
            // Load scheduled messages
            loadScheduledMessages();
            
            // Check scheduled messages every minute
            setInterval(checkScheduledMessages, 60000);
        }
        
        if (connection === 'close') {
            isConnected = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`Connection closed. Status: ${statusCode}`);
            
            // Reconnect if disconnected
            if (statusCode !== DisconnectReason.loggedOut) {
                console.log('Reconnecting in 5 seconds...');
                setTimeout(connectToWhatsApp, 5000);
            } else {
                console.log('Logged out. Please delete auth_info folder and restart.');
            }
        }
    });
    
    // Handle credentials update
    sock.ev.on('creds.update', saveCreds);
    
    // Real-time message handler
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type === 'notify') {
            for (const msg of messages) {
                if (!msg.message) continue;
                
                const jid = msg.key.remoteJid;
                const messageText = msg.message.conversation || 
                                   msg.message.extendedTextMessage?.text ||
                                   '';
                
                console.log(`\n📨 Message from ${jid}: ${messageText}`);
                
                // Handle commands
                if (messageText.startsWith('!')) {
                    await handleCommand(jid, messageText, msg);
                }
            }
        }
    });
    
    return sock;
}

// Command handler
async function handleCommand(jid, command, originalMsg) {
    const parts = command.slice(1).split(' ');
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);
    
    switch(cmd) {
        case 'schedule':
            // !schedule [time] [message] - Schedule a message
            // Example: !schedule 2024-12-31T23:59 Hello everyone!
            if (args.length < 2) {
                await sock.sendMessage(jid, { 
                    text: 'Usage: !schedule YYYY-MM-DDTHH:MM Message\nExample: !schedule 2024-12-31T23:59 Happy New Year!' 
                });
                return;
            }
            
            const scheduleTime = new Date(args[0]);
            const message = args.slice(1).join(' ');
            
            if (isNaN(scheduleTime.getTime())) {
                await sock.sendMessage(jid, { text: 'Invalid time format. Use: YYYY-MM-DDTHH:MM' });
                return;
            }
            
            const scheduledId = Date.now().toString();
            scheduledMessages.push({
                id: scheduledId,
                jid: jid,
                message: message,
                time: scheduleTime.toISOString(),
                executed: false,
                created: new Date().toISOString()
            });
            saveScheduledMessages();
            
            await sock.sendMessage(jid, { 
                text: `✅ Message scheduled for ${scheduleTime.toLocaleString()}\nID: ${scheduledId}` 
            });
            break;
            
        case 'list':
            // !list - List all pending scheduled messages
            const pending = scheduledMessages.filter(m => !m.executed);
            if (pending.length === 0) {
                await sock.sendMessage(jid, { text: 'No pending scheduled messages.' });
            } else {
                let listText = '📅 Scheduled Messages:\n';
                pending.forEach((msg, idx) => {
                    listText += `${idx + 1}. ${new Date(msg.time).toLocaleString()}: ${msg.message.substring(0, 50)}...\n`;
                });
                await sock.sendMessage(jid, { text: listText });
            }
            break;
            
        case 'cancel':
            // !cancel [id] - Cancel a scheduled message
            if (args.length === 0) {
                await sock.sendMessage(jid, { text: 'Usage: !cancel [message_id]' });
                return;
            }
            
            const index = scheduledMessages.findIndex(m => m.id === args[0]);
            if (index !== -1) {
                const removed = scheduledMessages.splice(index, 1)[0];
                saveScheduledMessages();
                await sock.sendMessage(jid, { text: `✅ Cancelled message: ${removed.message.substring(0, 50)}` });
            } else {
                await sock.sendMessage(jid, { text: 'Message ID not found.' });
            }
            break;
            
        case 'ping':
            await sock.sendMessage(jid, { text: 'pong' });
            break;
            
        case 'help':
            await sock.sendMessage(jid, { 
                text: `📱 Available Commands:
!schedule [time] [message] - Schedule a message
!list - List scheduled messages
!cancel [id] - Cancel scheduled message
!ping - Check if bot is alive
!reply [id] [message] - Reply to a specific message
!broadcast [message] - Send to all contacts (admin only)`
            });
            break;
            
        default:
            await sock.sendMessage(jid, { text: 'Unknown command. Use !help for available commands.' });
    }
}

// Express server for web control
const app = express();
app.use(express.json());

app.get('/status', (req, res) => {
    res.json({
        connected: isConnected,
        user: sock?.user?.id || null,
        scheduledCount: scheduledMessages.filter(m => !m.executed).length
    });
});

app.post('/send', async (req, res) => {
    const { jid, message } = req.body;
    if (!jid || !message) {
        return res.status(400).json({ error: 'jid and message required' });
    }
    
    const success = await sendMessageWithRetry(jid, message);
    res.json({ success });
});

app.post('/schedule', async (req, res) => {
    const { jid, message, time } = req.body;
    if (!jid || !message || !time) {
        return res.status(400).json({ error: 'jid, message, and time required' });
    }
    
    const scheduleTime = new Date(time);
    if (isNaN(scheduleTime.getTime())) {
        return res.status(400).json({ error: 'Invalid time format' });
    }
    
    const scheduledId = Date.now().toString();
    scheduledMessages.push({
        id: scheduledId,
        jid,
        message,
        time: scheduleTime.toISOString(),
        executed: false,
        created: new Date().toISOString()
    });
    saveScheduledMessages();
    
    res.json({ id: scheduledId, scheduled: true });
});

app.get('/scheduled', (req, res) => {
    res.json(scheduledMessages.filter(m => !m.executed));
});

// Start everything
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🌐 Web control panel: http://localhost:${PORT}`);
});

// Start WhatsApp connection
connectToWhatsApp().catch(console.error);

// Keep alive for Railway
setInterval(() => {
    if (!isConnected) {
        console.log('⚠️ Not connected. Waiting for reconnection...');
    }
}, 30000);