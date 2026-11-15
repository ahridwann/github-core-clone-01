// rest: GitHub REST v3 under /api/v3. Every reply is JSON with a
// non-empty X-GitHub-Request-Id; errors are {"message": string}.
// Auth is checked by app.ts before this handler runs.

import { parseCommit, parseTree } from './git-pack.ts';
import { VIEWER_LOGIN, VIEWER_USER } from './scenario.ts';
import {
  buildTreeFromMap, commitInfo, createCommit, diffTrees, isoOf, listCommits, nextSeq, prMergeable,
  putObject, resolveRef, squashMerge, store, trialNowIso, treeFileMap,
} from './store.ts';
import type { Issue, PullRequest, Repo } from './store.ts';

export interface RestResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface RestRequest {
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  bodyIsJson: boolean;
  baseUrl: string;
}

function json(status: number, value: unknown, extraHeaders: Record<string, string> = {}): RestResponse {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders }, body: JSON.stringify(value) };
}

function err(status: number, message: string): RestResponse {
  return json(status, { message });
}

function noContent(): RestResponse {
  return { status: 204, headers: { 'content-type': 'application/json; charset=utf-8' }, body: '' };
}

function opaque(kind: string, value: string): string {
  return Buffer.from(`${kind}:${value}`).toString('base64url');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bodyOf(req: RestRequest): Record<string, unknown> {
  return isRecord(req.body) ? req.body : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function pageParams(req: RestRequest): { page: number; perPage: number } {
  const page = Number.parseInt(req.query.get('page') ?? '1', 10);
  const perPage = Number.parseInt(req.query.get('per_page') ?? '30', 10);
  return {
    page: Number.isFinite(page) && page > 0 ? page : 1,
    perPage: Number.isFinite(perPage) && perPage > 0 ? Math.min(perPage, 100) : 30,
  };
}

function paginate<T>(items: T[], req: RestRequest, path: string): { page: T[]; link: string | null } {
  const { page, perPage } = pageParams(req);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const url = new URL(`${req.baseUrl}${path}`);
    url.searchParams.set('page', String(page + 1));
    url.searchParams.set('per_page', String(perPage));
    link = `<${url.toString()}>; rel="next"`;
  }
  return { page: slice, link };
}

function linkHeader(link: string | null): Record<string, string> {
  return link ? { link } : {};
}

// ---------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------

function userJson(login: string): Record<string, unknown> {
  return { login, id: login === VIEWER_LOGIN ? VIEWER_USER.id : 1000, avatar_url: '', html_url: '', type: 'User', site_admin: false };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.databaseId,
    node_id: repo.globalId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner),
    private: repo.private,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `/${repo.owner}/${repo.name}`,
    clone_url: `/${repo.owner}/${repo.name}.git`,
    git_url: `git:///${repo.owner}/${repo.name}.git`,
    ssh_url: `git@/${repo.owner}/${repo.name}.git`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    language: null,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    license: null,
    topics: [],
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issue.globalId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: userJson(VIEWER_LOGIN),
    labels: issue.labels.map((label) => ({ id: label.id, node_id: `LA_${label.id}`, url: '', name: label.name, color: label.color, description: label.description, default: false })),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function issueJsonString(repo: Repo, issue: Issue): string {
  const cached = repo.issueJsonCache.get(issue.number);
  if (cached !== undefined) return cached;
  const text = JSON.stringify(issueJson(repo, issue));
  repo.issueJsonCache.set(issue.number, text);
  return text;
}

export function pullJson(repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    id: pr.id,
    node_id: pr.globalId,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    user: userJson(VIEWER_LOGIN),
    head: { label: `${repo.owner}:${pr.headRef}`, ref: pr.headRef, sha: pr.headSha, user: userJson(repo.owner), repo: repoJson(repo) },
    base: { label: `${repo.owner}:${pr.baseRef}`, ref: pr.baseRef, sha: pr.baseSha, user: userJson(repo.owner), repo: repoJson(repo) },
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    mergeable: prMergeable(repo, pr) === 'MERGEABLE',
    draft: false,
    locked: false,
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.closedAt,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
    html_url: `/${repo.owner}/${repo.name}/pull/${pr.number}`,
  };
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const obj = repo.objects.get(sha);
  if (!obj || obj.type !== 'commit') return null;
  let view;
  try {
    view = parseCommit(obj.data);
  } catch {
    return null;
  }
  const parseWho = (text: string): { name: string; email: string; date: string } => {
    const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(text);
    if (!match) return { name: text, email: '', date: trialNowIso() };
    return { name: match[1] as string, email: match[2] as string, date: isoOf(Number(match[3])) };
  };
  const author = parseWho(view.author);
  const committer = parseWho(view.committer);
  return {
    sha,
    node_id: `C_${sha}`,
    commit: {
      // GitHub returns the message without the trailing newline git stores.
      message: view.message.replace(/\n$/, ''),
      author,
      committer,
      tree: { sha: view.tree },
      url: '',
      comment_count: 0,
    },
    author: userJson(VIEWER_LOGIN),
    committer: userJson(VIEWER_LOGIN),
    parents: view.parents.map((parent) => ({ sha: parent })),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `/${repo.owner}/${repo.name}/commit/${sha}`,
  };
}

