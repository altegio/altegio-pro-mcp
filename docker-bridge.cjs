#!/usr/bin/env node

/**
 * MCP stdio-to-HTTP bridge for Docker containers
 *
 * This script acts as a bridge between Claude Desktop (stdio transport)
 * and the Altegio MCP server running in Docker (HTTP transport).
 *
 * Usage:
 *   node docker-bridge.js [http://localhost:8080]
 */

const readline = require('readline');
const http = require('http');
const https = require('https');

const DOCKER_URL = process.argv[2] || process.env.MCP_DOCKER_URL || 'http://localhost:8080';
const DEBUG = process.env.DEBUG === 'true';

function log(...args) {
  if (DEBUG) {
    console.error('[bridge]', ...args);
  }
}

function parseUrl(urlString) {
  const url = new URL(urlString);
  return {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: '/rpc'
  };
}

function sendHttpRequest(data) {
  return new Promise((resolve, reject) => {
    const url = parseUrl(DOCKER_URL);
    const client = url.protocol === 'https:' ? https : http;

    const postData = JSON.stringify(data);

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    log('Sending HTTP request:', options);
    log('Request data:', data);

    const req = client.request(options, (res) => {
      let responseData = '';

      res.on('data', (chunk) => {
        responseData += chunk;
      });

      res.on('end', () => {
        try {
          const parsed = JSON.parse(responseData);
          log('HTTP response:', parsed);
          resolve(parsed);
        } catch (error) {
          log('Parse error:', error);
          reject(new Error(`Failed to parse response: ${error.message}`));
        }
      });
    });

    req.on('error', (error) => {
      log('HTTP error:', error);
      reject(error);
    });

    req.write(postData);
    req.end();
  });
}

function sendResponse(response) {
  const output = JSON.stringify(response);
  log('Sending stdio response:', output);
  console.log(output);
}

async function handleRequest(request) {
  try {
    log('Received stdio request:', request);

    // Check if this is a notification (no id field)
    const isNotification = !('id' in request);

    // Forward request to Docker container
    const response = await sendHttpRequest(request);

    // Only send response if this is not a notification
    // Notifications don't expect responses
    if (!isNotification) {
      sendResponse(response);
    } else {
      log('Notification received, no response needed');
    }
  } catch (error) {
    log('Error handling request:', error);

    // Only send error response for requests (not notifications)
    if ('id' in request) {
      sendResponse({
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: -32603,
          message: `Bridge error: ${error.message}`
        }
      });
    }
  }
}

async function main() {
  log('Starting MCP stdio-to-HTTP bridge');
  log('Docker URL:', DOCKER_URL);
  log('Waiting for stdio input...');

  // Set up stdio readline interface
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  let pendingRequests = 0;

  async function handleRequestWithTracking(request) {
    pendingRequests++;
    try {
      await handleRequest(request);
    } finally {
      pendingRequests--;
      log(`Pending requests: ${pendingRequests}`);
    }
  }

  rl.on('line', async (line) => {
    if (!line.trim()) return;

    try {
      const request = JSON.parse(line);
      await handleRequestWithTracking(request);
    } catch (error) {
      log('Failed to parse request:', error);
      sendResponse({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: 'Parse error'
        }
      });
    }
  });

  rl.on('close', () => {
    log('stdin closed, waiting for pending requests...');
    // Wait for pending requests to finish
    const checkInterval = setInterval(() => {
      if (pendingRequests === 0) {
        log('All requests completed, exiting');
        clearInterval(checkInterval);
        process.exit(0);
      }
    }, 100);

    // Safety timeout
    setTimeout(() => {
      log('Timeout waiting for requests, forcing exit');
      clearInterval(checkInterval);
      process.exit(0);
    }, 30000);
  });

  process.on('SIGINT', () => {
    log('Received SIGINT, exiting');
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    log('Received SIGTERM, exiting');
    process.exit(0);
  });
}

main().catch(error => {
  log('Fatal error:', error);
  process.exit(1);
});
