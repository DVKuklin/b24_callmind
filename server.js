// server.js — HTTP обёртка для Cloudflare Worker (Node.js 18+)
import { createServer } from 'node:http';
import { readFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from './worker.js';
import 'dotenv/config';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const FRONT_DIR = join(__dirname, 'front');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff2':'font/woff2',
  '.woff': 'font/woff',
};

const LOG_FILE = join(__dirname, 'error.log');

function logError(method, url, status, message) {
  const line = `[${new Date().toISOString()}] ${status} ${method} ${url} — ${message}\n`;
  process.stderr.write(line);
  appendFile(LOG_FILE, line).catch(() => {});
}

const PORT = process.env.PORT || 3000;

const env = {
  OPENAI_KEY:   process.env.OPENAI_KEY   || '',
  DEEPSEEK_KEY: process.env.DEEPSEEK_KEY || '',
  HTTPS_PROXY:  process.env.HTTPS_PROXY  || '',
};

createServer(async (nodeReq, nodeRes) => {
  // Раздача статики из front/
  const pathname = new URL(nodeReq.url, 'http://localhost').pathname;
  const staticPath = join(FRONT_DIR, pathname === '/' ? 'index.html' : pathname);

  if (existsSync(staticPath)) {
    try {
      const data = await readFile(staticPath);
      const mime = MIME[extname(staticPath)] || 'application/octet-stream';
      nodeRes.writeHead(200, { 'Content-Type': mime });
      nodeRes.end(data);
      return;
    } catch (e) {
      logError(nodeReq.method, nodeReq.url, 500, e.message);
      nodeRes.writeHead(500);
      nodeRes.end('Read error');
      return;
    }
  }

  // API запросы — передаём в worker
  const url = `http://localhost:${PORT}${nodeReq.url}`;

  const headers = {};
  for (const [k, v] of Object.entries(nodeReq.headers)) {
    if (typeof v === 'string') headers[k] = v;
  }

  const chunks = [];
  for await (const chunk of nodeReq) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : null;

  const request = new Request(url, {
    method: nodeReq.method,
    headers,
    body: body?.length ? body : undefined,
  });

  let response;
  try {
    response = await worker.fetch(request, env);
  } catch (e) {
    logError(nodeReq.method, nodeReq.url, 500, e.message);
    nodeRes.writeHead(500, { 'Content-Type': 'application/json' });
    nodeRes.end(JSON.stringify({ error: e.message }));
    return;
  }

  nodeRes.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  const buf = await response.arrayBuffer();
  nodeRes.end(Buffer.from(buf));

}).listen(PORT, () => {
  console.log(`CallMind Worker running on http://0.0.0.0:${PORT}`);
});
