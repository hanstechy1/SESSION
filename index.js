const express = require('express');
const cors = require('cors');
const pino = require('pino');
const { makeWASocket, useMultiFileAuthState, delay, Browsers } = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());

app.get('/', (req, res) => {
    res.send('WhatsApp Session Server is active and running!');
});

app.post('/generate', async (req, res) => {
    let { phone, method } = req.body;
    
    if (method === 'pair' && !phone) {
        return res.status(400).json({ error: "Please enter a valid phone number!" });
    }

    if (phone) phone = phone.replace(/[^0-9]/g, '');
    const sessionDir = path.join(__dirname, 'sessions', (phone || 'qr_' + Date.now()));

    if (fs.existsSync(sessionDir)) {
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch(e) {}
    }

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        
        const sock = makeWASocket({
            auth: state,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            browser: Browsers.macOS('Desktop'),
        });

        sock.ev.on('creds.update', saveCreds);

        if (method === 'pair') {
            await delay(2000);
            if (!sock.authState.creds.registered) {
                try {
                    const code = await sock.requestPairingCode(phone);
                    return res.json({ code });
                } catch (err) {
                    console.error("Pairing error:", err);
                    return res.status(500).json({ error: "Failed to generate pairing code. Check phone number!" });
                }
            } else {
                return res.json({ message: "Number already registered!" });
            }
        } 
        else if (method === 'qr') {
            let qrSent = false;
            sock.ev.on('connection.update', (update) => {
                const { qr } = update;
                if (qr && !qrSent && !res.headersSent) {
                    qrSent = true;
                    return res.json({ qr });
                }
            });

            setTimeout(() => {
                if (!qrSent && !res.headersSent) {
                    return res.status(504).json({ error: "QR Code timeout. Please try again." });
                }
            }, 15000);
        }

        // Kutuma Session ID kwenye DM ya mtumiaji moja kwa moja
        sock.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'open') {
                try {
                    await delay(3000);
                    const credsPath = path.join(sessionDir, 'creds.json');
                    if (fs.existsSync(credsPath)) {
                        const credsData = fs.readFileSync(credsPath, 'utf8');
                        const sessionId = Buffer.from(credsData).toString('base64');
                        const message = `✅ *Connected Successfully!*\n\nHere is your Session ID:\n\n\`\`\`Session_${sessionId}\`\`\`\n\n*Warning:* Do not share this ID with anyone!`;
                        await sock.sendMessage(sock.user.id, { text: message });
                    }
                } catch (err) {
                    console.error("Error sending DM:", err);
                }
                setTimeout(() => {
                    try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch(e) {}
                }, 10000);
            }
        });

    } catch (error) {
        console.error("Fatal error:", error);
        if (!res.headersSent) {
            res.status(500).json({ error: "Server error occurred." });
        }
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
