# ProTop API (contract)

The single source of truth between `protop-app/` (Flask, SQLite) and `public/projects/protop/` (vanilla JS).
If you change it, change this file in the same commit and say so.

Base path: **`/projects/protop/api`** (gunicorn runs with `SCRIPT_NAME=/projects/protop/api`; Caddy proxies it).
All responses are JSON (`application/json`) unless noted. Errors are `{"error": "human readable message"}` with a status of
400 (bad input), 404, 405, 409 (room full), 413 (too large), 422 (understood but invalid), 429 (rate limited, with `Retry-After`),
502/504 (an upstream database failed or timed out), 503 (too many rooms, or the catalog snapshot is missing). Every response carries `Cache-Control` and
`X-Content-Type-Options: nosniff`; API responses carry `Content-Security-Policy: default-src 'none'`.
Nothing here needs cookies or accounts. The browser never talks to a third party: the backend fetches RCSB, UniProt, AlphaKnot and
KnotProt itself, validates IDs, caches, and time-limits every upstream call.

## Aggregator (read only, cached)

These keep the **JSON shapes of the old Render backend** (`f23-protop/backend/app/routes.py` + `functions/functions.py`) so the old
Search page's field handling still applies. Only the paths change.

| Method + path | Old route | Notes |
|---|---|---|
| `GET /pdb/<ids>` | `/fetch_pdb/<pdb_ids>` | comma-separated PDB IDs, at most 5; each `^[0-9][A-Za-z0-9]{3}$`. Result keys are the IDs as you wrote them; IDs RCSB does not know are left out (404 if none are known) |
| `GET /uniprot/<id>` | `/fetch_uniprot/<uniprot_id>` | `^[A-Za-z0-9_-]{4,20}$`. Optional `?variants=true` (or `1`) adds the old `variants` map; if the variant service is down the rest is still returned with `"variants_error"` instead |
| `GET /alphaknot/<id>` | `/fetch_alphaknot/<uniprot_id>` | UniProt accession (no `-F1`). Returns columns of lists exactly like the old `to_dict(orient='list')`: `uniprotId, knotType, category, knotProbability, pLDDT_knotCore, knotCoreRange, knotCoreLength, pLDDT_chain, knotCoreStart, knotCoreEnd`; all lists are empty when AlphaKnot has no knot for it. `knotType` uses `3_1` style |
| `GET /knotprot` and `GET /knotprot/<ids>` | `/fetch_knotprot/[<pdb_ids>]` | PDB IDs (at most 50). `{pdbid: {...}}`, keys lower-case for `/knotprot`, as written for `/knotprot/<ids>`; unknown IDs are `null`. Each value is the old per-chain dict of the entry's first chain (`pdbId, chain, chainLength, category, knotCategory, knotType, nCut, cCut, knotRange, knotRangeStart, knotRangeEnd, knotCoreLength`) plus `knotTypeName` (`3_1` form of `knotType`, which stays KnotProt's own code such as `"31"`) plus `chains`: the list of all chain dicts of the entry. Missing values are `null` |
| `GET /structure/<pdbid>.<fmt>` | (new) | `fmt` is `pdb` or `cif`. Coordinates from files.rcsb.org, `text/plain`, <= 8 MB, cached. 404 if RCSB has no such file |

## Catalog (knotted proteins)

Served from a SQLite snapshot (no live MongoDB). `snapshot` says when and from where it was taken.

`GET /catalog?q=&knot=&source=&sort=&order=&page=&per_page=`
- `q` free text over ids and names, `knot` exact knot type, `source` is `alphaknot` or `knotprot`, `sort` one of the returned columns,
  `order` `asc|desc`, `page` from 1, `per_page` 1..100 (default 25).
- Returns `{"total", "page", "per_page", "rows": [...], "facets": {"knot_types": [{"name","count"}], "sources": [{"name","count"}]}, "snapshot": {"date", "sources": [...]}}`.
- Row fields come from the old Mongo documents (`knotcat.py`): at least `uniprotId` and/or `pdbId`, the knot type, knotcore length and
  disease annotations where the sources have them. Name them in camelCase exactly as the old documents did and list them in a comment at the top of the catalog module.

`GET /catalog.csv?...same filters...` -> `text/csv` with a header row, at most 50,000 rows, `Content-Disposition: attachment`.

## Workspace rooms (shared annotation and mutation workspace)

