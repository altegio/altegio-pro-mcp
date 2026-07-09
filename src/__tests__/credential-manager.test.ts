import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { CredentialManager } from '../providers/credential-manager.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('CredentialManager', () => {
  let manager: CredentialManager;
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `altegio-test-${Date.now()}`);
    manager = new CredentialManager(testDir);
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('save and load', () => {
    it('should save and load credentials', async () => {
      const credentials = {
        user_token: 'test-token-123',
        user_id: 12345,
        updated_at: new Date().toISOString(),
      };

      await manager.save(credentials);
      const loaded = manager.load();

      expect(loaded).not.toBeNull();
      expect(loaded?.user_token).toBe('test-token-123');
      expect(loaded?.user_id).toBe(12345);
    });

    it('should return null when no credentials exist', () => {
      const loaded = manager.load();
      expect(loaded).toBeNull();
    });

    it('should load credentials async', async () => {
      const credentials = {
        user_token: 'async-token-456',
        user_id: 67890,
        updated_at: new Date().toISOString(),
      };

      await manager.save(credentials);
      const loaded = await manager.loadAsync();

      expect(loaded).not.toBeNull();
      expect(loaded?.user_token).toBe('async-token-456');
      expect(loaded?.user_id).toBe(67890);
    });
  });

  describe('clear', () => {
    it('should clear credentials', async () => {
      const credentials = {
        user_token: 'test-token',
        user_id: 123,
        updated_at: new Date().toISOString(),
      };

      await manager.save(credentials);
      await manager.clear();
      const loaded = manager.load();

      expect(loaded).toBeNull();
    });

    it('should not throw when clearing non-existent credentials', async () => {
      await expect(manager.clear()).resolves.not.toThrow();
    });
  });

  describe('exists', () => {
    it('should return true when credentials exist', async () => {
      const credentials = {
        user_token: 'test-token',
        user_id: 123,
        updated_at: new Date().toISOString(),
      };

      await manager.save(credentials);
      const exists = await manager.exists();

      expect(exists).toBe(true);
    });

    it('should return false when credentials do not exist', async () => {
      const exists = await manager.exists();
      expect(exists).toBe(false);
    });
  });

  describe('encryption', () => {
    it('should encrypt credentials when key is provided', async () => {
      const encryptionKey = 'test-encryption-key-12345678';
      const encryptedManager = new CredentialManager(testDir, encryptionKey);

      const credentials = {
        user_token: 'secret-token',
        user_id: 999,
        updated_at: new Date().toISOString(),
      };

      await encryptedManager.save(credentials);

      const fileContent = await fs.readFile(
        join(testDir, 'credentials.json'),
        'utf8'
      );

      expect(fileContent).not.toContain('secret-token');
      expect(fileContent).toContain('iv');
      expect(fileContent).toContain('authTag');
    });

    it('should decrypt credentials when key is provided', async () => {
      const encryptionKey = 'test-encryption-key-12345678';
      const encryptedManager = new CredentialManager(testDir, encryptionKey);

      const credentials = {
        user_token: 'secret-token-encrypted',
        user_id: 888,
        updated_at: new Date().toISOString(),
      };

      await encryptedManager.save(credentials);
      const loaded = encryptedManager.load();

      expect(loaded).not.toBeNull();
      expect(loaded?.user_token).toBe('secret-token-encrypted');
      expect(loaded?.user_id).toBe(888);
    });

    it('should fail to decrypt with wrong key', async () => {
      const key1 = 'test-key-1-12345678';
      const key2 = 'test-key-2-87654321';

      const manager1 = new CredentialManager(testDir, key1);
      const manager2 = new CredentialManager(testDir, key2);

      const credentials = {
        user_token: 'secret-token',
        user_id: 777,
        updated_at: new Date().toISOString(),
      };

      await manager1.save(credentials);
      const loaded = manager2.load();

      expect(loaded).toBeNull();
    });
  });

  describe('getFilePath', () => {
    it('should return credentials file path', () => {
      const path = manager.getFilePath();
      expect(path).toContain('credentials.json');
    });

    it('should return an identity-scoped path when a key is given', () => {
      const path = manager.getFilePath('abc123');
      expect(path).toContain('credentials-abc123.json');
    });
  });

  describe('identity-scoped storage', () => {
    const credA = { user_token: 'tok-A', user_id: 1, updated_at: '2026-07-09' };
    const credB = { user_token: 'tok-B', user_id: 2, updated_at: '2026-07-09' };

    it('writes two distinct files for two identity keys', async () => {
      await manager.save(credA, 'keyaaaa');
      await manager.save(credB, 'keybbbb');

      expect(manager.load('keyaaaa')?.user_token).toBe('tok-A');
      expect(manager.load('keybbbb')?.user_token).toBe('tok-B');

      const files = await fs.readdir(testDir);
      expect(files).toContain('credentials-keyaaaa.json');
      expect(files).toContain('credentials-keybbbb.json');
      // No shared legacy file is created for scoped writes.
      expect(files).not.toContain('credentials.json');
    });

    it('clear(keyA) leaves keyB intact', async () => {
      await manager.save(credA, 'keyaaaa');
      await manager.save(credB, 'keybbbb');

      await manager.clear('keyaaaa');

      expect(manager.load('keyaaaa')).toBeNull();
      expect(manager.load('keybbbb')?.user_token).toBe('tok-B');
    });

    it('keeps the legacy file and identity files independent', async () => {
      await manager.save({ user_token: 'legacy', user_id: 0, updated_at: 'x' });
      await manager.save(credA, 'keyaaaa');

      expect(manager.load()?.user_token).toBe('legacy');
      expect(manager.load('keyaaaa')?.user_token).toBe('tok-A');
    });

    it('scopes exists() per identity key', async () => {
      await manager.save(credA, 'keyaaaa');

      expect(await manager.exists('keyaaaa')).toBe(true);
      expect(await manager.exists('keybbbb')).toBe(false);
      expect(await manager.exists()).toBe(false);
    });

    it('loads a scoped credential asynchronously', async () => {
      await manager.save(credA, 'keyaaaa');
      const loaded = await manager.loadAsync('keyaaaa');
      expect(loaded?.user_token).toBe('tok-A');
    });
  });
});
