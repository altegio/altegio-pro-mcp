/**
 * Secure credential storage manager
 */
import type { AltegioCredentials } from '../types/altegio.types.js';
export declare class CredentialManager {
    private readonly logger;
    private readonly credentialsDir;
    private readonly credentialsFile;
    private readonly encryptionKey?;
    constructor(customDir?: string, encryptionKey?: string);
    /**
     * Ensure credentials directory exists with proper permissions
     */
    private ensureDirectory;
    /**
     * Encrypt data if encryption key is available
     */
    private encrypt;
    /**
     * Decrypt data if encryption key is available
     */
    private decrypt;
    /**
     * Save credentials to file
     */
    save(credentials: AltegioCredentials): Promise<void>;
    /**
     * Load credentials from file
     */
    load(): AltegioCredentials | null;
    /**
     * Load credentials async
     */
    loadAsync(): Promise<AltegioCredentials | null>;
    /**
     * Clear saved credentials
     */
    clear(): Promise<void>;
    /**
     * Check if credentials exist
     */
    exists(): Promise<boolean>;
    /**
     * Get credentials file path
     */
    getFilePath(): string;
}
//# sourceMappingURL=credential-manager.d.ts.map