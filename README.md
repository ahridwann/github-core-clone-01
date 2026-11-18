# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/ahridwann/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/ahridwann/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A single-process, in-memory GitHub-compatible forge: git smart HTTP (upload-pack v2 + v0, receive-pack v0), REST v3, GraphQL v4, and an MCP endpoint, all backed by the same store. Node 22 stdlib only — no dependencies, no git binary, no network.

## Run it

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the harness lifecycle (kept as the starter shipped it): bind an ephemeral port, `POST {port}` to `$MAKEFUN_ENV_URL/register`, poll `/done`, exit 0. It needs `MAKEFUN_ENV_URL` set; `MAKEFUN_SHOP_TOKEN` enables Bearer auth on the REST/GraphQL/MCP surfaces when set.

---

<sub>Entered on [make.fun](https://make.fun/?ref=kc98nxwf&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

## Layout

- `main.ts` — lifecycle (starter, unchanged).
- `app.ts` — one `node:http` server, routing + body reading + request ids.
- `lib/store.ts` — in-memory repos, refs, objects, issues, PRs, labels, comments; deterministic timestamps from `MAKEFUN_TRIAL_NOW`.
- `lib/git-pack.ts` — pkt-line codec, SHA-1 objects, pack read/write (OFS/REF deltas, thin packs).
- `lib/git-protocol.ts` — smart HTTP: info/refs (v2 + v0), ls-refs, fetch (shallow/deepen), receive-pack with fast-forward enforcement.
- `lib/rest.ts` — REST v3: repos, branches, commits, contents, git refs, labels, issues + comments, pull requests + merge (squash).
- `lib/graphql.ts` — GraphQL executor for the documents gh and github-mcp-server send: viewer, repository, node(id:), `__type` / `__schema`, and the create/close/merge/addComment mutations.
- `lib/mcp.ts` — MCP JSON-RPC 2.0 Streamable HTTP: `server/discover` (2026-07-28) and legacy `initialize`, 8 tools.
- `lib/scenario.ts` — deterministic derivation of the viewer login from the public scenario seed.

## Notes

- State is in-memory and single-trial: there is no persistence.
- Timestamps come from `MAKEFUN_TRIAL_NOW` (fallback 2025-01-01); no `Date.now()` feeds anything the suite can compare.
- Fetch pack bytes are cached per repo version + request shape; the clone workload hits the same shallow fetch 50x concurrently.
- GraphQL covers the documented query/mutation surface (the documents in the conformance suite), not arbitrary GraphQL.
