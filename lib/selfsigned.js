'use strict';
/**
 * Genera un certificado X.509 autofirmado usando solo modulos nativos de Node.
 * Sirve para ofrecer HTTPS en la red local, requisito de los navegadores
 * para compartir pantalla o camara (getUserMedia / getDisplayMedia).
 */
const crypto = require('crypto');

/* ---------- Codificacion DER ---------- */
function len(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  let v = n;
  while (v > 0) { bytes.unshift(v & 0xff); v >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function tlv(tag, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
}
const seq = (...parts) => tlv(0x30, Buffer.concat(parts));
const set = (...parts) => tlv(0x31, Buffer.concat(parts));
const nullVal = () => Buffer.from([0x05, 0x00]);
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const octetString = (buf) => tlv(0x04, buf);
const utf8String = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const ia5String = (s) => tlv(0x16, Buffer.from(s, 'ascii'));
const explicitCtx = (n, buf) => tlv(0xa0 | n, buf);

function integer(buf) {
  let b = Buffer.isBuffer(buf) ? buf : Buffer.from([buf]);
  let i = 0;
  while (i < b.length - 1 && b[i] === 0 && !(b[i + 1] & 0x80)) i++;
  b = b.subarray(i);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0x00]), b]);
  return tlv(0x02, b);
}

function bitString(buf, unusedBits) {
  return tlv(0x03, Buffer.concat([Buffer.from([unusedBits || 0]), buf]));
}

function oid(dotted) {
  const parts = dotted.split('.').map(Number);
  const out = [40 * parts[0] + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i];
    const stack = [v & 0x7f];
    v >>= 7;
    while (v > 0) { stack.unshift((v & 0x7f) | 0x80); v >>= 7; }
    out.push(...stack);
  }
  return tlv(0x06, Buffer.from(out));
}

function utcTime(date) {
  const p = (n) => String(n).padStart(2, '0');
  const s = p(date.getUTCFullYear() % 100) + p(date.getUTCMonth() + 1) + p(date.getUTCDate()) +
            p(date.getUTCHours()) + p(date.getUTCMinutes()) + p(date.getUTCSeconds()) + 'Z';
  return tlv(0x17, Buffer.from(s, 'ascii'));
}

const OID = {
  sha256RSA: '1.2.840.113549.1.1.11',
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  serverAuth: '1.3.6.1.5.5.7.3.1',
  subjectAltName: '2.5.29.17'
};

function name(cn, org) {
  return seq(
    set(seq(oid(OID.organization), utf8String(org))),
    set(seq(oid(OID.commonName), utf8String(cn)))
  );
}

function extension(oidStr, critical, valueDer) {
  const parts = [oid(oidStr)];
  if (critical) parts.push(bool(true));
  parts.push(octetString(valueDer));
  return seq(...parts);
}

function isIPv4(host) {
  return /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(host) &&
    host.split('.').every((n) => Number(n) >= 0 && Number(n) <= 255);
}

function generalNames(hosts) {
  const items = hosts.map((h) => {
    if (isIPv4(h)) {
      return tlv(0x87, Buffer.from(h.split('.').map(Number)));   // iPAddress [7]
    }
    return tlv(0x82, Buffer.from(h, 'ascii'));                    // dNSName [2]
  });
  return seq(...items);
}

function derToPem(der, label) {
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN ${label}-----\n${b64}${b64.endsWith('\n') ? '' : '\n'}-----END ${label}-----\n`;
}

/**
 * @param {string[]} hosts  nombres DNS e IPs que cubre el certificado
 * @param {number} days     validez
 * @returns {{key: string, cert: string}} en formato PEM
 */
function generate(hosts, days) {
  const altNames = Array.from(new Set(['localhost', '127.0.0.1', ...(hosts || [])].filter(Boolean)));
  const validDays = days || 825;

  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spki = publicKey.export({ type: 'spki', format: 'der' });

  const notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  const notAfter = new Date(Date.now() + validDays * 24 * 3600 * 1000);

  const sigAlg = seq(oid(OID.sha256RSA), nullVal());
  const subject = name('CINE-MAS', 'CINE-MAS Home Theater');

  const extensions = explicitCtx(3, seq(
    extension(OID.basicConstraints, true, seq()),
    // digitalSignature + keyEncipherment
    extension(OID.keyUsage, true, bitString(Buffer.from([0xa0]), 5)),
    extension(OID.extKeyUsage, false, seq(oid(OID.serverAuth))),
    extension(OID.subjectAltName, false, generalNames(altNames))
  ));

  const tbs = seq(
    explicitCtx(0, integer(Buffer.from([0x02]))),        // version v3
    integer(crypto.randomBytes(16)),                      // numero de serie
    sigAlg,
    subject,                                              // emisor (autofirmado)
    seq(utcTime(notBefore), utcTime(notAfter)),
    subject,
    spki,
    extensions
  );

  const signature = crypto.createSign('RSA-SHA256').update(tbs).sign(privateKey);
  const cert = seq(tbs, sigAlg, bitString(signature));

  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: derToPem(cert, 'CERTIFICATE'),
    hosts: altNames,
    notAfter
  };
}

module.exports = { generate };