// ---------------------------------------------------------------------------
// contents helpers
// ---------------------------------------------------------------------------

function treeEntryAt(repo: Repo, treeOid: string, segments: string[]): { type: 'file' | 'dir'; oid: string; name: string } | null {
  let currentOid = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const obj = repo.objects.get(currentOid);
    if (!obj || obj.type !== 'tree') return null;
    let entries;
    try {
      entries = parseTree(obj.data);
    } catch {
      return null;
    }
    const segment = segments[i] as string;
    const entry = entries.find((candidate) => candidate.name === segment);
    if (!entry) return null;
    if (i === segments.length - 1) {
      return { type: entry.mode === '40000' ? 'dir' : 'file', oid: entry.oid, name: entry.name };
    }
    if (entry.mode !== '40000') return null;
    currentOid = entry.oid;
  }
  return null;
}

function dirListing(repo: Repo, treeOid: string, pathPrefix: string): Array<Record<string, unknown>> {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return [];
  let entries;
  try {
    entries = parseTree(obj.data);
  } catch {
    return [];
  }
  return entries.map((entry) => ({
    type: entry.mode === '40000' ? 'dir' : 'file',
    size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
    name: entry.name,
    path: pathPrefix === '' ? entry.name : `${pathPrefix}/${entry.name}`,
    sha: entry.oid,
    url: '',
    html_url: '',
    download_url: entry.mode === '40000' ? null : '',
  }));
}

// ---------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------

export function handleRest(req: RestRequest): RestResponse {
  const segments = req.segments;
  const method = req.method;

  // GET /api/v3/
  if (segments.length === 0) {
    if (method === 'GET') {
      return json(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    }
    return err(404, 'Not Found');
  }

  // GET /api/v3/meta
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method === 'GET') return json(200, { installed_version: '1.0.0', installed_at: trialNowIso(), setup_url: '', upgrade_url: '' });
    return err(404, 'Not Found');
  }

  // GET /api/v3/user
  if (segments.length === 1 && segments[0] === 'user') {
    if (method === 'GET') {
      return json(200, { login: VIEWER_LOGIN, id: VIEWER_USER.id, node_id: 'U_1000', avatar_url: '', html_url: '', type: 'User', name: VIEWER_USER.name, email: VIEWER_USER.email, site_admin: false });
    }
    return err(404, 'Not Found');
  }

  // /api/v3/user/repos
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const repos = store.reposOf(VIEWER_LOGIN).map((repo) => repoJson(repo));
      const { page, link } = paginate(repos, req, '/api/v3/user/repos');
      return json(200, page, linkHeader(link));
    }
    if (method === 'POST') {
      if (!req.bodyIsJson) return err(400, 'Invalid JSON body');
      const body = bodyOf(req);
      const name = str(body.name);
      if (name === '') return err(422, 'name is required');
      if (store.getRepo(VIEWER_LOGIN, name)) return err(422, 'Repository already exists');
      const repo = store.createRepo(VIEWER_LOGIN, name, {
        description: str(body.description),
        private: body.private === true,
        defaultBranch: typeof body.default_branch === 'string' && body.default_branch !== '' ? body.default_branch : undefined,
      });
      return json(201, repoJson(repo));
    }
    return err(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = decodeURIComponent(segments[1] as string);
    const repoName = decodeURIComponent(segments[2] as string);
    const repo = store.getRepo(owner, repoName);
    if (!repo) return err(404, 'Not Found');
    const rest = segments.slice(3);
    return handleRepoRoute(req, repo, rest);
  }

  return err(404, 'Not Found');
}

