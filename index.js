const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { MessageMedia } = require('whatsapp-web.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const { sessions, createSession, destroySession, restoreSessions } = require('./sessions');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

// POST /connect
// Start a new session and return client_id + QR image URL immediately.
app.post('/connect', (req, res) => {
  const { callback_url } = req.body;
  const clientId = uuidv4();
  const qrUrl = `${BASE_URL}/qr-image/${clientId}.png`;

  createSession(clientId, callback_url || null);

  res.json({ client_id: clientId, qr_url: qrUrl });
});

// GET /qr/:client_id
// Return the latest QR as a base64 data URL (polling fallback).
app.get('/qr/:clientId', (req, res) => {
  const { clientId } = req.params;
  const session = sessions.get(clientId);

  if (!session) {
    return res.status(404).json({ error: 'client not found' });
  }

  const qrPath = path.join('/tmp', `qr-${clientId}.png`);
  if (!session.qrPath || !fs.existsSync(qrPath)) {
    return res.status(404).json({ error: 'QR not ready yet' });
  }

  const data = fs.readFileSync(qrPath);
  res.json({ qr: `data:image/png;base64,${data.toString('base64')}` });
});

// GET /qr-image/:client_id.png
// Serve the QR PNG file directly (for img src= usage).
app.get('/qr-image/:file', (req, res) => {
  const clientId = req.params.file.replace(/\.png$/i, '');
  const qrPath = path.join('/tmp', `qr-${clientId}.png`);

  if (!fs.existsSync(qrPath)) {
    return res.status(404).json({ error: 'QR image not found' });
  }

  res.setHeader('Content-Type', 'image/png');
  res.sendFile(qrPath);
});

// POST /send
// Send a text message or a text+image message.
app.post('/send', async (req, res) => {
  const { client_id, destination, number, message, image } = req.body;
  const target = destination || number;

  if (!client_id || !target || !message) {
    return res.status(400).json({ ok: false, error: 'client_id, destination and message are required' });
  }

  const session = sessions.get(client_id);
  if (!session) {
    return res.status(404).json({ ok: false, error: 'client not found' });
  }

  if (session.status !== 'ready') {
    return res.status(409).json({ ok: false, error: `client not ready (status: ${session.status})` });
  }

  const chatId = `${target}@c.us`;

  try {
    if (image) {
      const response = await axios.get(image, {
        responseType: 'arraybuffer',
        timeout: 30_000,
      });
      const mimeType = response.headers['content-type'] || 'image/png';
      const base64Data = Buffer.from(response.data).toString('base64');
      const media = new MessageMedia(mimeType, base64Data);
      await session.client.sendMessage(chatId, media, { caption: message });
    } else {
      await session.client.sendMessage(chatId, message);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(`[${client_id}] Send error:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /disconnect
// Destroy and remove a session.
app.post('/disconnect', async (req, res) => {
  const { client_id } = req.body;

  if (!client_id) {
    return res.status(400).json({ error: 'client_id is required' });
  }

  const ok = await destroySession(client_id);
  if (!ok) {
    return res.status(404).json({ error: 'client not found' });
  }

  res.json({ ok: true });
});

// 404 catch-all
app.use((req, res) => {
  res.status(404).json({ error: 'not found' });
});

app.listen(PORT, async () => {
  console.log(`WhatsApp gateway running on port ${PORT} (base: ${BASE_URL})`);
  await restoreSessions();
});
