const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// client_id → { client, status, qrPath, callbackUrl }
const sessions = new Map();

const AUTH_DIR = path.join(process.cwd(), '.wwebjs_auth');
const QR_DIR = '/tmp';

function makeClient(clientId) {
  return new Client({
    authStrategy: new LocalAuth({ clientId }),
    puppeteer: {
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    },
  });
}

function createSession(clientId, callbackUrl) {
  const client = makeClient(clientId);
  const sessionData = { client, status: 'initializing', qrPath: null, callbackUrl };
  sessions.set(clientId, sessionData);

  client.on('qr', async (qr) => {
    const qrPath = path.join(QR_DIR, `qr-${clientId}.png`);
    try {
      await qrcode.toFile(qrPath, qr, { type: 'png', width: 300 });
      sessionData.qrPath = qrPath;
      sessionData.status = 'qr';
    } catch (err) {
      console.error(`[${clientId}] QR generation failed:`, err.message);
    }
  });

  client.on('ready', async () => {
    sessionData.status = 'ready';
    console.log(`[${clientId}] Session ready`);

    if (!callbackUrl) return;

    try {
      const info = client.info;
      const number = info.wid.user;
      const name = info.pushname;

      let profilePicture = null;
      try {
        profilePicture = await client.getProfilePicUrl(info.wid._serialized);
      } catch (_) {}

      await axios.post(callbackUrl, {
        client_id: clientId,
        name,
        number,
        profile_picture: profilePicture,
      });
    } catch (err) {
      console.error(`[${clientId}] Callback to ${callbackUrl} failed:`, err.message);
    }
  });

  client.on('auth_failure', (msg) => {
    console.error(`[${clientId}] Auth failure:`, msg);
    sessionData.status = 'auth_failure';
  });

  client.on('disconnected', (reason) => {
    console.log(`[${clientId}] Disconnected:`, reason);
    sessionData.status = 'disconnected';
    sessions.delete(clientId);
  });

  client.initialize().catch((err) => {
    console.error(`[${clientId}] Initialize error:`, err.message);
    sessionData.status = 'error';
  });

  return sessionData;
}

async function destroySession(clientId) {
  const sessionData = sessions.get(clientId);
  if (!sessionData) return false;

  try {
    await sessionData.client.destroy();
  } catch (err) {
    console.error(`[${clientId}] Destroy error:`, err.message);
  }

  sessions.delete(clientId);

  const sessionDir = path.join(AUTH_DIR, `session-${clientId}`);
  if (fs.existsSync(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }

  const qrPath = path.join(QR_DIR, `qr-${clientId}.png`);
  if (fs.existsSync(qrPath)) {
    fs.unlinkSync(qrPath);
  }

  return true;
}

async function restoreSessions() {
  if (!fs.existsSync(AUTH_DIR)) return;

  const entries = fs.readdirSync(AUTH_DIR, { withFileTypes: true });
  const sessionDirs = entries
    .filter((e) => e.isDirectory() && e.name.startsWith('session-'))
    .map((e) => e.name.replace(/^session-/, ''));

  for (const clientId of sessionDirs) {
    if (sessions.has(clientId)) continue;
    console.log(`[restore] Restoring session: ${clientId}`);
    createSession(clientId, null);
  }
}

module.exports = { sessions, createSession, destroySession, restoreSessions };
