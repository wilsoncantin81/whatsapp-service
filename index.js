const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
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

// Mensajes enviados recientemente. Si el celular de quien recibe no logra descifrar un mensaje,
// WhatsApp pide reenviarlo; sin esta memoria el destinatario se queda en "Esperando el mensaje".
const SENT_CACHE_MAX = 2000;
const sentMessages = new Map();
function rememberSent(msg) {
  if (!msg?.key?.id || !msg.message) return;
  sentMessages.set(msg.key.id, msg.message);
  if (sentMessages.size > SENT_CACHE_MAX) sentMessages.delete(sentMessages.keys().next().value);
}
// Contador de reintentos de descifrado por mensaje (lo usa Baileys internamente)
const retryCounts = new Map();
const msgRetryCounterCache = {
  get: (k) => retryCounts.get(k),
  set: (k, v) => { retryCounts.set(k, v); if (retryCounts.size > SENT_CACHE_MAX) retryCounts.delete(retryCounts.keys().next().value); },
  del: (k) => retryCounts.delete(k),
  flushAll: () => retryCounts.clear(),
};

/** Normaliza el número y confirma que tenga WhatsApp. Devuelve el JID o null. */
async function resolveJid(to) {
  const digits = String(to).replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  const [result] = await sock.onWhatsApp(`${digits}@s.whatsapp.net`);
  return result?.exists ? result.jid : null;
}

async function sendText(to, message) {
  const jid = await resolveJid(to);
  if (!jid) {
    const err = new Error('El número no tiene WhatsApp o es inválido');
    err.status = 400;
    throw err;
  }
  const sent = await sock.sendMessage(jid, { text: message });
  rememberSent(sent);
  return jid;
}

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
    markOnlineOnConnect: false,
    syncFullHistory: false,
    msgRetryCounterCache,
    // Reenvío cuando el destinatario pide de nuevo el mensaje (evita "Esperando el mensaje")
    getMessage: async (key) => sentMessages.get(key.id),
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
app.get('/qr', authMiddleware, (req, res) => {
  if (isReady) return res.json({ status: 'already_connected' });
  if (!qrString) return res.json({ status: 'waiting_for_qr', message: 'Espera unos segundos y recarga' });
  res.json({ status: 'scan_qr', qr: qrString });
});

// Ver QR como imagen HTML (fácil de escanear desde el celular)
app.get('/qr-image', authMiddleware, async (req, res) => {
  if (isReady) return res.send('<html><body style="background:#000;color:#0f0;font-family:sans-serif;text-align:center;padding:40px"><h2>✅ WhatsApp ya está conectado!</h2></body></html>');
  if (!qrString) return res.send('<html><body style="background:#000;color:#fff;font-family:sans-serif;text-align:center;padding:40px"><h2>⏳ Esperando QR...</h2><p>Recarga en 5 segundos</p><script>setTimeout(()=>location.reload(),5000)</script></body></html>');
  try {
    const dataUrl = await QRCode.toDataURL(qrString, { width: 400, margin: 2 });
    res.send(`<html><head><meta http-equiv="refresh" content="20"></head><body style="background:#fff;text-align:center;padding:20px;font-family:sans-serif"><h2>Escanea con WhatsApp Business</h2><p>Dispositivos vinculados → Vincular dispositivo</p><img src="${dataUrl}" style="width:300px;height:300px"><p style="color:#999;font-size:12px">Este QR expira en ~20s — la página recarga sola</p></body></html>`);
  } catch(e) {
    res.status(500).send('Error generando QR: ' + e.message);
  }
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
    const jid = await sendText(to, message);
    const digits = jid.split('@')[0];
    console.log(`📤 Enviado a ${digits}: ${message.substring(0, 60)}…`);
    res.json({ ok: true, to: digits });
  } catch (err) {
    console.error('Error enviando mensaje:', err.message);
    res.status(err.status || 500).json({ error: err.message });
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
      const jid = await sendText(to, message);
      results.push({ to: jid.split('@')[0], ok: true });
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
