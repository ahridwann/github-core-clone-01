// git-protocol: git smart HTTP — upload-pack v2 + v0, receive-pack v0.
// Handlers take the raw request body and answer with a status, headers and a
// Buffer body. Pack generation for fetch is cached per (repo version, wants,
// depth, haves, shallow boundaries): the clone workload hits the same
// shallow fetch 50x concurrently, so the cache is what makes it fast.

import { decodePktLines, hashObject, pktDelim, pktFlush, pktLine, pktLines, readPack, splitCommandsAndPack, writePack } from './git-pack.ts';
import type { GitObject, PktPacket } from './git-pack.ts';
import { commitInfo, depthLimitedObjects, isAncestor, peelToCommit, reachable, store } from './store.ts';
import type { Repo } from './store.ts';

export const ZERO_OID = '0'.repeat(40);

export interface GitResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

function textResponse(status: number, text: string): GitResponse {
  return { status, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: Buffer.from(text, 'utf8') };
}

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const out: Array<{ name: string; oid: string }> = [];
  for (const [name, oid] of repo.refs) out.push({ name, oid });
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

function headOid(repo: Repo): string | null {
  return repo.refs.get(headTarget(repo)) ?? null;
}

function peelOf(repo: Repo, oid: string): string | undefined {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tag') return undefined;
  const peeled = peelToCommit(repo, oid);
  return peeled === oid ? undefined : peeled;
}

// ---------------------------------------------------------------------------
// advertisements (cached per repo version)
// ---------------------------------------------------------------------------

const UPLOAD_V2_CAPS = 'ls-refs=unborn\nfetch=shallow filter\nobject-format=sha1\nagent=forge/1.0\n';

function buildV2Advertisement(): Buffer {
  // Protocol v2 over smart HTTP: the advertisement starts directly with
  // "version 2" — the "# service=..." line + flush is v0-only, and real
  // git rejects a v2 advertisement that carries it.
  return pktLines(['version 2\n', 'ls-refs=unborn\n', 'fetch=shallow filter\n', 'object-format=sha1\n', 'agent=forge/1.0\n', 'flush']);
}

function buildV0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-receive-pack'
      ? 'symref=HEAD:refs/heads/main report-status side-band-64k delete-refs ofs-delta agent=forge/1.0'
      : 'symref=HEAD:refs/heads/main side-band-64k side-band thin-pack ofs-delta multi_ack multi_ack_detailed shallow agent=forge/1.0';
  const preamble = service === 'git-receive-pack' ? '# service=git-receive-pack\n' : '# service=git-upload-pack\n';
  const parts: Buffer[] = [pktLine(preamble), pktFlush];
  const refs = sortedRefs(repo);
  const tip = headOid(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    parts.push(pktFlush);
    return Buffer.concat(parts);
  }
  let first = true;
  const lines: Array<{ oid: string; name: string }> = [];
  if (tip !== null) lines.push({ oid: tip, name: 'HEAD' });
  for (const ref of refs) lines.push(ref);
  for (const ref of refs) {
    const peeled = peelOf(repo, ref.oid);
    if (peeled !== undefined) lines.push({ oid: peeled, name: `${ref.name}^{}` });
  }
  for (const line of lines) {
    if (first) {
      parts.push(pktLine(`${line.oid} ${line.name}\0${caps}\n`));
      first = false;
    } else {
      parts.push(pktLine(`${line.oid} ${line.name}\n`));
    }
  }
  parts.push(pktFlush);
  return Buffer.concat(parts);
}

function advertisements(repo: Repo): { v2: Buffer; v0up: Buffer; v0recv: Buffer } {
  if (repo.advCache && repo.advCache.version === repo.version) {
    return { v2: repo.advCache.v2, v0up: repo.advCache.v0up, v0recv: repo.advCache.v0recv };
  }
  const built = { v2: buildV2Advertisement(), v0up: buildV0Advertisement(repo, 'git-upload-pack'), v0recv: buildV0Advertisement(repo, 'git-receive-pack') };
  repo.advCache = { version: repo.version, ...built };
  return built;
}

// ---------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------

export function handleInfoRefs(owner: string, repoName: string, service: string, gitProtocol: string | undefined): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return textResponse(404, 'Not Found');
  const adv = advertisements(repo);
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2') {
      return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-advertisement' }, body: adv.v2 };
    }
    return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-advertisement' }, body: adv.v0up };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-advertisement' }, body: adv.v0recv };
  }
  return textResponse(400, 'unknown service');
}

// ---------------------------------------------------------------------------
// ls-refs (v2)
// ---------------------------------------------------------------------------

function handleLsRefs(repo: Repo, body: Buffer): GitResponse {
  let packets: PktPacket[];
  try {
    packets = decodePktLines(body);
  } catch {
    return textResponse(400, 'bad pkt-line');
  }
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: Buffer[] = [];
  const tip = headOid(repo);
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    if (unborn && keep('HEAD')) {
      out.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
    }
  } else {
    if (symrefs && keep('HEAD') && tip !== null) {
      out.push(pktLine(`${tip} HEAD symref-target:refs/heads/main\n`));
    }
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (peel) {
        const peeled = peelOf(repo, ref.oid);
        if (peeled !== undefined) line += ` peeled:${peeled}`;
      }
      out.push(pktLine(`${line}\n`));
    }
  }
  out.push(pktFlush);
  return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' }, body: Buffer.concat(out) };
}

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
  done: boolean;
}

