# Deploying jsanker.com on Oracle Cloud Always Free

One small VM runs the whole site (Caddy + PHP in one container). Everything it stores lives in one
folder on that VM's disk, `/var/lib/jsanker` (a Docker volume), and `scripts/backup.sh` copies it nightly.

What you'll have at the end:

```
jsanker.com  ->  Cloudflare DNS  ->  Oracle VM (Ubuntu, Docker)  ->  container: Caddy + PHP
                                                                         |-- volume appdata  (SQLite DBs, uploads)  <- backed up nightly
                                                                         '-- volume caddy_data (HTTPS certificates)
blog posts + accounts: Google Firebase (not on the VM)
```

Steps marked **(you)** need your Oracle/Cloudflare login. Everything else is a command to paste.

Oracle's free-tier limits and console wording change; where this guide is unsure it says so. Check
Oracle's own "Always Free resources" page for the current allowance.

---

## 1. Create the VM  (you)

1. Sign up at oracle.com/cloud/free. It asks for a card for identity verification. Choose your **home
   region** carefully: it cannot be changed later.
2. Console → **Compute → Instances → Create instance**.
   - **Image:** Canonical Ubuntu 24.04.
   - **Shape:** `VM.Standard.A1.Flex` (Ampere ARM), **2 OCPU / 12 GB** is enough, and is inside even the
     reduced free allowance. If you get "Out of host capacity", try another availability domain, try again
     later, or use `VM.Standard.E2.1.Micro` (1 GB RAM; see "Small machines" below).
   - **Boot volume:** 50 GB.
   - **SSH keys:** upload your public key (`~/.ssh/id_ed25519.pub`, or `ssh-keygen -t ed25519` to make one).
3. Give it a stable address: **Networking → IP management → Reserved public IPs → Create**, then attach it
   to the instance's network interface. (An ephemeral IP can change if the instance is recreated.)
4. Open the web ports: **Networking → Virtual cloud networks →** your VCN **→ Security lists → Default →
   Add ingress rules**: source `0.0.0.0/0`, TCP, destination ports `80` and `443`, and UDP `443` (HTTP/3).

## 2. Prepare the server

```sh
ssh ubuntu@YOUR_IP

# Oracle's Ubuntu images also block ports in the OS firewall. Open 80/443 and make it permanent:
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80  -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p udp --dport 443 -j ACCEPT
sudo netfilter-persistent save

sudo apt-get update && sudo apt-get -y upgrade
sudo apt-get install -y docker.io docker-compose-v2 git
sudo usermod -aG docker ubuntu && exit        # log out and back in so the group applies
```

Ubuntu installs security updates automatically (`unattended-upgrades`), so there's nothing to schedule.

### Small machines (1 GB RAM)

Building the image can run out of memory on the 1 GB micro shape. Add swap first:

```sh
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 3. Get the code and configuration

```sh
ssh ubuntu@YOUR_IP
git clone https://github.com/jpsank/jsanker.com.git && cd jsanker.com
git checkout revamp            # use `main` once the pull request is merged
cp .env.example .env
```

Fill in `.env` with the `FIREBASE_*` values (copy them from the `.env` on your laptop; they're public
identifiers): from your laptop, `scp .env ubuntu@YOUR_IP:jsanker.com/.env`.
**Leave `SERVER_NAME` unset for now**: the site then answers on plain HTTP so you can test by IP.

## 4. Start it and test by IP

```sh
docker compose -f compose.prod.yaml up -d --build
```

Open `http://YOUR_IP/`. You should see the home page. (HTTPS and the blog's sign-in only work after step 6.)

## 5. Import the old data  (once)

Copy the legacy databases up from your laptop. They contain messages and password hashes, so put them
somewhere temporary and remove them afterwards:

```sh
# on your laptop
scp -r "/path/to/puffyboa.xyz/projects/db" ubuntu@YOUR_IP:/tmp/legacy
# (and, if you ever recover them, the old OpenChat attachments: scp -r /path/to/uploads ubuntu@YOUR_IP:/tmp/legacy-uploads)

# on the server, in ~/jsanker.com
export COMPOSE_FILE=compose.prod.yaml
scripts/migrate-legacy.sh /tmp/legacy --dry-run      # read the report: counts only, no message text
scripts/migrate-legacy.sh /tmp/legacy                # the real import (add --uploads=/tmp/legacy-uploads if you have them)
rm -rf /tmp/legacy /tmp/legacy-uploads
```

