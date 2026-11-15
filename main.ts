// Forge entrypoint.
//
// This file only runs the trial boot dance: start the server defined in
// app.ts, tell the trial environment which port the kernel gave the
// server, and then wait until the environment reports that its suite
// has finished, before shutting the server down and leaving with a
// zero status.
//
// The forge itself — git, REST, GraphQL, MCP — lives in app.ts and in
// lib/; nothing here knows about repositories, issues, or packs.

import { createApp } from './app.ts';

const REGISTER_SUFFIX = '/register';
const DONE_SUFFIX = '/done';
const POLL_GAP_MS = 1000;
const CALL_BUDGET_MS = 5000;
const REGISTER_WINDOW_MS = 30000;
const REGISTER_GAP_MS = 250;
const LOST_LIMIT = 5;
const SHUTDOWN_GRACE_MS = 2000;

function pause(milliseconds: number): Promise<void> {
  return new Promise<void>((fulfil) => {
    setTimeout(fulfil, milliseconds);
  });
}

function readEnvRoot(): string {
  const root = process.env.MAKEFUN_ENV_URL;
  if (root === undefined || root.trim() === '') {
    throw new Error('MAKEFUN_ENV_URL is not set, so the trial environment cannot be reached');
  }
  return root.replace(/\/+$/, '');
}

async function parseJsonText(text: string): Promise<unknown> {
  return Promise.resolve()
    .then((): unknown => JSON.parse(text) as unknown)
    .catch((): undefined => undefined);
}

async function readJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim() === '') return undefined;
  return parseJsonText(text);
}

function fieldOf(payload: unknown, name: string): unknown {
  if (payload === null || typeof payload !== 'object') return undefined;
  return (payload as Record<string, unknown>)[name];
}

type ForgeServer = ReturnType<typeof createApp>;

async function bindForge(): Promise<{ server: ForgeServer; port: number }> {
  const server = createApp();
  await new Promise<void>((fulfil, reject) => {
    server.once('error', reject);
    server.listen({ port: 0, host: '0.0.0.0' }, () => {
      server.removeListener('error', reject);
      fulfil();
    });
  });
  const listening = server.address();
  if (listening === null || typeof listening === 'string') {
    server.close(() => undefined);
    throw new Error('the forge listener came up without a TCP port');
  }
  return { server, port: listening.port };
}

async function announce(envRoot: string, port: number): Promise<void> {
  const target = `${envRoot}${REGISTER_SUFFIX}`;
  const startedAt = Date.now();
  for (;;) {
    let response: Response;
    try {
      response = await fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(CALL_BUDGET_MS),
      });
    } catch (error) {
      if (Date.now() - startedAt > REGISTER_WINDOW_MS) {
        throw new Error(`could not reach the environment to register: ${error instanceof Error ? error.message : String(error)}`);
      }
      await pause(REGISTER_GAP_MS);
      continue;
    }
    if (response.status === 409) {
      throw new Error('the environment already has an entry registered');
    }
    if (response.ok && fieldOf(await readJsonBody(response), 'ok') === true) {
      return;
    }
    if (Date.now() - startedAt > REGISTER_WINDOW_MS) {
      throw new Error(`the environment refused the register call with HTTP ${response.status}`);
    }
    await pause(REGISTER_GAP_MS);
  }
}

async function waitUntilDone(envRoot: string): Promise<void> {
  const target = `${envRoot}${DONE_SUFFIX}`;
  let lost = 0;
  let seen = false;
  for (;;) {
    let response: Response;
    try {
      response = await fetch(target, { signal: AbortSignal.timeout(CALL_BUDGET_MS) });
    } catch {
      lost += 1;
      if (seen && lost >= LOST_LIMIT) return;
      await pause(POLL_GAP_MS);
      continue;
    }
    if (!response.ok) {
      lost += 1;
      if (seen && lost >= LOST_LIMIT) return;
      await pause(POLL_GAP_MS);
      continue;
    }
    lost = 0;
    seen = true;
    if (fieldOf(await readJsonBody(response), 'done') === true) {
      return;
    }
    await pause(POLL_GAP_MS);
  }
}

function closeForge(server: ForgeServer): Promise<void> {
  return new Promise<void>((fulfil) => {
    const timer = setTimeout(() => fulfil(), SHUTDOWN_GRACE_MS);
    server.close(() => {
      clearTimeout(timer);
      fulfil();
    });
  });
}

async function runForge(): Promise<number> {
  let envRoot: string;
  try {
    envRoot = readEnvRoot();
  } catch (error) {
    process.stderr.write(`forge: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const { server, port } = await bindForge();
  try {
    await announce(envRoot, port);
    await waitUntilDone(envRoot);
  } catch (error) {
    process.stderr.write(`forge: ${error instanceof Error ? error.message : String(error)}\n`);
    await closeForge(server);
    return 1;
  }
  await closeForge(server);
  return 0;
}

const exitCode = await runForge();
process.exitCode = exitCode;