function parseFetchLines(packets: PktPacket[]): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: undefined, done: false };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) req.wants.push(line.slice(5).split(' ')[0] as string);
    else if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim());
    else if (line === 'done') req.done = true;
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7), 10);
      if (Number.isFinite(n)) req.depth = n;
    }
  }
  // de-duplicate, keeping order
  req.wants = [...new Set(req.wants)];
  req.haves = [...new Set(req.haves)];
  req.shallow = [...new Set(req.shallow)];
  return req;
}

function fetchResponse(repo: Repo, req: FetchRequest, v2: boolean): GitResponse {
  const cacheKey = `${req.wants.join(',')}|d=${req.depth ?? ''}|h=${req.haves.join(',')}|s=${req.shallow.join(',')}|done=${req.done ? 1 : 0}|v2=${v2 ? 1 : 0}`;
  const cached = repo.packCache.get(cacheKey);
  if (cached) {
    return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' }, body: cached };
  }

  // What the client already holds: full history below each non-shallow have,
  // only the depth-1 closure below each shallow have (a deepen boundary).
  const held = new Set<string>();
  for (const have of req.haves) {
    if (req.shallow.includes(have)) {
      const closure = depthLimitedObjects(repo, [have], 1);
      for (const oid of closure.objects) held.add(oid);
    } else {
      for (const oid of reachable(repo, [have])) held.add(oid);
    }
  }

  const wanted = depthLimitedObjects(repo, req.wants, req.depth);
  const toSend = new Set<string>();
  for (const oid of wanted.objects) if (!held.has(oid)) toSend.add(oid);

  // Shallow info: the boundary commits of this fetch. With a depth limit the
  // wanted set's boundary commits are shallow; a deepen also unshallows the
  // old boundary commits that are now interior (their parent is included).
  const shallowOut: string[] = [];
  const unshallowOut: string[] = [];
  if (req.depth !== undefined) {
    for (const oid of wanted.shallow) if (toSend.has(oid) || wanted.objects.has(oid)) shallowOut.push(oid);
    for (const boundary of req.shallow) {
      if (wanted.objects.has(boundary) && !shallowOut.includes(boundary)) {
        // the old boundary is now interior when its parent was delivered
        const info = commitInfo(repo, boundary);
        if (info && info.parents.some((parent) => toSend.has(parent))) unshallowOut.push(boundary);
      }
    }
  }

  // Acknowledgements: ACK every have the server can reach from a want, else NAK.
  const ackLines: string[] = [];
  let anyAck = false;
  for (const have of req.haves) {
    let reachableFromWant = false;
    for (const want of req.wants) {
      if (isAncestor(repo, have, want)) {
        reachableFromWant = true;
        break;
      }
    }
    if (reachableFromWant) {
      ackLines.push(`ACK ${have}\n`);
      anyAck = true;
    }
  }
  if (!anyAck) ackLines.push('NAK\n');

  const objects: GitObject[] = [];
  for (const oid of toSend) {
    const obj = repo.objects.get(oid);
    if (obj) objects.push(obj);
  }
  const pack = writePack(objects);

  const parts: Buffer[] = [];
  if (v2) {
    // The acknowledgments section appears iff the request did NOT carry
    // `done` (stateful negotiation: the client sent haves and waits for
    // ACKs before finishing). With `done` present the client expects
    // `packfile` next — sending the section then makes real git die
    // with "expected 'packfile', received 'acknowledgments'". This
    // matches real git servers for both shapes.
    if (!req.done) {
      parts.push(pktLine('acknowledgments\n'));
      for (const line of ackLines) parts.push(pktLine(line));
      parts.push(pktLine('ready\n'));
      parts.push(pktDelim);
    }
    if (shallowOut.length > 0 || unshallowOut.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of shallowOut) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of unshallowOut) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(pktDelim);
    }
    parts.push(pktLine('packfile\n'));
    appendSideband(parts, pack);
    parts.push(pktFlush);
  } else {
    for (const line of ackLines) parts.push(pktLine(line));
    for (const oid of shallowOut) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallowOut) parts.push(pktLine(`unshallow ${oid}\n`));
    appendSideband(parts, pack);
    parts.push(pktFlush);
  }
  const body = Buffer.concat(parts);
  if (repo.packCache.size > 64) repo.packCache.clear();
  repo.packCache.set(cacheKey, body);
  return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' }, body };
}

function appendSideband(parts: Buffer[], pack: Buffer): void {
  // Max pkt-line is 65520 bytes total (4-byte length + 65516 payload);
  // the 1-byte sideband band counts toward the payload, so pack
  // chunks are 65515 bytes.
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(pktLine(payload));
  }
  if (pack.length === 0) {
    parts.push(pktLine(Buffer.from([1])));
  }
}

