/*
 * A small QR encoder - just enough to put the join address on screen as
 * something a phone can scan.
 *
 * Byte mode, error correction level M, versions 1 to 10, which covers any
 * "https://<ip>:<port>/phone" URL with room to spare. Everything follows the
 * usual construction: encode to codewords, add Reed-Solomon parity, interleave
 * the blocks, lay the bits out in the zig-zag, then pick whichever of the eight
 * masks scores lowest on the standard penalty rules.
 */

// --- per-version tables, error level M ------------------------------------
// [ec codewords per block, blocks in group 1, data codewords each,
//  blocks in group 2, data codewords each]
const VERSIONS = {
  1: [10, 1, 16, 0, 0],
  2: [16, 1, 28, 0, 0],
  3: [26, 1, 44, 0, 0],
  4: [18, 2, 32, 0, 0],
  5: [24, 2, 43, 0, 0],
  6: [16, 4, 27, 0, 0],
  7: [18, 4, 31, 0, 0],
  8: [22, 2, 38, 2, 39],
  9: [22, 3, 36, 2, 37],
  10: [26, 4, 43, 1, 44],
};

const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

const ECC_M = 0;                 // the two-bit indicator for level M
const FORMAT_MASK = 0x5412;
const FORMAT_GEN = 0x537;
const VERSION_GEN = 0x1f25;

// --- GF(256) --------------------------------------------------------------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function buildTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) { x ^= 0x11d; }
  }
  for (let i = 255; i < 512; i++) { EXP[i] = EXP[i - 255]; }
})();

function mul(a, b) {
  if (a === 0 || b === 0) { return 0; }
  return EXP[LOG[a] + LOG[b]];
}

function generatorPoly(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= mul(g[j], EXP[i]);
    }
    g = next;
  }
  return g;
}

/** Reed-Solomon parity for one block. */
function parity(data, n) {
  const g = generatorPoly(n);
  const rem = data.slice().concat(new Array(n).fill(0));
  for (let i = 0; i < data.length; i++) {
    const coef = rem[i];
    if (coef === 0) { continue; }
    for (let j = 0; j < g.length; j++) {
      rem[i + j] ^= mul(g[j], coef);
    }
  }
  return rem.slice(data.length);
}

// --- data encoding --------------------------------------------------------

function utf8Bytes(text) {
  return Array.from(new TextEncoder().encode(text));
}

function capacityBytes(version) {
  const [ec, b1, d1, b2, d2] = VERSIONS[version];
  const dataCw = b1 * d1 + b2 * d2;
  const countBits = version < 10 ? 8 : 16;
  return dataCw - Math.ceil((4 + countBits) / 8);
}

function pickVersion(byteLen) {
  for (let v = 1; v <= 10; v++) {
    if (byteLen <= capacityBytes(v)) { return v; }
  }
  return null;
}

function buildCodewords(bytes, version) {
  const [ecLen, b1, d1, b2, d2] = VERSIONS[version];
  const dataCw = b1 * d1 + b2 * d2;
  const countBits = version < 10 ? 8 : 16;

  const bits = [];
  const push = (value, len) => {
    for (let i = len - 1; i >= 0; i--) { bits.push((value >> i) & 1); }
  };
  push(0b0100, 4);                       // byte mode
  push(bytes.length, countBits);
  for (const b of bytes) { push(b, 8); }

  const capacityBits = dataCw * 8;
  for (let i = 0; i < 4 && bits.length < capacityBits; i++) { bits.push(0); }
  while (bits.length % 8 !== 0) { bits.push(0); }

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) { byte = (byte << 1) | bits[i + j]; }
    codewords.push(byte);
  }
  const PAD = [0xec, 0x11];
  let p = 0;
  while (codewords.length < dataCw) { codewords.push(PAD[p++ % 2]); }

  // split into blocks, compute parity, then interleave
  const blocks = [];
  let at = 0;
  for (let i = 0; i < b1; i++) { blocks.push(codewords.slice(at, at += d1)); }
  for (let i = 0; i < b2; i++) { blocks.push(codewords.slice(at, at += d2)); }
  const eccBlocks = blocks.map(b => parity(b, ecLen));

  const out = [];
  const maxData = Math.max(...blocks.map(b => b.length));
  for (let i = 0; i < maxData; i++) {
    for (const b of blocks) { if (i < b.length) { out.push(b[i]); } }
  }
  for (let i = 0; i < ecLen; i++) {
    for (const b of eccBlocks) { out.push(b[i]); }
  }
  return out;
}

