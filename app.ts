// app: single node:http server. Routes:
//   GET  /healthz                       -> {"ok":true}
//   /api/v3/*                           -> REST v3 (Bearer auth)
//   POST /api/graphql                  -> GraphQL (Bearer auth)
//   /mcp                               -> MCP JSON-RPC (Bearer auth on POST; DELETE -> 204)
//   /{owner}/{repo}.git/*              -> git smart HTTP (no auth; real git sends none)
//   anything else                      -> 404 JSON {"message":"Not Found"}
// Every JSON reply carries a non-empty X-GitHub-Request-Id.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { handleGit } from './lib/git-protocol.ts';
import { handleRest } from './lib/rest.ts';
import type { RestRequest } from './lib/rest.ts';
import { handleGraphql } from './lib/graphql.ts';
import { handleMcp } from './lib/mcp.ts';

const MAX_BODY_BYTES = 32 * 1024 * 1024;

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function sendJson(res: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = value === '' ? '' : JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(body);
}

function sendRaw(res: ServerResponse, status: number, headers: Record<string, string>, body: Buffer): void {
  res.writeHead(status, { ...headers, 'content-length': body.length });
  res.end(body);
}

function isAuthorized(req: IncomingMessage): boolean {
  const token = process.env.MAKEFUN_SHOP_TOKEN;
  if (token === undefined || token === '') return true;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${token}`;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) reject(new Error('body too large'));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

interface ParsedBody {
  raw: string;
  json: unknown;
  jsonError: boolean;
}

function parseBody(raw: Buffer): ParsedBody {
  const text = raw.toString('utf8');
  if (text.trim() === '') return { raw: text, json: undefined, jsonError: false };
  try {
    return { raw: text, json: JSON.parse(text) as unknown, jsonError: false };
  } catch {
    return { raw: text, json: undefined, jsonError: true };
  }
}

export function createApp(): Server {
  return createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const pathname = url.pathname;
        const method = req.method ?? 'GET';

        if (pathname === '/healthz' && method === 'GET') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // REST v3
        if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
          if (!isAuthorized(req)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
          const parsed = parseBody(body);
          if (parsed.jsonError) {
            sendJson(res, 400, { message: 'Invalid JSON body' });
            return;
          }
          const segments = pathname.split('/').filter((part) => part !== '').slice(2);
          const restReq: RestRequest = {
            method,
            segments,
            query: url.searchParams,
            body: parsed.json,
            bodyIsJson: parsed.json !== undefined || parsed.raw.trim() === '',
            baseUrl: `http://${req.headers.host ?? 'localhost'}`,
          };
          const result = handleRest(restReq);
          const headers: Record<string, string> = { ...result.headers, 'x-github-request-id': nextRequestId() };
          sendRaw(res, result.status, headers, Buffer.from(result.body, 'utf8'));
          return;
        }

        // GraphQL
        if (pathname === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (!isAuthorized(req)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          const body = await readBody(req);
          const parsed = parseBody(body);
          if (parsed.jsonError) {
            sendJson(res, 400, { message: 'Invalid JSON body' });
            return;
          }
          const result = handleGraphql(parsed.json);
          sendRaw(res, result.status, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': nextRequestId() }, Buffer.from(result.body, 'utf8'));
          return;
        }

        // MCP
        if (pathname === '/mcp') {
          if (method === 'DELETE') {
            sendRaw(res, 204, { 'x-github-request-id': nextRequestId() }, Buffer.alloc(0));
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (!isAuthorized(req)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          const body = await readBody(req);
          const parsed = parseBody(body);
          const result = handleMcp({ raw: parsed.raw, json: parsed.json, jsonError: parsed.jsonError, method });
          const headers: Record<string, string> = { ...result.headers, 'x-github-request-id': nextRequestId() };
          if (result.status === 202) {
            sendRaw(res, 202, headers, Buffer.alloc(0));
            return;
          }
          sendRaw(res, result.status, headers, Buffer.from(result.body, 'utf8'));
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(pathname);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1] as string);
          const repoName = decodeURIComponent(gitMatch[2] as string);
          const subPath = gitMatch[3] ?? '/';
          const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
          const result = await handleGit({
            method,
            owner,
            repo: repoName,
            subPath,
            query: url.searchParams,
            headers: req.headers,
            body,
          });
          sendRaw(res, result.status, result.headers, result.body);
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (error) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: error instanceof Error ? error.message : 'Internal Server Error' });
        } else {
          res.end();
        }
      }
    })();
  });
}
