const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const express = require('express');
const cors = require('cors');
const { Boom } = require('@hapi/boom');
const P = require('pino');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET || '';

let sock = null;
let isReady = false;
let qrString = null;

// ── Auth middleware ──────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  if (!API_SECRET) return next(); // sin secret configurado → abierto (solo dev)
  const token = req.headers['x-api-secret'] || req.query.secret;
  if (token !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── Conectar WhatsApp ────────────────────────────────────────────────
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('/app/auth_info');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger: P({ level: 'silent' }),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, P({ level: 'silent' })),
    },
    printQRInTerminal: false,
    browser: ['Gipfel IT', 'Chrome', '1.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrString = qr;
      isReady = false;
      console.log('\n══════════════════════════════════════');
      console.log('  ESCANEA ESTE QR CON WHATSAPP BUSINESS');
      console.log('══════════════════════════════════════\n');
      qrcode.generate(qr, { small: true });
      console.log('\n  También disponible en GET /qr\n');
    }

    if (connection === 'close') {
      isReady = false;
      qrString = null;
      const shouldReconnect =
        (lastDisconnect?.error instanceof Boom)
          ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
          : true;
      console.log('Conexión cerrada. Reconectando:', shouldReconnect);
      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 3000);
      } else {
        console.log('Sesión cerrada (logout). Borra /app/auth_info y reinicia.');
      }
    }

    if (connection === 'open') {
      isReady = true;
      qrString = null;
      console.log('✅ WhatsApp conectado y listo!');
    }
  });
}

// ── Endpoints ────────────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({
    service: 'Gipfel WhatsApp Service',
    status: isReady ? 'ready' : 'connecting',
    qrPending: !!qrString,
  });
});

// Ver QR en texto (para copiarlo)
app.get('/qr', (req, res) => {
  if (isReady) return res.json({ status: 'already_connected' });
  if (!qrString) return res.json({ status: 'waiting_for_qr', message: 'Espera unos segundos y recarga' });
  res.json({ status: 'scan_qr', qr: qrString });
});

// Enviar mensaje — endpoint principal usado por todas las apps
app.post('/send', authMiddleware, async (req, res) => {
  const { to, message } = req.body;

  if (!to || !message) {
    return res.status(400).json({ error: 'Se requieren "to" y "message"' });
  }
  if (!isReady) {
    return res.status(503).json({ error: 'WhatsApp no está conectado aún', qrPending: !!qrString });
  }

  try {
    // Normalizar número: solo dígitos, agregar @s.whatsapp.net
    const digits = to.replace(/\D/g, '');
    const jid = digits.includes('@') ? digits : `${digits}@s.whatsapp.net`;

    await sock.sendMessage(jid, { text: message });
    console.log(`📤 Enviado a ${digits}: ${message.substring(0, 60)}…`);
    res.json({ ok: true, to: digits });
  } catch (err) {
    console.error('Error enviando mensaje:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Enviar a múltiples números (batch)
app.post('/send-batch', authMiddleware, async (req, res) => {
  const { messages } = req.body; // [{ to, message }]
  if (!Array.isArray(messages)) return res.status(400).json({ error: '"messages" debe ser un array' });
  if (!isReady) return res.status(503).json({ error: 'WhatsApp no conectado' });

  const results = [];
  for (const { to, message } of messages) {
    try {
      const digits = to.replace(/\D/g, '');
      const jid = `${digits}@s.whatsapp.net`;
      await sock.sendMessage(jid, { text: message });
      results.push({ to: digits, ok: true });
      await new Promise(r => setTimeout(r, 500)); // pequeña pausa entre mensajes
    } catch (err) {
      results.push({ to, ok: false, error: err.message });
    }
  }
  res.json({ results });
});

// ── Arrancar ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 WhatsApp Service corriendo en puerto ${PORT}`);
  connectToWhatsApp();
});
