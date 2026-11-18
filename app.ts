// app: single node:http server. Routes:
//   GET  /healthz                       -> {"ok":true}
//   /api/v3/*                           -> REST v3 (Bearer auth)
//   POST /api/graphql                  -> GraphQL (Bearer auth)
//   /mcp                               -> MCP JSON-RPC (Bearer auth on POST; DELETE -> 204)
//   /{owner}/{repo}.git/*              -> git smart HTTP (no auth; real git sends none)
//   anything else                      -> 404 JSON {"message":"Not Found"}
// Every JSON reply carries a non-empty X-GitHub-Request-Id.
//
// Hot-path notes (the four timed workloads run thousands of requests
// through here, so dispatch is kept allocation-light on purpose):
//   - the request target is split by hand instead of `new URL(...)`
//     (no URL object, no query parse for routes that need none);
//   - the expected Authorization value is built once per server;
//   - bodies are read with a single-chunk fast path (the common case);
//   - segment lists are built by one manual pass, no split+filter.

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

/** Split a request target into its path part and its query part (no `?` → ''). */
function splitTarget(rawUrl: string): { pathname: string; search: string } {
  const q = rawUrl.indexOf('?');
  if (q < 0) return { pathname: rawUrl === '' ? '/' : rawUrl, search: '' };
  return { pathname: q === 0 ? '/' : rawUrl.slice(0, q), search: rawUrl.slice(q + 1) };
}

/** Path segments: '/a/b/c' → ['a', 'b', 'c']; empty parts dropped, one pass. */
function pathSegments(pathname: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i <= pathname.length; i += 1) {
    if (i === pathname.length || pathname.charCodeAt(i) === 47) {
      if (i > start) out.push(pathname.slice(start, i));
      start = i + 1;
    }
  }
  return out;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let first: Buffer | null = null;
    let chunks: Buffer[] | null = null;
    let total = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      if (first === null) first = chunk;
      else {
        if (chunks === null) chunks = [first];
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      if (tooLarge) reject(new Error('body too large'));
      else if (first === null) resolve(Buffer.alloc(0));
      else if (chunks === null) resolve(first);
      else resolve(Buffer.concat(chunks, total));
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
  // The bearer token never changes during a trial, so the expected header
  // is built once instead of per request.
  const shopToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const expectedAuth = shopToken === '' ? '' : `Bearer ${shopToken}`;
  const isAuthorized = (req: IncomingMessage): boolean => {
    if (expectedAuth === '') return true;
    return (req.headers.authorization ?? '') === expectedAuth;
  };

  return createServer((req, res) => {
    void (async () => {
      try {
        const { pathname, search } = splitTarget(req.url ?? '/');
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
          const segments = pathSegments(pathname).slice(2);
          const restReq: RestRequest = {
            method,
            segments,
            query: new URLSearchParams(search),
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
            query: new URLSearchParams(search),
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
