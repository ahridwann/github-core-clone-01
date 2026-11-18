// store: the forge's whole in-memory state. One process, one trial, no
// persistence. Deterministic timestamps come from MAKEFUN_TRIAL_NOW; nothing
// here reads the wall clock for data the suite can compare.

import { buildCommit, buildTree, hashObject, parseCommit, parseTag, parseTree } from './git-pack.ts';
import type { GitObject, GitObjectType, TreeEntry } from './git-pack.ts';
import { VIEWER_LOGIN, VIEWER_USER } from './scenario.ts';

export { VIEWER_LOGIN, VIEWER_USER };

export const ZERO_OID = '0'.repeat(40);

/** The trial's "now": MAKEFUN_TRIAL_NOW (ISO or epoch ms), else a fixed epoch. */
function computeTrialNowSec(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw !== undefined && raw !== '') {
    if (/^\d+$/.test(raw)) {
      const ms = Number(raw);
      if (Number.isFinite(ms) && ms > 0) return Math.floor(ms / 1000);
    }
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return 1735689600; // 2025-01-01T00:00:00Z
}

// The trial clock never moves during a process (the env var is fixed at
// start), so compute it once instead of re-parsing the env + building a
// Date on every timestamped write.
const TRIAL_NOW_SEC = computeTrialNowSec();
const TRIAL_NOW_ISO = new Date(TRIAL_NOW_SEC * 1000).toISOString();

export function trialNowSec(): number {
  return TRIAL_NOW_SEC;
}

export function trialNowIso(): string {
  return TRIAL_NOW_ISO;
}

let globalSeq = 0;
export function nextSeq(): number {
  globalSeq += 1;
  return globalSeq;
}

/** A commit timestamp that stays deterministic yet unique per commit. */
export function commitTimestamp(): number {
  return trialNowSec() + nextSeq();
}