The import refuses to run if the site already has data, so it's safe to retry. To redo it from scratch,
delete the two `.sqlite` files in the volume (see the README, "Importing the 2019 databases").

Refresh `http://YOUR_IP/projects/openchat/` and `/projects/apedia/` to see the messages and posts.

## 6. Point the domain at the VM  (you)

Do this only after step 5, because it switches the live site over. In **Cloudflare → DNS** for `jsanker.com`:

| Type | Name | Content | Proxy |
| --- | --- | --- | --- |
| A | `@` | your reserved IP (replaces the current record pointing at Netlify) | **DNS only** (grey cloud) |
| CNAME | `www` | `jsanker.com` (replaces the CNAME to `jsanker.netlify.app`) | **DNS only** |

DNS only matters: Caddy gets its HTTPS certificate straight from Let's Encrypt, and the orange-cloud proxy
would interfere with that and hide visitors' IP addresses from the rate limiter.

Then on the server, edit `.env` and set:

```
SERVER_NAME=jsanker.com, www.jsanker.com
```

```sh
docker compose -f compose.prod.yaml up -d
docker compose -f compose.prod.yaml logs -f web      # wait for "certificate obtained successfully"
```

Visit `https://jsanker.com`. To roll back, put the old records back in Cloudflare (the Netlify site is
untouched until you delete it).

## 7. Backups  (do not skip: this is the only copy of the data)

On the server:

```sh
crontab -e
# add this line (nightly at 03:17, keeps 14 days on the server):
17 3 * * *  /home/ubuntu/jsanker.com/scripts/backup.sh >> /home/ubuntu/jsanker-backup.log 2>&1
```

Run it once by hand to check: `scripts/backup.sh`, then `ls /srv/jsanker-backups/`. (If `/srv` isn't
writable by `ubuntu`, run `sudo mkdir /srv/jsanker-backups && sudo chown ubuntu /srv/jsanker-backups` first.)

**Copy backups to another machine.** A backup on the same VM dies with the VM. Simplest: from your laptop,
on whatever schedule you like (a weekly reminder is enough for a site this size):

```sh
rsync -az ubuntu@YOUR_IP:/srv/jsanker-backups/ ~/jsanker-backups/
```

Or have the server push them itself with [rclone](https://rclone.org) to any storage you like
(`rclone config`, then set `BACKUP_REMOTE=remote:bucket/jsanker` in the cron line).

**Restore** (replaces the live data; the site is stopped briefly):

```sh
scripts/restore.sh /srv/jsanker-backups/20261104-031700
```

Try a restore once on purpose, now, so you know it works before you need it.

## 8. Updating the site

```sh
cd ~/jsanker.com && git pull
docker compose -f compose.prod.yaml up -d --build
```

Rebuild now and then with `--pull` to pick up a newer PHP/Caddy base image. Data lives in the volumes,
so rebuilding doesn't touch it. Run it as a **single instance** (SQLite is a local file).

## Things to know about Oracle's free tier

- **Idle machines may be reclaimed.** I recall Oracle reserving the right to reclaim Always Free compute
  instances that sit nearly idle for a week; a small personal site may look idle. I couldn't confirm the
  current policy, so read Oracle's Always Free documentation. Upgrading the account to "Pay As You Go"
  (you're still charged nothing while inside the free limits) is commonly suggested to avoid it. Decide
  with the docs in front of you.
- **Free accounts can be terminated** more readily than paid ones. That's why step 7's off-server copy matters.
- **Capacity:** ARM machines are sometimes unavailable in a region; the 1 GB AMD micro is the fallback.
- **Cost to watch:** nothing here should bill you, but set a budget alert in the console (Billing → Budgets)
  at a small amount so a mistake can't surprise you.

## Troubleshooting

- `http://YOUR_IP/` times out: the VCN security list (step 1.4) or the OS firewall (step 2) is still closed.
- HTTPS certificate not issued: DNS hasn't propagated yet (`dig +short jsanker.com` should show your IP),
  or the Cloudflare record is orange-clouded.
- Everyone gets rate-limited as one user: visitors' real IPs aren't reaching the app. Keep Cloudflare on DNS
  only, or add Cloudflare's ranges to `trusted_proxies` in `docker/Caddyfile`.
- See what the site is doing: `docker compose -f compose.prod.yaml logs --tail=100 web`.
