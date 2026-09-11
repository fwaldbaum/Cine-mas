#!/usr/bin/env node
'use strict';
/**
 * CINE-MÁS - Servidor del selector de plataformas para el cine de casa.
 *
 * - Sirve la pantalla del televisor, el control remoto del celular y la
 *   pagina para compartir pantalla (Seeke).
 * - HTTP en la red local + HTTPS con certificado autofirmado (necesario para
 *   que el navegador del celular permita compartir pantalla o camara).
 * - WebSocket propio para el control remoto y la senalizacion WebRTC.
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ws = require('./lib/ws');
const selfsigned = require('./lib/selfsigned');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CERT_DIR = path.join(ROOT, '.certs');

const HTTP_PORT = Number(process.env.CINEMAS_PORT || 8123);
const HTTPS_PORT = Number(process.env.CINEMAS_HTTPS_PORT || 8443);
const ENABLE_HTTPS = process.env.CINEMAS_HTTPS !== '0';

/* ---------------- Estado de la sesion ---------------- */
const state = {
  pin: process.env.CINEMAS_PIN && /^\d{4,8}$/.test(process.env.CINEMAS_PIN)
    ? process.env.CINEMAS_PIN
    : String(crypto.randomInt(1000, 10000)),
  shareToken: crypto.randomBytes(8).toString('hex'),
  tv: { screen: 'home', focus: 0, platform: null },
  startedAt: Date.now()
};

const clients = new Set();
const pinAttempts = new Map(); // ip -> { count, until }

