import crypto from 'crypto';

function getEncryptionKey(): Buffer {
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret) {
    throw new Error('FATAL: ENCRYPTION_KEY environment variable is not set. It must be a 32-byte string.');
  }
  let keyBuffer = Buffer.from(secret, 'hex');
  if (keyBuffer.length !== 32) {
    keyBuffer = crypto.createHash('sha256').update(secret).digest();
  }
  return keyBuffer;
}

export function encryptSecretKey(text: string, publicKey: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${encrypted}:${authTag}`;
}

export function decryptSecretKey(encryptedText: string, publicKey: string): string {
  if (!encryptedText.includes(':')) {
    return encryptedText;
  }

  const parts = encryptedText.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted format');
  
  const iv = Buffer.from(parts[0], 'hex');
  let authTag = Buffer.from(parts[1], 'hex');
  let encrypted = parts[2];
  
  if (authTag.length !== 16) {
    const possibleAuthTag = Buffer.from(parts[2], 'hex');
    if (possibleAuthTag.length === 16) {
      encrypted = parts[1];
      authTag = possibleAuthTag;
    }
  }

  const secret = process.env.ENCRYPTION_KEY;
  if (!secret) throw new Error('ENCRYPTION_KEY missing');

  let key1 = Buffer.from(secret, 'hex');
  if (key1.length !== 32) {
    key1 = crypto.createHash('sha256').update(secret).digest();
  }
  
  const key2 = crypto.createHash('sha256').update(secret).digest();

  const keysToTry = [key1, key2];
  const aadsToTry = [null, Buffer.from(publicKey, 'utf8')];

  for (const key of keysToTry) {
    for (const aad of aadsToTry) {
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        if (aad) {
          decipher.setAAD(aad);
        }
        decipher.setAuthTag(authTag);
        
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
      } catch (e) {
        // Try next combination
      }
    }
  }

  throw new Error('Could not decrypt wallet');
}
