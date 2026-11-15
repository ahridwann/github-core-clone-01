// graphql: a small GraphQL executor for the documents gh and
// github-mcp-server send (see sdk/conformance/checks-graphql.ts).
// Supports: viewer, repository(+issue/issues/pullRequest/pullRequests),
// node(id:), __type/__schema introspection, and the five mutations
// createIssue, closeIssue, createPullRequest, mergePullRequest,
// addComment. Batched bodies (JSON arrays) return one result per
// operation, in order. Unknown fields produce HTTP 200 with an
// errors array naming the field; an unknown repo is data.repository
// null with no errors. Auth is checked by app.ts before this handler.

import { VIEWER_LOGIN, VIEWER_USER } from './scenario.ts';
import {
  commitInfo, diffTrees, nextSeq, prMergeable, squashMerge, store, trialNowIso,
} from './store.ts';
import type { Issue, PullRequest, Repo } from './store.ts';

// ---------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';
  value: string;
}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') { i += 1; continue; }
    if (ch === '#') { while (i < source.length && source[i] !== '\n') i += 1; continue; }
    if (ch === '.' && source.slice(i, i + 3) === '...') { tokens.push({ kind: 'punct', value: '...' }); i += 3; continue; }
    if ('!$&():=@[]{}|'.includes(ch)) { tokens.push({ kind: 'punct', value: ch }); i += 1; continue; }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'u') { out += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16)); j += 4; }
          else out += esc;
          j += 2;
          continue;
        }
        out += source[j];
        j += 1;
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${ch}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// parser (AST)
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selectionSet: SelectionSet | null;
}

interface FragmentSpreadNode { kind: 'spread'; name: string }
interface InlineFragmentNode { kind: 'inline'; typeCondition: string | null; selectionSet: SelectionSet }
type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;
type SelectionSet = SelectionNode[];

interface OperationNode {
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variableDefinitions: Array<{ name: string; defaultValue: ValueNode | null }>;
  selectionSet: SelectionSet;
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, SelectionSet>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token { return this.tokens[this.pos] as Token; }
  private next(): Token { return this.tokens[this.pos++] as Token; }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`Expected ${value}, got ${token.value}`);
  }
  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`Expected name, got ${token.value}`);
    if (value !== undefined && token.value !== value) throw new Error(`Expected ${value}, got ${token.value}`);
    return token.value;
  }
  private matchPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) { this.pos += 1; return true; }
    return false;
  }

  parseDocument(): DocumentNode {
    const doc: DocumentNode = { operations: [], fragments: new Map() };
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        doc.operations.push({ operation: 'query', name: null, variableDefinitions: [], selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        this.expectName();
        doc.fragments.set(name, this.parseSelectionSet());
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        const operation = this.next().value as 'query' | 'mutation' | 'subscription';
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        const variableDefinitions = this.parseVariableDefinitions();
        doc.operations.push({ operation, name, variableDefinitions, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`Unexpected token ${token.value}`);
    }
    return doc;
  }

  private parseVariableDefinitions(): Array<{ name: string; defaultValue: ValueNode | null }> {
    const defs: Array<{ name: string; defaultValue: ValueNode | null }> = [];
    if (!this.matchPunct('(')) return defs;
    while (!this.matchPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.matchPunct('=')) defaultValue = this.parseValue(true);
      defs.push({ name, defaultValue });
    }
    return defs;
  }

  private parseType(): void {
    if (this.matchPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.matchPunct('!');
  }

  private parseSelectionSet(): SelectionSet {
    this.expectPunct('{');
    const selections: SelectionSet = [];
    while (!this.matchPunct('}')) {
      if (this.peek().kind === 'punct' && this.peek().value === '...') {
        this.next();
        if (this.peek().kind === 'name' && this.peek().value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          selections.push({ kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() });
        } else if (this.peek().kind === 'name') {
          selections.push({ kind: 'spread', name: this.next().value });
        } else {
          selections.push({ kind: 'inline', typeCondition: null, selectionSet: this.parseSelectionSet() });
        }
        continue;
      }
      const first = this.expectName();
      let alias: string | null = null;
      let name = first;
      if (this.matchPunct(':')) {
        alias = first;
        name = this.expectName();
      }
      const args = this.parseArguments();
      this.parseDirectives();
      let selectionSet: SelectionSet | null = null;
      if (this.peek().kind === 'punct' && this.peek().value === '{') selectionSet = this.parseSelectionSet();
      selections.push({ alias, name, args, selectionSet });
    }
    return selections;
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (!this.matchPunct('(')) return args;
    while (!this.matchPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue(true) });
    }
    return args;
  }

  private parseDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  private parseValue(isConst: boolean): ValueNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '$') {
      this.next();
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      this.next();
      const values: ValueNode[] = [];
      while (!this.matchPunct(']')) values.push(this.parseValue(isConst));
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      this.next();
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.matchPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue(isConst) });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') { this.next(); return { kind: 'int', value: Number.parseInt(token.value, 10) }; }
    if (token.kind === 'float') { this.next(); return { kind: 'float', value: Number.parseFloat(token.value) }; }
    if (token.kind === 'string') { this.next(); return { kind: 'string', value: token.value }; }
    if (token.kind === 'name') {
      this.next();
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`Unexpected value token ${token.value}`);
  }
}