// --- matrix ---------------------------------------------------------------

function blankMatrix(size) {
  const m = [], reserved = [];
  for (let r = 0; r < size; r++) {
    m.push(new Array(size).fill(0));
    reserved.push(new Array(size).fill(false));
  }
  return { m, reserved };
}

function placeFinder(m, reserved, row, col) {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = row + r, cc = col + c;
      if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) { continue; }
      const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6))
        || (c >= 0 && c <= 6 && (r === 0 || r === 6));
      const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      m[rr][cc] = (inRing || inCore) ? 1 : 0;
      reserved[rr][cc] = true;
    }
  }
}

function placeAlignment(m, reserved, version) {
  const coords = ALIGN[version];
  const size = m.length;
  for (const r of coords) {
    for (const c of coords) {
      // skip the three corners already taken by finder patterns
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9)
          || (r >= size - 9 && c <= 8)) { continue; }
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          m[r + dr][c + dc] = (ring === 1) ? 0 : 1;
          reserved[r + dr][c + dc] = true;
        }
      }
    }
  }
}

function reserveFormat(reserved, size, version) {
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) { reserved[8][i] = true; reserved[i][8] = true; }
  }
  reserved[8][6] = true;
  reserved[6][8] = true;
  for (let i = 0; i < 8; i++) {
    reserved[8][size - 1 - i] = true;
    reserved[size - 1 - i][8] = true;
  }
  if (version >= 7) {
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 3; c++) {
        reserved[r][size - 11 + c] = true;
        reserved[size - 11 + c][r] = true;
      }
    }
  }
}

function bchFormat(value) {
  let v = value << 10;
  for (let i = 14; i >= 10; i--) {
    if ((v >> i) & 1) { v ^= FORMAT_GEN << (i - 10); }
  }
  return ((value << 10) | v) ^ FORMAT_MASK;
}

function bchVersion(version) {
  let v = version << 12;
  for (let i = 17; i >= 12; i--) {
    if ((v >> i) & 1) { v ^= VERSION_GEN << (i - 12); }
  }
  return (version << 12) | v;
}

/**
 * The 15 format bits, written twice.
 *
 * Two details here are easy to get wrong and both make the symbol unreadable
 * while still looking plausible: the bits go down each sequence
 * most-significant first, and the second copy splits 7 modules vertically then
 * 8 horizontally - the module at (size-8, 8) is the always-dark one, not a
 * format bit.
 */
function placeFormat(m, size, mask) {
  const bits = bchFormat((ECC_M << 3) | mask);

  const copy1 = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
                 [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  const copy2 = [];
  for (let i = 0; i < 7; i++) { copy2.push([size - 1 - i, 8]); }
  for (let i = 7; i < 15; i++) { copy2.push([8, size - 15 + i]); }

  for (let k = 0; k < 15; k++) {
    const bit = (bits >> (14 - k)) & 1;
    m[copy1[k][0]][copy1[k][1]] = bit;
    m[copy2[k][0]][copy2[k][1]] = bit;
  }
  m[size - 8][8] = 1;                        // the always-dark module
}

function placeVersion(m, size, version) {
  if (version < 7) { return; }
  const bits = bchVersion(version);
  for (let i = 0; i < 18; i++) {
    const bit = (bits >> i) & 1;
    const r = Math.floor(i / 3);
    const c = i % 3;
    m[r][size - 11 + c] = bit;
    m[size - 11 + c][r] = bit;
  }
}

function placeData(m, reserved, codewords) {
  const size = m.length;
  const bits = [];
  for (const cw of codewords) {
    for (let i = 7; i >= 0; i--) { bits.push((cw >> i) & 1); }
  }
  let idx = 0;
  let dir = -1;
  let row = size - 1;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) { col--; }               // the vertical timing line
    for (;;) {
      for (let k = 0; k < 2; k++) {
        const c = col - k;
        if (!reserved[row][c]) {
          m[row][c] = idx < bits.length ? bits[idx++] : 0;
        }
      }
      row += dir;
      if (row < 0 || row >= size) {
        row -= dir;
        dir = -dir;
        break;
      }
    }
  }
}

