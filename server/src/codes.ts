// Short, unambiguous room codes (used as the Colyseus roomId).
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const used = new Set<string>();

export function allocateCode(): string {
  for (let attempt = 0; attempt < 1000; attempt++) {
    let code = '';
    for (let i = 0; i < 5; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    if (!used.has(code)) {
      used.add(code);
      return code;
    }
  }
  throw new Error('Could not allocate a room code');
}

export function releaseCode(code: string) {
  used.delete(code);
}

export function normalizeCode(raw: string) {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}