export function isoOf(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// global ids (opaque Relay ids; never the plain numeric id)
// ---------------------------------------------------------------------------

export function encodeGlobalId(kind: string, value: string): string {
  return Buffer.from(`${kind}:${value}`, 'utf8').toString('base64url');
}

export function decodeGlobalId(id: string): { kind: string; value: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), value: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  id: number;
  globalId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Comment {
  id: number;
  globalId: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface PullRequest {
  id: number;
  globalId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Repo {
  databaseId: number;
  globalId: string;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  createdSeq: number;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  commitCache: Map<string, { tree: string; parents: string[] }>;
  issues: Issue[];
  issueCounter: number;
  comments: Map<number, Comment[]>;
  commentCounter: number;
  prs: PullRequest[];
  prCounter: number;
  labels: Map<string, Label>;
  labelCounter: number;
  version: number;
  packCache: Map<string, Buffer>;
  advCache: { version: number; v2: Buffer; v0up: Buffer; v0recv: Buffer } | null;
  /** Cached ls-refs response: pure function of refs + request flags. */
  lsRefsCache: { version: number; key: string; buf: Buffer } | null;
  issueJsonCache: Map<number, string>;
}

export class Store {
  repos = new Map<string, Repo>();
  byGlobalId = new Map<string, Repo>();
  repoCounter = 0;
  issueIdCounter = 0;
  commentIdCounter = 0;
  prIdCounter = 0;
  labelIdCounter = 0;

  key(owner: string, name: string): string {
    return `${owner}\0${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, options: { description?: string; private?: boolean; defaultBranch?: string }): Repo {
    this.repoCounter += 1;
    const now = trialNowIso();
    const repo: Repo = {
      databaseId: this.repoCounter,
      globalId: encodeGlobalId('Repository', String(this.repoCounter)),
      owner,
      name,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: options.defaultBranch ?? 'main',
      createdAt: now,
      updatedAt: now,
      createdSeq: nextSeq(),
      refs: new Map(),
      objects: new Map(),
      commitCache: new Map(),
      issues: [],
      issueCounter: 0,
      comments: new Map(),
      commentCounter: 0,
      prs: [],
      prCounter: 0,
      labels: new Map(),
      labelCounter: 0,
      version: 0,
      packCache: new Map(),
      advCache: null,
      lsRefsCache: null,
      issueJsonCache: new Map(),
    };
    this.repos.set(this.key(owner, name), repo);
    this.byGlobalId.set(repo.globalId, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    const repo = this.repos.get(this.key(owner, name));
    if (!repo) return false;
    this.repos.delete(this.key(owner, name));
    this.byGlobalId.delete(repo.globalId);
    return true;
  }

  repoByGlobalId(id: string): Repo | undefined {
    return this.byGlobalId.get(id);
  }

  /** Repos owned by `owner`, in creation order. */
  reposOf(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  bump(repo: Repo): void {
    repo.version += 1;
    repo.packCache.clear();
    repo.advCache = null;
    repo.lsRefsCache = null;
  }
}

export const store = new Store();

// ---------------------------------------------------------------------------
// git objects
// ---------------------------------------------------------------------------

export function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) {
    repo.objects.set(oid, { type, data });
    if (type === 'commit') {
      try {
        const view = parseCommit(data);
        repo.commitCache.set(oid, { tree: view.tree, parents: view.parents });
      } catch {
        // not a parseable commit; leave uncached
      }
    }
  }
  return oid;
}

export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

export function commitInfo(repo: Repo, oid: string): { tree: string; parents: string[] } | undefined {
  const cached = repo.commitCache.get(oid);
  if (cached) return cached;
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'commit') return undefined;
  try {
    const view = parseCommit(obj.data);
    const info = { tree: view.tree, parents: view.parents };
    repo.commitCache.set(oid, info);
    return info;
  } catch {
    return undefined;
  }
}

/** True when `ancestor` is reachable from `oid` (or equal to it). */
export function isAncestor(repo: Repo, ancestor: string, oid: string): boolean {
  if (ancestor === oid) return true;
  const seen = new Set<string>();
  const stack: string[] = [oid];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === ancestor) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const info = commitInfo(repo, current);
    if (!info) continue;
    for (const parent of info.parents) stack.push(parent);
  }
  return false;
}

/** All object ids reachable from `roots` (commits, their trees/blobs, tags). */
export function reachable(repo: Repo, roots: string[]): Set<string> {
  const out = new Set<string>();
  const stack: string[] = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    out.add(oid);
    if (obj.type === 'commit') {
      const info = commitInfo(repo, oid);
      if (!info) continue;
      stack.push(info.tree);
      for (const parent of info.parents) stack.push(parent);
    } else if (obj.type === 'tree') {
      try {
        for (const entry of parseTree(obj.data)) stack.push(entry.oid);
      } catch {
        // ignore malformed tree
      }
    } else if (obj.type === 'tag') {
      try {
        stack.push(parseTag(obj.data).object);
      } catch {
        // ignore
      }
    }
  }
  return out;
}

/**
 * Commits reachable from `roots`, within `depth` generations (depth 1 = the
 * roots only; undefined = the whole history). Returns the commit oids plus,
 * for each, the objects reachable from it without crossing the depth limit.
 */
export function depthLimitedObjects(repo: Repo, roots: string[], depth: number | undefined): { objects: Set<string>; shallow: string[]; unshallow: string[] } {
  const objects = new Set<string>();
  const shallow: string[] = [];
  const visitedCommits = new Map<string, number>(); // oid -> generation (0 = root)
  const queue: Array<{ oid: string; gen: number }> = roots.map((oid) => ({ oid, gen: 0 }));
  const addTreeObjects = (treeOid: string): void => {
    const stack: string[] = [treeOid];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (objects.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      objects.add(oid);
      if (obj.type === 'tree') {
        try {
          for (const entry of parseTree(obj.data)) stack.push(entry.oid);
        } catch {
          // ignore
        }
      }
    }
  };
  while (queue.length > 0) {
    const item = queue.shift() as { oid: string; gen: number };
    const known = visitedCommits.get(item.oid);
    if (known !== undefined && known <= item.gen) continue;
    visitedCommits.set(item.oid, item.gen);
    const info = commitInfo(repo, item.oid);
    if (!info) {
      // a tag or a bare object root: include it and what it points at
      const obj = repo.objects.get(item.oid);
      if (!obj) continue;
      objects.add(item.oid);
      if (obj.type === 'tag') {
        try {
          const target = parseTag(obj.data).object;
          queue.push({ oid: target, gen: item.gen });
        } catch {
          // ignore
        }
      } else if (obj.type === 'tree') {
        addTreeObjects(item.oid);
      }
      continue;
    }
    objects.add(item.oid);
    addTreeObjects(info.tree);
    if (depth === undefined || item.gen + 1 < depth) {
      for (const parent of info.parents) queue.push({ oid: parent, gen: item.gen + 1 });
    } else {
      // this commit is at the depth boundary: it is shallow
      shallow.push(item.oid);
    }
  }
  return { objects, shallow, unshallow: [] };
}

/** Peel a ref target to its commit (through tag objects). */
export function peelToCommit(repo: Repo, oid: string): string {
  let current = oid;
  for (let i = 0; i < 16; i += 1) {
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'tag') return current;
    try {
      current = parseTag(obj.data).object;
    } catch {
      return current;
    }
  }
  return current;
}

// ---------------------------------------------------------------------------
// trees: file maps and tree building
// ---------------------------------------------------------------------------

export type FileMap = Map<string, { oid: string; mode: string }>;

/** The flat file map of a tree object (path -> blob). */
export function treeFileMap(repo: Repo, treeOid: string | null): FileMap {
  const out: FileMap = new Map();
  if (treeOid === null) return out;
  const walk = (oid: string, prefix: string): void => {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') return;
    let entries: TreeEntry[];
    try {
      entries = parseTree(obj.data);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/** Build a tree object from a file map, reusing unchanged subtrees of `baseTreeOid`. */
export function buildTreeFromMap(repo: Repo, files: FileMap, baseTreeOid: string | null): string {
  // Group files by first path segment, recursively.
  const build = (paths: string[], prefix: string, baseOid: string | null): string => {
    const baseEntries = new Map<string, TreeEntry>();
    if (baseOid !== null) {
      const baseObj = repo.objects.get(baseOid);
      if (baseObj && baseObj.type === 'tree') {
        try {
          for (const entry of parseTree(baseObj.data)) baseEntries.set(entry.name, entry);
        } catch {
          // ignore
        }
      }
    }
    const dirs = new Map<string, string[]>();
    const entries: TreeEntry[] = [];
    for (const path of paths) {
      const rest = prefix === '' ? path : path.slice(prefix.length + 1);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        const file = files.get(path);
        if (file) entries.push({ mode: file.mode, name: rest, oid: file.oid });
      } else {
        const dir = rest.slice(0, slash);
        const list = dirs.get(dir) ?? [];
        list.push(path);
        dirs.set(dir, list);
      }
    }
    for (const [dir, subPaths] of dirs) {
      const baseEntry = baseEntries.get(dir);
      const subOid = build(subPaths, prefix === '' ? dir : `${prefix}/${dir}`, baseEntry && baseEntry.mode === '40000' ? baseEntry.oid : null);
      entries.push({ mode: '40000', name: dir, oid: subOid });
    }
    const data = buildTree(entries);
    return putObject(repo, 'tree', data);
  };
  return build([...files.keys()], '', baseTreeOid);
}

/** Create a commit object on `repo` and store it. Returns its oid. */
export function createCommit(repo: Repo, fields: { tree: string; parents: string[]; message: string }): string {
  const author = `${VIEWER_USER.name} <${VIEWER_USER.email}>`;
  const data = buildCommit({
    tree: fields.tree,
    parents: fields.parents,
    message: fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`,
    author,
    committer: author,
    timestamp: commitTimestamp(),
  });
  return putObject(repo, 'commit', data);
}

/** Resolve a ref-ish (branch name, full ref, or commit sha) to a commit oid. */
export function resolveRef(repo: Repo, refish: string | undefined): string | null {
  if (refish === undefined || refish === '') {
    const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    return tip ?? null;
  }
  if (repo.refs.has(refish)) return repo.refs.get(refish) as string;
  const asBranch = repo.refs.get(`refs/heads/${refish}`);
  if (asBranch) return asBranch;
  const asTag = repo.refs.get(`refs/tags/${refish}`);
  if (asTag) return peelToCommit(repo, asTag);
  if (/^[0-9a-f]{40}$/.test(refish) && repo.objects.has(refish)) return refish;
  if (/^[0-9a-f]{7,39}$/.test(refish)) {
    for (const oid of repo.objects.keys()) if (oid.startsWith(refish)) return oid;
  }
  return null;
}

/** Commits reachable from `tip`, newest first (DFS, parents in order). */
export function listCommits(repo: Repo, tip: string | null, limit: number): Array<{ sha: string; message: string; authorName: string; authorEmail: string; date: string; parents: string[] }> {
  const out: Array<{ sha: string; message: string; authorName: string; authorEmail: string; date: string; parents: string[] }> = [];
  if (tip === null) return out;
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0 && out.length < limit) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    let view;
    try {
      view = parseCommit(obj.data);
    } catch {
      continue;
    }
    const authorMatch = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(view.author) ?? null;
    out.push({
      sha: oid,
      message: view.message,
      authorName: authorMatch ? authorMatch[1] as string : view.author,
      authorEmail: authorMatch ? authorMatch[2] as string : '',
      date: authorMatch ? isoOf(Number(authorMatch[3])) : trialNowIso(),
      parents: view.parents,
    });
    for (let i = view.parents.length - 1; i >= 0; i -= 1) stack.push(view.parents[i] as string);
  }
  return out;
}

