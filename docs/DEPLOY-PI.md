# Running jsanker.com on a Raspberry Pi (free, via a Cloudflare Tunnel)

The Pi at home runs the whole site in Docker. A small `cloudflared` container dials *out* to Cloudflare, and
Cloudflare serves `jsanker.com` over HTTPS and forwards requests to the Pi. You open **nothing** on your router
and don't need a static IP. Everything the site stores lives in one Docker volume, backed up nightly.

```
visitor -> Cloudflare (HTTPS, jsanker.com) -> tunnel -> Pi: container web (Caddy + PHP) -> volume appdata (SQLite, uploads)
blog posts + accounts: Google Firebase (not on the Pi)
```

Steps marked **(you)** need your Cloudflare login or physical access to the hardware.

**What you need:** a 64-bit-capable Pi (3, 4, 5 or Zero 2 W), a power supply, internet at home, and a USB SSD or
a *new* SD card. Don't reuse the corrupted card until step 0 is done. Reflashing it would destroy the old data.

**Honest limits:** the site is down whenever your power or home internet is, and a Pi's SD card is the weakest
part (that is probably what died last time). Hence: boot from an SSD if you can, and do step 7 (off-Pi backups).

---

## 0. Rescue the old data from the corrupted SD card  (you, then me)

Do this before anything else, with the old card in your Mac (USB reader). Don't let macOS "initialize" it.

```sh
brew install ddrescue
diskutil list                                   # find the card, e.g. /dev/disk4 (check the SIZE!)
diskutil unmountDisk /dev/disk4
sudo ddrescue -r3 /dev/rdisk4 ~/pi-old-sd.img ~/pi-old-sd.map
```

