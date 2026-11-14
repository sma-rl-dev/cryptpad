# CryptPad — tester-env deployment (SMA fork)

Pinned baseline: **2026.5.1** @ `3b3bb6b28d570f747e03920d720fef152b8d26d4`
(upstream `cryptpad/cryptpad`, latest stable release tag; no skip rationale).

This fork adds the tester-env deployment tooling on top of that pristine tag.
No application source is modified.

| File | Purpose |
|---|---|
| `tester-env` | CLI: `deploy` / `seed` / `verify` / `reset` / `stop` / `logs` / `status` / `help` |
| `Dockerfile.tester-env` | editable-source image (deps + components layers cached, source copied last) |
| `tester-env-entrypoint.sh` | generates `config/config.js`, pins origins, `npm run build`, `npm start` |
| `scripts/tester-env-seed.cjs` | deterministic headless seed + `--verify` |

Upstream `Dockerfile`, `docker-compose.yml` and `docker-entrypoint.sh` are left untouched.
OnlyOffice is never installed.

## Quick Start

```bash
./tester-env deploy   # build image from source, start container, wait for HTTP
./tester-env seed     # fixed account rl-tester + 3 documents + Notes folder
./tester-env verify   # HTTP/config/seed assertions (non-zero on failure)
./tester-env reset    # remove container + 5 data volumes (image kept)
```

`scripts/rl-env` invokes `reset` → `deploy` → `seed` with
`--run-id <id> --port <port>` and env `IMAGE_TAG`, `PORT`,
`TESTER_ENV_BROWSER_ORIGIN`. Manual runs work with defaults.

## Ports and origins

| Role | Manual default | Runner |
|---|---|---|
| main app | `http://host.docker.internal:8240/` | `http://<bridge-gateway>:<port>/` |
| CSP sandbox | main port + 1 | main port + 1 |
| websocket | main port + 2, **not published** (proxied via `/cryptpad_websocket`) | same |

The container listens and publishes `PORT` and `PORT+1` with identical
host:container numbers so upstream `lib/env.js` derives `httpSafeOrigin` as
`httpUnsafeOrigin` port + 1.

`tester-env` sets `ApiConfig.httpUnsafeOrigin` from
`TESTER_ENV_BROWSER_ORIGIN` (exported by `scripts/rl-env`, matching
`ts-runner`'s browser URL) and falls back to
`http://host.docker.internal:<port>` for manual/MCP-browser runs. This matters:
CryptPad gates app paths **client-side** in
`www/common/sframe-common-outer.js` (`window.location.origin !==
ApiConfig.httpUnsafeOrigin` ⇒ “only be accessed via …” modal + stuck Loading).
The server itself does not gate on the `Host` header, so host-side
`curl http://localhost:<port>/` still works for diagnostics.

`httpSafePort` is deliberately left at its commented default: setting it
explicitly leaves `Env.httpSafePort` undefined upstream and the sandbox
listener never starts.

## Seed data (deterministic)

Account: `rl-tester` / `Test-Password-RL-2026-Seed!`

| Entry | Type | Notes |
|---|---|---|
| `Q2 Launch Plan` | Code | drive root; file id `1000000000001`, channel `d91836ed120f2ac96b98840115529d09` |
| `Notes/Team Standup Notes` | Code | file id `1000000000002`, channel `38b42933018bec4128bad251355ec7c7` |
| `Notes/Shared Links` | Code | file id `1000000000003`, channel `db7965e630dfd8563ddd74838b034553` |

Drive channel `5b2afd40de9f0ab1fe6cb4279062438f`; all `ctime/atime` fixed at
`2026-05-01T09:00:00Z` (+1 s/+2 s); Templates and Trash empty.

CryptPad accounts are end-to-end encrypted, so there is no server seed API.
`scripts/tester-env-seed.cjs` reproduces the browser registration flow
headlessly inside the container: scrypt-derived keys in the same byte order as
`www/common/common-login.js`, `Block.writeLoginBlock` with `User_hash`, three
pad channels with fixed content, then the account drive user-object. Every
random value is replaced by `SHA256('cryptpad-seed/v1/'+label)`, so
reset → deploy → seed reproduces identical channels, hrefs and content.
The seed is idempotent (exits 0 when the account channel is already populated)
and the CLI passes `CPAD_MAIN_PORT` / `CPAD_MAIN_ORIGIN` so it works on any
allocated port.

## Verify

`./tester-env verify` asserts, from the host:

- main page serves CryptPad on `PORT`;
- `/api/config` advertises the expected unsafe and sandbox origins;
- sandbox origin answers on `PORT+1`;
- `/api/broadcast` answers;
- then runs the seed read-back: login block/edPublic match the fixed
  derivation, 3 documents with expected titles, channels, `ctime` and
  read-only hrefs, Notes folder with 2 children, empty templates/trash, and
  each document's exact content.

`verify` does **not** prove browser rendering — use a GUI/browser pass for that
(“Saved” status, Users panel, drive listing).

## Safety notes

- `reset` removes only `tester-env-cryptpad[-<run-id>]` and
  `cryptpad[-<run-id>]-{blob,block,customize,data,datastore}`.
- The image is **never** removed by the CLI (`docker rmi` is not used); image
  tags are content-addressed and shared across in-flight runs. Reclaim with
  `scripts/rl-env gc --prune-images`.
- No broad `docker prune`, no volume/image-wide cleanup, and no interaction
  with `alevern/chromium-browser` or `chromium-ls*` browser containers.
- `IMAGE_TAG` is honoured verbatim; `RUN_ID` scopes only container and volume
  names, never the image tag.

## Evidence (this fork)

- Source build: image `tester-env-cryptpad:dev` from the tag tree; first boot
  runs `npm run build` (several minutes) then answers on `PORT`.
- Reset: removes container + 5 volumes; redeploy + verify fully green.
- Deterministic seed: 3 independent reset/deploy/seed/verify cycles produced
  identical channel ids (see table above).
- Browser smoke, MCP browser (`host.docker.internal:8240`): landing page,
  `/login/` → `/drive/#` with `Notes` + `Q2 Launch Plan`, `Notes` → 2 documents,
  `Team Standup Notes` opens the Code editor with `# Standup 2026-05-01`,
  `- Alice: API done`, `Saved`, `Users: rl-tester`.
- Browser smoke, runner origin (`http://172.16.0.1:8240`, bridge gateway,
  `TESTER_ENV_BROWSER_ORIGIN` set): same login → drive → Notes → document path
  with no origin modal and no stuck Loading; `/api/config` advertises
  `http://172.16.0.1:8240`.
- Port/origin parameterization: `deploy --port 8260` with
  `TESTER_ENV_BROWSER_ORIGIN=http://172.16.0.1:8260` produced the same drive and
  document channel ids; `/api/config` advertised unsafe `172.16.0.1:8260` and
  sandbox `172.16.0.1:8261`; browser login → drive listing passed on 8260.
- The seed's HTTP/websocket client uses container loopback
  (`http://localhost:<port>`), not the browser origin: `host.docker.internal`
  does not resolve inside the app container.
