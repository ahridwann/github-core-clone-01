// mcp: JSON-RPC 2.0 Streamable HTTP at POST /mcp.
// Modern era (server/discover, supportedVersions) and the legacy
// handshake (initialize + notifications/initialized) are both served.
// Tools act on the same in-memory store as REST and GraphQL.
// Auth is checked by app.ts before this handler runs.

import { VIEWER_LOGIN } from './scenario.ts';
import { nextSeq, prMergeable, squashMerge, store, trialNowIso } from './store.ts';
import type { Issue, PullRequest, Repo } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

export interface McpRequest {
  raw: string;
  json: unknown;
  jsonError: boolean;
  method: string;
}

export interface McpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const SERVER_NAME = 'github-core-forge';
const SERVER_VERSION = '1.0.0';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] };
}

// Precomputed once so two tools/list calls are byte-identical.
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the given owner (defaults to the authenticated user).',
    inputSchema: { type: 'object', properties: {
      name: { type: 'string', description: 'Repository name' },
      description: { type: 'string', description: 'Repository description' },
      private: { type: 'boolean', description: 'Whether the repository is private' },
      owner: { type: 'string', description: 'Owner login (defaults to the authenticated user)' },
      full_name: { type: 'string', description: 'owner/repo, alternative to owner + name' },
    }, required: ['name'] },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: { type: 'object', properties: {
      owner: { type: 'string', description: 'Owner login' },
      repo: { type: 'string', description: 'Repository name' },
      full_name: { type: 'string', description: 'owner/repo, alternative to owner + repo' },
    }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: { type: 'object', properties: {
      owner: { type: 'string', description: 'Owner login' },
      repo: { type: 'string', description: 'Repository name' },
      title: { type: 'string', description: 'Issue title' },
      body: { type: 'string', description: 'Issue body' },
      labels: { type: 'string', description: 'Comma-separated label names' },
    }, required: ['owner', 'repo', 'title'] },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: { type: 'object', properties: {
      owner: { type: 'string', description: 'Owner login' },
      repo: { type: 'string', description: 'Repository name' },
      state: { type: 'string', description: 'open, closed, or all (default open)' },
    }, required: ['owner', 'repo'] },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: { type: 'object', properties: {
      owner: { type: 'string', description: 'Owner login' },
      repo: { type: 'string', description: 'Repository name' },
      issue_number: { type: 'string', description: 'Issue number' },
    }, required: ['owner', 'repo', 'issue_number'] },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: { type: 'object', properties: {
      owner: { type: 'string', description: 'Owner login' },
      repo: { type: 'string', description: 'Repository name' },
      title: { type: 'string', description: 'Pull request title' },
      body: { type: 'string', description: 'Pull request body' },
      head: { type: 'string', description: 'Head branch name' },
      base: { type: 'string', description: 'Base branch name' },
    }, required: ['owner', 'repo', 'title', 'head', 'base'] },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: { type: 'object', properties: {
      owner: { type: 'string', description: 'Owner login' },
      repo: { type: 'string', description: 'Repository name' },
      state: { type: 'string', description: 'open, closed, or all (default open)' },
    }, required: ['owner', 'repo'] },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: { type: 'object', properties: {
      owner: { type: 'string', description: 'Owner login' },
      repo: { type: 'string', description: 'Repository name' },
      pull_number: { type: 'string', description: 'Pull request number' },
      number: { type: 'string', description: 'Alias for pull_number' },
    }, required: ['owner', 'repo', 'pull_number'] },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonRpc(id: unknown, result: unknown): McpResponse {
  return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, result }) };
}

function jsonRpcError(id: unknown, code: number, message: string, status = 200): McpResponse {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) };
}

function toolResult(value: unknown, isError = false): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value, isError };
}

function toolError(message: string): Record<string, unknown> {
  return toolResult({ error: message }, true);
}

function resolveOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((owner === '' || repo === '') && typeof args.full_name === 'string') {
    const slash = args.full_name.indexOf('/');
    if (slash > 0) {
      if (owner === '') owner = args.full_name.slice(0, slash);
      if (repo === '') repo = args.full_name.slice(slash + 1);
    }
  }
  if (owner === '') owner = VIEWER_LOGIN;
  return { owner, repo };
}

function requireArgs(args: Record<string, unknown>, names: string[]): string | null {
  for (const name of names) {
    const value = args[name];
    if (value === undefined || value === null || value === '') return name;
  }
  return null;
}

