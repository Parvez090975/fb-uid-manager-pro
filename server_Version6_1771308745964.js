const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cors());
app.use(express.static('public'));

const DATA_FILE = path.join(__dirname, 'data.json');
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'your-secret-key-change-this';

// ==================== FACEBOOK ACCESS TOKENS ====================
// Add your own tokens here for better reliability
const FB_TOKENS = [
    '350685531728|62f8ce9f74b12f84c123cc23437a4a32',
    '256002347743983|374e60f8b9bb6b8cbb30f78030438895',
    // Add more tokens if you have them
];

function getRandomToken() {
    return FB_TOKENS[Math.floor(Math.random() * FB_TOKENS.length)];
}

// ==================== ENCRYPTION FUNCTIONS ====================

function encrypt(text) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY.padEnd(32, '0').slice(0, 32)), iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

function decrypt(text) {
    try {
        const parts = text.split(':');
        const iv = Buffer.from(parts[0], 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY.padEnd(32, '0').slice(0, 32)), iv);
        let decrypted = decipher.update(parts[1], 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (e) {
        return text;
    }
}

// ==================== DATA FUNCTIONS ====================

function readData() {
    try {
        if (!fs.existsSync(DATA_FILE)) {
            fs.writeFileSync(DATA_FILE, JSON.stringify({ users: [], stats: { total: 0, encrypted: 0 } }));
        }
        return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) {
        return { users: [], stats: { total: 0, encrypted: 0 } };
    }
}

function writeData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ==================== FACEBOOK GRAPH API ====================

async function fetchFacebookName(uid) {
    const token = getRandomToken();
    const maxRetries = 3;
    let lastError = null;

    for (let i = 0; i < maxRetries; i++) {
        try {
            console.log(`[Facebook API] Attempting to fetch ${uid} (Attempt ${i + 1}/${maxRetries})`);

            const response = await axios.get(`https://graph.facebook.com/v18.0/${uid}`, {
                params: {
                    fields: 'name,first_name,last_name,picture.type(small)',
                    access_token: token
                },
                timeout: 5000
            });

            if (response.data.name) {
                console.log(`[Facebook API] ✅ Success: ${uid} -> ${response.data.name}`);
                return {
                    name: response.data.name,
                    firstName: response.data.first_name || '',
                    lastName: response.data.last_name || '',
                    picture: response.data.picture?.data?.url || null,
                    source: 'facebook',
                    verified: true
                };
            }
        } catch (error) {
            lastError = error.message;
            console.log(`[Facebook API] ⚠️ Attempt ${i + 1} failed: ${error.message}`);
            
            if (error.response?.status === 429) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    }

    console.log(`[Facebook API] ❌ Failed: ${uid} - ${lastError}`);
    
    return {
        name: `User_${uid.substring(0, 6)}`,
        firstName: '',
        lastName: '',
        picture: null,
        source: 'default',
        verified: false,
        error: lastError
    };
}

// ==================== API ENDPOINTS ====================

// Fetch Facebook Name
app.post('/api/fetch-name', async (req, res) => {
    const { uid } = req.body;
    if (!uid) {
        return res.status(400).json({ error: 'UID required' });
    }

    const nameData = await fetchFacebookName(uid);
    res.json(nameData);
});

// Save User
app.post('/api/save-user', (req, res) => {
    const { uid, password, name, encrypted } = req.body;

    if (!uid) {
        return res.status(400).json({ error: 'UID required' });
    }

    const data = readData();
    const existingIndex = data.users.findIndex(u => u.uid === uid);

    const userData = {
        uid,
        password: encrypted ? encrypt(password || '') : password || '',
        name: name || `User_${uid.substring(0, 6)}`,
        encrypted: encrypted || false,
        savedAt: new Date(),
        verified: true
    };

    if (existingIndex !== -1) {
        data.users[existingIndex] = userData;
    } else {
        data.users.push(userData);
    }

    data.stats = {
        total: data.users.length,
        encrypted: data.users.filter(u => u.encrypted).length
    };

    writeData(data);
    res.json({ success: true, message: 'User saved successfully' });
});

// Get All Users
app.get('/api/users', (req, res) => {
    const data = readData();
    const decryptedUsers = data.users.map(user => ({
        ...user,
        password: user.encrypted ? decrypt(user.password) : user.password
    }));
    res.json({ users: decryptedUsers, stats: data.stats });
});

// Search Users
app.get('/api/search', (req, res) => {
    const { q } = req.query;
    if (!q) {
        return res.status(400).json({ error: 'Search query required' });
    }

    const data = readData();
    const filtered = data.users.filter(user => 
        user.uid.includes(q) || 
        user.name.toLowerCase().includes(q.toLowerCase())
    );

    const decrypted = filtered.map(user => ({
        ...user,
        password: user.encrypted ? decrypt(user.password) : user.password
    }));

    res.json(decrypted);
});

// Delete User
app.delete('/api/users/:uid', (req, res) => {
    const { uid } = req.params;
    const data = readData();
    data.users = data.users.filter(u => u.uid !== uid);

    data.stats = {
        total: data.users.length,
        encrypted: data.users.filter(u => u.encrypted).length
    };

    writeData(data);
    res.json({ success: true, message: 'User deleted' });
});

// Download as Text
app.get('/api/download/txt', (req, res) => {
    const data = readData();
    let content = 'UID|PASSWORD|NAME|VERIFIED\n';
    content += '─'.repeat(80) + '\n';

    data.users.forEach(user => {
        const password = user.encrypted ? decrypt(user.password) : user.password;
        const verified = user.verified ? '✅' : '❌';
        if (password) {
            content += `${user.uid}|${password}|${user.name}|${verified}\n`;
        } else {
            content += `${user.uid}||${user.name}|${verified}\n`;
        }
    });

    res.header('Content-Disposition', 'attachment; filename="UID_Data.txt"');
    res.header('Content-Type', 'text/plain');
    res.send(content);
});

// Download as JSON
app.get('/api/download/json', (req, res) => {
    const data = readData();
    const decryptedUsers = data.users.map(user => ({
        uid: user.uid,
        password: user.encrypted ? decrypt(user.password) : user.password,
        name: user.name,
        encrypted: user.encrypted,
        verified: user.verified,
        savedAt: user.savedAt
    }));

    res.header('Content-Disposition', 'attachment; filename="UID_Data.json"');
    res.header('Content-Type', 'application/json');
    res.send(JSON.stringify(decryptedUsers, null, 2));
});

// Download as CSV
app.get('/api/download/csv', (req, res) => {
    const data = readData();
    let content = 'UID,PASSWORD,NAME,ENCRYPTED,VERIFIED,SAVED_AT\n';

    data.users.forEach(user => {
        const password = user.encrypted ? decrypt(user.password) : user.password;
        const sanitizedPassword = password.replace(/,/g, ';');
        const sanitizedName = user.name.replace(/,/g, ';');
        content += `${user.uid},"${sanitizedPassword}","${sanitizedName}",${user.encrypted},${user.verified},"${user.savedAt}"\n`;
    });

    res.header('Content-Disposition', 'attachment; filename="UID_Data.csv"');
    res.header('Content-Type', 'text/csv');
    res.send(content);
});

// Bulk Import
app.post('/api/bulk-import', (req, res) => {
    const { data: importData, encrypted } = req.body;

    if (!importData || !Array.isArray(importData)) {
        return res.status(400).json({ error: 'Invalid data format' });
    }

    const data = readData();
    let importedCount = 0;

    importData.forEach(item => {
        if (item.uid) {
            const existingIndex = data.users.findIndex(u => u.uid === item.uid);
            const userData = {
                uid: item.uid,
                password: encrypted ? encrypt(item.password || '') : item.password || '',
                name: item.name || `User_${item.uid.substring(0, 6)}`,
                encrypted: encrypted || false,
                verified: item.verified || false,
                savedAt: new Date()
            };

            if (existingIndex !== -1) {
                data.users[existingIndex] = userData;
            } else {
                data.users.push(userData);
                importedCount++;
            }
        }
    });

    data.stats = {
        total: data.users.length,
        encrypted: data.users.filter(u => u.encrypted).length
    };

    writeData(data);
    res.json({ success: true, imported: importedCount, total: data.users.length });
});

// Get Statistics
app.get('/api/stats', (req, res) => {
    const data = readData();
    res.json({
        total: data.users.length,
        encrypted: data.users.filter(u => u.encrypted).length,
        unencrypted: data.users.filter(u => !u.encrypted).length,
        verified: data.users.filter(u => u.verified).length
    });
});

// Test Facebook Tokens
app.get('/api/test-facebook', async (req, res) => {
    try {
        const token = getRandomToken();
        const response = await axios.get('https://graph.facebook.com/me', {
            params: { access_token: token },
            timeout: 5000
        });

        res.json({ 
            status: 'success', 
            message: '✅ Facebook API Connected',
            data: response.data,
            tokensConfigured: FB_TOKENS.length 
        });
    } catch (error) {
        res.json({ 
            status: 'error', 
            message: `❌ ${error.message}`,
            tokensConfigured: FB_TOKENS.length 
        });
    }
});

// Health Check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        message: 'Server is running',
        timestamp: new Date()
    });
});

app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════╗
║   🔥 FB UID Manager Pro v2.0 🔥     ║
║   Running on port ${PORT}                ║
║   Facebook Tokens: ${FB_TOKENS.length} configured         ║
║   Encryption: ✅ ACTIVE              ║
╚══════════════════════════════════════╝
    `);
});