// ---------------------------------------------------------------------------
// diffs (for pull-request files and mergeability)
// ---------------------------------------------------------------------------

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  oldOid: string | null;
  newOid: string | null;
}

function countLines(data: Buffer): string[] {
  const text = data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function lineDiff(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const oldLines = oldData === null ? [] : countLines(oldData);
  const newLines = newData === null ? [] : countLines(newData);
  const oldSet = new Map<string, number>();
  for (const line of oldLines) oldSet.set(line, (oldSet.get(line) ?? 0) + 1);
  let additions = 0;
  const remaining = new Map(oldSet);
  for (const line of newLines) {
    const count = remaining.get(line) ?? 0;
    if (count > 0) remaining.set(line, count - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const count of remaining.values()) deletions += count;
  return { additions, deletions };
}

export function diffTrees(repo: Repo, oldTreeOid: string | null, newTreeOid: string | null): FileChange[] {
  const oldMap = treeFileMap(repo, oldTreeOid);
  const newMap = treeFileMap(repo, newTreeOid);
  const changes: FileChange[] = [];
  const paths = new Set<string>([...oldMap.keys(), ...newMap.keys()]);
  for (const path of paths) {
    const oldEntry = oldMap.get(path);
    const newEntry = newMap.get(path);
    if (oldEntry && !newEntry) {
      const oldData = repo.objects.get(oldEntry.oid)?.data ?? null;
      const diff = lineDiff(oldData, null);
      changes.push({ path, status: 'removed', additions: 0, deletions: diff.deletions, oldOid: oldEntry.oid, newOid: null });
    } else if (!oldEntry && newEntry) {
      const newData = repo.objects.get(newEntry.oid)?.data ?? null;
      const diff = lineDiff(null, newData);
      changes.push({ path, status: 'added', additions: diff.additions, deletions: 0, oldOid: null, newOid: newEntry.oid });
    } else if (oldEntry && newEntry && oldEntry.oid !== newEntry.oid) {
      const oldData = repo.objects.get(oldEntry.oid)?.data ?? null;
      const newData = repo.objects.get(newEntry.oid)?.data ?? null;
      const diff = lineDiff(oldData, newData);
      changes.push({ path, status: 'modified', additions: diff.additions, deletions: diff.deletions, oldOid: oldEntry.oid, newOid: newEntry.oid });
    }
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return changes;
}

/** Mergeability of a pull request: 'MERGEABLE' or 'CONFLICTING'. */
export function prMergeable(repo: Repo, pr: PullRequest): 'MERGEABLE' | 'CONFLICTING' {
  const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
  if (!baseTip || !headTip) return 'CONFLICTING';
  const baseInfo = commitInfo(repo, baseTip);
  const headInfo = commitInfo(repo, headTip);
  const mergeBaseInfo = commitInfo(repo, pr.mergeBaseSha);
  if (!baseInfo || !headInfo || !mergeBaseInfo) return 'CONFLICTING';
  const headChanges = diffTrees(repo, mergeBaseInfo.tree, headInfo.tree);
  const baseMap = treeFileMap(repo, baseInfo.tree);
  const mergeBaseMap = treeFileMap(repo, mergeBaseInfo.tree);
  for (const change of headChanges) {
    const baseEntry = baseMap.get(change.path);
    const mergeBaseEntry = mergeBaseMap.get(change.path);
    const baseOid = baseEntry ? baseEntry.oid : null;
    const mergeBaseOid = mergeBaseEntry ? mergeBaseEntry.oid : null;
    if (baseOid !== mergeBaseOid && baseOid !== change.newOid) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

/** Squash-merge a pull request onto its base branch. Returns the merge commit oid, or null on conflict. */
export function squashMerge(repo: Repo, pr: PullRequest): string | null {
  if (prMergeable(repo, pr) !== 'MERGEABLE') return null;
  const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
  if (!baseTip || !headTip) return null;
  const baseInfo = commitInfo(repo, baseTip);
  const headInfo = commitInfo(repo, headTip);
  const mergeBaseInfo = commitInfo(repo, pr.mergeBaseSha);
  if (!baseInfo || !headInfo || !mergeBaseInfo) return null;
  const headChanges = diffTrees(repo, mergeBaseInfo.tree, headInfo.tree);
  const headMap = treeFileMap(repo, headInfo.tree);
  const resultMap = treeFileMap(repo, baseInfo.tree);
  for (const change of headChanges) {
    if (change.status === 'removed') resultMap.delete(change.path);
    else if (change.newOid) resultMap.set(change.path, { oid: change.newOid, mode: headMap.get(change.path)?.mode ?? '100644' });
  }
  const treeOid = buildTreeFromMap(repo, resultMap, baseInfo.tree);
  const mergeSha = createCommit(repo, {
    tree: treeOid,
    parents: [baseTip],
    message: `${pr.title} (#${pr.number})`,
  });
  repo.refs.set(`refs/heads/${pr.baseRef}`, mergeSha);
  store.bump(repo);
  return mergeSha;
}