function handleRepoRoute(req: RestRequest, repo: Repo, rest: string[]): RestResponse {
  const method = req.method;

  // /repos/{o}/{r} itself
  if (rest.length === 0) {
    if (method === 'GET') return json(200, repoJson(repo));
    if (method === 'PATCH') {
      if (!req.bodyIsJson) return err(400, 'Invalid JSON body');
      const body = bodyOf(req);
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
        store.repos.delete(store.key(repo.owner, repo.name));
        repo.name = body.name;
        store.repos.set(store.key(repo.owner, repo.name), repo);
      }
      repo.updatedAt = trialNowIso();
      return json(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      return noContent();
    }
    return err(404, 'Not Found');
  }

  const head = rest[0] as string;

  // branches
  if (head === 'branches') {
    if (rest.length === 1) {
      if (method !== 'GET') return err(404, 'Not Found');
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((name) => ({ name, commit: { sha: repo.refs.get(`refs/heads/${name}`) as string, url: '' }, protected: false }));
      return json(200, branches);
    }
    if (rest.length === 2) {
      const branch = decodeURIComponent(rest[1] as string);
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (!sha) return err(404, 'Not Found');
      if (method === 'GET') return json(200, { name: branch, commit: { sha, url: '' }, protected: false });
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  // commits
  if (head === 'commits') {
    if (rest.length === 1) {
      if (method !== 'GET') return err(404, 'Not Found');
      const refish = req.query.get('sha') ?? undefined;
      const tip = resolveRef(repo, refish);
      const { page, perPage } = pageParams(req);
      const all = listCommits(repo, tip, 1000);
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const items = slice.map((commit) => commitJson(repo, commit.sha)).filter((item): item is Record<string, unknown> => item !== null);
      return json(200, items);
    }
    if (rest.length === 2) {
      if (method !== 'GET') return err(404, 'Not Found');
      const sha = decodeURIComponent(rest[1] as string);
      const item = commitJson(repo, sha);
      if (!item) return err(404, 'Not Found');
      return json(200, item);
    }
    return err(404, 'Not Found');
  }

  // contents
  if (head === 'contents') {
    const path = rest.slice(1).map((segment) => decodeURIComponent(segment)).join('/');
    return handleContents(req, repo, path);
  }

  // git refs
  if (head === 'git') {
    return handleGitRefs(req, repo, rest.slice(1));
  }

  // labels
  if (head === 'labels') {
    if (rest.length === 1) {
      if (method === 'GET') {
        return json(200, [...repo.labels.values()].map((label) => ({ id: label.id, node_id: `LA_${label.id}`, url: '', name: label.name, color: label.color, description: label.description, default: false })));
      }
      if (method === 'POST') {
        if (!req.bodyIsJson) return err(400, 'Invalid JSON body');
        const body = bodyOf(req);
        const name = str(body.name);
        if (name === '') return err(422, 'name is required');
        if (repo.labels.has(name)) return err(422, 'Label already exists');
        store.labelIdCounter += 1;
        const label = { id: store.labelIdCounter, name, color: typeof body.color === 'string' ? body.color : 'ededed', description: typeof body.description === 'string' ? body.description : '' };
        repo.labels.set(name, label);
        return json(201, { id: label.id, node_id: `LA_${label.id}`, url: '', name: label.name, color: label.color, description: label.description, default: false });
      }
      return err(404, 'Not Found');
    }
    if (rest.length === 2 && method === 'GET') {
      const label = repo.labels.get(decodeURIComponent(rest[1] as string));
      if (!label) return err(404, 'Not Found');
      return json(200, { id: label.id, node_id: `LA_${label.id}`, url: '', name: label.name, color: label.color, description: label.description, default: false });
    }
    return err(404, 'Not Found');
  }

  // issues
  if (head === 'issues') {
    return handleIssues(req, repo, rest.slice(1));
  }

  // pulls
  if (head === 'pulls') {
    return handlePulls(req, repo, rest.slice(1));
  }

  return err(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------

function handleContents(req: RestRequest, repo: Repo, path: string): RestResponse {
  const method = req.method;
  if (method === 'GET') {
    const refish = req.query.get('ref') ?? undefined;
    const tip = resolveRef(repo, refish);
    if (tip === null) return err(404, 'Not Found');
    const info = commitInfo(repo, tip);
    if (!info) return err(404, 'Not Found');
    if (path === '') return json(200, dirListing(repo, info.tree, ''));
    const segments = path.split('/').filter((segment) => segment !== '');
    const entry = treeEntryAt(repo, info.tree, segments);
    if (!entry) return err(404, 'Not Found');
    if (entry.type === 'dir') return json(200, dirListing(repo, entry.oid, path));
    const blob = repo.objects.get(entry.oid);
    if (!blob) return err(404, 'Not Found');
    return json(200, {
      type: 'file',
      encoding: 'base64',
      size: blob.data.length,
      name: entry.name,
      path,
      content: blob.data.toString('base64'),
      sha: entry.oid,
      url: '',
      html_url: '',
      download_url: '',
    });
  }

  if (method === 'PUT') {
    if (!req.bodyIsJson) return err(400, 'Invalid JSON body');
    if (path === '') return err(422, 'path is required');
    const body = bodyOf(req);
    const contentB64 = str(body.content);
    if (contentB64 === '') return err(422, 'content is required');
    let contentBytes: Buffer;
    try {
      contentBytes = Buffer.from(contentB64, 'base64');
    } catch {
      return err(422, 'content is not valid base64');
    }
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const refName = `refs/heads/${branch}`;
    const parentTip = repo.refs.get(refName) ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    const parentInfo = parentTip ? commitInfo(repo, parentTip) : undefined;
    const parentTree = parentInfo ? parentInfo.tree : null;
    const files = treeFileMap(repo, parentTree);
    const existing = files.get(path);
    const blobOid = putObject(repo, 'blob', contentBytes);
    if (typeof body.sha === 'string' && body.sha !== '') {
      if (!existing) return err(409, 'sha does not match: file does not exist');
      if (existing.oid.toLowerCase() !== body.sha.toLowerCase()) return err(409, 'sha does not match the current file');
    }
    const isCreate = !existing;
    files.set(path, { oid: blobOid, mode: '100644' });
    const treeOid = buildTreeFromMap(repo, files, parentTree);
    const message = typeof body.message === 'string' && body.message !== '' ? body.message : `Update ${path}`;
    const commitSha = createCommit(repo, { tree: treeOid, parents: parentTip ? [parentTip] : [], message });
    repo.refs.set(refName, commitSha);
    store.bump(repo);
    repo.updatedAt = trialNowIso();
    const name = path.split('/').pop() ?? path;
    return json(isCreate ? 201 : 200, {
      content: { name, path, sha: blobOid, size: contentBytes.length, type: 'file', encoding: 'base64', content: contentB64 },
      commit: { sha: commitSha, message, author: userJson(VIEWER_LOGIN), committer: userJson(VIEWER_LOGIN) },
    });
  }

  if (method === 'DELETE') {
    if (!req.bodyIsJson) return err(400, 'Invalid JSON body');
    if (path === '') return err(422, 'path is required');
    const body = bodyOf(req);
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const refName = `refs/heads/${branch}`;
    const parentTip = repo.refs.get(refName);
    if (!parentTip) return err(404, 'Not Found');
    const parentInfo = commitInfo(repo, parentTip);
    if (!parentInfo) return err(404, 'Not Found');
    const files = treeFileMap(repo, parentInfo.tree);
    const existing = files.get(path);
    if (!existing) return err(404, 'Not Found');
    if (typeof body.sha === 'string' && body.sha !== '' && existing.oid.toLowerCase() !== body.sha.toLowerCase()) {
      return err(409, 'sha does not match the current file');
    }
    files.delete(path);
    const treeOid = buildTreeFromMap(repo, files, parentInfo.tree);
    const message = typeof body.message === 'string' && body.message !== '' ? body.message : `Delete ${path}`;
    const commitSha = createCommit(repo, { tree: treeOid, parents: [parentTip], message });
    repo.refs.set(refName, commitSha);
    store.bump(repo);
    repo.updatedAt = trialNowIso();
    return json(200, { commit: { sha: commitSha, message } });
  }

  return err(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// git refs
// ---------------------------------------------------------------------------

function handleGitRefs(req: RestRequest, repo: Repo, rest: string[]): RestResponse {
  const method = req.method;
  // POST /git/refs
  if (rest.length === 1 && rest[0] === 'refs') {
    if (method !== 'POST') return err(404, 'Not Found');
    if (!req.bodyIsJson) return err(400, 'Invalid JSON body');
    const body = bodyOf(req);
    const ref = str(body.ref);
    const sha = str(body.sha);
    if (!ref.startsWith('refs/') || sha === '') return err(422, 'ref and sha are required');
    if (!repo.objects.has(sha)) return err(422, 'sha does not exist');
    if (repo.refs.has(ref)) return err(422, 'Reference already exists');
    repo.refs.set(ref, sha);
    store.bump(repo);
    const type = repo.objects.get(sha)?.type ?? 'commit';
    return json(201, { ref, node_id: `RF_${ref}`, url: '', object: { sha, type, url: '' } });
  }
  // GET /git/refs (list)
  if (rest.length === 1 && rest[0] === 'refs' && method === 'GET') {
    return json(200, [...repo.refs.entries()].sort().map(([ref, sha]) => ({ ref, node_id: `RF_${ref}`, url: '', object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' } })));
  }
  // /git/refs/heads/{branch} and /git/refs/tags/{tag}
  if (rest.length === 3 && rest[0] === 'refs' && (rest[1] === 'heads' || rest[1] === 'tags')) {
    const ref = `refs/${rest[1]}/${decodeURIComponent(rest[2] as string)}`;
    if (method === 'GET') {
      const sha = repo.refs.get(ref);
      if (!sha) return err(404, 'Not Found');
      return json(200, { ref, node_id: `RF_${ref}`, url: '', object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' } });
    }
    if (method === 'PATCH' && rest[1] === 'heads') {
      if (!req.bodyIsJson) return err(400, 'Invalid JSON body');
      const body = bodyOf(req);
      const sha = str(body.sha);
      if (!repo.objects.has(sha)) return err(422, 'sha does not exist');
      if (!repo.refs.has(ref)) return err(404, 'Not Found');
      repo.refs.set(ref, sha);
      store.bump(repo);
      return json(200, { ref, node_id: `RF_${ref}`, url: '', object: { sha, type: 'commit', url: '' } });
    }
    return err(404, 'Not Found');
  }
  return err(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------

function handleIssues(req: RestRequest, repo: Repo, rest: string[]): RestResponse {
  const method = req.method;
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let list = repo.issues.slice();
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      const sort = req.query.get('sort') ?? 'created';
      const direction = req.query.get('direction') ?? 'desc';
      if (sort === 'created') {
        list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      }
      const { page, link } = paginate(list.map((issue) => issueJson(repo, issue)), req, `/api/v3/repos/${repo.owner}/${repo.name}/issues`);
      return json(200, page, linkHeader(link));
    }
    if (method === 'POST') {
      if (!req.bodyIsJson) return err(400, 'Invalid JSON body');
      const body = bodyOf(req);
      const title = str(body.title);
      if (title === '') return err(422, 'title is required');
      const labelNames: string[] = [];
      if (Array.isArray(body.labels)) {
        for (const entry of body.labels) {
          if (typeof entry === 'string') labelNames.push(entry);
          else if (isRecord(entry) && typeof entry.name === 'string') labelNames.push(entry.name);
        }
      }
      for (const name of labelNames) {
        if (!repo.labels.has(name)) return err(422, `Label "${name}" does not exist`);
      }
      repo.issueCounter += 1;
      store.issueIdCounter += 1;
      const now = trialNowIso();
      const issue: Issue = {
        id: store.issueIdCounter,
        globalId: '',
        number: repo.issueCounter,
        title,
        body: typeof body.body === 'string' ? body.body : '',
        state: 'open',
        labels: labelNames.map((name) => repo.labels.get(name) as Issue['labels'][number]),
        createdSeq: nextSeq(),
        createdAt: now,
        updatedAt: now,
        closedAt: null,
      };
      issue.globalId = opaque('Issue', `${repo.databaseId}:${issue.number}`);
      repo.issues.push(issue);
      return json(201, issueJson(repo, issue));
    }
    return err(404, 'Not Found');
  }

  const number = Number.parseInt(rest[0] as string, 10);
  if (!Number.isInteger(number)) return err(404, 'Not Found');
  const issue = repo.issues.find((candidate) => candidate.number === number);

  if (rest.length === 2 && rest[1] === 'comments') {
    if (!issue) return err(404, 'Not Found');
    if (method === 'GET') {
      const comments = repo.comments.get(number) ?? [];
      return json(200, comments.map((comment) => ({
        id: comment.id,
        node_id: comment.globalId,
        body: comment.body,
        user: userJson(VIEWER_LOGIN),
        created_at: comment.createdAt,
        updated_at: comment.updatedAt,
        url: '',
        html_url: '',
        issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${number}`,
      })));
    }
    if (method === 'POST') {
      if (!req.bodyIsJson) return err(400, 'Invalid JSON body');
      const body = bodyOf(req);
      const text = str(body.body);
      if (text === '') return err(422, 'body is required');
      repo.commentCounter += 1;
      store.commentIdCounter += 1;
      const now = trialNowIso();
      const comment = { id: store.commentIdCounter, globalId: opaque('IssueComment', `${repo.databaseId}:${number}:${repo.commentCounter}`), body: text, createdAt: now, updatedAt: now };
      const list = repo.comments.get(number) ?? [];
      list.push(comment);
      repo.comments.set(number, list);
      repo.issueJsonCache.delete(number);
      return json(201, {
        id: comment.id,
        node_id: comment.globalId,
        body: comment.body,
        user: userJson(VIEWER_LOGIN),
        created_at: comment.createdAt,
        updated_at: comment.updatedAt,
        url: '',
        html_url: '',
        issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${number}`,
      });
    }
    return err(404, 'Not Found');
  }

  if (rest.length === 1) {
    if (!issue) return err(404, 'Not Found');
    if (method === 'GET') {
      return { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: issueJsonString(repo, issue) };
    }
    if (method === 'PATCH') {
      if (!req.bodyIsJson) return err(400, 'Invalid JSON body');
      const body = bodyOf(req);
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') {
        issue.state = body.state;
        issue.closedAt = body.state === 'closed' ? trialNowIso() : null;
      }
      if (Array.isArray(body.labels)) {
        const names: string[] = [];
        for (const entry of body.labels) {
          if (typeof entry === 'string') names.push(entry);
          else if (isRecord(entry) && typeof entry.name === 'string') names.push(entry.name);
        }
        for (const name of names) if (!repo.labels.has(name)) return err(422, `Label "${name}" does not exist`);
        issue.labels = names.map((name) => repo.labels.get(name) as Issue['labels'][number]);
      }
      issue.updatedAt = trialNowIso();
      repo.issueJsonCache.delete(number);
      return json(200, issueJson(repo, issue));
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// pulls
// ---------------------------------------------------------------------------

function branchNameOf(value: unknown): string {
  if (typeof value !== 'string') return '';
  const colon = value.indexOf(':');
  return colon >= 0 ? value.slice(colon + 1) : value;
}

function handlePulls(req: RestRequest, repo: Repo, rest: string[]): RestResponse {
  const method = req.method;
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let list = repo.prs.slice();
      if (state === 'open') list = list.filter((pr) => pr.state === 'open');
      else if (state === 'closed') list = list.filter((pr) => pr.state === 'closed');
      const { page, link } = paginate(list.map((pr) => pullJson(repo, pr)), req, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`);
      return json(200, page, linkHeader(link));
    }
    if (method === 'POST') {
      if (!req.bodyIsJson) return err(400, 'Invalid JSON body');
      const body = bodyOf(req);
      const title = str(body.title);
      const head = branchNameOf(body.head);
      const base = branchNameOf(body.base);
      if (title === '' || head === '' || base === '') return err(422, 'title, head and base are required');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) return err(422, 'head or base branch does not exist');
      const existing = repo.prs.find((pr) => pr.state === 'open' && pr.headRef === head && pr.baseRef === base);
      if (existing) return err(422, 'A pull request already exists for this head and base');
      repo.prCounter += 1;
      store.prIdCounter += 1;
      const now = trialNowIso();
      const pr: PullRequest = {
        id: store.prIdCounter,
        globalId: opaque('PullRequest', `${repo.databaseId}:${repo.prCounter}`),
        number: repo.prCounter,
        title,
        body: typeof body.body === 'string' ? body.body : '',
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
      repo.prs.push(pr);
      return json(201, pullJson(repo, pr));
    }
    return err(404, 'Not Found');
  }

  const number = Number.parseInt(rest[0] as string, 10);
  if (!Number.isInteger(number)) return err(404, 'Not Found');
  const pr = repo.prs.find((candidate) => candidate.number === number);

  if (rest.length === 2 && rest[1] === 'files') {
    if (!pr) return err(404, 'Not Found');
    if (method !== 'GET') return err(404, 'Not Found');
    const headInfo = commitInfo(repo, pr.headSha);
    const baseInfo = commitInfo(repo, pr.mergeBaseSha);
    if (!headInfo || !baseInfo) return err(404, 'Not Found');
    const changes = diffTrees(repo, baseInfo.tree, headInfo.tree);
    return json(200, changes.map((change) => ({
      sha: change.newOid ?? change.oldOid ?? '',
      filename: change.path,
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.additions + change.deletions,
      blob_url: '',
      raw_url: '',
      contents_url: '',
    })));
  }

  if (rest.length === 2 && rest[1] === 'merge') {
    if (!pr) return err(404, 'Not Found');
    if (method === 'GET') {
      return json(200, { merged: pr.merged, mergeable: prMergeable(repo, pr) === 'MERGEABLE', state: pr.state });
    }
    if (method === 'PUT') {
      if (pr.merged) return err(405, 'Pull request already merged');
      if (pr.state === 'closed') return err(405, 'Pull request is closed');
      const mergeSha = squashMerge(repo, pr);
      if (mergeSha === null) return err(405, 'Merge conflict');
      pr.merged = true;
      pr.state = 'closed';
      pr.mergedAt = trialNowIso();
      pr.mergeCommitSha = mergeSha;
      pr.closedAt = pr.mergedAt;
      pr.updatedAt = trialNowIso();
      return json(200, { sha: mergeSha, merged: true, message: `Pull request #${pr.number} successfully merged` });
    }
    return err(404, 'Not Found');
  }

  if (rest.length === 1) {
    if (!pr) return err(404, 'Not Found');
    if (method === 'GET') return json(200, pullJson(repo, pr));
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}