Run these in a normal Terminal window: `sudo` needs a real terminal to ask for your password, so it won't work
inside Claude Code. (macOS has no direct disc access, so don't add `-d`.) `ddrescue` copies every readable sector and
retries bad ones; re-run the same command to retry what failed. After it finishes, put the card away and **work
only on the image**. The image is the original; keep a copy of it.

Then tell me where the image is. I'll mount it read-only in Docker, find `openchat.db`, `openchat2.db`, `apedia.db`
and any `uploads/` folder, repair the *copy* if needed, and run the import dry-run for you. Nothing here
modifies the image.

If the card is too damaged to read at all, the databases are gone and the site starts empty. The guide still works.

## 1. Set up the Pi  (you)

1. Flash **Raspberry Pi OS Lite (64-bit)** onto the SSD or new card with Raspberry Pi Imager. In its settings
   (gear / "Edit settings") set a hostname, create a user with a strong password, enable SSH, and add your Wi-Fi if
   you aren't using Ethernet (Ethernet is more reliable). Boot from the SSD: on a Pi 4/5 it works out of the box
   with recent firmware; on a Pi 3 it needs USB boot enabled.

   **If the Pi never joins the network** (red LED solid, green barely flickering) and the SSD is in a USB-to-SATA
   cable, the cable's chip may hang in UAS mode. Plug the SSD back into your computer, open `cmdline.txt` on the
   `bootfs` volume and add `usb-storage.quirks=VVVV:PPPP:u` (the cable's USB vendor and product IDs) before
   `rootwait`, keeping it all on one line. For the Sabrent EC-SSHD (JMicron JMS578) that is
   `usb-storage.quirks=152d:a578:u`. Find the IDs with `system_profiler SPUSBHostDataType` on a Mac or `lsusb` on Linux.
2. SSH in and install Docker (Docker's official convenience script; it supports Raspberry Pi OS):

```sh
ssh YOUR_USER@YOUR_PI.local
sudo apt-get update && sudo apt-get -y full-upgrade
sudo apt-get install -y git unattended-upgrades          # unattended-upgrades = automatic security updates
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER" && exit                  # log out and back in so the group applies
```

3. Pi with 1 GB RAM or less (Zero 2 W, Pi 3)? Building the image can run out of memory. Add swap first:

```sh
sudo dphys-swapfile swapoff && sudo sed -i 's/^CONF_SWAPSIZE=.*/CONF_SWAPSIZE=2048/' /etc/dphys-swapfile \
  && sudo dphys-swapfile setup && sudo dphys-swapfile swapon
```

## 2. Create the tunnel  (you)

1. Cloudflare dashboard → **Zero Trust** (it asks you to pick a team name and a plan: choose the **Free** plan;
   a card may be requested for verification, and you shouldn't be charged on Free. Check the screen before you confirm).
2. **Networks → Tunnels → Create a tunnel →** type **Cloudflared**, name it `jsanker-pi`. On the install screen,
   choose **Docker** and copy the long token after `--token` (starts with `eyJ`). Don't run their command; step 3
   uses the token.
3. In the tunnel's **Published application routes** (called "Public Hostname" in older dashboards) add:
   - hostname `jsanker.com`, service type **HTTP**, URL `web:80`
   - hostname `www.jsanker.com`, service type **HTTP**, URL `web:80`

   Cloudflare creates the DNS records for you. If it complains a record for `jsanker.com` already exists (the old
   Netlify one), delete that record in **DNS** first, **but only after step 5**, because deleting it switches the
   live site over.

## 3. Get the code and configuration

```sh
ssh YOUR_USER@YOUR_PI.local
git clone https://github.com/jpsank/jsanker.com.git && cd jsanker.com
git checkout revamp                 # use `main` once the pull request is merged
cp .env.example .env
cp tunnel.env.example tunnel.env
nano tunnel.env                     # paste the token after TUNNEL_TOKEN=
```

Fill `.env` with the `FIREBASE_*` values (from your laptop: `scp .env YOUR_USER@YOUR_PI.local:jsanker.com/.env`).
Leave `SERVER_NAME` unset: Cloudflare does the HTTPS, the container speaks plain HTTP inside Docker.

## 4. Start it

```sh
docker compose -f compose.prod.yaml up -d --build     # the first build takes several minutes on a Pi
docker compose -f compose.prod.yaml logs --tail=20 tunnel   # look for "Registered tunnel connection"
```

The tunnel shows as **Healthy** in the Cloudflare dashboard. At this point `https://jsanker.com` already
answers *if* the DNS records point at the tunnel (step 2.3). The site is empty until step 5.

## 5. Import the old data  (once)

Copy the recovered databases to the Pi, import, and delete the copies (they contain messages and password hashes):

```sh
# on your laptop (the folder I extracted from the image)
scp -r ~/recovered/db YOUR_USER@YOUR_PI.local:/tmp/legacy
scp -r ~/recovered/uploads YOUR_USER@YOUR_PI.local:/tmp/legacy-uploads     # only if uploads were recovered

# on the Pi, in ~/jsanker.com
export COMPOSE_FILE=compose.prod.yaml
scripts/migrate-legacy.sh /tmp/legacy --dry-run          # counts only, no message text
scripts/migrate-legacy.sh /tmp/legacy                    # the real import (add --uploads=/tmp/legacy-uploads)
rm -rf /tmp/legacy /tmp/legacy-uploads
```

The import refuses to run if the site already has data, so retrying is safe. To start over, delete the two
`.sqlite` files in the volume (README, "Importing the 2019 databases").

## 6. Switch the domain over  (you)

Do this only once the import looks right. In Cloudflare **DNS** for `jsanker.com`, the `@` and `www` records must
be the `jsanker-pi` tunnel's CNAMEs (the dashboard creates them when you add the routes in step 2.3, after you
delete the old Netlify records). **Proxied (orange cloud)** is correct and required for tunnels. To roll back, put
the old Netlify records back (the Netlify site is untouched until you delete it).

## 7. Backups  (do not skip: the Pi's disk is the only copy)

On the Pi:

```sh
sudo mkdir -p /srv/jsanker-backups && sudo chown "$USER" /srv/jsanker-backups
crontab -e
# add (nightly at 03:17, keeps 14 days on the Pi):
17 3 * * *  /home/YOUR_USER/jsanker.com/scripts/backup.sh >> /home/YOUR_USER/jsanker-backup.log 2>&1
```

Run `scripts/backup.sh` once by hand and check `ls /srv/jsanker-backups/`.

**Also copy the backups off the Pi**, so a dead disk, theft or fire doesn't lose everything. Pick one:

- **From your Mac, whenever you like** (a weekly reminder is enough for a site this size):
  `rsync -az YOUR_USER@YOUR_PI.local:/srv/jsanker-backups/ ~/jsanker-backups/`
- **Automatic, to Cloudflare R2** (free 10 GB, no egress fees; may ask for a card to enable R2, check the screen):
  create an R2 bucket and an API token (Object Read & Write) in the dashboard, then on the Pi
  `sudo apt-get install -y rclone && rclone config` (type `s3`, provider `Cloudflare`, paste the keys and your
  account's endpoint) and add `BACKUP_REMOTE=r2:YOUR_BUCKET/jsanker` in front of the cron command:
  `17 3 * * *  BACKUP_REMOTE=r2:YOUR_BUCKET/jsanker /home/YOUR_USER/jsanker.com/scripts/backup.sh ...`

Restore (replaces the live data; the site is stopped briefly):

```sh
scripts/restore.sh /srv/jsanker-backups/20261104-031700
```

Test a restore once on purpose, now, so you know it works before you need it.

## 8. Updating the site

```sh
cd ~/jsanker.com && git pull
docker compose -f compose.prod.yaml up -d --build
docker compose -f compose.prod.yaml pull tunnel && docker compose -f compose.prod.yaml up -d   # newer cloudflared, occasionally
```

Data lives in the volumes, so rebuilding doesn't touch it. Run a **single instance** (SQLite is a local file).
The Pi OS itself updates security fixes automatically (`unattended-upgrades`); reboot now and then.

### Automatic deploys (GitHub webhook)

A push to `main` redeploys the site within about a minute (the time the build takes). GitHub POSTs to
`https://deploy.jsanker.com/hook`; the Cloudflare Tunnel forwards it to `scripts/deploy-listener.py`, a
standard-library Python service (~10 MB) that checks the HMAC signature and then runs `scripts/deploy.sh`
(`git merge --ff-only origin/main`, rebuild `web`). Only signed `push` events for `refs/heads/main` of
`jpsank/jsanker.com` do anything; pushes during a build collapse into one follow-up build. A failed build leaves
the old container serving.

One-time setup:

1. On the Pi: `cd ~/jsanker.com && git pull && docker compose -f compose.prod.yaml up -d tunnel`
   (the tunnel service gained `host.docker.internal`), then `sudo scripts/install-deploy-hook.sh`.
   It installs the `jsanker-deploy` systemd service and prints the webhook secret.
2. Cloudflare Zero Trust -> Networks -> Tunnels -> `jsanker-pi` -> Public hostname -> add `deploy.jsanker.com`,
   service `HTTP`, URL `host.docker.internal:9000`. (This creates its own DNS record; leave the wildcard alone.)
3. GitHub -> repo Settings -> Webhooks -> Add: Payload URL `https://deploy.jsanker.com/hook`, content type
   `application/json`, the secret from step 1, event "Just the push event".

Check it: the webhook's "Recent Deliveries" tab shows `200 pong` for the ping, and
`journalctl -u jsanker-deploy -f` shows each deploy. Deploy by hand any time with `scripts/deploy.sh`
(`FORCE=1` to rebuild when nothing changed). The listener only exposes `/hook`, so the public URL can do nothing
without the secret; to rotate it, delete `~/.deploy-secret`, rerun the install script and update GitHub.

## Things to know

- **Visitor IPs:** behind the tunnel every request arrives from the `cloudflared` container. The app reads
  Cloudflare's `CF-Connecting-IP` header for rate limiting, and only when the direct peer is a private address, so
  the container must publish no ports (the provided compose file doesn't). Don't add `ports:` unless you remove that.
- **Cloudflare's terms:** serving a small personal site through a tunnel is the intended use. Heavy media streaming
  isn't. This site is far from it.
- **If the Pi dies:** flash another, repeat steps 1-4 and 7's restore from your off-Pi backup. The tunnel token
  keeps working from any machine.
- **Power cuts:** SQLite in WAL mode survives them, but cheap SD cards don't always. Another reason for an SSD and
  for the off-Pi backups.

## Troubleshooting

- Cloudflare shows error 1033 / 502: the tunnel isn't running or `web` isn't up. `docker compose -f compose.prod.yaml ps`
  and `logs --tail=50 tunnel web`.
- Tunnel logs say the token is invalid: re-copy it into `tunnel.env` (no quotes, no spaces) and `up -d` again.
- Everyone gets rate-limited as one user: the `CF-Connecting-IP` header isn't arriving. Check the hostname is
  **proxied** (orange cloud) and goes through the tunnel.
- Image build killed / out of memory: add swap (step 1.3).
