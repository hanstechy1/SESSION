const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  delay,
  Browsers,
  DisconnectReason,
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.json({ status: 'active', message: 'Pairing server is running' });
});

// Tunatunza socket inayofanya kazi ili isikatike
const activeSockets = new Map();

app.get('/pair', async (req, res) => {
  let number = req.query.number;
  if (!number) {
    return res.status(400).json({ error: 'Namba ya simu inahitajika' });
  }

  number = number.replace(/\D/g, '');
  const sessionDir = path.join(__dirname, 'temp', number);

  // Kama kulikuwa na socket ya zamani kwa namba hii, ifunge kwanza
  if (activeSockets.has(number)) {
    try {
      activeSockets.get(number).ws.close();
    } catch (e) {}
    activeSockets.delete(number);
  }

  try {
    await fs.remove(sessionDir).catch(() => {});
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'fatal' }),
      browser: Browsers.windows('Chrome'), // Windows Chrome inakubaliwa sana na WhatsApp
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 0,
      keepAliveIntervalMs: 10000,
    });

    activeSockets.set(number, sock);
    sock.ev.on('creds.update', saveCreds);

    let codeSentToClient = false;

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;

      // WhatsApp inapofunguka na kuthibitisha simu
      if (connection === 'open') {
        try {
          await delay(3000);
          const credsPath = path.join(sessionDir, 'creds.json');
          if (fs.existsSync(credsPath)) {
            const credsData = fs.readFileSync(credsPath);
            const sessionId = Buffer.from(credsData).toString('base64');

            const userJid = `${number}@s.whatsapp.net`;
            await sock.sendMessage(userJid, {
              text: `*HONGERA! UMEUNGANISHWA.* 🎉\n\nSession ID yako ni:\n\n\`\`\`${sessionId}\`\`\`\n\n_Hifadhi session hii salama!_`,
            });
          }

          await delay(2000);
          activeSockets.delete(number);
          await sock.ws.close();
          await fs.remove(sessionDir).catch(() => {});
        } catch (err) {
          console.error('Hitilafu kutuma session:', err);
        }
      }

      // Kama muunganisho umekatika wakati bado inasubiri
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`Connection closed na status: ${statusCode}`);
        if (statusCode !== DisconnectReason.loggedOut) {
          // Si logout ya kawaida, muunganisho ulikatwa na mtandao
        }
      }
    });

    // Subiri sekunde 6 ili socket iwe na uhusiano imara na WhatsApp
    await delay(6000);

    const code = await sock.requestPairingCode(number);
    codeSentToClient = true;

    const formattedCode = code?.includes('-')
      ? code
      : `${code.slice(0, 4)}-${code.slice(4)}`;

    return res.json({ code: formattedCode });
  } catch (err) {
    console.error('Hitilafu:', err);
    activeSockets.delete(number);
    await fs.remove(sessionDir).catch(() => {});
    return res.status(500).json({ error: 'Imeshindwa kutengeneza pair code' });
  }
});
app.get('/qr', async (req, res) => {
  const sessionDir = path.join(__dirname, 'temp', `qr_${Date.now()}`);
  let replied = false;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'fatal' }),
      browser: Browsers.windows('Chrome'),
      syncFullHistory: false,
    });
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, qr }) => {
      if (qr && !replied) {
        replied = true;
        res.json({ qr });
      }
      if (connection === 'open') {
        try {
          await delay(3000);
          const creds = fs.readFileSync(path.join(sessionDir, 'creds.json'));
          const sessionId = Buffer.from(creds).toString('base64');
          const me = sock.user.id.split(':')[0] + '@s.whatsapp.net';
          await sock.sendMessage(me, {
            text: `*HONGERA! UMEUNGANISHWA.* 🎉\n\nSession ID yako:\n\n\`\`\`${sessionId}\`\`\``,
          });
          await delay(2000);
          await sock.ws.close();
        } catch (e) {
          console.error('Hitilafu kutuma session');
        }
        await fs.remove(sessionDir).catch(() => {});
      }
    });

    setTimeout(async () => {
      if (!replied) {
        replied = true;
        res.status(504).json({ error: 'QR haikupatikana' });
      }
    }, 25000);
  } catch (err) {
    await fs.remove(sessionDir).catch(() => {});
    if (!replied) res.status(500).json({ error: 'Imeshindwa kutengeneza QR' });
  }
});


app.listen(PORT, () => {
  console.log(`Server ipo tayari kwenye port ${PORT}`);
});
