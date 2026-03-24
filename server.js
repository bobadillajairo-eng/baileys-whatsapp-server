// server.js — Baileys WhatsApp microservice with MongoDB persistence and CRM (ESM)
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
import { MongoClient } from 'mongodb';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET || 'changeme-set-this-in-railway-dashboard';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://bobadillajairo_db_user:fHsz934E3tTPCcpF@cluster0.8nnfj9g.mongodb.net/?appName=Cluster0';
const DB_NAME = process.env.DB_NAME || 'whatsapp_bot';

// ─── MongoDB Connection ────────────────────────────────────────────────────
let mongoClient = null;
let db = null;
let collections = {};

async function connectMongoDB() {
    try {
        console.log('[MongoDB] Connecting to MongoDB Atlas...');
        mongoClient = new MongoClient(MONGODB_URI, {
            maxPoolSize: 10,
            minPoolSize: 2,
            maxIdleTimeMS: 60000,
            connectTimeoutMS: 10000,
            socketTimeoutMS: 45000,
            serverSelectionTimeoutMS: 5000
        });
        
        await mongoClient.connect();
        db = mongoClient.db(DB_NAME);
        
        // Initialize collections
        collections = {
            authState: db.collection('auth_state'),
            scheduledMessages: db.collection('scheduled_messages'),
            messageHistory: db.collection('message_history'),
            groupsCache: db.collection('groups_cache'),
            botSettings: db.collection('bot_settings'),
            // CRM Collections
            contacts: db.collection('crm_contacts'),
            conversations: db.collection('crm_conversations'),
            tags: db.collection('crm_tags'),
            notes: db.collection('crm_notes'),
            campaigns: db.collection('crm_campaigns'),
            templates: db.collection('crm_templates')
        };
        
        // Create indexes
        await collections.scheduledMessages.createIndex({ schedule_time: 1 });
        await collections.scheduledMessages.createIndex({ jid: 1 });
        await collections.scheduledMessages.createIndex({ executed: 1 });
        await collections.messageHistory.createIndex({ timestamp: -1 });
        await collections.messageHistory.createIndex({ jid: 1 });
        await collections.messageHistory.createIndex({ message_id: 1 }, { unique: true });
        await collections.authState.createIndex({ id: 1 }, { unique: true });
        
        // CRM Indexes
        await collections.contacts.createIndex({ phone: 1 }, { unique: true });
        await collections.contacts.createIndex({ tags: 1 });
        await collections.conversations.createIndex({ contact_id: 1 });
        await collections.conversations.createIndex({ timestamp: -1 });
        await collections.campaigns.createIndex({ created_at: -1 });
        await collections.templates.createIndex({ name: 1 }, { unique: true });
        
        console.log('[MongoDB] ✅ Connected to MongoDB Atlas successfully');
        console.log(`[MongoDB] Database: ${DB_NAME}`);
        
        return true;
    } catch (err) {
        console.error('[MongoDB] ❌ Connection error:', err.message);
        return false;
    }
}

// ─── MongoDB Data Access Layer ────────────────────────────────────────────
class MongoDBDataStore {
    // Auth State Methods
    static async saveAuthState(id, state) {
        try {
            await collections.authState.updateOne(
                { id: id },
                { $set: { state: state, updated_at: new Date() } },
                { upsert: true }
            );
            return true;
        } catch (err) {
            console.error('[MongoDB] Error saving auth state:', err);
            return false;
        }
    }

    static async loadAuthState(id) {
        try {
            const doc = await collections.authState.findOne({ id: id });
            return doc?.state || null;
        } catch (err) {
            console.error('[MongoDB] Error loading auth state:', err);
            return null;
        }
    }

    // Scheduled Messages Methods
    static async addScheduledMessage(id, jid, message, scheduleTime, fromUser) {
        try {
            const doc = {
                id: id,
                jid: jid,
                message: message,
                schedule_time: new Date(scheduleTime),
                executed: false,
                executed_at: null,
                created_at: new Date(),
                from_user: fromUser,
                retry_count: 0,
                last_error: null
            };
            await collections.scheduledMessages.insertOne(doc);
            console.log(`[MongoDB] Scheduled message added: ${id}`);
            return id;
        } catch (err) {
            console.error('[MongoDB] Error adding scheduled message:', err);
            return null;
        }
    }

    static async getPendingScheduledMessages() {
        try {
            return await collections.scheduledMessages.find({
                executed: false,
                schedule_time: { $lte: new Date() }
            }).sort({ schedule_time: 1 }).toArray();
        } catch (err) {
            console.error('[MongoDB] Error getting pending messages:', err);
            return [];
        }
    }

    static async getScheduledMessagesByJid(jid, includeExecuted = false) {
        try {
            const query = { jid: jid };
            if (!includeExecuted) query.executed = false;
            return await collections.scheduledMessages.find(query)
                .sort({ schedule_time: 1 })
                .toArray();
        } catch (err) {
            console.error('[MongoDB] Error getting messages by JID:', err);
            return [];
        }
    }

    static async markMessageExecuted(id) {
        try {
            await collections.scheduledMessages.updateOne(
                { id: id },
                { $set: { executed: true, executed_at: new Date() } }
            );
            return true;
        } catch (err) {
            console.error('[MongoDB] Error marking message executed:', err);
            return false;
        }
    }

    static async updateMessageRetry(id, error) {
        try {
            await collections.scheduledMessages.updateOne(
                { id: id },
                { $inc: { retry_count: 1 }, $set: { last_error: error } }
            );
        } catch (err) {
            console.error('[MongoDB] Error updating retry:', err);
        }
    }

