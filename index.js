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

// Ukurasa wa mwanzo kuangalia kama server ipo hewani
app.get('/', (req, res) => {
  res.json({ status: 'active', message: 'Pairing server is running' });
});

app.get('/pair', async (req, res) => {
  let number = req.query.number;
  if (!number) {
    return res.status(400).json({ error: 'Namba ya simu inahitajika' });
  }

  // Ondoa alama zote zisizo namba (mfano +, nafasi, mabano)
  number = number.replace(/\D/g, '');

  const sessionDir = path.join(__dirname, 'temp', `${number}`);

  try {
    // 1. Futa data za zamani za namba hii ili kuzuia migongano ya code
    await fs.remove(sessionDir).catch(() => {});

    // 2. Anzisha auth state mpya
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'fatal' }),
      browser: Browsers.ubuntu('Chrome'), // Browser inayokubaliwa zaidi na WhatsApp sasa
      syncFullHistory: false, // Hii inafanya iwe ya haraka sana bila kupakia meseji za nyuma
      markOnlineOnConnect: true,
    });

    sock.ev.on('creds.update', saveCreds);

    // 3. WhatsApp inapothibitisha kuunganishwa
    sock.ev.on('connection.update', async (update) => {
      const { connection } = update;

      if (connection === 'open') {
        try {
          await delay(2000);

          const credsPath = path.join(sessionDir, 'creds.json');
          if (fs.existsSync(credsPath)) {
            const credsData = fs.readFileSync(credsPath);
            const sessionId = Buffer.from(credsData).toString('base64');

            // Tuma Session ID moja kwa moja kwenye WhatsApp DM ya mtumiaji
            const userJid = `${number}@s.whatsapp.net`;
            await sock.sendMessage(userJid, {
              text: `*HONGERA! UMEUNGANISHWA.* 🎉\n\nHii hapa Session ID yako:\n\n\`\`\`${sessionId}\`\`\`\n\n_Hifadhi session hii vizuri na usimpe mtu yeyote!_`,
            });
          }

          // Subiri sekunde 2 kisha funga socket na ufute mafaili ya muda
          await delay(2000);
          await sock.ws.close();
          await fs.remove(sessionDir).catch(() => {});
        } catch (e) {
          console.error('Hitilafu wakati wa kutuma Session ID:', e);
        }
      }
    });

    // 4. Subiri sekunde 5 ili socket iwe tayari kabla ya kuomba code
    await delay(5000);

    const code = await sock.requestPairingCode(number);

    // Format code kuwa na kistari katikati (mfano ABCD-1234) kama haina
    const cleanCode = code?.includes('-')
      ? code
      : `${code.slice(0, 4)}-${code.slice(4)}`;

    return res.json({ code: cleanCode });
  } catch (err) {
    console.error('Hitilafu ya kutengeneza code:', err);
    await fs.remove(sessionDir).catch(() => {});
    return res.status(500).json({ error: 'Imeshindwa kupata pair code. Jaribu tena.' });
  }
});

app.listen(PORT, () => {
  console.log(`Server ipo tayari kwenye port ${PORT}`);
});
