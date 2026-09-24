import { randomBytes, createHash, createHmac, createCipheriv, createDecipheriv, pbkdf2, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../../gateway/config.js';
const derive = promisify(pbkdf2);
export function digest(value: string) { return createHash('sha256').update(value).digest('hex'); }
export function secretToken() { return randomBytes(32).toString('base64url'); }
export function protect(value: string) {
  const key = Buffer.from(config.LUMINA_ENCRYPTION_KEY, 'hex'), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return 'lumina:v1:' + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
}
export function reveal(value: string) {
  if (!value) return '';
  if (!value.startsWith('lumina:v1:')) throw new Error('Identidade não cifrada no formato LUMINA.');
  const data = Buffer.from(value.slice(10), 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(config.LUMINA_ENCRYPTION_KEY, 'hex'), data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
}
export function emailLookup(email: string) { return createHmac('sha256', Buffer.from(config.LUMINA_ENCRYPTION_KEY, 'hex')).update(email.trim().toLowerCase()).digest('hex'); }
export function passwordPolicy(value: string) {
  if (value.length < 8 || value.length > 256 || !/[A-Z]/.test(value) || !/[a-z]/.test(value) || !/[0-9]/.test(value) || !/[^a-zA-Z0-9]/.test(value)) throw new Error('Use de 8 a 256 caracteres, com maiúscula, minúscula, número e caractere especial.');
}
export async function hashPassword(password: string) {
  passwordPolicy(password);
  const salt = randomBytes(16), iterations = 600000;
  const hash = await derive(password, salt, iterations, 32, 'sha256');
  return ['pbkdf2_sha256', iterations, salt.toString('hex'), hash.toString('hex')].join('$');
}
const dummy = 'pbkdf2_sha256$600000$' + '00'.repeat(16) + '$' + '00'.repeat(32);
export async function matchesPassword(password: string, encoded = dummy) {
  const [algorithm, count, salt, hash] = encoded.split('$');
  if (algorithm !== 'pbkdf2_sha256' || !/^\d+$/.test(count) || Number(count) < 100000 || Number(count) > 2000000 || !/^[a-f0-9]{32}$/i.test(salt) || !/^[a-f0-9]{64}$/i.test(hash)) return false;
  const actual = await derive(password, Buffer.from(salt, 'hex'), Number(count), 32, 'sha256');
  return timingSafeEqual(actual, Buffer.from(hash, 'hex'));
}
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function totpSecret() {
  const bytes = randomBytes(20); let bits = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  return bits.match(/.{5}/g)!.map(b => alphabet[parseInt(b, 2)]).join('');
}
export function totpCode(secret: string, step = Math.floor(Date.now() / 30000)) {
  const normalized = secret.toUpperCase().replace(/=+$/, '');
  if (!/^[A-Z2-7]+$/.test(normalized)) throw new Error('Segredo TOTP inválido.');
  const bits = [...normalized].map(c => alphabet.indexOf(c).toString(2).padStart(5, '0')).join('');
  const key = Buffer.from(bits.match(/.{8}/g)!.map(b => parseInt(b, 2)));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(step));
  const hash = createHmac('sha1', key).update(counter).digest(), offset = hash[19] & 15;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}
export function verifyTotp(secret: string, code: string, lastStep = -1): number | undefined {
  if (!/^\d{6}$/.test(code)) return;
  const now = Math.floor(Date.now() / 30000);
  for (const step of [now, now - 1, now + 1]) {
    if (step > lastStep && timingSafeEqual(Buffer.from(totpCode(secret, step)), Buffer.from(code))) return step;
  }
}