    static async deleteScheduledMessage(id, jid = null) {
        try {
            const query = { id: id };
            if (jid) query.jid = jid;
            const result = await collections.scheduledMessages.findOneAndDelete(query);
            return result.value;
        } catch (err) {
            console.error('[MongoDB] Error deleting message:', err);
            return null;
        }
    }

    static async cleanupOldMessages(daysToKeep = 7) {
        try {
            const cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - daysToKeep);
            const result = await collections.scheduledMessages.deleteMany({
                executed: true,
                executed_at: { $lt: cutoff }
            });
            console.log(`[MongoDB] Cleaned up ${result.deletedCount} old scheduled messages`);
            return result.deletedCount;
        } catch (err) {
            console.error('[MongoDB] Error cleaning up messages:', err);
            return 0;
        }
    }

    // Message History Methods
    static async saveMessageHistory(message) {
        try {
            const doc = {
                message_id: message.id,
                jid: message.jid,
                sender: message.sender,
                message_text: message.text,
                message_type: message.type || 'text',
                timestamp: message.timestamp || new Date(),
                is_group: message.isGroup || false,
                from_me: message.fromMe || false,
                processed: true,
                media_url: message.media_url || null
            };
            
            await collections.messageHistory.updateOne(
                { message_id: message.id },
                { $set: doc },
                { upsert: true }
            );
        } catch (err) {
            console.error('[MongoDB] Error saving message history:', err);
        }
    }

    static async getRecentMessages(jid, limit = 50) {
        try {
            return await collections.messageHistory.find({ jid: jid })
                .sort({ timestamp: -1 })
                .limit(limit)
                .toArray();
        } catch (err) {
            console.error('[MongoDB] Error getting recent messages:', err);
            return [];
        }
    }

    static async searchMessages(jid, searchTerm, limit = 20) {
        try {
            return await collections.messageHistory.find({
                jid: jid,
                message_text: { $regex: searchTerm, $options: 'i' }
            })
                .sort({ timestamp: -1 })
                .limit(limit)
                .toArray();
        } catch (err) {
            console.error('[MongoDB] Error searching messages:', err);
            return [];
        }
    }

    static async getMessageStats() {
        try {
            const oneWeekAgo = new Date();
            oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
            
            const stats = await collections.messageHistory.aggregate([
                { $match: { timestamp: { $gte: oneWeekAgo } } },
                {
                    $group: {
                        _id: null,
                        total_messages: { $sum: 1 },
                        unique_chats: { $addToSet: "$jid" },
                        sent_messages: { $sum: { $cond: ["$from_me", 1, 0] } },
                        received_messages: { $sum: { $cond: ["$from_me", 0, 1] } },
                        group_messages: { $sum: { $cond: ["$is_group", 1, 0] } }
                    }
                }
            ]).toArray();
            
            const result = stats[0] || {};
            return {
                total_messages: result.total_messages || 0,
                unique_chats: result.unique_chats?.length || 0,
                sent_messages: result.sent_messages || 0,
                received_messages: result.received_messages || 0,
                group_messages: result.group_messages || 0
            };
        } catch (err) {
            console.error('[MongoDB] Error getting stats:', err);
            return {
                total_messages: 0,
                unique_chats: 0,
                sent_messages: 0,
                received_messages: 0,
                group_messages: 0
            };
        }
    }

    // ========== CRM METHODS ==========
    
    // Contacts Management
    static async createOrUpdateContact(contactData) {
        try {
            const result = await collections.contacts.updateOne(
                { phone: contactData.phone },
                { 
                    $set: { 
                        ...contactData,
                        last_updated: new Date()
                    },
                    $setOnInsert: {
                        created_at: new Date(),
                        total_messages: 0,
                        total_conversations: 0
                    }
                },
                { upsert: true }
            );
            return result;
        } catch (err) {
            console.error('[CRM] Error saving contact:', err);
            return null;
        }
    }

    static async getContact(phone) {
        try {
            return await collections.contacts.findOne({ phone: phone });
        } catch (err) {
            console.error('[CRM] Error getting contact:', err);
            return null;
        }
    }

    static async getAllContacts(filters = {}, limit = 100, skip = 0) {
        try {
            const query = {};
            if (filters.tags) query.tags = { $in: filters.tags };
            if (filters.status) query.status = filters.status;
            if (filters.search) {
                query.$or = [
                    { phone: { $regex: filters.search, $options: 'i' } },
                    { name: { $regex: filters.search, $options: 'i' } },
                    { email: { $regex: filters.search, $options: 'i' } }
                ];
            }
            
            const contacts = await collections.contacts.find(query)
                .sort({ last_updated: -1 })
                .skip(skip)
                .limit(limit)
                .toArray();
            
            const total = await collections.contacts.countDocuments(query);
            return { contacts, total };
        } catch (err) {
            console.error('[CRM] Error getting contacts:', err);
            return { contacts: [], total: 0 };
        }
    }

    static async addContactTag(phone, tag) {
        try {
            await collections.contacts.updateOne(
                { phone: phone },
                { $addToSet: { tags: tag } }
            );
            return true;
        } catch (err) {
            console.error('[CRM] Error adding tag:', err);
            return false;
        }
    }

    static async removeContactTag(phone, tag) {
        try {
            await collections.contacts.updateOne(
                { phone: phone },
                { $pull: { tags: tag } }
            );
            return true;
        } catch (err) {
            console.error('[CRM] Error removing tag:', err);
            return false;
        }
    }

    static async deleteContact(phone) {
        try {
            const result = await collections.contacts.deleteOne({ phone: phone });
            return result.deletedCount > 0;
        } catch (err) {
            console.error('[CRM] Error deleting contact:', err);
            return false;
        }
    }

    // Conversations Management
    static async saveConversation(conversationData) {
        try {
            const result = await collections.conversations.insertOne({
                ...conversationData,
                timestamp: new Date()
            });
            
            // Update contact's message count
            await collections.contacts.updateOne(
                { phone: conversationData.phone },
                { 
                    $inc: { total_messages: 1 },
                    $set: { last_message_at: new Date() }
                }
            );
            
            return result;
        } catch (err) {
            console.error('[CRM] Error saving conversation:', err);
            return null;
        }
    }

    static async getConversations(phone, limit = 50) {
        try {
            return await collections.conversations.find({ phone: phone })
                .sort({ timestamp: -1 })
                .limit(limit)
                .toArray();
        } catch (err) {
            console.error('[CRM] Error getting conversations:', err);
            return [];
        }
    }

    static async getAllConversations(limit = 100, skip = 0) {
        try {
            const conversations = await collections.conversations.find()
                .sort({ timestamp: -1 })
                .skip(skip)
                .limit(limit)
                .toArray();
            
            const total = await collections.conversations.countDocuments();
            return { conversations, total };
        } catch (err) {
            console.error('[CRM] Error getting conversations:', err);
            return { conversations: [], total: 0 };
        }
    }

    // Notes Management
    static async addNote(phone, note, createdBy = 'system') {
        try {
            const noteData = {
                phone: phone,
                note: note,
                created_by: createdBy,
                created_at: new Date()
            };
            
            await collections.notes.insertOne(noteData);
            
            // Update contact with latest note
            await collections.contacts.updateOne(
                { phone: phone },
                { 
                    $push: { notes: noteData },
                    $set: { last_note_at: new Date() }
                }
            );
            
            return true;
        } catch (err) {
            console.error('[CRM] Error adding note:', err);
            return false;
        }
    }

    static async getNotes(phone, limit = 20) {
        try {
            return await collections.notes.find({ phone: phone })
                .sort({ created_at: -1 })
                .limit(limit)
                .toArray();
        } catch (err) {
            console.error('[CRM] Error getting notes:', err);
            return [];
        }
    }

    // Tags Management
    static async getAllTags() {
        try {
            const tags = await collections.contacts.aggregate([
                { $unwind: "$tags" },
                { $group: { _id: "$tags", count: { $sum: 1 } } },
                { $sort: { count: -1 } }
            ]).toArray();
            return tags;
        } catch (err) {
            console.error('[CRM] Error getting tags:', err);
            return [];
        }
    }

    // Campaigns Management
    static async createCampaign(campaignData) {
        try {
            const campaign = {
                ...campaignData,
                created_at: new Date(),
                status: 'draft',
                sent_count: 0,
                failed_count: 0
            };
            const result = await collections.campaigns.insertOne(campaign);
            return result;
        } catch (err) {
            console.error('[CRM] Error creating campaign:', err);
            return null;
        }
    }

    static async getCampaigns() {
        try {
            return await collections.campaigns.find()
                .sort({ created_at: -1 })
                .toArray();
        } catch (err) {
            console.error('[CRM] Error getting campaigns:', err);
            return [];
        }
    }

    static async getCampaign(id) {
        try {
            const { ObjectId } = await import('mongodb');
            return await collections.campaigns.findOne({ _id: new ObjectId(id) });
        } catch (err) {
            console.error('[CRM] Error getting campaign:', err);
            return null;
        }
    }

    static async executeCampaign(campaignId) {
        try {
            const { ObjectId } = await import('mongodb');
            const campaign = await collections.campaigns.findOne({ _id: new ObjectId(campaignId) });
            if (!campaign) return null;
            
            // Get target contacts based on filters
            let query = {};
            if (campaign.target_tags && campaign.target_tags.length > 0) {
                query.tags = { $in: campaign.target_tags };
            }
            
            const contacts = await collections.contacts.find(query).toArray();
            let sent = 0, failed = 0;
            
            for (const contact of contacts) {
                try {
                    const jid = contact.phone + '@s.whatsapp.net';
                    if (sock && sessionStatus === 'connected') {
                        await sock.sendMessage(jid, { text: campaign.message });
                        sent++;
                        
                        // Save to conversation history
                        await MongoDBDataStore.saveConversation({
                            phone: contact.phone,
                            message: campaign.message,
                            direction: 'outgoing',
                            campaign_id: campaignId,
                            status: 'sent'
                        });
                        
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                } catch (err) {
                    failed++;
                    console.error(`[CRM] Failed to send to ${contact.phone}:`, err);
                }
            }
            
            // Update campaign stats
            await collections.campaigns.updateOne(
                { _id: new ObjectId(campaignId) },
                { 
                    $set: { 
                        status: 'completed',
                        executed_at: new Date(),
                        sent_count: sent,
                        failed_count: failed
                    }
                }
            );
            
            return { sent, failed, total: contacts.length };
        } catch (err) {
            console.error('[CRM] Error executing campaign:', err);
            return null;
        }
    }

    static async deleteCampaign(campaignId) {
        try {
            const { ObjectId } = await import('mongodb');
            const result = await collections.campaigns.deleteOne({ _id: new ObjectId(campaignId) });
            return result.deletedCount > 0;
        } catch (err) {
            console.error('[CRM] Error deleting campaign:', err);
            return false;
        }
    }

    // Templates Management
    static async saveTemplate(templateData) {
        try {
            const result = await collections.templates.updateOne(
                { name: templateData.name },
                { $set: { ...templateData, updated_at: new Date() } },
                { upsert: true }
            );
            return result;
        } catch (err) {
            console.error('[CRM] Error saving template:', err);
            return null;
        }
    }

    static async getTemplates() {
        try {
            return await collections.templates.find()
                .sort({ name: 1 })
                .toArray();
        } catch (err) {
            console.error('[CRM] Error getting templates:', err);
            return [];
        }
    }

    static async deleteTemplate(name) {
        try {
            const result = await collections.templates.deleteOne({ name: name });
            return result.deletedCount > 0;
        } catch (err) {
            console.error('[CRM] Error deleting template:', err);
            return false;
        }
    }

    // Analytics
    static async getAnalytics() {
        try {
            const totalContacts = await collections.contacts.countDocuments();
            const totalMessages = await collections.conversations.countDocuments();
            const activeToday = await collections.conversations.countDocuments({
                timestamp: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) }
            });
            
            const messagesByDay = await collections.conversations.aggregate([
                {
                    $group: {
                        _id: { $dateToString: { format: "%Y-%m-%d", date: "$timestamp" } },
                        count: { $sum: 1 }
                    }
                },
                { $sort: { _id: -1 } },
                { $limit: 7 }
            ]).toArray();
            
            const topTags = await this.getAllTags();
            
            return {
                total_contacts: totalContacts,
                total_messages: totalMessages,
                active_today: activeToday,
                messages_by_day: messagesByDay.reverse(),
                top_tags: topTags.slice(0, 5)
            };
        } catch (err) {
            console.error('[CRM] Error getting analytics:', err);
            return null;
        }
    }
}

