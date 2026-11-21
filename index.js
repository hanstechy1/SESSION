const express = require('express');
const fs = require('fs-extra');
const pino = require('pino');
const {
  default: makeWASocket, useMultiFileAuthState, Browsers, DisconnectReason,
  delay, fetchLatestBaileysVersion, makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;
const logger = pino({ level: 'silent' });
const done = new Set();

async function startSocket(id, opts = {}, attempt = 0) {
  const dir = `./temp/${id}`;
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    logger,
    printQRInTerminal: false,
    browser: Browsers.macOS('Chrome'),
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
  });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr && opts.onQr) { opts.onQr(qr); opts.onQr = null; }

    if (connection === 'open' && !done.has(id)) {
      done.add(id);
      try {
        await delay(5000);
        const creds = await fs.readFile(`${dir}/creds.json`);
        const sessionId = 'HANS TECHY~' + Buffer.from(creds).toString('base64');
        const jid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
        await sock.sendMessage(jid, { text: sessionId });
        await sock.sendMessage(jid, { text: '*CONNECTED* ✅\nKeep this Session ID private.' });
      } catch (e) { console.error('Sending session failed'); }
      await delay(3000);
      try { sock.end(); } catch {}
      await fs.remove(dir);
      return;
    }

    if (connection === 'close' && !done.has(id)) {
      const status = lastDisconnect?.error?.output?.statusCode;
      const registered = sock.authState.creds.registered;
      if (status === DisconnectReason.restartRequired || (registered && status !== DisconnectReason.loggedOut && attempt < 3)) {
        startSocket(id, {}, attempt + 1); // reconnect after pairing — the key fix
      } else {
        await fs.remove(dir);
      }
    }
  });

  if (opts.number && !state.creds.registered) {
    await delay(3000);
    try {
      const code = await sock.requestPairingCode(opts.number);
      opts.onCode(code);
    } catch (e) { opts.onCode(null); }
  }
}

app.get('/', (req, res) => res.json({ status: 'active', message: 'Pairing server is running' }));

app.get('/pair', async (req, res) => {
  const number = String(req.query.number || '').replace(/\D/g, '');
  if (!number) return res.status(400).json({ error: 'Number is required' });
  const id = `p_${number}_${Date.now()}`;
  let sent = false;
  const reply = (code) => {
    if (sent) return; sent = true;
    if (!code) return res.status(500).json({ error: 'Could not get code' });
    res.json({ code: code.match(/.{1,4}/g).join('-') });
  };
  setTimeout(() => reply(null), 25000);
  startSocket(id, { number, onCode: reply }).catch(() => reply(null));
});

app.get('/qr', async (req, res) => {
  const id = `q_${Date.now()}`;
  let sent = false;
  const reply = (qr) => {
    if (sent) return; sent = true;
    qr ? res.json({ qr }) : res.status(500).json({ error: 'Could not get QR' });
  };
  setTimeout(() => reply(null), 25000);
  startSocket(id, { onQr: reply }).catch(() => reply(null));
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
