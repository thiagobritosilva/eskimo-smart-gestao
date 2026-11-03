import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { hash, verify, Algorithm } from '@node-rs/argon2';
import { env } from '../config/env.js';

// ---------- Senhas (Argon2id, parâmetros OWASP) ----------
const ARGON_OPTS = { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON_OPTS);
}

export async function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashed, plain);
  } catch {
    return false;
  }
}

/** Hash fictício para equalizar o tempo de resposta quando o usuário não existe. */
let dummyHash: Promise<string> | undefined;
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  return dummyHash;
}

// ---------- Tokens de sessão ----------
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

// ---------- Cifragem de segredos (AES-256-GCM) ----------
// Formato: v1.<iv b64url>.<tag b64url>.<ciphertext b64url>
export function encryptSecret(plain: string): string {
  const key = Buffer.from(env().APP_ENCRYPTION_KEY, 'base64');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptSecret(payload: string): string {
  const [version, iv, tag, ct] = payload.split('.');
  if (version !== 'v1' || !iv || !tag || !ct) throw new Error('Formato de segredo cifrado inválido.');
  const key = Buffer.from(env().APP_ENCRYPTION_KEY, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}