function getRepoOrError(owner: string, repoName: string): Repo | Record<string, unknown> {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
  return repo;
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const missing = requireArgs(args, ['name']);
      if (missing) return toolError(`Missing required argument: ${missing}`);
      const repoName = String(args.name);
      let owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : VIEWER_LOGIN;
      if (owner === VIEWER_LOGIN && typeof args.full_name === 'string') {
        const slash = args.full_name.indexOf('/');
        if (slash > 0) owner = args.full_name.slice(0, slash);
      }
      if (store.getRepo(owner, repoName)) return toolError(`Repository ${owner}/${repoName} already exists`);
      const repo = store.createRepo(owner, repoName, {
        description: typeof args.description === 'string' ? args.description : '',
        private: args.private === true,
      });
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      const { owner, repo } = resolveOwnerRepo(args);
      const missing = requireArgs({ owner, repo }, ['owner', 'repo']);
      if (missing) return toolError(`Missing required argument: ${missing}`);
      const found = getRepoOrError(owner, repo);
      if (!isRecord(found) || !('databaseId' in found)) return found as Record<string, unknown>;
      return toolResult(repoJson(found as Repo));
    }
    case 'create_issue': {
      const { owner, repo } = resolveOwnerRepo(args);
      const missing = requireArgs({ ...args, owner, repo }, ['owner', 'repo', 'title']);
      if (missing) return toolError(`Missing required argument: ${missing}`);
      const found = getRepoOrError(owner, repo);
      if (!isRecord(found) || !('databaseId' in found)) return found as Record<string, unknown>;
      const target = found as Repo;
      const labelNames: string[] = [];
      if (typeof args.labels === 'string' && args.labels !== '') {
        labelNames.push(...args.labels.split(',').map((part) => part.trim()).filter((part) => part !== ''));
      } else if (Array.isArray(args.labels)) {
        for (const entry of args.labels) if (typeof entry === 'string') labelNames.push(entry);
      }
      for (const labelName of labelNames) {
        if (!target.labels.has(labelName)) return toolError(`Label "${labelName}" does not exist`);
      }
      target.issueCounter += 1;
      store.issueIdCounter += 1;
      const now = trialNowIso();
      const issue: Issue = {
        id: store.issueIdCounter,
        globalId: Buffer.from(`Issue:${target.databaseId}:${target.issueCounter}`).toString('base64url'),
        number: target.issueCounter,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: labelNames.map((labelName) => target.labels.get(labelName) as Issue['labels'][number]),
        createdSeq: nextSeq(),
        createdAt: now,
        updatedAt: now,
        closedAt: null,
      };
      target.issues.push(issue);
      return toolResult({ ...issueJson(target, issue), number: issue.number });
    }
    case 'list_issues': {
      const { owner, repo } = resolveOwnerRepo(args);
      const missing = requireArgs({ owner, repo }, ['owner', 'repo']);
      if (missing) return toolError(`Missing required argument: ${missing}`);
      const found = getRepoOrError(owner, repo);
      if (!isRecord(found) || !('databaseId' in found)) return found as Record<string, unknown>;
      const target = found as Repo;
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = target.issues.slice();
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      return toolResult({ issues: list.map((issue) => issueJson(target, issue)) });
    }
    case 'get_issue': {
      const { owner, repo } = resolveOwnerRepo(args);
      const number = Number(args.issue_number ?? args.number ?? '');
      const missing = requireArgs({ owner, repo }, ['owner', 'repo']);
      if (missing) return toolError(`Missing required argument: ${missing}`);
      if (!Number.isInteger(number)) return toolError('Missing required argument: issue_number');
      const found = getRepoOrError(owner, repo);
      if (!isRecord(found) || !('databaseId' in found)) return found as Record<string, unknown>;
      const target = found as Repo;
      const issue = target.issues.find((candidate) => candidate.number === number);
      if (!issue) return toolError(`Issue #${number} not found`);
      return toolResult(issueJson(target, issue));
    }
    case 'create_pull_request': {
      const { owner, repo } = resolveOwnerRepo(args);
      const missing = requireArgs({ ...args, owner, repo }, ['owner', 'repo', 'title', 'head', 'base']);
      if (missing) return toolError(`Missing required argument: ${missing}`);
      const found = getRepoOrError(owner, repo);
      if (!isRecord(found) || !('databaseId' in found)) return found as Record<string, unknown>;
      const target = found as Repo;
      const head = String(args.head);
      const base = String(args.base);
      const headSha = target.refs.get(`refs/heads/${head}`);
      const baseSha = target.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) return toolError('head or base branch does not exist');
      const existing = target.prs.find((pr) => pr.state === 'open' && pr.headRef === head && pr.baseRef === base);
      if (existing) return toolError('A pull request already exists for this head and base');
      target.prCounter += 1;
      store.prIdCounter += 1;
      const now = trialNowIso();
      const pr: PullRequest = {
        id: store.prIdCounter,
        globalId: Buffer.from(`PullRequest:${target.databaseId}:${target.prCounter}`).toString('base64url'),
        number: target.prCounter,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        mergeBaseSha: baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        createdSeq: nextSeq(),
        createdAt: now,
        updatedAt: now,
        closedAt: null,
      };
      target.prs.push(pr);
      return toolResult({ ...pullJson(target, pr), pull_number: pr.number });
    }
    case 'list_pull_requests': {
      const { owner, repo } = resolveOwnerRepo(args);
      const missing = requireArgs({ owner, repo }, ['owner', 'repo']);
      if (missing) return toolError(`Missing required argument: ${missing}`);
      const found = getRepoOrError(owner, repo);
      if (!isRecord(found) || !('databaseId' in found)) return found as Record<string, unknown>;
      const target = found as Repo;
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = target.prs.slice();
      if (state === 'open') list = list.filter((pr) => pr.state === 'open');
      else if (state === 'closed') list = list.filter((pr) => pr.state === 'closed');
      return toolResult({ pull_requests: list.map((pr) => ({ ...pullJson(target, pr), pull_number: pr.number })) });
    }
    case 'merge_pull_request': {
      const { owner, repo } = resolveOwnerRepo(args);
      const number = Number(args.pull_number ?? args.number ?? '');
      const missing = requireArgs({ owner, repo }, ['owner', 'repo']);
      if (missing) return toolError(`Missing required argument: ${missing}`);
      if (!Number.isInteger(number)) return toolError('Missing required argument: pull_number');
      const found = getRepoOrError(owner, repo);
      if (!isRecord(found) || !('databaseId' in found)) return found as Record<string, unknown>;
      const target = found as Repo;
      const pr = target.prs.find((candidate) => candidate.number === number);
      if (!pr) return toolError(`Pull request #${number} not found`);
      if (pr.merged || pr.state !== 'open') return toolError('Pull request is already closed');
      if (prMergeable(target, pr) !== 'MERGEABLE') return toolError('Merge conflict');
      const mergeSha = squashMerge(target, pr);
      if (mergeSha === null) return toolError('Merge conflict');
      pr.merged = true;
      pr.state = 'closed';
      pr.mergedAt = trialNowIso();
      pr.mergeCommitSha = mergeSha;
      pr.closedAt = pr.mergedAt;
      pr.updatedAt = trialNowIso();
      return toolResult({ merged: true, sha: mergeSha, number: pr.number, pull_number: pr.number });
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

export function handleMcp(req: McpRequest): McpResponse {
  // Parse error: non-JSON body. Try to recover the id from the raw text.
  if (req.jsonError) {
    const match = /"id"\s*:\s*("[^"]*"|-?\d+|null)/.exec(req.raw);
    let id: unknown = null;
    if (match) {
      const raw = match[1] as string;
      if (raw.startsWith('"')) id = raw.slice(1, -1);
      else if (raw === 'null') id = null;
      else id = Number(raw);
    }
    return jsonRpcError(id, -32700, 'Parse error', 400);
  }

  const body = req.json;
  if (!isRecord(body) || typeof body.method !== 'string') {
    return jsonRpcError(isRecord(body) ? body.id ?? null : null, -32600, 'Invalid Request');
  }

  const id = 'id' in body ? body.id : undefined;
  const isNotification = id === undefined;
  const method = body.method;
  const params = isRecord(body.params) ? body.params : {};

  // Notifications get an empty 202.
  if (isNotification) {
    return { status: 202, headers: {}, body: '' };
  }

  switch (method) {
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return jsonRpc(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'server/discover': {
      return jsonRpc(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        capabilities: { tools: {} },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      });
    }
    case 'ping': {
      return jsonRpc(id, {});
    }
    case 'tools/list': {
      return jsonRpc(id, { tools: TOOLS });
    }
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      const tool = TOOLS.find((candidate) => candidate.name === toolName);
      if (!tool) return jsonRpcError(id, -32602, `Unknown tool: ${toolName}`);
      return jsonRpc(id, callTool(toolName, args));
    }
    default: {
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
    }
  }
}
