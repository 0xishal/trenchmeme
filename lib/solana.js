// Tanpa dependency: base58, cek ed25519 on-curve, PDA & Associated Token Account (ATA).
import crypto from 'node:crypto';

const ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MAP = Object.fromEntries([...ALPHA].map((c, i) => [c, BigInt(i)]));

export function b58decode(s) {
  let n = 0n;
  for (const c of s) {
    if (!(c in MAP)) throw new Error('base58 tidak valid');
    n = n * 58n + MAP[c];
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of s) { if (c === '1') bytes.unshift(0); else break; }
  return Uint8Array.from(bytes);
}

export function b58encode(buf) {
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) { out = ALPHA[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b === 0) out = '1' + out; else break; }
  return out;
}

const P = 2n ** 255n - 19n;
const modp = (a) => ((a % P) + P) % P;
function pow(b, e) {
  let r = 1n; b = modp(b);
  while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; }
  return r;
}
const D = modp(-121665n * pow(121666n, P - 2n));

// Apakah 32 byte ini titik valid di kurva ed25519? (PDA harus TIDAK di kurva)
export function isOnCurve(bytes) {
  const b = Uint8Array.from(bytes);
  b[31] &= 0x7f;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(b[i]);
  if (y >= P) return false;
  const y2 = (y * y) % P;
  const u = modp(y2 - 1n);
  const v = modp(D * y2 + 1n);
  const x2 = (u * pow(v, P - 2n)) % P;
  if (x2 === 0n) return true;
  return pow(x2, (P - 1n) / 2n) === 1n;
}

export function findProgramAddress(seeds, programId) {
  const prog = b58decode(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const h = crypto.createHash('sha256');
    for (const s of seeds) h.update(s);
    h.update(Uint8Array.of(bump));
    h.update(prog);
    h.update(Buffer.from('ProgramDerivedAddress'));
    const out = h.digest();
    if (!isOnCurve(out)) return b58encode(out);
  }
  throw new Error('PDA tidak ditemukan');
}

const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export function ata(owner, mint, tokenProgram) {
  return findProgramAddress([b58decode(owner), b58decode(tokenProgram), b58decode(mint)], ATA_PROGRAM);
}
