# jsanker.com

Julian Sanker's personal site: plain HTML/PHP, one stylesheet for the new pages, no build step, one container.

## Layout

```
public/            document root (the only thing the web server can see)
  index.php        home
  projects/        ChemCalc, OpenChat, APedia, Speedreed, WireWorld, Audiovisual + cut-down "souvenirs" (HHA Grades, uMusic, CoronaRiskMap, Lucas Gifs)
  blog/            Firebase-backed blog (vanilla ES modules, no React)
  life/            life.js + life.css for the Game of Life on the home page (/life/ redirects home); api/pattern.php serves random RLE patterns
  photos/          photo page
  assets/site.css  the new minimalist design (system light/dark) for home, blog, photos
  assets/legacy/   the original puffyboa.xyz shared.css + favicon, used by the ported projects
src/               shared PHP (bootstrap, layout, Censor, LegacyClean) and per-project server code — NOT web-accessible
bin/               bin/migrate-legacy.php (one-off import of the 2019 databases), bin/backup.php (online backup)
tests/             word-filter tests
data/              read-only app data (Game of Life patterns, ChemCalc tables, Speedreed texts) — NOT web-accessible
docker/            Caddyfile + php.ini
firestore.rules    Firestore security rules for the blog (deploy with the Firebase CLI)
scripts/smoke.sh   builds the image, boots it, checks routes and security headers
scripts/backup.sh, scripts/restore.sh   production backup / restore of the data volume
compose.prod.yaml  production compose file (80/443, restart on boot, named volumes)
docs/DEPLOY-ORACLE.md   step-by-step deploy on Oracle Cloud Always Free
```

## Run locally

```sh
cp .env.example .env      # fill in the Firebase web config for the blog (optional)
docker compose up --build # http://localhost:8080
scripts/smoke.sh          # production-image smoke test (routes, 404s, headers)
scripts/test.sh           # PHP lint + word-filter tests
```

## Deploy

Step-by-step for a free Oracle Cloud VM, including DNS, importing the old data and nightly backups:
**[docs/DEPLOY-ORACLE.md](docs/DEPLOY-ORACLE.md)**. Any host that runs a Docker image with a persistent disk works
(a VPS, Fly.io, Railway…); use `compose.prod.yaml`. Netlify can't host this app (no PHP, no persistent disk).