// ─── State ─────────────────────────────────────────────────────────────────
let sock = null;
let currentQR = null;
let sessionStatus = 'disconnected';
let isConnecting = false;
let retryCount = 0;
let connectedUser = null;

// ─── Send Message with Retry ───────────────────────────────────────────────
async function sendMessageWithRetry(jid, text, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            if (sock && sessionStatus === 'connected') {
                const result = await sock.sendMessage(jid, { text: text });
                console.log(`[SEND] Message sent to ${jid}: ${text.substring(0, 50)}...`);
                
                // Save to history
                await MongoDBDataStore.saveMessageHistory({
                    id: result.key.id,
                    jid: jid,
                    sender: sock.user.id,
                    text: text,
                    type: 'text',
                    timestamp: new Date(),
                    isGroup: jid.includes('@g.us'),
                    fromMe: true
                });
                
                return result;
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (err) {
            console.error(`[SEND] Attempt ${i + 1} failed:`, err.message);
            if (i < retries - 1) await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
    return false;
}

// ─── Check Scheduled Messages ─────────────────────────────────────────────
async function checkScheduledMessages() {
    if (sessionStatus !== 'connected') {
        console.log('[SCHEDULER] Waiting for connection...');
        return;
    }
    
    try {
        const pendingMessages = await MongoDBDataStore.getPendingScheduledMessages();
        
        for (const msg of pendingMessages) {
            console.log(`[SCHEDULER] Executing: ${msg.id}`);
            const success = await sendMessageWithRetry(msg.jid, msg.message);
            
            if (success) {
                await MongoDBDataStore.markMessageExecuted(msg.id);
            } else {
                await MongoDBDataStore.updateMessageRetry(msg.id, 'Send failed after retries');
                if (msg.retry_count >= 2) {
                    await MongoDBDataStore.markMessageExecuted(msg.id);
                    console.log(`[SCHEDULER] Failed after 3 retries: ${msg.id}`);
                }
            }
        }
        
        await MongoDBDataStore.cleanupOldMessages(7);
        
    } catch (err) {
        console.error('[SCHEDULER] Error:', err.message);
    }
}

// ─── Command Handler ─────────────────────────────────────────────────────
async function handleCommand(jid, command, originalMsg, msgInfo) {
    const parts = command.slice(1).split(' ');
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);
    
    console.log(`[CMD] Processing: ${cmd} from ${jid}`);
    
    switch(cmd) {
        case 'schedule':
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
            await MongoDBDataStore.addScheduledMessage(
                scheduledId, 
                jid, 
                messageText, 
                scheduleTime, 
                connectedUser?.id || 'unknown'
            );
            
            await sock.sendMessage(jid, { 
                text: `✅ *Message Scheduled!*\n\n📝 "${messageText.substring(0, 100)}"\n⏰ ${scheduleTime.toLocaleString()}\n🆔 ID: \`${scheduledId}\`\n\nUse !list to see all schedules or !cancel ${scheduledId} to cancel` 
            });
            break;
            
        case 'list':
            const messages = await MongoDBDataStore.getScheduledMessagesByJid(jid);
            if (messages.length === 0) {
                await sock.sendMessage(jid, { text: '📭 No pending scheduled messages.' });
            } else {
                let listText = `📅 *Your Scheduled Messages* (${messages.length})\n\n`;
                messages.forEach((msg, idx) => {
                    const date = new Date(msg.schedule_time);
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
            
            const removed = await MongoDBDataStore.deleteScheduledMessage(args[0], jid);
            if (removed) {
                await sock.sendMessage(jid, { text: `✅ *Cancelled*: "${removed.message.substring(0, 100)}"` });
            } else {
                await sock.sendMessage(jid, { text: '❌ Message ID not found. Use !list to see your scheduled messages.' });
            }
            break;
            
        case 'history':
            const limit = args[0] ? parseInt(args[0]) : 10;
            const history = await MongoDBDataStore.getRecentMessages(jid, Math.min(limit, 50));
            if (history.length === 0) {
                await sock.sendMessage(jid, { text: '📭 No recent messages found.' });
            } else {
                let historyText = `📜 *Recent Messages* (last ${history.length})\n\n`;
                history.slice(0, 10).forEach((msg, idx) => {
                    const time = new Date(msg.timestamp).toLocaleTimeString();
                    const prefix = msg.from_me ? '📤 You' : '📨 Them';
                    historyText += `${idx + 1}. ${prefix} (${time}): ${msg.message_text?.substring(0, 50)}${msg.message_text?.length > 50 ? '...' : ''}\n`;
                });
                await sock.sendMessage(jid, { text: historyText });
            }
            break;
            
        case 'search':
            if (args.length === 0) {
                await sock.sendMessage(jid, { text: 'Usage: !search [term] - Search messages' });
                return;
            }
            const searchTerm = args.join(' ');
            const results = await MongoDBDataStore.searchMessages(jid, searchTerm, 10);
            if (results.length === 0) {
                await sock.sendMessage(jid, { text: `🔍 No messages found containing "${searchTerm}"` });
            } else {
                let searchText = `🔍 *Search Results* for "${searchTerm}"\n\n`;
                results.forEach((msg, idx) => {
                    const time = new Date(msg.timestamp).toLocaleString();
                    searchText += `${idx + 1}. ${time}\n   ${msg.message_text.substring(0, 80)}...\n\n`;
                });
                await sock.sendMessage(jid, { text: searchText });
            }
            break;
            
        case 'stats':
            const stats = await MongoDBDataStore.getMessageStats();
            await sock.sendMessage(jid, { 
                text: `📊 *Message Statistics* (Last 7 Days)\n\n` +
                      `📨 Total Messages: ${stats.total_messages}\n` +
                      `💬 Unique Chats: ${stats.unique_chats}\n` +
                      `📤 Sent: ${stats.sent_messages}\n` +
                      `📥 Received: ${stats.received_messages}\n` +
                      `👥 Group Messages: ${stats.group_messages}`
            });
            break;
            
        case 'ping':
            await sock.sendMessage(jid, { 
                text: `🏓 Pong! Connected since: ${new Date().toLocaleString()}\n📊 Status: ${sessionStatus}\n🗄️ DB: MongoDB Atlas ✅` 
            });
            break;
            
        case 'status':
            const scheduledCount = (await MongoDBDataStore.getPendingScheduledMessages()).length;
            await sock.sendMessage(jid, { 
                text: `📊 *Bot Status*\n\n` +
                      `✅ Connected: ${sessionStatus === 'connected'}\n` +
                      `⏰ Scheduled: ${scheduledCount}\n` +
                      `👤 User: ${connectedUser?.id || 'Unknown'}\n` +
                      `🗄️ Database: MongoDB Atlas ✅\n` +
                      `⏱️ Uptime: ${Math.floor(process.uptime() / 60)} minutes`
            });
            break;
            
        case 'help':
            await sock.sendMessage(jid, { 
                text: `🤖 *WhatsApp Bot Commands*\n\n` +
                      `📅 *Schedule*\n` +
                      `!schedule [time] [msg] - Schedule a message\n` +
                      `!list - Show your scheduled messages\n` +
                      `!cancel [id] - Cancel a scheduled message\n\n` +
                      `📜 *History*\n` +
                      `!history [limit] - Show recent messages\n` +
                      `!search [term] - Search messages\n` +
                      `!stats - Show message statistics\n\n` +
                      `ℹ️ *Info*\n` +
                      `!ping - Check if bot is alive\n` +
                      `!status - Show bot status\n` +
                      `!help - Show this menu\n\n` +
                      `⏰ *Time Formats*\n` +
                      `• 2024-12-31T23:59 - Specific date/time\n` +
                      `• in 30m - In 30 minutes\n` +
                      `• in 2h - In 2 hours\n` +
                      `• tomorrow 9am - Tomorrow at 9 AM`
            });
            break;
            
        default:
            await sock.sendMessage(jid, { text: '❓ Unknown command. Use !help for available commands.' });
    }
}

// ─── Express Server ───────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static('public'));

function authCheck(req, res, next) {
    if (req.headers['x-api-secret'] !== API_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// ─── Basic Routes ─────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
    let dbStatus = 'disconnected';
    try {
        if (mongoClient && mongoClient.topology?.isConnected()) {
            dbStatus = 'connected';
        }
    } catch (err) {
        dbStatus = 'error';
    }
    
    const pendingCount = (await MongoDBDataStore.getPendingScheduledMessages()).length;
    
    res.json({ 
        status: 'ok', 
        whatsapp: sessionStatus,
        database: dbStatus,
        scheduledCount: pendingCount,
        timestamp: new Date().toISOString()
    });
});

app.get('/qr', authCheck, (req, res) => {
    if (sessionStatus === 'connected') return res.json({ status: 'connected', qr: null });
    if (!currentQR) return res.json({ status: sessionStatus, qr: null });
    res.json({ status: 'scanning', qr: currentQR });
});

app.get('/status', authCheck, async (req, res) => {
    const scheduledCount = (await MongoDBDataStore.getPendingScheduledMessages()).length;
    res.json({ 
        status: sessionStatus,
        user: connectedUser,
        database: 'MongoDB Atlas',
        scheduledCount: scheduledCount,
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
        
        // Save to CRM conversation
        await MongoDBDataStore.saveConversation({
            phone: phone,
            message: message,
            direction: 'outgoing',
            status: 'sent'
        });
        
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
    await MongoDBDataStore.addScheduledMessage(scheduledId, jid, message, scheduleTime, 'api');
    
    res.json({ 
        id: scheduledId, 
        scheduled: true, 
        time: scheduleTime.toISOString(),
        message: message.substring(0, 100)
    });
});

app.get('/scheduled', authCheck, async (req, res) => {
    const pending = await MongoDBDataStore.getPendingScheduledMessages();
    res.json({
        total: pending.length,
        pending: pending
    });
});

app.delete('/scheduled/:id', authCheck, async (req, res) => {
    const { id } = req.params;
    const removed = await MongoDBDataStore.deleteScheduledMessage(id);
    if (removed) {
        res.json({ deleted: true, message: removed.message });
    } else {
        res.status(404).json({ error: 'Message not found' });
    }
});

app.get('/history/:jid', authCheck, async (req, res) => {
    const { jid } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const history = await MongoDBDataStore.getRecentMessages(jid, Math.min(limit, 100));
    res.json({ jid, count: history.length, messages: history });
});

app.get('/search/:jid', authCheck, async (req, res) => {
    const { jid } = req.params;
    const { q, limit } = req.query;
    if (!q) {
        return res.status(400).json({ error: 'Search query required' });
    }
    const results = await MongoDBDataStore.searchMessages(jid, q, parseInt(limit) || 20);
    res.json({ jid, query: q, count: results.length, results });
});

app.get('/stats', authCheck, async (req, res) => {
    const stats = await MongoDBDataStore.getMessageStats();
    const scheduledCount = (await MongoDBDataStore.getPendingScheduledMessages()).length;
    res.json({
        messages: stats,
        scheduled: { pending: scheduledCount },
        whatsapp: { status: sessionStatus, user: connectedUser?.id },
        uptime: process.uptime()
    });
});

app.get('/groups', authCheck, async (req, res) => {
    if (sessionStatus !== 'connected') {
        return res.status(503).json({ error: 'WhatsApp not connected' });
    }
    
    try {
        const groups = await sock.groupFetchAllParticipating();
        const groupList = Object.values(groups).map(g => ({
            id: g.id,
            name: g.subject,
            participants: g.participants?.length || 0,
            owner: g.owner
        }));
        
        res.json(groupList);
    } catch (err) {
        res.status(500).json({ error: err.message });
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
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        res.json({ success: true, results });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/logout', authCheck, async (req, res) => {
    try { 
        if (sock) await sock.logout(); 
    } catch (_) {}
    
    await MongoDBDataStore.saveAuthState('whatsapp-auth', {});
    
    sessionStatus = 'disconnected';
    currentQR = null;
    sock = null;
    isConnecting = false;
    retryCount = 0;
    setTimeout(() => connectToWhatsApp(), 1000);
    res.json({ success: true, message: 'Logged out. New QR will be generated.' });
});

app.get('/ping-stats', authCheck, (req, res) => {
    res.json({
        selfPing: {
            enabled: true,
            intervalSeconds: 240,
            uptimeSeconds: process.uptime()
        },
        whatsapp: {
            status: sessionStatus,
            connected: sessionStatus === 'connected',
            user: connectedUser?.id || null
        },
        database: {
            connected: mongoClient && mongoClient.topology?.isConnected(),
            type: 'MongoDB Atlas',
            name: DB_NAME
        }
    });
});

// ─── CRM API Routes ───────────────────────────────────────────────────────

// Serve CRM dashboard
app.get('/crm', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'crm.html'));
});

// Contacts CRUD
app.get('/api/crm/contacts', authCheck, async (req, res) => {
    const { limit = 100, skip = 0, tags, status, search } = req.query;
    const filters = {};
    if (tags) filters.tags = tags.split(',');
    if (status) filters.status = status;
    if (search) filters.search = search;
    
    const result = await MongoDBDataStore.getAllContacts(filters, parseInt(limit), parseInt(skip));
    res.json(result);
});

app.get('/api/crm/contacts/:phone', authCheck, async (req, res) => {
    const contact = await MongoDBDataStore.getContact(req.params.phone);
    if (!contact) {
        return res.status(404).json({ error: 'Contact not found' });
    }
    res.json(contact);
});

app.post('/api/crm/contacts', authCheck, async (req, res) => {
    const { phone, name, email, tags, status, notes } = req.body;
    if (!phone) {
        return res.status(400).json({ error: 'Phone is required' });
    }
    
    const result = await MongoDBDataStore.createOrUpdateContact({
        phone,
        name,
        email,
        tags: tags || [],
        status: status || 'active',
        notes: notes || []
    });
    
    res.json({ success: true, result });
});

app.delete('/api/crm/contacts/:phone', authCheck, async (req, res) => {
    const deleted = await MongoDBDataStore.deleteContact(req.params.phone);
    if (deleted) {
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Contact not found' });
    }
});

app.post('/api/crm/contacts/:phone/tags', authCheck, async (req, res) => {
    const { tag } = req.body;
    if (!tag) {
        return res.status(400).json({ error: 'Tag is required' });
    }
    
    await MongoDBDataStore.addContactTag(req.params.phone, tag);
    res.json({ success: true });
});

app.delete('/api/crm/contacts/:phone/tags/:tag', authCheck, async (req, res) => {
    await MongoDBDataStore.removeContactTag(req.params.phone, req.params.tag);
    res.json({ success: true });
});

// Conversations
app.get('/api/crm/conversations', authCheck, async (req, res) => {
    const { limit = 100, skip = 0 } = req.query;
    const result = await MongoDBDataStore.getAllConversations(parseInt(limit), parseInt(skip));
    res.json(result);
});

app.get('/api/crm/conversations/:phone', authCheck, async (req, res) => {
    const { limit = 50 } = req.query;
    const conversations = await MongoDBDataStore.getConversations(req.params.phone, parseInt(limit));
    res.json(conversations);
});

// Notes
app.post('/api/crm/notes', authCheck, async (req, res) => {
    const { phone, note } = req.body;
    if (!phone || !note) {
        return res.status(400).json({ error: 'Phone and note are required' });
    }
    
    await MongoDBDataStore.addNote(phone, note, req.headers['x-user-id'] || 'api');
    res.json({ success: true });
});

app.get('/api/crm/notes/:phone', authCheck, async (req, res) => {
    const notes = await MongoDBDataStore.getNotes(req.params.phone);
    res.json(notes);
});

// Tags
app.get('/api/crm/tags', authCheck, async (req, res) => {
    const tags = await MongoDBDataStore.getAllTags();
    res.json(tags);
});

// Campaigns
app.get('/api/crm/campaigns', authCheck, async (req, res) => {
    const campaigns = await MongoDBDataStore.getCampaigns();
    res.json(campaigns);
});

app.post('/api/crm/campaigns', authCheck, async (req, res) => {
    const { name, message, target_tags, schedule_time } = req.body;
    if (!name || !message) {
        return res.status(400).json({ error: 'Name and message are required' });
    }
    
    const result = await MongoDBDataStore.createCampaign({
        name,
        message,
        target_tags: target_tags || [],
        schedule_time: schedule_time ? new Date(schedule_time) : null
    });
    
    res.json({ success: true, id: result.insertedId });
});

app.post('/api/crm/campaigns/:id/execute', authCheck, async (req, res) => {
    const { id } = req.params;
    const result = await MongoDBDataStore.executeCampaign(id);
    res.json(result);
});

app.delete('/api/crm/campaigns/:id', authCheck, async (req, res) => {
    const deleted = await MongoDBDataStore.deleteCampaign(req.params.id);
    if (deleted) {
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Campaign not found' });
    }
});

// Templates
app.get('/api/crm/templates', authCheck, async (req, res) => {
    const templates = await MongoDBDataStore.getTemplates();
    res.json(templates);
});

app.post('/api/crm/templates', authCheck, async (req, res) => {
    const { name, content, category } = req.body;
    if (!name || !content) {
        return res.status(400).json({ error: 'Name and content are required' });
    }
    
    await MongoDBDataStore.saveTemplate({ name, content, category });
    res.json({ success: true });
});

app.delete('/api/crm/templates/:name', authCheck, async (req, res) => {
    const deleted = await MongoDBDataStore.deleteTemplate(req.params.name);
    if (deleted) {
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Template not found' });
    }
});

// Analytics
app.get('/api/crm/analytics', authCheck, async (req, res) => {
    const analytics = await MongoDBDataStore.getAnalytics();
    res.json(analytics);
});

// Bulk Operations
app.post('/api/crm/bulk/send', authCheck, async (req, res) => {
    const { contacts, message, template_name } = req.body;
    if (!contacts || !contacts.length) {
        return res.status(400).json({ error: 'Contacts are required' });
    }
    
    let finalMessage = message;
    if (template_name) {
        const templates = await MongoDBDataStore.getTemplates();
        const template = templates.find(t => t.name === template_name);
        if (template) finalMessage = template.content;
    }
    
    const results = [];
    for (const contact of contacts) {
        try {
            const jid = contact.phone + '@s.whatsapp.net';
            if (sock && sessionStatus === 'connected') {
                await sock.sendMessage(jid, { text: finalMessage });
                
                await MongoDBDataStore.saveConversation({
                    phone: contact.phone,
                    message: finalMessage,
                    direction: 'outgoing',
                    status: 'sent'
                });
                
                results.push({ phone: contact.phone, success: true });
            } else {
                results.push({ phone: contact.phone, success: false, error: 'WhatsApp not connected' });
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (err) {
            results.push({ phone: contact.phone, success: false, error: err.message });
        }
    }
    
    res.json({ results, total: results.length, success_count: results.filter(r => r.success).length });
});

// Import/Export
app.post('/api/crm/import', authCheck, async (req, res) => {
    const { contacts } = req.body;
    if (!contacts || !contacts.length) {
        return res.status(400).json({ error: 'Contacts array is required' });
    }
    
    let imported = 0;
    for (const contact of contacts) {
        await MongoDBDataStore.createOrUpdateContact(contact);
        imported++;
    }
    
    res.json({ imported, total: contacts.length });
});

app.get('/api/crm/export', authCheck, async (req, res) => {
    const { format = 'json', tags } = req.query;
    const filters = {};
    if (tags) filters.tags = tags.split(',');
    
    const { contacts } = await MongoDBDataStore.getAllContacts(filters, 10000, 0);
    
    if (format === 'csv') {
        const csvHeaders = 'Phone,Name,Email,Tags,Status,Created At,Last Updated\n';
        const csvRows = contacts.map(c => 
            `${c.phone},${c.name || ''},${c.email || ''},"${(c.tags || []).join(';')}",${c.status || 'active'},${c.created_at},${c.last_updated}`
        ).join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=contacts.csv');
        res.send(csvHeaders + csvRows);
    } else {
        res.json(contacts);
    }
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

    try {
        let savedState = await MongoDBDataStore.loadAuthState('whatsapp-auth');
        if (!savedState) {
            savedState = {};
            console.log('[WA] No saved auth state found, will create new');
        }
        
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`[WA] Using WA version ${version.join('.')} — isLatest: ${isLatest}`);

        sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            auth: savedState,
            printQRInTerminal: false,
            browser: Browsers.ubuntu('Chrome'),
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 10000,
            retryRequestDelayMs: 2000,
            maxMsgRetryCount: 3,
            syncFullHistory: true,
            markOnlineOnConnect: true,
        });

        sock.ev.on('creds.update', async (creds) => {
            await MongoDBDataStore.saveAuthState('whatsapp-auth', creds);
            console.log('[WA] Credentials saved to MongoDB');
        });

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
                
                if (sock.user) {
                    connectedUser = sock.user;
                    console.log(`[WA] Connected as: ${sock.user.id} (${sock.user.name || 'Unknown'})`);
                }
                
                console.log('[WA] Connected! Loading scheduled messages...');
                
                if (global.scheduleInterval) clearInterval(global.scheduleInterval);
                global.scheduleInterval = setInterval(checkScheduledMessages, 30000);
                await checkScheduledMessages();
            }

            if (connection === 'close') {
                isConnecting = false;
                const code = lastDisconnect?.error?.output?.statusCode;
                console.log('[WA] Disconnected, code:', code);

                if (code === DisconnectReason.loggedOut) {
                    await MongoDBDataStore.saveAuthState('whatsapp-auth', {});
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

        // Real-time message handler with CRM integration
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type === 'notify') {
                for (const msg of messages) {
                    if (!msg.message) continue;
                    
                    const jid = msg.key.remoteJid;
                    const isGroup = jid.includes('@g.us');
                    const sender = isGroup ? msg.key.participant : jid;
                    const phone = sender.split('@')[0];
                    
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
                        continue;
                    }
                    
                    // Save to MongoDB
                    await MongoDBDataStore.saveMessageHistory({
                        id: msg.key.id,
                        jid: jid,
                        sender: sender,
                        text: messageText,
                        type: messageType,
                        timestamp: new Date(),
                        isGroup: isGroup,
                        fromMe: false
                    });
                    
                    // Save to CRM conversation
                    await MongoDBDataStore.saveConversation({
                        phone: phone,
                        message: messageText,
                        direction: 'incoming',
                        type: messageType,
                        status: 'received'
                    });
                    
                    // Auto-create or update contact
                    await MongoDBDataStore.createOrUpdateContact({
                        phone: phone,
                        name: msg.pushName || null,
                        last_message_at: new Date()
                    });
                    
                    console.log(`\n📨 [${isGroup ? 'GROUP' : 'PRIVATE'}] From: ${sender}`);
                    console.log(`   Message: ${messageText.substring(0, 100)}`);
                    
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
        
        sock.ev.on('messages.update', async (updates) => {
            for (const update of updates) {
                if (update.update?.edited) {
                    console.log(`[EDIT] Message ${update.key.id} was edited`);
                }
            }
        });
        
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

// ─── Start Server with Self-Ping ─────────────────────────────────────────
const server = app.listen(PORT, async () => {
    console.log(`\n🚀 =====================================`);
    console.log(`[Server] Running on port ${PORT}`);
    
    await connectMongoDB();
    
    console.log(`[API] Endpoints available:`);
    console.log(`   GET  /health - Health check`);
    console.log(`   GET  /status - Bot status`);
    console.log(`   POST /send - Send message`);
    console.log(`   POST /schedule - Schedule message`);
    console.log(`   GET  /scheduled - List scheduled messages`);
    console.log(`   GET  /crm - CRM Dashboard`);
    console.log(`   GET  /api/crm/contacts - List contacts`);
    console.log(`   GET  /api/crm/campaigns - List campaigns`);
    console.log(`   GET  /api/crm/templates - List templates`);
    console.log(`   GET  /api/crm/analytics - View analytics`);
    console.log(`=====================================\n`);
    connectToWhatsApp();
});

// Self-ping to keep Railway awake
const SELF_PING_INTERVAL = 4 * 60 * 1000;
let pingCount = 0;

async function selfPing() {
    try {
        const response = await fetch(`http://localhost:${PORT}/health`);
        if (response.ok) {
            pingCount++;
            console.log(`💓 [SELF-PING #${pingCount}] Success at ${new Date().toISOString()}`);
        }
    } catch (err) {
        console.error(`❌ [SELF-PING] Error: ${err.message}`);
    }
}

setInterval(selfPing, SELF_PING_INTERVAL);
selfPing();

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n\n🛑 Shutting down gracefully...');
    if (global.scheduleInterval) clearInterval(global.scheduleInterval);
    if (sock) await sock.logout();
    if (mongoClient) await mongoClient.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
});