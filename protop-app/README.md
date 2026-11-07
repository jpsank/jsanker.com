# ProTop backend

Flask 3 + SQLite backend for the revived 2023 Yale ProTop project: a cached aggregator for RCSB, UniProt, AlphaKnot and KnotProt,
a knotted-protein catalog (read-only SQLite snapshot) and collaborative workspace rooms. The contract with the frontend is
[API.md](API.md). It is same-origin only: no CORS, no cookies, no accounts.

## Run locally

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
SCRIPT_NAME=/projects/protop/api .venv/bin/gunicorn -w 1 --threads 4 -b 127.0.0.1:8000 wsgi:app
# e.g. http://127.0.0.1:8000/projects/protop/api/catalog?per_page=3
```

Run it with **one worker** (rate limits and presence live in process memory); threads are fine.

| Setting | Default | Meaning |
|---|---|---|
| `APP_DATA_DIR` | `./var` | writable; data lives in `$APP_DATA_DIR/protop/protop.sqlite3` (rooms, ops, upstream cache; WAL mode) |
| `PROTOP_CATALOG` | `protop/data/catalog.sqlite` | catalog snapshot, opened read-only |

Startup deletes expired rooms and trims the upstream cache (max 256 MB, entries older than 7 days dropped); room expiry is also checked on access and hourly.

## Tests

```sh
.venv/bin/python -m unittest discover -s tests      # offline, about a second
```

## Rebuilding the catalog snapshot

```sh
.venv/bin/python -m protop.build_catalog            # needs network, about 3 minutes
```

Downloads the AlphaKnot AF1-Knot and KnotProt bulk tables the old `knotcat.py` used, one AlphaKnot detail request per protein
(knot core), PDB-to-UniProt mappings from RCSB and disease names from UniProt, and rewrites `protop/data/catalog.sqlite` (about 0.75 MB). Commit the result.
`--no-details` and `--no-diseases` skip those steps.

## Layout

`protop/aggregator.py` upstream routes - `upstream.py` guarded, cached fetching - `structure.py` PDB/mmCIF reader - `rooms.py` rooms, ops, sync, presence, export -
`catalog.py` catalog routes - `knotdata.py` table parsers - `build_catalog.py` snapshot builder - `security.py` client IP, rate limits, headers (copied from OpenChat).