A **room** is one structure plus a shared, append-only log of operations. The room id is an unguessable link
(`secrets.token_urlsafe(16)`, 22 chars of `[A-Za-z0-9_-]`); knowing it is the permission to read and write. No accounts. The
frontend keeps the id in the URL hash (`/projects/protop/workspace/#<id>`) so it never reaches server logs or Referer headers.

`POST /rooms` body `{"pdb": "1R42"}` or `{"upload": {"name": "my.pdb", "text": "<pdb or mmCIF text>"}}`
-> `201 {"id", "created", "expires"}` plus the same body as `GET /rooms/<id>`.
Uploads: <= 5 MB, must parse as PDB or mmCIF text with at least one polymer chain and <= 200,000 atoms, anything else is 422. Rate limit: 10 rooms per hour per IP.
At most 500 live rooms (503 beyond that). A room expires 14 days after its last write or sync; expired rooms are deleted lazily and by a cleanup on startup.

`GET /rooms/<id>` ->
```json
{"id": "...", "created": "ISO-8601", "expires": "ISO-8601", "seq": 17,
 "structure": {"format": "pdb|cif", "title": "...", "source": "pdb:1R42" },
 "chains": [{"name": "A", "residues": [{"num": 1, "icode": "", "aa": "M"}, ...]}]}
```
`aa` is the one-letter code from the ATOM/HETATM polymer residues present in the file (unknown or modified residues are `X`). `num`+`icode` are the
structure's own numbering, the key used everywhere below.

`GET /rooms/<id>/structure` -> the stored coordinates, `text/plain`.

`GET /rooms/<id>/sync?since=<seq>&client=<client id>` -> `{"seq": N, "ops": [...ops with seq > since, in order...], "presence": [...]}`.
Calling it counts as a heartbeat. Poll about every 1.5 s while the tab is visible, every 15 s when hidden.
`client` is a random string (8..32 of `[A-Za-z0-9_-]`) the browser invents once per tab.
Presence entries: `{"client", "name", "color", "chain", "start", "end"}` for clients seen in the last 20 s (the caller included), where chain/start/end may be `null`.

`POST /rooms/<id>/presence` body `{"client", "name", "color", "chain", "start", "end"}` (`start`/`end` are residue `num`s, or all three `null` for no selection) -> `204`.
`name` <= 32 chars, `color` is `#rrggbb`.

`POST /rooms/<id>/ops` one op per request, body below -> `201 {"seq": N, "op": {...}}`. All ops carry `"client"` and `"author"` (display name, <= 32 chars).

| `type` | other fields | meaning |
|---|---|---|
| `annotation` | `chain`, `start`, `end` (residue nums, start <= end), `text` (1..500 chars) | a comment on a residue range |
| `annotation_edit` | `target` (seq of the annotation), `text` | replaces the text |
| `annotation_delete` | `target` | removes it |
| `mutation` | `chain`, `num`, `icode` (optional), `to` (one-letter amino acid), `note` (optional, <= 500) | a proposed substitution; the server fills in `from` and rejects with 422 if the residue does not exist or `to` equals `from` or is not one of `ACDEFGHIKLMNPQRSTVWY` |
| `mutation_status` | `target`, `status` is `proposed`, `accepted` or `rejected` | anyone with the link may set it; the last op wins |
| `mutation_delete` | `target` | removes it |

A stored op is `{"seq", "type", "ts": "ISO-8601", "author", "client", ...the fields above..., "from"?}`. **Clients fold the log**: for each annotation/mutation
the newest edit/status/delete op with `target == its seq` wins. The server validates targets (422 if the target is not an op of the right kind).
Limits: request body <= 40 KB; <= 200 live annotations and <= 200 live mutations per room; <= 2,000 ops per room (409 `"This room is full."`); 120 ops per minute per IP.

`GET /rooms/<id>/export?format=fasta|json`
- `fasta`: one record per chain with **accepted mutations applied**; the header lists them (`>1R42_A mutated: M1V,K42R`). `text/plain`.
- `json`: `{"room", "structure", "chains", "annotations": [...live...], "mutations": [{... "status"}], "exported": "ISO"}`. `application/json`, `Content-Disposition: attachment`.

## Client IP and limits

Rate limits key on the visitor address exactly as `openchat-app/openchat/security.py` does (`CF-Connecting-IP` trusted only when the direct peer is a private address).

## Implementation notes (binding where they add detail to the above)