export function handleUploadPack(owner: string, repoName: string, body: Buffer, gitProtocol: string | undefined): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return textResponse(404, 'Not Found');
  let packets: PktPacket[];
  try {
    packets = decodePktLines(body);
  } catch {
    return textResponse(400, 'bad pkt-line');
  }
  const firstLine = packets.find((packet) => packet.kind === 'data')?.payload.toString('utf8').replace(/\n$/, '') ?? '';
  const isV2 = gitProtocol === 'version=2' || firstLine.startsWith('command=');
  if (!isV2) {
    // v0 fetch
    const req = parseFetchLines(packets);
    if (req.wants.length === 0) return textResponse(400, 'no want lines');
    return fetchResponse(repo, req, false);
  }
  if (firstLine === 'command=ls-refs') return handleLsRefs(repo, body);
  if (firstLine === 'command=fetch') {
    const req = parseFetchLines(packets);
    if (req.wants.length === 0) return textResponse(400, 'no want lines');
    return fetchResponse(repo, req, true);
  }
  return textResponse(400, `unknown v2 command ${JSON.stringify(firstLine)}`);
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(owner: string, repoName: string, body: Buffer): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return textResponse(404, 'Not Found');
  let commands: PushCommand[] = [];
  let packBytes: Buffer = Buffer.alloc(0);
  try {
    const split = splitCommandsAndPack(body);
    packBytes = split.pack;
    for (const packet of split.packets) {
      if (packet.kind !== 'data') continue;
      const text = packet.payload.toString('utf8');
      const nul = text.indexOf('\0');
      const line = (nul >= 0 ? text.slice(0, nul) : text).replace(/\n$/, '');
      const parts = line.split(' ');
      if (parts.length < 3) continue;
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
  } catch {
    return textResponse(400, 'bad pkt-line');
  }
  if (commands.length === 0) return textResponse(400, 'no commands');

  // Unpack first: objects land in the store even when a ref is refused.
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, obj] of objects) {
        if (hashObject(obj.type, obj.data) !== oid) throw new Error(`object ${oid} does not recompute`);
        if (!repo.objects.has(oid)) {
          repo.objects.set(oid, obj);
          if (obj.type === 'commit') {
            try {
              const view = parseCommit(obj.data);
              repo.commitCache.set(oid, { tree: view.tree, parents: view.parents });
            } catch {
              // ignore
            }
          }
        }
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack error';
    }
  }

  const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  let refChanged = false;
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    let ok = false;
    let reason = '';
    if (!unpackOk) {
      reason = 'unpack error';
    } else if (command.newOid === ZERO_OID) {
      // delete
      if (current === undefined) reason = 'no such ref';
      else if (command.oldOid !== ZERO_OID && command.oldOid !== current) reason = 'non-fast-forward';
      else {
        repo.refs.delete(command.ref);
        ok = true;
        refChanged = true;
      }
    } else if (command.oldOid === ZERO_OID) {
      // create
      if (current !== undefined) reason = 'already exists';
      else if (!repo.objects.has(command.newOid)) reason = 'object not found';
      else {
        repo.refs.set(command.ref, command.newOid);
        ok = true;
        refChanged = true;
      }
    } else {
      // update
      if (current === undefined) reason = 'no such ref';
      else if (command.oldOid !== current) reason = 'non-fast-forward';
      else if (!repo.objects.has(command.newOid)) reason = 'object not found';
      else if (command.newOid === current) ok = true;
      else if (command.ref.startsWith('refs/heads/') && repo.objects.get(command.newOid)?.type !== 'commit') reason = 'invalid object';
      else if (!isAncestor(repo, command.oldOid, command.newOid)) reason = 'non-fast-forward';
      else {
        repo.refs.set(command.ref, command.newOid);
        ok = true;
        refChanged = true;
      }
    }
    reportLines.push(ok ? `ok ${command.ref}\n` : `ng ${command.ref} ${reason}\n`);
  }
  if (refChanged) store.bump(repo);

  // report-status inside side-band-64k band 1
  const inner = pktLines([...reportLines, 'flush']);
  const outer = Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), inner])), pktFlush]);
  return { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-result' }, body: outer };
}

export function repoExists(owner: string, repoName: string): boolean {
  return store.getRepo(owner, repoName) !== undefined;
}

// ---------------------------------------------------------------------------
// dispatcher (used by app.ts)
// ---------------------------------------------------------------------------

export interface GitRequest {
  method: string;
  owner: string;
  repo: string;
  subPath: string;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export function handleGit(req: GitRequest): GitResponse {
  const gitProtocol = typeof req.headers['git-protocol'] === 'string' ? req.headers['git-protocol'] : undefined;
  if (req.method === 'GET' && req.subPath === '/info/refs') {
    const service = req.query.get('service') ?? '';
    return handleInfoRefs(req.owner, req.repo, service, gitProtocol);
  }
  if (req.method === 'POST' && req.subPath === '/git-upload-pack') {
    return handleUploadPack(req.owner, req.repo, req.body, gitProtocol);
  }
  if (req.method === 'POST' && req.subPath === '/git-receive-pack') {
    return handleReceivePack(req.owner, req.repo, req.body);
  }
  return textResponse(404, 'Not Found');
}
