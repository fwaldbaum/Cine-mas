/*!
 * qr.js - Generador de codigos QR sin dependencias.
 * Modo byte (UTF-8), versiones 1-10, niveles de correccion L/M/Q/H.
 * Uso:  QR.matrix("texto", "M") -> array de arrays 0/1
 *       QR.toSVG("texto", {ecl:"M", size:320, margin:4})
 *       QR.render(elemento, "texto", opciones)
 */
(function (global) {
  'use strict';

  /* ---------- Campo de Galois GF(256), polinomio 0x11D ---------- */
  var EXP = new Uint8Array(512);
  var LOG = new Uint8Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();

  function gmul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  function rsGenPoly(degree) {
    var poly = [1];
    for (var i = 0; i < degree; i++) {
      var next = new Array(poly.length + 1);
      for (var k = 0; k < next.length; k++) next[k] = 0;
      for (var j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gmul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  function rsRemainder(data, ecLen) {
    var gen = rsGenPoly(ecLen);
    var res = new Uint8Array(data.length + ecLen);
    res.set(data, 0);
    for (var i = 0; i < data.length; i++) {
      var coef = res[i];
      if (coef !== 0) {
        for (var j = 1; j < gen.length; j++) {
          res[i + j] ^= gmul(gen[j], coef);
        }
      }
    }
    return res.subarray(data.length);
  }

  /* ---------- Tablas ISO/IEC 18004 (versiones 1-10) ---------- */
  // total de codewords por version
  var TOTAL_CW = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

  // [ecCodewordsPorBloque, bloquesG1, datosG1, bloquesG2, datosG2]
  var EC_TABLE = {
    L: [
      [7, 1, 19, 0, 0], [10, 1, 34, 0, 0], [15, 1, 55, 0, 0], [20, 1, 80, 0, 0],
      [26, 1, 108, 0, 0], [18, 2, 68, 0, 0], [20, 2, 78, 0, 0], [24, 2, 97, 0, 0],
      [30, 2, 116, 0, 0], [18, 2, 68, 2, 69]
    ],
    M: [
      [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0],
      [24, 2, 43, 0, 0], [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39],
      [22, 3, 36, 2, 37], [26, 4, 43, 1, 44]
    ],
    Q: [
      [13, 1, 13, 0, 0], [22, 1, 22, 0, 0], [18, 2, 17, 0, 0], [26, 2, 24, 0, 0],
      [18, 2, 15, 2, 16], [24, 4, 19, 0, 0], [18, 2, 14, 4, 15], [22, 4, 18, 2, 19],
      [20, 4, 16, 4, 17], [24, 6, 19, 2, 20]
    ],
    H: [
      [17, 1, 9, 0, 0], [28, 1, 16, 0, 0], [22, 2, 13, 0, 0], [16, 4, 9, 0, 0],
      [22, 2, 11, 2, 12], [28, 4, 15, 0, 0], [26, 4, 13, 1, 14], [26, 4, 14, 2, 15],
      [24, 4, 12, 4, 13], [28, 6, 15, 2, 16]
    ]
  };

  var ECL_BITS = { L: 1, M: 0, Q: 3, H: 2 };

  var ALIGN_POS = [
    [], [6, 18], [6, 22], [6, 26], [6, 30],
    [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]
  ];

  /* ---------- Utilidades ---------- */
  function utf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        var c2 = str.charCodeAt(i + 1);
        var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        i++;
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
                 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      } else {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    }
    return out;
  }

  function BitBuffer() {
    this.bits = [];
  }
  BitBuffer.prototype.put = function (value, length) {
    for (var i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  };
  BitBuffer.prototype.length = function () {
    return this.bits.length;
  };

  function dataCapacityBits(version, ecl) {
    var t = EC_TABLE[ecl][version - 1];
    var dataCw = t[1] * t[2] + t[3] * t[4];
    return dataCw * 8;
  }

  function bchFormat(data) {
    var d = data << 10;
    for (var i = 14; i >= 10; i--) {
      if ((d >>> i) & 1) d ^= 0x537 << (i - 10);
    }
    return ((data << 10) | d) ^ 0x5412;
  }

  function bchVersion(version) {
    var d = version << 12;
    for (var i = 17; i >= 12; i--) {
      if ((d >>> i) & 1) d ^= 0x1f25 << (i - 12);
    }
    return (version << 12) | d;
  }

  /* ---------- Codificacion ---------- */
  function encodeData(text, ecl) {
    var bytes = utf8Bytes(text);
    var version = 0;
    for (var v = 1; v <= 10; v++) {
      var lenBits = v < 10 ? 8 : 16;
      var need = 4 + lenBits + bytes.length * 8;
      if (need <= dataCapacityBits(v, ecl)) { version = v; break; }
    }
    if (!version) throw new Error('Texto demasiado largo para el QR (max version 10).');

    var cci = version < 10 ? 8 : 16;
    var bb = new BitBuffer();
    bb.put(4, 4);                 // indicador de modo byte
    bb.put(bytes.length, cci);
    for (var i = 0; i < bytes.length; i++) bb.put(bytes[i], 8);

    var capacity = dataCapacityBits(version, ecl);
    var terminator = Math.min(4, capacity - bb.length());
    bb.put(0, terminator);
    while (bb.length() % 8 !== 0) bb.put(0, 1);

    var dataCw = [];
    for (var b = 0; b < bb.bits.length; b += 8) {
      var byte = 0;
      for (var k = 0; k < 8; k++) byte = (byte << 1) | bb.bits[b + k];
      dataCw.push(byte);
    }
    var pad = [0xec, 0x11], p = 0;
    while (dataCw.length < capacity / 8) dataCw.push(pad[p++ % 2]);

    return { version: version, codewords: dataCw };
  }

  function buildFinalCodewords(version, ecl, dataCw) {
    var t = EC_TABLE[ecl][version - 1];
    var ecLen = t[0], nb1 = t[1], dc1 = t[2], nb2 = t[3], dc2 = t[4];
    var blocks = [], ecBlocks = [], offset = 0, i;

    for (i = 0; i < nb1; i++) {
      var blk1 = dataCw.slice(offset, offset + dc1);
      offset += dc1;
      blocks.push(blk1);
      ecBlocks.push(rsRemainder(Uint8Array.from(blk1), ecLen));
    }
    for (i = 0; i < nb2; i++) {
      var blk2 = dataCw.slice(offset, offset + dc2);
      offset += dc2;
      blocks.push(blk2);
      ecBlocks.push(rsRemainder(Uint8Array.from(blk2), ecLen));
    }

    var result = [];
    var maxData = Math.max(dc1, dc2);
    for (i = 0; i < maxData; i++) {
      for (var b = 0; b < blocks.length; b++) {
        if (i < blocks[b].length) result.push(blocks[b][i]);
      }
    }
    for (i = 0; i < ecLen; i++) {
      for (var e = 0; e < ecBlocks.length; e++) result.push(ecBlocks[e][i]);
    }
    return result;
  }

  /* ---------- Matriz ---------- */
  function newMatrix(size, value) {
    var m = new Array(size);
    for (var i = 0; i < size; i++) {
      m[i] = new Array(size);
      for (var j = 0; j < size; j++) m[i][j] = value;
    }
    return m;
  }

  function placeFunctionPatterns(mod, res, version) {
    var size = mod.length, i, j;

    function finder(row, col) {
      for (var r = -1; r <= 7; r++) {
        for (var c = -1; c <= 7; c++) {
          var rr = row + r, cc = col + c;
          if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
          var on = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                   (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
                   (r >= 2 && r <= 4 && c >= 2 && c <= 4);
          mod[rr][cc] = on ? 1 : 0;
          res[rr][cc] = true;
        }
      }
    }
    finder(0, 0);
    finder(0, size - 7);
    finder(size - 7, 0);

    // Patrones de sincronizacion
    for (i = 8; i < size - 8; i++) {
      var bit = i % 2 === 0 ? 1 : 0;
      mod[6][i] = bit; res[6][i] = true;
      mod[i][6] = bit; res[i][6] = true;
    }

    // Patrones de alineacion
    var pos = ALIGN_POS[version - 1];
    for (i = 0; i < pos.length; i++) {
      for (j = 0; j < pos.length; j++) {
        var ar = pos[i], ac = pos[j];
        if ((ar <= 7 && ac <= 7) || (ar <= 7 && ac >= size - 8) || (ar >= size - 8 && ac <= 7)) continue;
        for (var dr = -2; dr <= 2; dr++) {
          for (var dc = -2; dc <= 2; dc++) {
            var on2 = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
            mod[ar + dr][ac + dc] = on2 ? 1 : 0;
            res[ar + dr][ac + dc] = true;
          }
        }
      }
    }

    // Zonas reservadas para la informacion de formato
    for (i = 0; i < 9; i++) {
      if (!res[8][i]) { mod[8][i] = 0; res[8][i] = true; }
      if (!res[i][8]) { mod[i][8] = 0; res[i][8] = true; }
    }
    for (i = 0; i < 8; i++) {
      res[8][size - 1 - i] = true; mod[8][size - 1 - i] = 0;
      res[size - 1 - i][8] = true; mod[size - 1 - i][8] = 0;
    }
    // Modulo oscuro
    mod[size - 8][8] = 1;
    res[size - 8][8] = true;

    // Informacion de version (>= 7)
    if (version >= 7) {
      var vinfo = bchVersion(version);
      for (i = 0; i < 18; i++) {
        var b = (vinfo >>> i) & 1;
        var r1 = Math.floor(i / 3), c1 = size - 11 + (i % 3);
        mod[r1][c1] = b; res[r1][c1] = true;
        mod[c1][r1] = b; res[c1][r1] = true;
      }
    }
  }

  function placeData(mod, res, codewords) {
    var size = mod.length;
    var bitIndex = 0;
    var upward = true;
    for (var col = size - 1; col > 0; col -= 2) {
      if (col === 6) col = 5;
      for (var n = 0; n < size; n++) {
        var row = upward ? size - 1 - n : n;
        for (var c = 0; c < 2; c++) {
          var cc = col - c;
          if (res[row][cc]) continue;
          var bit = 0;
          var byteIdx = bitIndex >> 3;
          if (byteIdx < codewords.length) {
            bit = (codewords[byteIdx] >>> (7 - (bitIndex & 7))) & 1;
          }
          mod[row][cc] = bit;
          bitIndex++;
        }
      }
      upward = !upward;
    }
  }

  function maskFn(id, i, j) {
    switch (id) {
      case 0: return (i + j) % 2 === 0;
      case 1: return i % 2 === 0;
      case 2: return j % 3 === 0;
      case 3: return (i + j) % 3 === 0;
      case 4: return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
      case 5: return ((i * j) % 2) + ((i * j) % 3) === 0;
      case 6: return (((i * j) % 2) + ((i * j) % 3)) % 2 === 0;
      case 7: return (((i + j) % 2) + ((i * j) % 3)) % 2 === 0;
    }
    return false;
  }

  function applyMask(mod, res, id) {
    var size = mod.length;
    for (var i = 0; i < size; i++) {
      for (var j = 0; j < size; j++) {
        if (!res[i][j] && maskFn(id, i, j)) mod[i][j] ^= 1;
      }
    }
  }

  function placeFormat(mod, ecl, mask) {
    var size = mod.length;
    var fmt = bchFormat((ECL_BITS[ecl] << 3) | mask);
    for (var i = 0; i < 15; i++) {
      var bit = (fmt >>> i) & 1;
      if (i < 6) mod[i][8] = bit;
      else if (i === 6) mod[7][8] = bit;
      else if (i === 7) mod[8][8] = bit;
      else if (i === 8) mod[8][7] = bit;
      else mod[8][14 - i] = bit;

      if (i < 8) mod[8][size - 1 - i] = bit;
      else mod[size - 15 + i][8] = bit;
    }
  }

  function penalty(mod) {
    var size = mod.length, score = 0, i, j, run, last;

    // Regla 1: series de 5 o mas del mismo color
    for (i = 0; i < size; i++) {
      run = 1; last = mod[i][0];
      for (j = 1; j < size; j++) {
        if (mod[i][j] === last) { run++; }
        else { if (run >= 5) score += run - 2; last = mod[i][j]; run = 1; }
      }
      if (run >= 5) score += run - 2;

      run = 1; last = mod[0][i];
      for (j = 1; j < size; j++) {
        if (mod[j][i] === last) { run++; }
        else { if (run >= 5) score += run - 2; last = mod[j][i]; run = 1; }
      }
      if (run >= 5) score += run - 2;
    }

    // Regla 2: bloques 2x2
    for (i = 0; i < size - 1; i++) {
      for (j = 0; j < size - 1; j++) {
        var v = mod[i][j];
        if (v === mod[i][j + 1] && v === mod[i + 1][j] && v === mod[i + 1][j + 1]) score += 3;
      }
    }

    // Regla 3: patrones 1:1:3:1:1 con zona clara
    var p1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    var p2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    function matches(get, start) {
      for (var k = 0; k < 11; k++) if (get(start + k) !== p1[k]) return false;
      return true;
    }
    function matches2(get, start) {
      for (var k = 0; k < 11; k++) if (get(start + k) !== p2[k]) return false;
      return true;
    }
    for (i = 0; i < size; i++) {
      for (j = 0; j <= size - 11; j++) {
        (function (row, col) {
          var getRow = function (k) { return mod[row][k]; };
          var getCol = function (k) { return mod[k][row]; };
          if (matches(getRow, col) || matches2(getRow, col)) score += 40;
          if (matches(getCol, col) || matches2(getCol, col)) score += 40;
        })(i, j);
      }
    }

    // Regla 4: proporcion de modulos oscuros
    var dark = 0;
    for (i = 0; i < size; i++) for (j = 0; j < size; j++) dark += mod[i][j];
    var ratio = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(ratio - 50) / 5) * 10;
    return score;
  }

  function matrix(text, ecl) {
    ecl = (ecl || 'M').toUpperCase();
    if (!EC_TABLE[ecl]) ecl = 'M';
    var enc = encodeData(String(text), ecl);
    var version = enc.version;
    var finalCw = buildFinalCodewords(version, ecl, enc.codewords);
    var size = 17 + 4 * version;

    var best = null, bestScore = Infinity;
    for (var m = 0; m < 8; m++) {
      var mod = newMatrix(size, 0);
      var res = newMatrix(size, false);
      placeFunctionPatterns(mod, res, version);
      placeData(mod, res, finalCw);
      applyMask(mod, res, m);
      placeFormat(mod, ecl, m);
      var s = penalty(mod);
      if (s < bestScore) { bestScore = s; best = mod; }
    }
    return best;
  }

  function toSVG(text, opts) {
    opts = opts || {};
    var ecl = opts.ecl || 'M';
    var margin = opts.margin == null ? 4 : opts.margin;
    var dark = opts.dark || '#000000';
    var light = opts.light || '#ffffff';
    var m = matrix(text, ecl);
    var n = m.length;
    var total = n + margin * 2;
    var path = '';
    for (var i = 0; i < n; i++) {
      for (var j = 0; j < n; j++) {
        if (m[i][j]) path += 'M' + (j + margin) + ' ' + (i + margin) + 'h1v1h-1z';
      }
    }
    var sizeAttr = opts.size ? ' width="' + opts.size + '" height="' + opts.size + '"' : '';
    return '<svg xmlns="http://www.w3.org/2000/svg"' + sizeAttr +
      ' viewBox="0 0 ' + total + ' ' + total + '" shape-rendering="crispEdges" role="img" aria-label="Codigo QR">' +
      '<rect width="' + total + '" height="' + total + '" fill="' + light + '"/>' +
      '<path d="' + path + '" fill="' + dark + '"/></svg>';
  }

  function render(el, text, opts) {
    if (!el) return;
    try {
      el.innerHTML = toSVG(text, opts);
    } catch (err) {
      el.textContent = 'QR error: ' + err.message;
    }
  }

  var QR = { matrix: matrix, toSVG: toSVG, render: render };

  if (typeof module !== 'undefined' && module.exports) module.exports = QR;
  global.QR = QR;
})(typeof window !== 'undefined' ? window : globalThis);