// ---------------------------------------------------------------------------
// schema (for introspection)
// ---------------------------------------------------------------------------

interface FieldDef { name: string; type: string }
interface TypeDef {
  kind: 'OBJECT' | 'ENUM' | 'SCALAR' | 'INPUT_OBJECT';
  fields?: FieldDef[];
  enumValues?: string[];
  inputFields?: string[];
}

const SCHEMA: Record<string, TypeDef> = {
  Query: { kind: 'OBJECT', fields: [
    { name: 'viewer', type: 'User' }, { name: 'repository', type: 'Repository' },
    { name: 'node', type: 'Node' }, { name: '__type', type: '__Type' }, { name: '__schema', type: '__Schema' },
  ] },
  Mutation: { kind: 'OBJECT', fields: [
    { name: 'createIssue', type: 'CreateIssuePayload' }, { name: 'closeIssue', type: 'CloseIssuePayload' },
    { name: 'createPullRequest', type: 'CreatePullRequestPayload' }, { name: 'mergePullRequest', type: 'MergePullRequestPayload' },
    { name: 'addComment', type: 'AddCommentPayload' },
  ] },
  Repository: { kind: 'OBJECT', fields: [
    { name: 'id', type: 'ID' }, { name: 'databaseId', type: 'Int' }, { name: 'name', type: 'String' },
    { name: 'nameWithOwner', type: 'String' }, { name: 'owner', type: 'User' },
    { name: 'defaultBranchRef', type: 'Ref' }, { name: 'viewerPermission', type: 'String' },
    { name: 'hasIssuesEnabled', type: 'Boolean' }, { name: 'issue', type: 'Issue' },
    { name: 'issues', type: 'IssueConnection' }, { name: 'pullRequests', type: 'PullRequestConnection' },
    { name: 'pullRequest', type: 'PullRequest' },
  ] },
  Issue: { kind: 'OBJECT', fields: [
    { name: 'id', type: 'ID' }, { name: 'number', type: 'Int' }, { name: 'title', type: 'String' },
    { name: 'state', type: 'IssueState' }, { name: 'body', type: 'String' },
    { name: 'createdAt', type: 'String' }, { name: 'updatedAt', type: 'String' },
    { name: 'author', type: 'User' }, { name: 'labels', type: 'LabelConnection' },
    { name: 'comments', type: 'IssueCommentConnection' },
  ] },
  PullRequest: { kind: 'OBJECT', fields: [
    { name: 'id', type: 'ID' }, { name: 'number', type: 'Int' }, { name: 'title', type: 'String' },
    { name: 'body', type: 'String' }, { name: 'headRefName', type: 'String' },
    { name: 'baseRefName', type: 'String' }, { name: 'mergeable', type: 'MergeableState' },
    { name: 'state', type: 'PullRequestState' }, { name: 'merged', type: 'Boolean' },
    { name: 'files', type: 'PullRequestFileConnection' }, { name: 'mergedAt', type: 'String' },
    { name: 'mergeCommitSha', type: 'String' },
  ] },
  User: { kind: 'OBJECT', fields: [
    { name: 'id', type: 'ID' }, { name: 'login', type: 'String' }, { name: 'name', type: 'String' }, { name: 'email', type: 'String' },
  ] },
  Ref: { kind: 'OBJECT', fields: [{ name: 'name', type: 'String' }, { name: 'target', type: 'String' }] },
  IssueConnection: { kind: 'OBJECT', fields: [
    { name: 'nodes', type: 'Issue' }, { name: 'edges', type: 'IssueEdge' },
    { name: 'totalCount', type: 'Int' }, { name: 'pageInfo', type: 'PageInfo' },
  ] },
  PullRequestConnection: { kind: 'OBJECT', fields: [
    { name: 'nodes', type: 'PullRequest' }, { name: 'edges', type: 'PullRequestEdge' },
    { name: 'totalCount', type: 'Int' }, { name: 'pageInfo', type: 'PageInfo' },
  ] },
  IssueEdge: { kind: 'OBJECT', fields: [{ name: 'node', type: 'Issue' }, { name: 'cursor', type: 'String' }] },
  PullRequestEdge: { kind: 'OBJECT', fields: [{ name: 'node', type: 'PullRequest' }, { name: 'cursor', type: 'String' }] },
  PageInfo: { kind: 'OBJECT', fields: [
    { name: 'hasNextPage', type: 'Boolean' }, { name: 'hasPreviousPage', type: 'Boolean' },
    { name: 'startCursor', type: 'String' }, { name: 'endCursor', type: 'String' },
  ] },
  Label: { kind: 'OBJECT', fields: [
    { name: 'id', type: 'ID' }, { name: 'name', type: 'String' }, { name: 'color', type: 'String' }, { name: 'description', type: 'String' },
  ] },
  LabelConnection: { kind: 'OBJECT', fields: [
    { name: 'nodes', type: 'Label' }, { name: 'edges', type: 'LabelEdge' }, { name: 'totalCount', type: 'Int' }, { name: 'pageInfo', type: 'PageInfo' },
  ] },
  LabelEdge: { kind: 'OBJECT', fields: [{ name: 'node', type: 'Label' }, { name: 'cursor', type: 'String' }] },
  IssueComment: { kind: 'OBJECT', fields: [
    { name: 'id', type: 'ID' }, { name: 'body', type: 'String' }, { name: 'author', type: 'User' }, { name: 'createdAt', type: 'String' },
  ] },
  IssueCommentConnection: { kind: 'OBJECT', fields: [
    { name: 'nodes', type: 'IssueComment' }, { name: 'edges', type: 'IssueCommentEdge' },
    { name: 'totalCount', type: 'Int' }, { name: 'pageInfo', type: 'PageInfo' },
  ] },
  IssueCommentEdge: { kind: 'OBJECT', fields: [{ name: 'node', type: 'IssueComment' }, { name: 'cursor', type: 'String' }] },
  PullRequestFileConnection: { kind: 'OBJECT', fields: [
    { name: 'nodes', type: 'PullRequestFile' }, { name: 'edges', type: 'PullRequestFileEdge' },
    { name: 'totalCount', type: 'Int' }, { name: 'pageInfo', type: 'PageInfo' },
  ] },
  PullRequestFileEdge: { kind: 'OBJECT', fields: [{ name: 'node', type: 'PullRequestFile' }, { name: 'cursor', type: 'String' }] },
  PullRequestFile: { kind: 'OBJECT', fields: [
    { name: 'path', type: 'String' }, { name: 'additions', type: 'Int' }, { name: 'deletions', type: 'Int' },
    { name: 'changes', type: 'Int' }, { name: 'status', type: 'String' },
  ] },
  CreateIssuePayload: { kind: 'OBJECT', fields: [{ name: 'issue', type: 'Issue' }] },
  CloseIssuePayload: { kind: 'OBJECT', fields: [{ name: 'issue', type: 'Issue' }] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: [{ name: 'pullRequest', type: 'PullRequest' }] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: [{ name: 'pullRequest', type: 'PullRequest' }] },
  AddCommentPayload: { kind: 'OBJECT', fields: [{ name: 'commentEdge', type: 'IssueCommentEdge' }] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT', 'MILESTONE', 'PULL_REQUEST'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  CreateIssueInput: { kind: 'INPUT_OBJECT', inputFields: ['repositoryId', 'title', 'body'] },
  CloseIssueInput: { kind: 'INPUT_OBJECT', inputFields: ['issueId'] },
  CreatePullRequestInput: { kind: 'INPUT_OBJECT', inputFields: ['repositoryId', 'baseRefName', 'headRefName', 'title', 'body'] },
  MergePullRequestInput: { kind: 'INPUT_OBJECT', inputFields: ['pullRequestId', 'mergeMethod'] },
  AddCommentInput: { kind: 'INPUT_OBJECT', inputFields: ['subjectId', 'body'] },
  IssueOrder: { kind: 'INPUT_OBJECT', inputFields: ['field', 'direction'] },
  String: { kind: 'SCALAR' },
  Int: { kind: 'SCALAR' },
  Boolean: { kind: 'SCALAR' },
  ID: { kind: 'SCALAR' },
  __Type: { kind: 'OBJECT', fields: [
    { name: 'name', type: 'String' }, { name: 'kind', type: 'String' }, { name: 'description', type: 'String' },
    { name: 'fields', type: '__Field' }, { name: 'enumValues', type: '__EnumValue' },
    { name: 'inputFields', type: '__InputValue' },
  ] },
  __Field: { kind: 'OBJECT', fields: [
    { name: 'name', type: 'String' }, { name: 'description', type: 'String' },
    { name: 'args', type: '__InputValue' }, { name: 'type', type: '__Type' },
  ] },
  __InputValue: { kind: 'OBJECT', fields: [
    { name: 'name', type: 'String' }, { name: 'description', type: 'String' }, { name: 'type', type: '__Type' }, { name: 'defaultValue', type: 'String' },
  ] },
  __EnumValue: { kind: 'OBJECT', fields: [{ name: 'name', type: 'String' }, { name: 'description', type: 'String' }] },
  __Schema: { kind: 'OBJECT', fields: [
    { name: 'types', type: '__Type' }, { name: 'queryType', type: '__Type' }, { name: 'mutationType', type: '__Type' }, { name: 'description', type: 'String' },
  ] },
};

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

type Plain = Record<string, unknown>;

interface Ctx {
  variables: Plain;
  fragments: Map<string, SelectionSet>;
  errors: Array<{ message: string }>;
}

function isRecord(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveValue(node: ValueNode, variables: Plain): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.name];
    case 'int': case 'float': case 'string': case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.values.map((child) => resolveValue(child, variables));
    case 'object': {
      const out: Plain = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argValue(field: FieldNode, name: string, variables: Plain): unknown {
  const arg = field.args.find((candidate) => candidate.name === name);
  if (!arg) return undefined;
  return resolveValue(arg.value, variables);
}

function decodeGlobalId(id: string): { kind: string; value: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), value: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function findRepoById(id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'Repository') return null;
  for (const repo of store.repos.values()) {
    if (repo.globalId === id || String(repo.databaseId) === decoded.value) return repo;
  }
  return null;
}

function findIssueById(id: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'Issue') return null;
  const parts = decoded.value.split(':');
  const dbId = parts[0] as string;
  const number = Number(parts[1]);
  for (const repo of store.repos.values()) {
    if (String(repo.databaseId) !== dbId) continue;
    const issue = repo.issues.find((candidate) => candidate.number === number);
    if (issue) return { repo, issue };
  }
  return null;
}

