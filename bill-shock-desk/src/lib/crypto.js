import crypto from 'node:crypto';

// --- Encryption at rest -----------------------------------------------------
// AES-256-GCM. The stored blob is: 12-byte IV | 16-byte auth tag | ciphertext.
// GCM authenticates as well as encrypts, so a tampered blob fails to decrypt
// instead of returning garbage.

export function encrypt(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8');
  const body = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

export function decrypt(key, blob) {
  const buf = Buffer.from(blob);
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const body = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

export const decryptText = (key, blob) => decrypt(key, blob).toString('utf8');

// --- Household access tokens ------------------------------------------------
// The raw token goes to the household once. The database keeps only its hash,
// so a database leak does not hand out working links.

export const newToken = () => crypto.randomBytes(24).toString('base64url');
export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

/** Compare two strings without leaking where they differ. */
export function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
