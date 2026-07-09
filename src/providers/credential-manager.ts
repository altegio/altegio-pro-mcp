/**
 * Secure credential storage manager
 */

import { promises as fs, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import crypto from 'crypto';
import type { AltegioCredentials } from '../types/altegio.types.js';
import { createLogger } from '../utils/logger.js';
import type { Logger } from 'pino';

export class CredentialManager {
  private readonly logger: Logger;
  private readonly credentialsDir: string;
  private readonly credentialsFile: string;
  private readonly encryptionKey?: string;

  constructor(customDir?: string, encryptionKey?: string) {
    this.logger = createLogger('credential-manager');
    this.credentialsDir = customDir || join(homedir(), '.altegio-mcp');
    this.credentialsFile = join(this.credentialsDir, 'credentials.json');
    this.encryptionKey =
      encryptionKey || process.env.CREDENTIALS_ENCRYPTION_KEY;
  }

  /**
   * Ensure credentials directory exists with proper permissions
   */
  private async ensureDirectory(): Promise<void> {
    try {
      await fs.mkdir(this.credentialsDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      this.logger.error({ error }, 'Failed to create credentials directory');
      throw error;
    }
  }

  /**
   * Encrypt data if encryption key is available
   */
  private encrypt(data: string): string {
    if (!this.encryptionKey) {
      return data;
    }

    const iv = crypto.randomBytes(16);
    const key = crypto.scryptSync(this.encryptionKey, 'salt', 32);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    let encrypted = cipher.update(data, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    return JSON.stringify({
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex'),
      encrypted,
    });
  }

  /**
   * Decrypt data if encryption key is available
   */
  private decrypt(encryptedData: string): string {
    if (!this.encryptionKey) {
      return encryptedData;
    }

    try {
      const { iv, authTag, encrypted } = JSON.parse(encryptedData);
      const key = crypto.scryptSync(this.encryptionKey, 'salt', 32);
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(iv, 'hex')
      );

      decipher.setAuthTag(Buffer.from(authTag, 'hex'));

      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    } catch (error) {
      this.logger.error({ error }, 'Failed to decrypt credentials');
      throw new Error('Invalid credentials or encryption key');
    }
  }

  /**
   * Resolve the file path for a given identity.
   *
   * When an `identityKey` is provided the token is stored in a per-identity
   * file (`credentials-<identityKey>.json`) so that concurrent delegated
   * callers never share a token. Without a key the legacy single-user file
   * (`credentials.json`) is used, preserving stdio behavior.
   */
  private fileFor(identityKey?: string): string {
    if (identityKey) {
      return join(this.credentialsDir, `credentials-${identityKey}.json`);
    }
    return this.credentialsFile;
  }

  /**
   * Save credentials to file (scoped to `identityKey` when provided)
   */
  public async save(
    credentials: AltegioCredentials,
    identityKey?: string
  ): Promise<void> {
    await this.ensureDirectory();

    try {
      const data = JSON.stringify(credentials, null, 2);
      const finalData = this.encrypt(data);

      await fs.writeFile(this.fileFor(identityKey), finalData, {
        mode: 0o600,
        encoding: 'utf8',
      });

      this.logger.info('Credentials saved successfully');
    } catch (error) {
      this.logger.error({ error }, 'Failed to save credentials');
      throw error;
    }
  }

  /**
   * Load credentials from file (scoped to `identityKey` when provided)
   */
  public load(identityKey?: string): AltegioCredentials | null {
    try {
      const data = readFileSync(this.fileFor(identityKey), 'utf8');
      const decryptedData = this.decrypt(data);
      const credentials = JSON.parse(decryptedData) as AltegioCredentials;

      this.logger.debug('Credentials loaded successfully');
      return credentials;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.logger.debug('No saved credentials found');
        return null;
      }

      this.logger.error({ error }, 'Failed to load credentials');
      return null;
    }
  }

  /**
   * Load credentials async (scoped to `identityKey` when provided)
   */
  public async loadAsync(
    identityKey?: string
  ): Promise<AltegioCredentials | null> {
    try {
      const data = await fs.readFile(this.fileFor(identityKey), 'utf8');
      const decryptedData = this.decrypt(data);
      const credentials = JSON.parse(decryptedData) as AltegioCredentials;

      this.logger.debug('Credentials loaded successfully');
      return credentials;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.logger.debug('No saved credentials found');
        return null;
      }

      this.logger.error({ error }, 'Failed to load credentials');
      return null;
    }
  }

  /**
   * Clear saved credentials (scoped to `identityKey` when provided)
   */
  public async clear(identityKey?: string): Promise<void> {
    try {
      await fs.unlink(this.fileFor(identityKey));
      this.logger.info('Credentials cleared successfully');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.error({ error }, 'Failed to clear credentials');
        throw error;
      }
    }
  }

  /**
   * Check if credentials exist (scoped to `identityKey` when provided)
   */
  public async exists(identityKey?: string): Promise<boolean> {
    try {
      await fs.access(this.fileFor(identityKey));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get credentials file path (scoped to `identityKey` when provided)
   */
  public getFilePath(identityKey?: string): string {
    return this.fileFor(identityKey);
  }
}