function findPrById(id: string): { repo: Repo; pr: PullRequest } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'PullRequest') return null;
  const parts = decoded.value.split(':');
  const dbId = parts[0] as string;
  const number = Number(parts[1]);
  for (const repo of store.repos.values()) {
    if (String(repo.databaseId) !== dbId) continue;
    const pr = repo.prs.find((candidate) => candidate.number === number);
    if (pr) return { repo, pr };
  }
  return null;
}

function typeOf(value: unknown): string {
  if (!isRecord(value) || typeof value.__type !== 'string') return '';
  return value.__type;
}

function wrapRepo(repo: Repo): Plain {
  return { __type: 'Repository', repo };
}
function wrapIssue(repo: Repo, issue: Issue): Plain {
  return { __type: 'Issue', repo, issue };
}
function wrapPr(repo: Repo, pr: PullRequest): Plain {
  return { __type: 'PullRequest', repo, pr };
}
function wrapUser(login: string): Plain {
  return { __type: 'User', login, id: login === VIEWER_LOGIN ? VIEWER_USER.id : 1000, name: login === VIEWER_LOGIN ? VIEWER_USER.name : login, email: login === VIEWER_LOGIN ? VIEWER_USER.email : '' };
}

function makeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`).toString('base64url');
}

function cursorNumber(cursor: string | null | undefined): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number(text.slice('cursor:'.length));
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

// Issues connection: sorted per orderBy, then windowed by first/after.
function issuesConnection(repo: Repo, field: FieldNode, ctx: Ctx): Plain {
  const first = argValue(field, 'first', ctx.variables);
  const after = argValue(field, 'after', ctx.variables);
  const states = argValue(field, 'states', ctx.variables);
  const orderBy = argValue(field, 'orderBy', ctx.variables);
  let list = repo.issues.slice();
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  let descending = false;
  if (isRecord(orderBy)) {
    descending = String(orderBy.direction ?? '').toUpperCase() === 'DESC';
  }
  list.sort((a, b) => {
    const bySeq = descending ? b.createdSeq - a.createdSeq : a.createdSeq - b.createdSeq;
    if (bySeq !== 0) return bySeq;
    return descending ? b.number - a.number : a.number - b.number;
  });
  const afterNumber = cursorNumber(typeof after === 'string' ? after : null);
  if (afterNumber !== null) {
    list = list.filter((issue) => (descending ? issue.number < afterNumber : issue.number > afterNumber));
  }
  const limit = typeof first === 'number' ? first : list.length;
  const window = list.slice(0, limit);
  const hasNextPage = list.length > window.length;
  return {
    __type: 'IssueConnection',
    nodes: window.map((issue) => wrapIssue(repo, issue)),
    edges: window.map((issue) => ({ __type: 'IssueEdge', node: wrapIssue(repo, issue), cursor: makeCursor(issue.number) })),
    totalCount: repo.issues.length,
    pageInfo: {
      __type: 'PageInfo',
      hasNextPage,
      hasPreviousPage: afterNumber !== null,
      startCursor: window.length > 0 ? makeCursor((window[0] as Issue).number) : null,
      endCursor: window.length > 0 ? makeCursor((window[window.length - 1] as Issue).number) : null,
    },
  };
}

function prsConnection(repo: Repo, field: FieldNode, ctx: Ctx): Plain {
  const first = argValue(field, 'first', ctx.variables);
  const after = argValue(field, 'after', ctx.variables);
  let list = repo.prs.slice().sort((a, b) => a.createdSeq - b.createdSeq);
  const afterNumber = cursorNumber(typeof after === 'string' ? after : null);
  if (afterNumber !== null) list = list.filter((pr) => pr.number > afterNumber);
  const limit = typeof first === 'number' ? first : list.length;
  const window = list.slice(0, limit);
  const hasNextPage = list.length > window.length;
  return {
    __type: 'PullRequestConnection',
    nodes: window.map((pr) => wrapPr(repo, pr)),
    edges: window.map((pr) => ({ __type: 'PullRequestEdge', node: wrapPr(repo, pr), cursor: makeCursor(pr.number) })),
    totalCount: repo.prs.length,
    pageInfo: {
      __type: 'PageInfo',
      hasNextPage,
      hasPreviousPage: afterNumber !== null,
      startCursor: window.length > 0 ? makeCursor((window[0] as PullRequest).number) : null,
      endCursor: window.length > 0 ? makeCursor((window[window.length - 1] as PullRequest).number) : null,
    },
  };
}

function prFiles(repo: Repo, pr: PullRequest, field: FieldNode, ctx: Ctx): Plain {
  const first = argValue(field, 'first', ctx.variables);
  const headInfo = commitInfo(repo, pr.headSha);
  const baseInfo = commitInfo(repo, pr.mergeBaseSha);
  const changes = headInfo && baseInfo ? diffTrees(repo, baseInfo.tree, headInfo.tree) : [];
  const nodes = changes.map((change) => ({
    __type: 'PullRequestFile',
    path: change.path,
    additions: change.additions,
    deletions: change.deletions,
    changes: change.additions + change.deletions,
    status: change.status,
  }));
  const limit = typeof first === 'number' ? first : nodes.length;
  const window = nodes.slice(0, limit);
  return {
    __type: 'PullRequestFileConnection',
    nodes: window,
    edges: window.map((node) => ({ __type: 'PullRequestFileEdge', node, cursor: '' })),
    totalCount: nodes.length,
    pageInfo: { __type: 'PageInfo', hasNextPage: nodes.length > window.length, hasPreviousPage: false, startCursor: null, endCursor: null },
  };
}

function prState(pr: PullRequest): string {
  if (pr.state === 'open') return 'OPEN';
  if (pr.merged) return 'MERGED';
  return 'CLOSED';
}

// Resolve one field on a wrapped value. Returns undefined when the
// field is unknown (error recorded) or when the value is null.
function resolveField(parentType: string, parent: Plain, field: FieldNode, ctx: Ctx): unknown {
  const name = field.name;
  const def = SCHEMA[parentType];
  if (def && def.kind === 'OBJECT' && def.fields && !def.fields.some((candidate) => candidate.name === name)) {
    ctx.errors.push({ message: `Cannot query field "${name}" on type "${parentType}".` });
    return undefined;
  }

  switch (parentType) {
    case 'Query': {
      if (name === 'viewer') return wrapUser(VIEWER_LOGIN);
      if (name === 'repository') {
        const owner = String(argValue(field, 'owner', ctx.variables) ?? '');
        const repoName = String(argValue(field, 'name', ctx.variables) ?? '');
        const repo = store.getRepo(owner, repoName);
        return repo ? wrapRepo(repo) : null;
      }
      if (name === 'node') {
        const id = String(argValue(field, 'id', ctx.variables) ?? '');
        const decoded = decodeGlobalId(id);
        if (!decoded) return null;
        if (decoded.kind === 'Repository') {
          const repo = findRepoById(id);
          return repo ? wrapRepo(repo) : null;
        }
        if (decoded.kind === 'Issue') {
          const found = findIssueById(id);
          return found ? wrapIssue(found.repo, found.issue) : null;
        }
        if (decoded.kind === 'PullRequest') {
          const found = findPrById(id);
          return found ? wrapPr(found.repo, found.pr) : null;
        }
        return null;
      }
      if (name === '__type') {
        const typeName = String(argValue(field, 'name', ctx.variables) ?? '');
        return { __type: '__Type', typeName };
      }
      if (name === '__schema') return { __type: '__Schema' };
      break;
    }
    case 'Mutation': {
      if (name === 'createIssue') return mutateCreateIssue(field, ctx);
      if (name === 'closeIssue') return mutateCloseIssue(field, ctx);
      if (name === 'createPullRequest') return mutateCreatePullRequest(field, ctx);
      if (name === 'mergePullRequest') return mutateMergePullRequest(field, ctx);
      if (name === 'addComment') return mutateAddComment(field, ctx);
      break;
    }
    case 'Repository': {
      const repo = parent.repo as Repo;
      if (name === 'id') return repo.globalId;
      if (name === 'databaseId') return repo.databaseId;
      if (name === 'name') return repo.name;
      if (name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (name === 'owner') return wrapUser(repo.owner);
      if (name === 'defaultBranchRef') {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        return tip ? { __type: 'Ref', name: repo.defaultBranch, target: tip } : null;
      }
      if (name === 'viewerPermission') return 'ADMIN';
      if (name === 'hasIssuesEnabled') return true;
      if (name === 'issue') {
        const number = argValue(field, 'number', ctx.variables);
        const issue = repo.issues.find((candidate) => candidate.number === number);
        return issue ? wrapIssue(repo, issue) : null;
      }
      if (name === 'issues') return issuesConnection(repo, field, ctx);
      if (name === 'pullRequests') return prsConnection(repo, field, ctx);
      if (name === 'pullRequest') {
        const number = argValue(field, 'number', ctx.variables);
        const pr = repo.prs.find((candidate) => candidate.number === number);
        return pr ? wrapPr(repo, pr) : null;
      }
      break;
    }
    case 'Issue': {
      const issue = parent.issue as Issue;
      const repo = parent.repo as Repo;
      if (name === 'id') return issue.globalId;
      if (name === 'number') return issue.number;
      if (name === 'title') return issue.title;
      if (name === 'body') return issue.body;
      if (name === 'state') return issue.state.toUpperCase();
      if (name === 'createdAt') return issue.createdAt;
      if (name === 'updatedAt') return issue.updatedAt;
      if (name === 'author') return wrapUser(VIEWER_LOGIN);
      if (name === 'labels') {
        const nodes = issue.labels.map((label) => ({ __type: 'Label', id: label.id, name: label.name, color: label.color, description: label.description }));
        return { __type: 'LabelConnection', nodes, edges: nodes.map((node) => ({ __type: 'LabelEdge', node, cursor: '' })), totalCount: nodes.length, pageInfo: { __type: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } };
      }
      if (name === 'comments') {
        const comments = repo.comments.get(issue.number) ?? [];
        const nodes = comments.map((comment) => ({ __type: 'IssueComment', id: comment.globalId, body: comment.body, author: wrapUser(VIEWER_LOGIN), createdAt: comment.createdAt }));
        return { __type: 'IssueCommentConnection', nodes, edges: nodes.map((node) => ({ __type: 'IssueCommentEdge', node, cursor: '' })), totalCount: nodes.length, pageInfo: { __type: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } };
      }
      break;
    }
    case 'PullRequest': {
      const pr = parent.pr as PullRequest;
      const repo = parent.repo as Repo;
      if (name === 'id') return pr.globalId;
      if (name === 'number') return pr.number;
      if (name === 'title') return pr.title;
      if (name === 'body') return pr.body;
      if (name === 'headRefName') return pr.headRef;
      if (name === 'baseRefName') return pr.baseRef;
      if (name === 'mergeable') return prMergeable(repo, pr);
      if (name === 'state') return prState(pr);
      if (name === 'merged') return pr.merged;
      if (name === 'files') return prFiles(repo, pr, field, ctx);
      if (name === 'mergedAt') return pr.mergedAt;
      if (name === 'mergeCommitSha') return pr.mergeCommitSha;
      break;
    }
    case 'User': {
      if (name === 'id') return parent.id ?? 1000;
      if (name === 'login') return parent.login;
      if (name === 'name') return parent.name ?? parent.login;
      if (name === 'email') return parent.email ?? '';
      break;
    }
    case 'Ref': {
      if (name === 'name') return parent.name;
      if (name === 'target') return parent.target;
      break;
    }
    case 'IssueConnection': case 'PullRequestConnection': case 'LabelConnection': case 'IssueCommentConnection': case 'PullRequestFileConnection': {
      if (name === 'nodes') return parent.nodes;
      if (name === 'edges') return parent.edges;
      if (name === 'totalCount') return parent.totalCount;
      if (name === 'pageInfo') return parent.pageInfo;
      break;
    }
    case 'IssueEdge': case 'PullRequestEdge': case 'LabelEdge': case 'IssueCommentEdge': case 'PullRequestFileEdge': {
      if (name === 'node') return parent.node;
      if (name === 'cursor') return parent.cursor;
      break;
    }
    case 'PageInfo': {
      if (name === 'hasNextPage') return parent.hasNextPage;
      if (name === 'hasPreviousPage') return parent.hasPreviousPage;
      if (name === 'startCursor') return parent.startCursor;
      if (name === 'endCursor') return parent.endCursor;
      break;
    }
    case 'Label': {
      if (name === 'id') return parent.id;
      if (name === 'name') return parent.name;
      if (name === 'color') return parent.color;
      if (name === 'description') return parent.description;
      break;
    }
    case 'IssueComment': {
      if (name === 'id') return parent.id;
      if (name === 'body') return parent.body;
      if (name === 'author') return parent.author;
      if (name === 'createdAt') return parent.createdAt;
      break;
    }
    case 'PullRequestFile': {
      if (name === 'path') return parent.path;
      if (name === 'additions') return parent.additions;
      if (name === 'deletions') return parent.deletions;
      if (name === 'changes') return parent.changes;
      if (name === 'status') return parent.status;
      break;
    }
    case '__Type': {
      const typeName = parent.typeName as string;
      const typeDef = SCHEMA[typeName];
      if (name === 'name') return typeName;
      if (name === 'kind') return typeDef ? typeDef.kind : null;
      if (name === 'description') return null;
      if (name === 'fields') {
        if (!typeDef || typeDef.kind !== 'OBJECT') return null;
        return (typeDef.fields ?? []).map((candidate) => ({
          __type: '__Field', name: candidate.name, description: null,
          args: [], type: { __type: '__Type', typeName: candidate.type },
        }));
      }
      if (name === 'enumValues') {
        if (!typeDef || typeDef.kind !== 'ENUM') return null;
        return (typeDef.enumValues ?? []).map((value) => ({ __type: '__EnumValue', name: value, description: null }));
      }
      if (name === 'inputFields') {
        if (!typeDef || typeDef.kind !== 'INPUT_OBJECT') return null;
        return (typeDef.inputFields ?? []).map((inputName) => ({
          __type: '__InputValue', name: inputName, description: null,
          type: { __type: '__Type', typeName: 'String' }, defaultValue: null,
        }));
      }
      break;
    }
    case '__Field': {
      if (name === 'name') return parent.name;
      if (name === 'description') return parent.description ?? null;
      if (name === 'args') return parent.args ?? [];
      if (name === 'type') return parent.type;
      break;
    }
    case '__InputValue': {
      if (name === 'name') return parent.name;
      if (name === 'description') return parent.description ?? null;
      if (name === 'type') return parent.type;
      if (name === 'defaultValue') return parent.defaultValue ?? null;
      break;
    }
    case '__EnumValue': {
      if (name === 'name') return parent.name;
      if (name === 'description') return parent.description ?? null;
      break;
    }
    case '__Schema': {
      if (name === 'types') return Object.keys(SCHEMA).map((typeName) => ({ __type: '__Type', typeName }));
      if (name === 'queryType') return { __type: '__Type', typeName: 'Query' };
      if (name === 'mutationType') return { __type: '__Type', typeName: 'Mutation' };
      if (name === 'description') return null;
      break;
    }
    case 'CreateIssuePayload': case 'CloseIssuePayload': {
      if (name === 'issue') return parent.issue;
      break;
    }
    case 'CreatePullRequestPayload': case 'MergePullRequestPayload': {
      if (name === 'pullRequest') return parent.pullRequest;
      break;
    }
    case 'AddCommentPayload': {
      if (name === 'commentEdge') return parent.commentEdge;
      break;
    }
  }

  ctx.errors.push({ message: `Cannot query field "${name}" on type "${parentType}".` });
  return undefined;
}

// Execute a selection set against a wrapped value (or the root).
function executeSelectionSet(parentType: string, parent: unknown, selections: SelectionSet, ctx: Ctx): Plain {
  const out: Plain = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (!fragment) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      const nested = executeSelectionSet(parentType, parent, fragment, ctx);
      Object.assign(out, nested);
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition !== null && selection.typeCondition !== parentType) continue;
      const nested = executeSelectionSet(parentType, parent, selection.selectionSet, ctx);
      Object.assign(out, nested);
      continue;
    }
    const field = selection as FieldNode;
    const responseKey = field.alias ?? field.name;
    const value = resolveField(parentType, parent as Plain, field, ctx);
    if (value === undefined) continue;
    if (field.selectionSet && value !== null && value !== undefined) {
      if (Array.isArray(value)) {
        out[responseKey] = value.map((item) => {
          if (isRecord(item)) return executeSelectionSet(typeOf(item), item, field.selectionSet as SelectionSet, ctx);
          return item;
        });
      } else if (isRecord(value)) {
        out[responseKey] = executeSelectionSet(typeOf(value), value, field.selectionSet, ctx);
      } else {
        out[responseKey] = value;
      }
    } else {
      out[responseKey] = value;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// mutations (shared with REST counters and ids)
// ---------------------------------------------------------------------------

function mutateCreateIssue(field: FieldNode, ctx: Ctx): Plain | null {
  const input = argValue(field, 'input', ctx.variables);
  if (!isRecord(input)) {
    ctx.errors.push({ message: 'createIssue requires an input object.' });
    return null;
  }
  const repo = findRepoById(String(input.repositoryId ?? ''));
  if (!repo) {
    ctx.errors.push({ message: 'Repository not found.' });
    return null;
  }
  const title = String(input.title ?? '');
  if (title === '') {
    ctx.errors.push({ message: 'title is required.' });
    return null;
  }
  repo.issueCounter += 1;
  store.issueIdCounter += 1;
  const now = trialNowIso();
  const issue: Issue = {
    id: store.issueIdCounter,
    globalId: Buffer.from(`Issue:${repo.databaseId}:${repo.issueCounter}`).toString('base64url'),
    number: repo.issueCounter,
    title,
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    labels: [],
    createdSeq: nextSeq(),
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
  repo.issues.push(issue);
  return { __type: 'CreateIssuePayload', issue: wrapIssue(repo, issue) };
}

function mutateCloseIssue(field: FieldNode, ctx: Ctx): Plain | null {
  const input = argValue(field, 'input', ctx.variables);
  if (!isRecord(input)) {
    ctx.errors.push({ message: 'closeIssue requires an input object.' });
    return null;
  }
  const found = findIssueById(String(input.issueId ?? ''));
  if (!found) {
    ctx.errors.push({ message: 'Issue not found.' });
    return null;
  }
  found.issue.state = 'closed';
  found.issue.closedAt = trialNowIso();
  found.issue.updatedAt = trialNowIso();
  found.repo.issueJsonCache.delete(found.issue.number);
  return { __type: 'CloseIssuePayload', issue: wrapIssue(found.repo, found.issue) };
}

function mutateCreatePullRequest(field: FieldNode, ctx: Ctx): Plain | null {
  const input = argValue(field, 'input', ctx.variables);
  if (!isRecord(input)) {
    ctx.errors.push({ message: 'createPullRequest requires an input object.' });
    return null;
  }
  const repo = findRepoById(String(input.repositoryId ?? ''));
  if (!repo) {
    ctx.errors.push({ message: 'Repository not found.' });
    return null;
  }
  const head = String(input.headRefName ?? '');
  const base = String(input.baseRefName ?? '');
  const title = String(input.title ?? '');
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (!headSha || !baseSha || title === '') {
    ctx.errors.push({ message: 'head or base branch does not exist.' });
    return null;
  }
  const existing = repo.prs.find((pr) => pr.state === 'open' && pr.headRef === head && pr.baseRef === base);
  if (existing) {
    ctx.errors.push({ message: 'A pull request already exists for this head and base.' });
    return null;
  }
  repo.prCounter += 1;
  store.prIdCounter += 1;
  const now = trialNowIso();
  const pr: PullRequest = {
    id: store.prIdCounter,
    globalId: Buffer.from(`PullRequest:${repo.databaseId}:${repo.prCounter}`).toString('base64url'),
    number: repo.prCounter,
    title,
    body: typeof input.body === 'string' ? input.body : '',
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
  return { __type: 'CreatePullRequestPayload', pullRequest: wrapPr(repo, pr) };
}

function mutateMergePullRequest(field: FieldNode, ctx: Ctx): Plain | null {
  const input = argValue(field, 'input', ctx.variables);
  if (!isRecord(input)) {
    ctx.errors.push({ message: 'mergePullRequest requires an input object.' });
    return null;
  }
  const found = findPrById(String(input.pullRequestId ?? ''));
  if (!found) {
    ctx.errors.push({ message: 'Pull request not found.' });
    return null;
  }
  const { repo, pr } = found;
  if (pr.merged || pr.state !== 'open') {
    ctx.errors.push({ message: 'Pull request is already closed.' });
    return null;
  }
  const mergeSha = squashMerge(repo, pr);
  if (mergeSha === null) {
    ctx.errors.push({ message: 'Merge conflict.' });
    return null;
  }
  pr.merged = true;
  pr.state = 'closed';
  pr.mergedAt = trialNowIso();
  pr.mergeCommitSha = mergeSha;
  pr.closedAt = pr.mergedAt;
  pr.updatedAt = trialNowIso();
  return { __type: 'MergePullRequestPayload', pullRequest: wrapPr(repo, pr) };
}

function mutateAddComment(field: FieldNode, ctx: Ctx): Plain | null {
  const input = argValue(field, 'input', ctx.variables);
  if (!isRecord(input)) {
    ctx.errors.push({ message: 'addComment requires an input object.' });
    return null;
  }
  const found = findIssueById(String(input.subjectId ?? ''));
  if (!found) {
    ctx.errors.push({ message: 'Issue not found.' });
    return null;
  }
  const text = String(input.body ?? '');
  if (text === '') {
    ctx.errors.push({ message: 'body is required.' });
    return null;
  }
  const { repo, issue } = found;
  repo.commentCounter += 1;
  store.commentIdCounter += 1;
  const now = trialNowIso();
  const comment = {
    id: store.commentIdCounter,
    globalId: Buffer.from(`IssueComment:${repo.databaseId}:${issue.number}:${repo.commentCounter}`).toString('base64url'),
    body: text,
    createdAt: now,
    updatedAt: now,
  };
  const list = repo.comments.get(issue.number) ?? [];
  list.push(comment);
  repo.comments.set(issue.number, list);
  repo.issueJsonCache.delete(issue.number);
  const node = { __type: 'IssueComment', id: comment.globalId, body: comment.body, author: wrapUser(VIEWER_LOGIN), createdAt: comment.createdAt };
  return { __type: 'AddCommentPayload', commentEdge: { __type: 'IssueCommentEdge', node, cursor: '' } };
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export interface GraphqlResult {
  status: number;
  body: string;
}

function executeOperation(operation: OperationNode, variables: Plain, fragments: Map<string, SelectionSet>): Plain {
  const ctx: Ctx = { variables: { ...variables }, fragments, errors: [] };
  for (const def of operation.variableDefinitions) {
    if (ctx.variables[def.name] === undefined && def.defaultValue !== null) {
      ctx.variables[def.name] = resolveValue(def.defaultValue, ctx.variables);
    }
  }
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(rootType, {}, operation.selectionSet, ctx);
  const result: Plain = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

export function handleGraphql(body: unknown): GraphqlResult {
  const respond = (value: unknown): GraphqlResult => ({ status: 200, body: JSON.stringify(value) });
  if (Array.isArray(body)) {
    const results = body.map((item) => {
      if (!isRecord(item) || typeof item.query !== 'string') return { data: null, errors: [{ message: 'Invalid operation document.' }] };
      return executeOne(item.query, isRecord(item.variables) ? item.variables : {});
    });
    return respond(results);
  }
  if (!isRecord(body) || typeof body.query !== 'string') {
    return respond({ data: null, errors: [{ message: 'Invalid operation document.' }] });
  }
  return respond(executeOne(body.query, isRecord(body.variables) ? body.variables : {}));
}

function executeOne(query: string, variables: Plain): Plain {
  let doc: DocumentNode;
  try {
    doc = new Parser(lex(query)).parseDocument();
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : 'GraphQL parse error' }] };
  }
  if (doc.operations.length === 0) return { data: null, errors: [{ message: 'No operation found.' }] };
  const operation = doc.operations[0] as OperationNode;
  return executeOperation(operation, variables, doc.fragments);
}
