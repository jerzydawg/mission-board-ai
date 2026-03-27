/**
 * Token Encryption/Decryption Helper
 * 
 * AES-256-GCM encryption for OAuth tokens stored in customer_connectors.
 * 
 * Security model:
 * - Tokens are encrypted before writing to DB
 * - Tokens are decrypted after reading from DB
 * - Even if DB is compromised, tokens are useless without TOKEN_ENCRYPTION_KEY
 * - Key lives ONLY in environment variables, never in code or git
 * 
 * Format: <iv_hex>:<ciphertext_hex>:<authtag_hex>
 * All components are hex-encoded for safe DB storage.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

// TOKEN_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)
const KEY_HEX = process.env.TOKEN_ENCRYPTION_KEY;

/**
 * Returns true if encryption is enabled (TOKEN_ENCRYPTION_KEY set and valid).
 */
function isEncryptionEnabled() {
  return !!(KEY_HEX && KEY_HEX.length === 64);
}

/**
 * Get the encryption key buffer. Throws if key is missing/invalid.
 */
function getKey() {
  if (!KEY_HEX) {
    throw new Error('[token-crypto] TOKEN_ENCRYPTION_KEY env var not set — cannot encrypt tokens');
  }
  if (KEY_HEX.length !== 64) {
    throw new Error(`[token-crypto] TOKEN_ENCRYPTION_KEY must be 64 hex chars (32 bytes), got ${KEY_HEX.length}`);
  }
  return Buffer.from(KEY_HEX, 'hex');
}

/**
 * Encrypt a token string using AES-256-GCM.
 * Returns encrypted string in format: <iv_hex>:<ciphertext_hex>:<authtag_hex>
 * 
 * @param {string|null|undefined} token - plaintext token
 * @returns {string|null} - encrypted string, or null if token is falsy
 */
export function encryptToken(token) {
  if (!token) return null;
  
  // If encryption not configured, log warning and return plaintext
  // This allows graceful degradation during key rotation
  if (!isEncryptionEnabled()) {
    console.warn('[token-crypto] WARNING: TOKEN_ENCRYPTION_KEY not set — storing token unencrypted');
    return token;
  }
  
  const key = getKey();
  const iv = randomBytes(12); // 96-bit IV for GCM (recommended)
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  
  const encrypted = Buffer.concat([
    cipher.update(token, 'utf8'),
    cipher.final()
  ]);
  
  const authTag = cipher.getAuthTag(); // 128-bit auth tag
  
  // Format: enc:<iv_hex>:<ciphertext_hex>:<authtag_hex>
  // "enc:" prefix distinguishes encrypted values from legacy plaintext
  return `enc:${iv.toString('hex')}:${encrypted.toString('hex')}:${authTag.toString('hex')}`;
}

/**
 * Decrypt a token string encrypted by encryptToken().
 * Handles both encrypted tokens (with "enc:" prefix) and legacy plaintext tokens.
 * 
 * @param {string|null|undefined} encrypted - encrypted token string
 * @returns {string|null} - plaintext token, or null if input is falsy
 */
export function decryptToken(encrypted) {
  if (!encrypted) return null;
  
  // Legacy plaintext token (pre-encryption migration or encryption disabled)
  if (!encrypted.startsWith('enc:')) {
    if (isEncryptionEnabled()) {
      // Log this for audit — tokens should be encrypted going forward
      console.warn('[token-crypto] Reading legacy unencrypted token — will be encrypted on next write');
    }
    return encrypted;
  }
  
  if (!isEncryptionEnabled()) {
    throw new Error('[token-crypto] Cannot decrypt token: TOKEN_ENCRYPTION_KEY not set');
  }
  
  const key = getKey();
  
  // Parse: enc:<iv_hex>:<ciphertext_hex>:<authtag_hex>
  const parts = encrypted.split(':');
  if (parts.length !== 4 || parts[0] !== 'enc') {
    throw new Error('[token-crypto] Invalid encrypted token format');
  }
  
  const [, ivHex, ciphertextHex, authTagHex] = parts;
  
  const iv = Buffer.from(ivHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ]);
  
  return decrypted.toString('utf8');
}

/**
 * Check if a stored token value is encrypted.
 * @param {string|null|undefined} value
 * @returns {boolean}
 */
export function isEncrypted(value) {
  return !!(value && value.startsWith('enc:'));
}

/**
 * Safely decrypt a connector's tokens.
 * Returns object with decrypted access_token and refresh_token.
 * Logs audit entry for token access.
 * 
 * @param {Object} connector - connector row from customer_connectors
 * @param {string} workerName - name of worker accessing tokens (for audit log)
 * @returns {{accessToken: string|null, refreshToken: string|null}}
 */
export function decryptConnectorTokens(connector, workerName = 'unknown') {
  // Audit log — NO token values, only metadata
  console.log(`[token-crypto] [AUDIT] ${workerName} accessed tokens for connector ${connector.id} (customer ${connector.customer_id}, type: ${connector.connector_type}) at ${new Date().toISOString()}`);
  
  let accessToken = null;
  let refreshToken = null;
  
  try {
    accessToken = decryptToken(connector.access_token);
  } catch (e) {
    console.error(`[token-crypto] Failed to decrypt access_token for connector ${connector.id}: ${e.message}`);
  }
  
  try {
    refreshToken = decryptToken(connector.refresh_token);
  } catch (e) {
    console.error(`[token-crypto] Failed to decrypt refresh_token for connector ${connector.id}: ${e.message}`);
  }
  
  return { accessToken, refreshToken };
}
