/**
 * Environment loader.
 *
 * Imported for its side effect as the very first import of each entrypoint, so
 * `process.env` is populated from `.env` before any other module reads it.
 *
 * `quiet: true` suppresses dotenv v17's startup banner. In stdio mode that
 * banner would be written to stdout and corrupt the MCP JSON-RPC stream.
 */
import { config } from 'dotenv';

config({ quiet: true });
