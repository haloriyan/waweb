const fs = require('fs');
const path = require('path');
const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { randomUUID } = require('crypto');
const QRCode = require('qrcode');
const { default: axios } = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = 6969;
const SESSIONS_FILE = path.join(__dirname, 'clients.json');

const loadClients = () => {
    try {
        let theClients = fs.readFileSync(SESSIONS_FILE);
        return JSON.parse(theClients) ?? [];
    } catch (err) {
        return [];
    }
}
function saveClients(clientIds) {
	fs.writeFileSync(SESSIONS_FILE, JSON.stringify(clientIds, null, 4));
}

let clientIds = loadClients();
let clients = {};

// Restore sessions on server start
clientIds.forEach((client_id) => {
	const client = new Client({
		authStrategy: new LocalAuth({ clientId: client_id }),
		puppeteer: {
			headless: true,
			args: ['--no-sandbox', '--disable-setuid-sandbox']
		}
	});

	clients[client_id] = client;

	client.initialize();

	client.on('ready', () => {
		console.log(`Restored client ${client_id} is ready`);
	});

	client.on('auth_failure', msg => {
		console.error(`Client ${client_id} auth failure:`, msg);
	});

	client.on('disconnected', () => {
		console.log(`Client ${client_id} disconnected`);
		delete clients[client_id];
		const index = clientIds.indexOf(client_id);
		if (index > -1) {
			clientIds.splice(index, 1);
			saveClients(clientIds);
		}
	});

    client.on('message', async (msg) => {
        let chat = await msg.getChat();
        let contact = await msg.getContact();
        let message = chat.lastMessage;

        console.log({
            message,
            contact,
        });
    })
});

app.post('/connect', async (req, res) => {
    const clientID = randomUUID();
    console.log('0');

    const client = new Client({
        puppeteer: {
            args: ['--no-sandbox'],
            headless: true
        },
        authStrategy: new LocalAuth({
            clientId: clientID
        })
    });

    clients[clientID] = client;
	clientIds.push(clientID);
	saveClients(clientIds);

    client.on('ready', async () => {
        console.log('client ready');
        const { callback_url } = req.body;
        if (callback_url) {
            const { wid, pushname } = client.info;
            const number = wid.user;
            const profilePicUrl = await client.getProfilePicUrl(wid._serialized);

            const response = await axios.post(callback_url, {
                client_id: clientID,
                name: pushname,
                number,
                profile_picture: profilePicUrl
            });
        }
    });
    client.on('qr', async (qr) => {
        console.log('qr code received');
        let fileName = clientID + ".png";
		const filePath = path.join(__dirname, 'public', 'qrcodes', fileName);

		await QRCode.toFile(filePath, qr, {
			type: 'png',
			width: 300
		});

		const qrUrl = `${req.protocol}://${req.get('host')}/qrcodes/${fileName}`;

		console.log('QR Code saved:', qrUrl);

		return res.status(200).json({
			client_id: clientID,
			qr_url: qrUrl
		});
    })

    client.initialize();
});
app.post('/send', async (req, res) => {
    const { client_id, destination, message, image, button_url, button_text } = req.body;

    if (!client_id || !destination || !message) {
        return res.status(400).json({
            status: false,
            error: 'client_id, destination, and message are required',
        });
    }

    const client = clients[client_id];
    if (!client) {
        return res.status(404).json({
            status: false,
            error: 'Client not found or not connected',
        });
    }

    const number = destination.includes('@c.us') ? destination : `${destination}@c.us`;

    try {
        await client.sendPresenceAvailable();

        const chat = await client.getChatById(number);
        await chat.sendStateTyping();

        // ⏳ Simulate delay (customizable)
        // await new Promise(resolve => setTimeout(resolve, 2000));
		const delay = Math.min(message.length * 100, 5000);
		await new Promise(res => setTimeout(res, delay));

        // ✋ Stop typing
        await chat.clearState();

        // 📩 Now send the actual message
        if (image) {
            const media = await MessageMedia.fromUrl(image);
            await client.sendMessage(number, media, { caption: message });

        } else if (button_url && typeof button_url === 'string') {
            const button = new Buttons(
                message,
                [{ type: 'url', url: button_url, body: button_text }],
                'Visit Link',
                'Footer (opt)'
            );
            await client.sendMessage(number, button);

        } else {
            await client.sendMessage(number, message);
        }

        return res.status(200).json({
            status: true,
            message: 'Message sent with typing simulation'
        });

    } catch (err) {
        console.error(err);
        return res.status(500).json({
            status: false,
            error: 'Failed to send message',
        });
    }
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
    console.log('[EXPRESS] Running on ', PORT);
})