function maskBit(mask, r, c) {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return ((((r * c) % 2) + ((r * c) % 3)) % 2) === 0;
    default: return ((((r + c) % 2) + ((r * c) % 3)) % 2) === 0;
  }
}

function penalty(m) {
  const size = m.length;
  let score = 0;

  // rule 1: runs of five or more of the same colour
  for (let i = 0; i < size; i++) {
    for (const horizontal of [true, false]) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        const a = horizontal ? m[i][j] : m[j][i];
        const b = horizontal ? m[i][j - 1] : m[j - 1][i];
        if (a === b) {
          run++;
        } else {
          if (run >= 5) { score += run - 2; }
          run = 1;
        }
      }
      if (run >= 5) { score += run - 2; }
    }
  }

  // rule 2: 2x2 blocks of one colour
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) {
        score += 3;
      }
    }
  }

  // rule 3: finder-like patterns
  const A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const matches = (get, start) => {
    let okA = true, okB = true;
    for (let k = 0; k < 11; k++) {
      const v = get(start + k);
      if (v !== A[k]) { okA = false; }
      if (v !== B[k]) { okB = false; }
    }
    return okA || okB;
  };
  for (let i = 0; i < size; i++) {
    for (let j = 0; j + 11 <= size; j++) {
      if (matches(k => m[i][k], j)) { score += 40; }
      if (matches(k => m[k][i], j)) { score += 40; }
    }
  }

  // rule 4: overall balance of dark modules
  let dark = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) { if (m[r][c]) { dark++; } }
  }
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

/**
 * Build the QR matrix for a string.
 * Returns { size, modules } where modules[row][col] is 0 or 1, or null if the
 * text is too long for the versions supported here.
 */
export function qrMatrix(text) {
  const bytes = utf8Bytes(text);
  const version = pickVersion(bytes.length);
  if (!version) { return null; }

  const size = 17 + version * 4;
  const codewords = buildCodewords(bytes, version);

  const base = blankMatrix(size);
  placeFinder(base.m, base.reserved, 0, 0);
  placeFinder(base.m, base.reserved, 0, size - 7);
  placeFinder(base.m, base.reserved, size - 7, 0);
  for (let i = 8; i < size - 8; i++) {
    const bit = i % 2 === 0 ? 1 : 0;
    base.m[6][i] = bit; base.reserved[6][i] = true;
    base.m[i][6] = bit; base.reserved[i][6] = true;
  }
  placeAlignment(base.m, base.reserved, version);
  reserveFormat(base.reserved, size, version);
  base.reserved[size - 8][8] = true;
  placeData(base.m, base.reserved, codewords);

  // try every mask and keep the tidiest
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const m = base.m.map(row => row.slice());
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!base.reserved[r][c] && maskBit(mask, r, c)) { m[r][c] ^= 1; }
      }
    }
    placeVersion(m, size, version);
    placeFormat(m, size, mask);
    const score = penalty(m);
    if (!best || score < best.score) { best = { score, m, mask }; }
  }

  return { size, modules: best.m, version, mask: best.mask };
}

/** Draw a matrix into a canvas, with the quiet zone scanners expect. */
export function drawQR(canvas, text, opts) {
  opts = opts || {};
  const result = qrMatrix(text);
  if (!result) { return null; }
  const quiet = opts.quiet === undefined ? 4 : opts.quiet;
  const total = result.size + quiet * 2;
  const scale = Math.max(1, Math.floor((opts.pixels || 160) / total));
  const px = total * scale;

  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = opts.light || "#ffffff";
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = opts.dark || "#0a0e1a";
  for (let r = 0; r < result.size; r++) {
    for (let c = 0; c < result.size; c++) {
      if (result.modules[r][c]) {
        ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
      }
    }
  }
  return result;
}