/* ---------------- Utilidades de red ---------------- */
function localAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const nameIface of Object.keys(ifaces)) {
    for (const info of ifaces[nameIface] || []) {
      if (info.family !== 'IPv4' && info.family !== 4) continue;
      if (info.internal) continue;
      out.push({ iface: nameIface, address: info.address });
    }
  }
  // Preferimos rangos tipicos de red domestica
  out.sort((a, b) => score(b.address) - score(a.address));
  return out;
}
function score(ip) {
  if (ip.startsWith('192.168.')) return 3;
  if (ip.startsWith('10.')) return 2;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 1;
  return 0;
}
function isLocalhost(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === 'localhost' || addr === '';
}
const TV_HOSTS = (process.env.CINEMAS_TV_HOSTS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
function canBeTv(addr) {
  if (TV_HOSTS.includes('*')) return true;   // CINEMAS_TV_HOSTS=* permite cualquier equipo
  return isLocalhost(addr) || TV_HOSTS.includes(addr);
}

/* ---------------- Servidor de archivos estaticos ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json'
};

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('No encontrado');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(data);
  });
}

function sendJSON(res, obj, status) {
  const body = JSON.stringify(obj);
  res.writeHead(status || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function handleRequest(req, res, secure) {
  const url = new URL(req.url, 'http://x');
  const pathname = decodeURIComponent(url.pathname);
  const remote = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');

  const routes = {
    '/': 'index.html',
    '/tv': 'index.html',
    '/r': 'remote.html',
    '/remote': 'remote.html',
    '/s': 'share.html',
    '/share': 'share.html'
  };

  if (pathname === '/api/info') {
    const addresses = localAddresses().map((a) => a.address);
    const host = url.searchParams.get('host') || addresses[0] || 'localhost';
    return sendJSON(res, {
      name: 'CINE-MÁS',
      addresses,
      httpPort: HTTP_PORT,
      httpsPort: httpsServer ? HTTPS_PORT : null,
      https: Boolean(httpsServer),
      remoteUrl: `http://${host}:${HTTP_PORT}/r`,
      shareUrl: httpsServer
        ? `https://${host}:${HTTPS_PORT}/s?t=${state.shareToken}`
        : `http://${host}:${HTTP_PORT}/s?t=${state.shareToken}`,
      // El PIN solo se entrega a quien puede actuar como televisor.
      pin: canBeTv(remote) ? state.pin : null,
      canBeTv: canBeTv(remote),
      secure
    });
  }

  if (pathname === '/healthz') return sendJSON(res, { ok: true, uptime: Date.now() - state.startedAt });

  if (routes[pathname]) return sendFile(res, path.join(PUBLIC_DIR, routes[pathname]));

  // Archivos estaticos, sin salir de public/
  const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Prohibido');
  }
  return sendFile(res, filePath);
}

/* ---------------- Logica del WebSocket ---------------- */
function broadcast(role, message, except) {
  for (const c of clients) {
    if (c.data.role === role && c !== except && c.open) c.send(message);
  }
}
function counts() {
  let tv = 0, remote = 0, share = 0;
  for (const c of clients) {
    if (c.data.role === 'tv') tv++;
    else if (c.data.role === 'remote') remote++;
    else if (c.data.role === 'share') share++;
  }
  return { tv, remote, share };
}
function announcePeers() {
  const peers = counts();
  for (const c of clients) {
    if (c.data.role && c.open) c.send({ t: 'peers', peers });
  }
}
function pinBlocked(ip) {
  const entry = pinAttempts.get(ip);
  if (!entry) return false;
  if (Date.now() > entry.until) { pinAttempts.delete(ip); return false; }
  return entry.count >= 5;
}
function registerPinFailure(ip) {
  const entry = pinAttempts.get(ip) || { count: 0, until: 0 };
  entry.count += 1;
  entry.until = Date.now() + 60000;
  pinAttempts.set(ip, entry);
}

function onConnection(conn) {
  clients.add(conn);
  conn.data.role = null;

  conn.on('message', (msg) => {
    if (!msg || typeof msg.t !== 'string') return;

    /* --- Registro --- */
    if (msg.t === 'hello') {
      const role = msg.role;
      if (role === 'tv') {
        if (!canBeTv(conn.remoteAddress)) {
          return conn.send({ t: 'denied', reason: 'tv-host',
            message: 'Esta pantalla solo puede abrirse en el equipo del cine (localhost) o en una IP autorizada con CINEMAS_TV_HOSTS.' });
        }
        conn.data.role = 'tv';
        conn.send({ t: 'welcome', role: 'tv', pin: state.pin, shareToken: state.shareToken, state: state.tv });
        announcePeers();
        return;
      }
      if (role === 'remote') {
        if (pinBlocked(conn.remoteAddress)) {
          return conn.send({ t: 'denied', reason: 'blocked', message: 'Demasiados intentos. Espera un minuto.' });
        }
        if (String(msg.pin || '') !== state.pin) {
          registerPinFailure(conn.remoteAddress);
          return conn.send({ t: 'denied', reason: 'pin', message: 'Contraseña incorrecta.' });
        }
        pinAttempts.delete(conn.remoteAddress);
        conn.data.role = 'remote';
        conn.send({ t: 'welcome', role: 'remote', state: state.tv, shareToken: state.shareToken });
        announcePeers();
        return;
      }
      if (role === 'share') {
        if (String(msg.token || '') !== state.shareToken) {
          return conn.send({ t: 'denied', reason: 'token', message: 'Código caducado. Vuelve a escanear el QR en la tele.' });
        }
        conn.data.role = 'share';
        conn.send({ t: 'welcome', role: 'share', state: state.tv });
        announcePeers();
        return;
      }
      return conn.send({ t: 'denied', reason: 'role' });
    }

    if (!conn.data.role) return; // sin registrar no se hace nada

    /* --- Ordenes del control remoto hacia el televisor --- */
    if (msg.t === 'cmd' && conn.data.role === 'remote') {
      broadcast('tv', { t: 'cmd', action: msg.action, id: msg.id, url: msg.url });
      return;
    }

    /* --- El televisor publica su estado --- */
    if (msg.t === 'state' && conn.data.role === 'tv') {
      state.tv = {
        screen: msg.screen || 'home',
        focus: typeof msg.focus === 'number' ? msg.focus : 0,
        platform: msg.platform || null,
        sharing: Boolean(msg.sharing)
      };
      broadcast('remote', { t: 'state', state: state.tv });
      broadcast('share', { t: 'state', state: state.tv });
      return;
    }

    /* --- Abrir un enlace en el televisor (Seeke / enviar enlace) --- */
    if (msg.t === 'openurl' && (conn.data.role === 'share' || conn.data.role === 'remote')) {
      const url = String(msg.url || '').trim();
      if (!/^https?:\/\//i.test(url)) return conn.send({ t: 'error', message: 'El enlace debe empezar por http:// o https://' });
      broadcast('tv', { t: 'openurl', url });
      conn.send({ t: 'ok', message: 'Enlace enviado a la tele.' });
      return;
    }

    /* --- Senalizacion WebRTC entre el celular y el televisor --- */
    if (msg.t === 'signal') {
      const target = conn.data.role === 'share' ? 'tv' : 'share';
      broadcast(target, { t: 'signal', from: conn.data.role, data: msg.data });
      return;
    }

    /* --- El televisor rota el codigo para compartir --- */
    if (msg.t === 'rotate-share' && conn.data.role === 'tv') {
      state.shareToken = crypto.randomBytes(8).toString('hex');
      conn.send({ t: 'share-token', shareToken: state.shareToken });
      broadcast('share', { t: 'bye', reason: 'token-rotado' });
      return;
    }

    /* --- El televisor cambia el PIN --- */
    if (msg.t === 'rotate-pin' && conn.data.role === 'tv') {
      state.pin = String(crypto.randomInt(1000, 10000));
      pinAttempts.clear();
      conn.send({ t: 'welcome', role: 'tv', pin: state.pin, shareToken: state.shareToken, state: state.tv });
      for (const c of clients) {
        if (c.data.role === 'remote') { c.send({ t: 'bye', reason: 'pin-cambiado' }); c.close(); }
      }
      console.log('\n  Nueva contraseña del control remoto: ' + state.pin + '\n');
      return;
    }
  });

  conn.on('close', () => {
    const wasRole = conn.data.role;
    clients.delete(conn);
    if (wasRole === 'share') broadcast('tv', { t: 'share-gone' });
    announcePeers();
  });
}

/* ---------------- Arranque ---------------- */
let httpsServer = null;

function loadOrCreateCert(hosts) {
  const keyPath = path.join(CERT_DIR, 'cine-mas.key');
  const certPath = path.join(CERT_DIR, 'cine-mas.crt');
  const metaPath = path.join(CERT_DIR, 'hosts.json');
  try {
    if (fs.existsSync(keyPath) && fs.existsSync(certPath) && fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const same = Array.isArray(meta.hosts) && hosts.every((h) => meta.hosts.includes(h));
      const cert = fs.readFileSync(certPath, 'utf8');
      const parsed = new crypto.X509Certificate(cert);
      const vigente = new Date(parsed.validTo).getTime() > Date.now() + 24 * 3600 * 1000;
      if (same && vigente) {
        return { key: fs.readFileSync(keyPath, 'utf8'), cert };
      }
    }
  } catch (err) { /* se regenera */ }

  const generated = selfsigned.generate(hosts, 825);
  try {
    fs.mkdirSync(CERT_DIR, { recursive: true });
    fs.writeFileSync(keyPath, generated.key, { mode: 0o600 });
    fs.writeFileSync(certPath, generated.cert);
    fs.writeFileSync(metaPath, JSON.stringify({ hosts: generated.hosts }, null, 2));
  } catch (err) {
    console.warn('  Aviso: no se pudo guardar el certificado (' + err.message + ')');
  }
  return generated;
}

function start() {
  const addresses = localAddresses().map((a) => a.address);
  const primary = addresses[0] || 'localhost';

  const httpServer = http.createServer((req, res) => handleRequest(req, res, false));
  ws.attach(httpServer, '/ws', onConnection);

  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  El puerto ${HTTP_PORT} ya está ocupado. Prueba: CINEMAS_PORT=8124 npm start\n`);
      process.exit(1);
    }
    throw err;
  });

  httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
    if (ENABLE_HTTPS) {
      try {
        const creds = loadOrCreateCert([...addresses, 'localhost', '127.0.0.1']);
        httpsServer = https.createServer({ key: creds.key, cert: creds.cert },
          (req, res) => handleRequest(req, res, true));
        ws.attach(httpsServer, '/ws', onConnection);
        httpsServer.on('error', (err) => {
          console.warn('  Aviso: HTTPS no disponible (' + err.message + ')');
          httpsServer = null;
        });
        httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => banner(primary, addresses));
        return;
      } catch (err) {
        console.warn('  Aviso: no se pudo iniciar HTTPS (' + err.message + ')');
      }
    }
    banner(primary, addresses);
  });
}

function banner(primary, addresses) {
  const line = '─'.repeat(58);
  console.log('\n' + line);
  console.log('  CINE-MÁS listo');
  console.log(line);
  console.log('  Televisor .......... http://localhost:' + HTTP_PORT + '/');
  console.log('  Control remoto ..... http://' + primary + ':' + HTTP_PORT + '/r');
  if (httpsServer) {
    console.log('  Compartir pantalla . https://' + primary + ':' + HTTPS_PORT + '/s');
  }
  console.log('  Contraseña ......... ' + state.pin);
  if (TV_HOSTS.length) {
    console.log('  Pantallas permitidas ' + (TV_HOSTS.includes('*') ? 'cualquier equipo de la red' : TV_HOSTS.join(', ')));
  }
  if (addresses.length > 1) {
    console.log('  Otras IP ........... ' + addresses.slice(1).join(', '));
  }
  console.log(line);
  console.log('  Abre el televisor en pantalla completa y escanea el QR.');
  console.log('  Para detener: Ctrl+C\n');
}

process.on('SIGINT', () => { console.log('\n  Hasta luego.\n'); process.exit(0); });

start();