- Set `SERVER_NAME=jsanker.com` for automatic HTTPS (leave unset for plain HTTP on :80).
- Mount a **persistent volume at `/var/lib/jsanker`** — SQLite databases (OpenChat, APedia), sessions,
  rate-limit state, and uploads live there. Also persist `/data` (Caddy's certificates).
- Set the `FIREBASE_*` variables from `.env.example` for the blog.
- Optional: `OPENCHAT_ALLOW_IMAGES=1` to allow image uploads on OpenChat (off by default — it is an
  anonymous public board with no moderation).
- Run a **single instance**: SQLite is on a local volume.
- **Back up `/var/lib/jsanker`**: `scripts/backup.sh` (nightly cron) and copy the result off the server.
- Rate limiting keys on the client IP as PHP sees it. Behind a proxy, make sure Caddy's
  `trusted_proxies` (see `docker/Caddyfile`) covers it, or everyone shares one bucket.

## Old projects keep their original look

The ported projects (ChemCalc, OpenChat, APedia, Speedreed, WireWorld, Audiovisual and the four souvenirs) deliberately
keep their original 2018-2020 UI: each uses its own original `style.css` on top of `assets/legacy/shared.css`, via
`page_start(['legacy' => true, ...])` (add `'nobar' => true` for pages that never had the breadcrumb bar). Only the
code underneath was patched; the new site theme is not applied to them. The original pages had no doctype, so a few
small CSS rules at the end of some `style.css` files emulate the old quirks-mode sizing.

## Security model

The old puffyboa.xyz projects were PHP written in high school (SQL injection, XSS, no CSRF, unrestricted
uploads, infinite loops reachable from user input). They were ported, not rewritten, and fixed:

- every value printed into HTML goes through `e()`; every SQL statement is a prepared statement
- every state-changing request is a POST with a CSRF token (OpenChat is anonymous, so it checks `Sec-Fetch-Site`/`Origin` instead)
- strict CSP on every page: no inline script, no inline style, no third-party origins (the blog widens it only for Firebase)
- hardened sessions (HttpOnly, SameSite, strict mode, regenerated on login)
- rate limits on login, registration, posting and voting
- uploads: type/size/dimension validated, re-encoded with GD, stored outside the web root
- the container runs unprivileged; `src/`, `data/` and dotfiles are not served; `php.ini` disables exec-style functions

## Word filter

`src/Censor.php` masks slurs with asterisks (same length) **when text is written**, in OpenChat messages and
APedia questions/answers/comments, and rejects APedia usernames that contain one. It handles case, leetspeak,
repeated letters, punctuation between letters, look-alike Unicode characters and zero-width padding, and has
explicit exceptions for innocent words ("snigger", "niggle", "Niger", "Maine Coon", "flame retardant"...).
The word list is ROT13-encoded in the source so the slurs are not sitting in plain text in the repo; see the
header comment of `src/Censor.php` for how to add words. It is a reasonable-effort filter, not a guarantee —
for example, letters separated by spaces are deliberately not matched. Tests: `scripts/test.sh`.

## Importing the 2019 databases

`bin/migrate-legacy.php` imports `openchat.db`, `openchat2.db` (merged chronologically) and `apedia.db`:

```sh
scripts/migrate-legacy.sh "/path/to/puffyboa.xyz/projects/db" --dry-run   # local compose volume
scripts/migrate-legacy.sh "/path/to/puffyboa.xyz/projects/db"
```

- **Keeps:** all messages, dates, APedia users (with their password hashes, so logins still work), posts, ids
  and votes. Old APedia text was stored HTML-escaped; it is decoded once.
- **Cleans:** slurs masked; injected markup (script/iframe blocks, tags with event handlers, `javascript:`)
  removed; control and bidi characters stripped; anything over the new limits (OpenChat 1000, APedia 5000
  characters) truncated; usernames that are invalid or contain a slur become `user<ID>`.
- **Reports:** counts and row ids with reason codes only — never message content.
- **Safe to rerun:** the destination must be empty (otherwise it refuses). To redo an import, delete
  `db/openchat.sqlite` / `db/apedia.sqlite` in the data volume. Legacy files are read as copies.
- **Do not commit the legacy databases** — they contain messages and password hashes.
- **Old OpenChat images:** the 24 attachment files from 2019 no longer exist anywhere on disk (the databases only
  kept a flag), so those 24 messages are imported as text. If you find the files (they were `uploads/<id>`, named by
  the old `openchat2.db` message id), rerun the import with `--uploads=/path/to/them`: each file goes through the
  same sanitiser as a new upload (type check, size/pixel caps, re-encode) and is stored outside the web root.
  Existing images are always shown; `OPENCHAT_ALLOW_IMAGES` only controls whether *new* uploads are allowed.

## What was ported, and what wasn't

| Project | Status |
| --- | --- |
| ChemCalc, OpenChat, APedia, Speedreed | PHP, ported + hardened |
| WireWorld, Audiovisual.js | JS, ported to the strict CSP |
| Game of Life | rewritten in vanilla JS; pattern API now PHP |
| Blog | Firebase backend unchanged; front end rewritten without React |
| CoronaRiskMap | live: frozen July-2020 snapshot of the real data, client-side, with a date slider |
| HHA Grades | live demo of the interface on made-up data (the school portal it scraped is gone) |
| uMusic | live demo of the player with fictional tracks synthesised in the browser (no one's music is hosted) |
| Lucas Gifs | live, cut down from 40 MB to 4 MB (animated WebP) |
| SharedLlama | never finished (MySQL prototype, fake login) — not ported |
| Speedreed texts | only the public-domain H.G. Wells books are included |
| Python "new OpenChat" (Reddit-style) | not ported (separate app with emails and accounts) |