**Status codes.** Malformed ids, wrong types and unknown enum values are **400**; well-formed values that are out of range or do not fit the data
(text length, residue not in the structure, `start > end`, bad target, bad `status`) are **422**. A room id that is malformed, unknown or expired is
always **404**. Aggregator: an invalid id is 400 before any upstream call; an upstream 404 (or 400) is 404; other upstream failures are 502, timeouts 504;
too many uncached lookups per IP (60/min) or the server being busy with other lookups is **429** with `Retry-After`. Upstream calls are cached 24 h and a stale copy is served if the upstream fails.

**Catalog.** Row = `{id, source, uniprotId, pdbId, chain, knotType, knotCategory, category, organism, proteinName, chainLength, knotCoreLength, knotCoreRange,
knotCoreStart, knotCoreEnd, knotProbability, pLDDT_knotCore, pLDDT_chain, nCut, cCut, diseases}`; every key is always present (`null` when unknown), `diseases` is a list of
UniProt disease names, `id` is a stable row number. `source=alphaknot` rows have `uniprotId` (AlphaKnot AF1-Knot predictions: organism, knot probability, pLDDT);
`source=knotprot` rows have `pdbId`+`chain` (`knotCategory` K knot / S slipknot, `category` Y published / A artifact / T not published) and, where RCSB maps it, a `uniprotId`,
`proteinName` and `organism`. `knotType` is always the `3_1` form (the `knot` filter also accepts `31`). `sort` may be any row key except `id`; sorting by `knotType` orders numerically
by crossing number (3_1, 4_1, ... 8_20, 10_1); null values sort last in both directions; default sort `knotType asc`. `q` is split on spaces (max 5 terms, all must match) over ids, knot type,
organism, protein name, disease names. Bad `sort|order|page|per_page|source` -> 400. Facets: `knot_types` ignores the `knot` filter and `sources` ignores the `source` filter (so they show the alternatives), both honour `q`.
`snapshot` = `{"date": "YYYY-MM-DD", "sources": ["human readable string", ...], "note": "...", "total": rows in the whole snapshot}`. CSV columns are the row keys above without `id`, `diseases` joined with `; `.

**Rooms.**
- `POST /rooms` with an unknown PDB id: 404. A PDB entry whose coordinates exceed the 5 MB / 200,000 atom limits: 422. Upload text above 5 MB: 422; a request body above ~6 MB: 413.
  Failed uploads do not use up the 10-rooms-per-hour allowance, but more than 60 attempts per hour are 429.
- Only the first model is read. mmCIF polymer residues are the rows with a `label_seq_id`; PDB polymer residues are `ATOM` records plus `HETATM` records of known modified amino acids (reported as `X`). A blank PDB chain id is named `_`.
- `aa` for nucleotides is `X`. Chain `name`s are 1..8 printable characters.
- A stored op always has `author` (empty or whitespace-only becomes `"Anonymous"`) and `client`. Mutation ops always carry `icode` (`""` if none), `note` (`""` if none) and `from`.
- Folding rules the server enforces: editing, status-changing or deleting a target that was already deleted is 422; targets must be earlier ops of the right kind. Exceeding 200 live annotations or 200 live mutations is 409 (`"This room already has 200 annotations."`), a full log is 409 `"This room is full."`.
- `sync`: `since` must be a non-negative integer (400 otherwise), `client` optional but 400 if malformed. `seq` and `ops` come from one consistent snapshot. Presence entries created by a bare sync heartbeat show name `"Anonymous"`, color `#888888` and null selection until the client posts its presence. `color` is stored lower-case.
  Sync extends the 14-day expiry at most once per 10 minutes; any accepted op extends it immediately. `GET /rooms/<id>` alone does not extend it.
- Extra limits: 600 syncs/min and 300 presence posts/min per IP (429), `Retry-After` always set on 429. Presence body <= 4 KB.
- Export `json`: `annotations` are `{seq, type, ts, author, client, chain, start, end, text}` with the folded (latest) text; `mutations` are the live mutation ops with `status`. `fasta` header: `>{pdbid or upload file stem}_{chain}` plus ` mutated: M1V,K42R` (`{from}{num}{icode}{to}`, applied in op order).
- Text fields: all control characters other than newline (plus bidi overrides, zero-width marks and U+2028/2029) are removed; everything else is stored verbatim. `text`/`note` keep newlines; `author`/`name`/upload `name` do not.
