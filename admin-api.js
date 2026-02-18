const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const os = require('os');
const fs = require('fs-extra');
const path = require('path');

// Models
const Session = mongoose.model('Session');
const Settings = mongoose.model('Settings');

// Global config storage
let globalConfig = {
    newsletterJIDs: ['120363402325089913@newsletter'],
    groupLinks: ['https://chat.whatsapp.com/IdGNaKt80DEBqirc2ek4ks'],
    autoViewStatus: true,
    autoLikeStatus: true,
    autoRecording: true,
    autoLikeEmojis: '💋,😶,✨️,💗,🎈,🎉,🥳,❤️,🧫,🐢',
    prefix: '.',
    ownerNumber: '255612491554',
    botFooter: '>  © 𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈🐢𝚂𝙸𝙻𝙰-𝙼𝙳',
    imagePath: 'https://files.catbox.moe/jwmx1j.jpg',
    channelLink: 'https://whatsapp.com/channel/0029VbBG4gfISTkCpKxyMH02'
};

// ==================== STATS ENDPOINTS ====================

// Get system stats
router.get('/stats', async (req, res) => {
    try {
        const totalSessions = await Session.countDocuments();
        const activeSessions = global.activeSockets?.size || 0;
        
        const memory = process.memoryUsage();
        const memoryMB = Math.round(memory.heapUsed / 1024 / 1024);
        
        const uptime = process.uptime();
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        
        // MongoDB connection status
        const mongoConnected = mongoose.connection.readyState === 1;
        
        // Get total documents
        const totalDocs = await Session.countDocuments() + await Settings.countDocuments();
        
        res.json({
            totalSessions,
            activeSessions,
            memory: `${memoryMB}MB`,
            uptime: `${hours}h ${minutes}m`,
            platform: os.platform(),
            nodeVersion: process.version,
            mongoURI: process.env.MONGODB_URI || 'mongodb+srv://...',
            mongoConnected,
            totalDocs
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get all sessions from MongoDB
router.get('/sessions', async (req, res) => {
    try {
        const sessions = await Session.find({}).sort({ updatedAt: -1 });
        
        const formatted = sessions.map(s => ({
            number: s.number,
            active: global.activeSockets?.has(s.number) || false,
            lastActive: s.updatedAt ? new Date(s.updatedAt).toLocaleString() : 'Never',
            createdAt: s.createdAt ? new Date(s.createdAt).toLocaleString() : 'Unknown'
        }));
        
        res.json({ sessions: formatted });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get config
router.get('/config', (req, res) => {
    res.json(globalConfig);
});

// ==================== SESSION MANAGEMENT ====================

// Reconnect all sessions
router.post('/reconnect-all', async (req, res) => {
    try {
        const sessions = await Session.find({});
        let success = 0;
        
        for (const session of sessions) {
            try {
                const number = session.number;
                if (!global.activeSockets?.has(number)) {
                    // Call reconnect function from pair.js
                    const mockRes = { 
                        headersSent: false, 
                        send: () => {}, 
                        status: () => mockRes 
                    };
                    
                    if (typeof global.EmpirePair === 'function') {
                        await global.EmpirePair(number, mockRes);
                        success++;
                    }
                    await new Promise(r => setTimeout(r, 1500));
                } else {
                    success++;
                }
            } catch (e) {
                console.error(`Failed to reconnect ${session.number}:`, e.message);
            }
        }
        
        // Log activity
        const logEntry = `[${new Date().toISOString()}] INFO - Reconnected ${success}/${sessions.length} sessions\n`;
        fs.appendFileSync(path.join(__dirname, '../logs.txt'), logEntry);
        
        res.json({ success, total: sessions.length });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Reconnect single session
router.post('/reconnect', async (req, res) => {
    try {
        const { number } = req.body;
        if (!number) return res.status(400).json({ error: 'Number required' });
        
        const mockRes = { 
            headersSent: false, 
            send: () => {}, 
            status: () => mockRes 
        };
        
        if (typeof global.EmpirePair === 'function') {
            await global.EmpirePair(number, mockRes);
            
            // Log
            const logEntry = `[${new Date().toISOString()}] INFO - Reconnected session: ${number}\n`;
            fs.appendFileSync(path.join(__dirname, '../logs.txt'), logEntry);
            
            res.json({ success: true, message: `Reconnected ${number}` });
        } else {
            res.status(500).json({ error: 'Reconnect function not available' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete single session
router.post('/delete-session', async (req, res) => {
    try {
        const { number } = req.body;
        if (!number) return res.status(400).json({ error: 'Number required' });
        
        // Delete from MongoDB
        await Session.deleteMany({ number });
        await Settings.deleteOne({ number });
        
        // Close socket if active
        if (global.activeSockets?.has(number)) {
            try {
                global.activeSockets.get(number).ws.close();
                global.activeSockets.delete(number);
            } catch (e) {}
        }
        
        // Delete local session folder
        const sessionPath = path.join(__dirname, '../session', `session_${number}`);
        if (fs.existsSync(sessionPath)) {
            await fs.remove(sessionPath);
        }
        
        // Log
        const logEntry = `[${new Date().toISOString()}] INFO - Deleted session: ${number}\n`;
        fs.appendFileSync(path.join(__dirname, '../logs.txt'), logEntry);
        
        res.json({ success: true, message: `Deleted ${number}` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete all sessions
router.post('/delete-all-sessions', async (req, res) => {
    try {
        // Delete all from MongoDB
        const deletedSessions = await Session.deleteMany({});
        await Settings.deleteMany({});
        
        // Close all sockets
        if (global.activeSockets) {
            for (const [number, socket] of global.activeSockets) {
                try {
                    socket.ws.close();
                } catch (e) {}
            }
            global.activeSockets.clear();
        }
        
        // Delete all local session folders
        const sessionDir = path.join(__dirname, '../session');
        if (fs.existsSync(sessionDir)) {
            await fs.emptyDir(sessionDir);
        }
        
        // Log
        const logEntry = `[${new Date().toISOString()}] WARN - Deleted ALL sessions (${deletedSessions.deletedCount})\n`;
        fs.appendFileSync(path.join(__dirname, '../logs.txt'), logEntry);
        
        res.json({ 
            success: true, 
            deleted: deletedSessions.deletedCount 
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Force logout session
router.post('/force-logout', async (req, res) => {
    try {
        const { number } = req.body;
        if (!number) return res.status(400).json({ error: 'Number required' });
        
        if (global.activeSockets?.has(number)) {
            const socket = global.activeSockets.get(number);
            
            // Send logout command
            try {
                await socket.sendMessage(socket.user.id, { 
                    text: '🚪 Force logout by admin' 
                });
            } catch (e) {}
            
            // Close connection
            socket.ws.close();
            global.activeSockets.delete(number);
        }
        
        // Delete creds but keep number in DB
        await Session.updateOne(
            { number },
            { $unset: { creds: 1 } }
        );
        
        // Log
        const logEntry = `[${new Date().toISOString()}] WARN - Force logout: ${number}\n`;
        fs.appendFileSync(path.join(__dirname, '../logs.txt'), logEntry);
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Clear all (stop all bots but keep DB)
router.post('/clear-all', (req, res) => {
    try {
        let cleared = 0;
        
        if (global.activeSockets) {
            for (const [number, socket] of global.activeSockets) {
                try {
                    socket.ws.close();
                    cleared++;
                } catch (e) {}
            }
            global.activeSockets.clear();
        }
        
        res.json({ success: true, cleared });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== AUTO-FOLLOW FUNCTIONS ====================

// Follow newsletters for all active bots
router.post('/follow-newsletters', async (req, res) => {
    try {
        const { jids } = req.body;
        if (!jids || !Array.isArray(jids)) {
            return res.status(400).json({ error: 'Invalid JIDs' });
        }
        
        // Save to global config
        globalConfig.newsletterJIDs = jids;
        
        let followed = 0;
        let totalBots = 0;
        
        // Follow for all active sockets
        if (global.activeSockets) {
            totalBots = global.activeSockets.size;
            
            for (const [number, socket] of global.activeSockets) {
                for (const jid of jids) {
                    try {
                        // Check if newsletter
                        if (jid.includes('@newsletter')) {
                            await socket.newsletterFollow(jid);
                            
                            // React to last message
                            try {
                                await socket.sendMessage(jid, { 
                                    react: { text: '❤️', key: { id: '1' } } 
                                });
                            } catch (e) {}
                            
                            followed++;
                        }
                        await new Promise(r => setTimeout(r, 1000));
                    } catch (e) {
                        console.error(`Failed to follow ${jid} for ${number}:`, e.message);
                    }
                }
            }
        }
        
        // Log
        const logEntry = `[${new Date().toISOString()}] INFO - Followed newsletters: ${followed} reactions\n`;
        fs.appendFileSync(path.join(__dirname, '../logs.txt'), logEntry);
        
        res.json({ 
            success: true, 
            followed,
            totalBots
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Join groups for all active bots
router.post('/join-groups', async (req, res) => {
    try {
        const { links } = req.body;
        if (!links || !Array.isArray(links)) {
            return res.status(400).json({ error: 'Invalid links' });
        }
        
        // Save to global config
        globalConfig.groupLinks = links;
        
        let joined = 0;
        let totalBots = 0;
        
        if (global.activeSockets) {
            totalBots = global.activeSockets.size;
            
            for (const [number, socket] of global.activeSockets) {
                for (const link of links) {
                    try {
                        const inviteCodeMatch = link.match(/chat\.whatsapp\.com\/([a-zA-Z0-9]+)/);
                        if (inviteCodeMatch) {
                            const result = await socket.groupAcceptInvite(inviteCodeMatch[1]);
                            if (result?.gid) joined++;
                            await new Promise(r => setTimeout(r, 1500));
                        }
                    } catch (e) {
                        console.error(`Failed to join ${link} for ${number}:`, e.message);
                    }
                }
            }
        }
        
        // Log
        const logEntry = `[${new Date().toISOString()}] INFO - Joined groups: ${joined} joins\n`;
        fs.appendFileSync(path.join(__dirname, '../logs.txt'), logEntry);
        
        res.json({ 
            success: true, 
            joined,
            totalBots
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Save auto settings
router.post('/save-auto-settings', (req, res) => {
    try {
        const settings = req.body;
        
        // Update global config
        globalConfig.autoViewStatus = settings.autoViewStatus;
        globalConfig.autoLikeStatus = settings.autoLikeStatus;
        globalConfig.autoRecording = settings.autoRecording;
        globalConfig.autoLikeEmojis = settings.autoLikeEmojis;
        
        // Apply to all active bots if needed
        if (global.activeSockets) {
            for (const socket of global.activeSockets.values()) {
                // Update socket config
                socket.autoViewStatus = settings.autoViewStatus;
                socket.autoLikeStatus = settings.autoLikeStatus;
                socket.autoRecording = settings.autoRecording;
                socket.autoLikeEmojis = settings.autoLikeEmojis;
            }
        }
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Save bot settings
router.post('/save-bot-settings', (req, res) => {
    try {
        const settings = req.body;
        
        // Update global config
        globalConfig.prefix = settings.prefix;
        globalConfig.ownerNumber = settings.ownerNumber;
        globalConfig.botFooter = settings.botFooter;
        globalConfig.imagePath = settings.imagePath;
        globalConfig.channelLink = settings.channelLink;
        
        // Apply to all active bots
        if (global.activeSockets) {
            for (const socket of global.activeSockets.values()) {
                socket.prefix = settings.prefix;
            }
        }
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Apply settings to all bots
router.post('/apply-settings-all', (req, res) => {
    try {
        let applied = 0;
        
        if (global.activeSockets) {
            for (const socket of global.activeSockets.values()) {
                // Apply all configs
                socket.prefix = globalConfig.prefix;
                socket.autoViewStatus = globalConfig.autoViewStatus;
                socket.autoLikeStatus = globalConfig.autoLikeStatus;
                socket.autoRecording = globalConfig.autoRecording;
                socket.autoLikeEmojis = globalConfig.autoLikeEmojis;
                applied++;
            }
        }
        
        res.json({ success: true, applied });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Save newsletter JIDs
router.post('/save-newsletter-jids', (req, res) => {
    try {
        const { jids } = req.body;
        globalConfig.newsletterJIDs = jids;
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Save group links
router.post('/save-group-links', (req, res) => {
    try {
        const { links } = req.body;
        globalConfig.groupLinks = links;
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== MONGODB FUNCTIONS ====================

// Change MongoDB URI (LIVE)
router.post('/change-mongodb', async (req, res) => {
    try {
        const { uri } = req.body;
        if (!uri) return res.status(400).json({ error: 'URI required' });
        
        // Validate URI format
        if (!uri.startsWith('mongodb+srv://') && !uri.startsWith('mongodb://')) {
            return res.status(400).json({ error: 'Invalid MongoDB URI format' });
        }
        
        // Disconnect current
        await mongoose.disconnect();
        
        // Connect new
        await mongoose.connect(uri, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
            serverSelectionTimeoutMS: 10000
        });
        
        // Update environment variable
        process.env.MONGODB_URI = uri;
        
        // Log
        const logEntry = `[${new Date().toISOString()}] INFO - Changed MongoDB URI\n`;
        fs.appendFileSync(path.join(__dirname, '../logs.txt'), logEntry);
        
        res.json({ success: true, message: 'MongoDB changed successfully' });
    } catch (error) {
        // Try to reconnect to old DB
        try {
            await mongoose.connect(process.env.MONGODB_URI, {
                useNewUrlParser: true,
                useUnifiedTopology: true
            });
        } catch (e) {}
        
        res.status(500).json({ error: error.message });
    }
});

// Test MongoDB connection
router.post('/test-mongo', async (req, res) => {
    try {
        const { uri } = req.body;
        
        // Use current URI if not provided
        const testUri = uri || process.env.MONGODB_URI;
        
        if (!testUri) {
            return res.status(400).json({ error: 'No URI provided' });
        }
        
        // Create temporary connection
        const conn = await mongoose.createConnection(testUri, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
            serverSelectionTimeoutMS: 5000
        });
        
        await conn.close();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// MongoDB stats
router.get('/mongo-stats', async (req, res) => {
    try {
        const sessions = await Session.countDocuments();
        const settings = await Settings.countDocuments();
        
        // Get database stats if connected
        let sizeMB = 0;
        let collections = 0;
        let indexes = 0;
        
        if (mongoose.connection.readyState === 1) {
            try {
                const db = mongoose.connection.db;
                const stats = await db.stats();
                sizeMB = Math.round(stats.dataSize / 1024 / 1024);
                collections = stats.collections;
                indexes = stats.indexes;
            } catch (e) {}
        }
        
        res.json({
            sessions,
            settings,
            size: `${sizeMB}MB`,
            collections,
            indexes
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== BACKUP & RESTORE ====================

// Backup all sessions
router.get('/backup', async (req, res) => {
    try {
        const sessions = await Session.find({});
        const settings = await Settings.find({});
        
        const backup = {
            timestamp: new Date().toISOString(),
            version: '1.0',
            sessions: sessions.map(s => ({
                number: s.number,
                sessionId: s.sessionId,
                settings: s.settings,
                creds: s.creds,
                createdAt: s.createdAt,
                updatedAt: s.updatedAt
            })),
            settings: settings.map(s => ({
                number: s.number,
                settings: s.settings,
                createdAt: s.createdAt,
                updatedAt: s.updatedAt
            }))
        };
        
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename=sila-backup-${new Date().toISOString().slice(0,10)}.json`);
        res.json(backup);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Restore from backup
router.post('/restore', async (req, res) => {
    try {
        const backup = req.body;
        
        if (!backup.sessions || !backup.settings) {
            return res.status(400).json({ error: 'Invalid backup format' });
        }
        
        let restored = 0;
        
        // Restore sessions
        for (const session of backup.sessions) {
            try {
                await Session.updateOne(
                    { number: session.number },
                    { 
                        $set: {
                            sessionId: session.sessionId,
                            settings: session.settings,
                            creds: session.creds,
                            updatedAt: new Date()
                        }
                    },
                    { upsert: true }
                );
                restored++;
            } catch (e) {
                console.error('Restore session error:', e.message);
            }
        }
        
        // Restore settings
        for (const setting of backup.settings) {
            try {
                await Settings.updateOne(
                    { number: setting.number },
                    { $set: { settings: setting.settings, updatedAt: new Date() } },
                    { upsert: true }
                );
            } catch (e) {}
        }
        
        // Log
        const logEntry = `[${new Date().toISOString()}] INFO - Restored ${restored} sessions from backup\n`;
        fs.appendFileSync(path.join(__dirname, '../logs.txt'), logEntry);
        
        res.json({ success: true, restored });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== LOGS ====================

// Get logs
router.get('/logs', (req, res) => {
    try {
        const logFile = path.join(__dirname, '../logs.txt');
        let logs = [];
        
        if (fs.existsSync(logFile)) {
            const content = fs.readFileSync(logFile, 'utf8');
            logs = content.split('\n')
                .filter(l => l.trim())
                .slice(-100) // Last 100 lines
                .map(l => {
                    const match = l.match(/\[(.*?)\] (\w+) - (.*)/);
                    if (match) {
                        return {
                            time: match[1],
                            level: match[2].toLowerCase(),
                            message: match[3]
                        };
                    }
                    return {
                        time: new Date().toLocaleTimeString(),
                        level: 'info',
                        message: l
                    };
                });
        }
        
        res.json({ logs });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Clear logs
router.post('/clear-logs', (req, res) => {
    try {
        const logFile = path.join(__dirname, '../logs.txt');
        fs.writeFileSync(logFile, '');
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== UTILITY ====================

// Ping
router.get('/ping', (req, res) => {
    res.json({ 
        status: 'active', 
        activeSessions: global.activeSockets?.size || 0,
        timestamp: new Date().toISOString()
    });
});

module.exports = router;
