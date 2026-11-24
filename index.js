const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const pino = require('pino');
const {
  default: makeWASocket, useMultiFileAuthState, Browsers, DisconnectReason,
  delay, fetchLatestBaileysVersion, makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');

const app = express();
app.use(express.json({ limit: '2mb' }));
const PORT = process.env.PORT || 3000;
const logger = pino({ level: 'silent' });
const done = new Set();
const API_SECRET = process.env.SESSION_STORE_TOKEN;
const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
}) : null;

async function ensureDatabase() {
  if (!pool) throw new Error('DATABASE_URL is required for short sessions.');
  if (!API_SECRET) throw new Error('SESSION_STORE_TOKEN is required.');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hans_sessions (
      id VARCHAR(32) PRIMARY KEY,
      auth_state JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '90 days')
    )
  `);
}

function authRequest(req, res, next) {
  const token = req.get('authorization') || '';
  if (!API_SECRET || token !== 'Bearer ' + API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

async function saveShortSession(dir) {
  const files = {};
  async function walk(folder, prefix = '') {
    const entries = await fs.readdir(folder, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      const relative = path.posix.join(prefix, entry.name);
      if (entry.isDirectory()) await walk(full, relative);
      else if (entry.isFile()) files[relative] = await fs.readFile(full, 'utf8');
    }
  }
  await walk(dir);
  if (!files['creds.json']) throw new Error('Baileys creds.json is missing.');
  const id = crypto.randomBytes(5).toString('base64url').toUpperCase();
  await pool.query(
    'INSERT INTO hans_sessions (id, auth_state) VALUES ($1, $2::jsonb)',
    [id, JSON.stringify(files)]
  );
  return id;
}

app.get('/', (_req, res) => res.json({ status: 'active', message: 'Pairing server is running' }));

app.get('/session/:id', authRequest, async (req, res) => {
  try {
    const id = String(req.params.id || '').toUpperCase();
    if (!/^[A-Z0-9_-]{6,20}$/.test(id)) return res.status(400).json({ error: 'Invalid session code' });
    const result = await pool.query(
      'SELECT auth_state FROM hans_sessions WHERE id = $1 AND expires_at > NOW()',
      [id]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Session not found or expired' });
    res.set('Cache-Control', 'no-store');
    return res.json({ files: result.rows[0].auth_state });
  } catch (error) {
    console.error('Session retrieval failed:', error.message);
    return res.status(500).json({ error: 'Could not retrieve session' });
  }
});

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
        await delay(1500);
        const shortId = await saveShortSession(dir);
        const jid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
        await sock.sendMessage(jid, { text: 'HANS TECHY~' + shortId });
        await sock.sendMessage(jid, { text: '*CONNECTED* ✅\\nKeep this Session ID private.' });
      } catch (e) {
        console.error('Saving session failed:', e.message);
        const jid = sock.user?.id?.split(':')[0] + '@s.whatsapp.net';
        if (sock.user?.id) await sock.sendMessage(jid, { text: 'Session storage failed. Please contact the bot owner.' }).catch(() => null);
      }
      await delay(3000);
      try { sock.end(); } catch {}
      await fs.remove(dir);
      return;
    }

    if (connection === 'close' && !done.has(id)) {
      const status = lastDisconnect?.error?.output?.statusCode;
      const registered = sock.authState.creds.registered;
      if (status === DisconnectReason.restartRequired || (registered && status !== DisconnectReason.loggedOut && attempt < 3)) {
        startSocket(id, {}, attempt + 1);
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

app.get('/pair', async (req, res) => {
  const number = String(req.query.number || '').replace(/\\D/g, '');
  if (!number) return res.status(400).json({ error: 'Number is required' });
  if (!pool || !API_SECRET) return res.status(503).json({ error: 'Short-session storage is not configured' });
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
  if (!pool || !API_SECRET) return res.status(503).json({ error: 'Short-session storage is not configured' });
  const id = `q_${Date.now()}`;
  let sent = false;
  const reply = (qr) => {
    if (sent) return; sent = true;
    qr ? res.json({ qr }) : res.status(500).json({ error: 'Could not get QR' });
  };
  setTimeout(() => reply(null), 25000);
  startSocket(id, { onQr: reply }).catch(() => reply(null));
});

ensureDatabase().then(() => {
  app.listen(PORT, () => console.log(`Session server running on port ${PORT}`));
}).catch((error) => {
  console.error('Session server startup failed:', error.message);
  process.exit(1);
});
