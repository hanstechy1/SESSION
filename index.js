const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  delay,
  Browsers,
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/pair', async (req, res) => {
  let number = req.query.number;
  if (!number) return res.status(400).json({ error: 'Namba ya simu inahitajika' });

  // Ondoa alama zote zisizo namba
  number = number.replace(/\D/g, '');

  const sessionDir = path.join(__dirname, 'temp', `${number}_${Date.now()}`);

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: Browsers.macOS('Safari'),
    });

    sock.ev.on('creds.update', saveCreds);

    // Kufuatilia pindi mtumiaji anapothibitisha pair code
    sock.ev.on('connection.update', async (update) => {
      const { connection } = update;

      if (connection === 'open') {
        try {
          await delay(3000);

          // Soma faili la creds na ulibadilishe kuwa Base64 Session ID
          const credsPath = path.join(sessionDir, 'creds.json');
          if (fs.existsSync(credsPath)) {
            const credsData = fs.readFileSync(credsPath);
            const sessionId = Buffer.from(credsData).toString('base64');

            // Tuma Session ID moja kwa moja kwenye DM ya mtumiaji
            const userJid = `${number}@s.whatsapp.net`;
            await sock.sendMessage(userJid, {
              text: `*HONGERA! UMEUNGANISHWA.* 🎉\n\nHii hapa Session ID yako:\n\n\`\`\`${sessionId}\`\`\`\n\n_Usitoe code hii kwa mtu yeyote!_`,
            });
          }

          await delay(2000);
          await sock.ws.close();
          await fs.remove(sessionDir); // Futa data za muda
        } catch (e) {
          console.error('Hitilafu kutuma Session ID:', e);
        }
      }
    });

    // Subiri sekunde 3 kisha omba Pairing Code
    await delay(1000);
const code = await sock.requestPairingCode(number);

    // Rudisha code tu kwenye tovuti
    return res.json({ code });
  } catch (err) {
    console.error('Hitilafu:', err);
    await fs.remove(sessionDir).catch(() => {});
    return res.status(500).json({ error: 'Imeshindwa kutengeneza pair code' });
  }
});

app.listen(PORT, () => {
  console.log(`Server ipo tayari kwenye port ${PORT}`);
});
