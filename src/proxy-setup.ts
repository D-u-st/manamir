// Proxy setup — must be imported BEFORE discord.js
// Loads .env, patches ws and sets undici global dispatcher

import 'dotenv/config';
import { createRequire } from 'module';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ProxyAgent, setGlobalDispatcher } from 'undici';

const require = createRequire(import.meta.url);

const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;

if (proxyUrl) {
  // Set undici global dispatcher — covers discord.js REST calls
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
  console.log(`[proxy] undici global dispatcher → ${proxyUrl}`);

  const agent = new HttpsProxyAgent(proxyUrl);

  // Patch ws module to inject proxy agent into all WebSocket connections
  try {
    const OrigWebSocket = require('ws');

    function PatchedWebSocket(address: string, protocols?: any, options?: any) {
      if (typeof protocols === 'object' && !Array.isArray(protocols) && protocols !== null) {
        options = protocols;
        protocols = undefined;
      }
      if (!options) options = {};
      if (!options.agent) options.agent = agent;

      return new OrigWebSocket(address, protocols, options);
    }

    PatchedWebSocket.prototype = OrigWebSocket.prototype;

    for (const key of Object.getOwnPropertyNames(OrigWebSocket)) {
      if (key !== 'prototype' && key !== 'length' && key !== 'name') {
        // as any required: monkey-patching dynamic properties from native ws module
        try { (PatchedWebSocket as any)[key] = OrigWebSocket[key]; } catch {}
      }
    }

    PatchedWebSocket.CONNECTING = OrigWebSocket.CONNECTING;
    PatchedWebSocket.OPEN = OrigWebSocket.OPEN;
    PatchedWebSocket.CLOSING = OrigWebSocket.CLOSING;
    PatchedWebSocket.CLOSED = OrigWebSocket.CLOSED;
    PatchedWebSocket.WebSocket = PatchedWebSocket;
    PatchedWebSocket.Server = OrigWebSocket.Server;

    const mod = require.cache[require.resolve('ws')];
    if (mod) {
      mod.exports = PatchedWebSocket;
    }

    console.log(`[proxy] WebSocket patched → ${proxyUrl}`);
  } catch (err) {
    console.warn(`[proxy] Failed to patch ws:`, err);
  }
}

export {};
