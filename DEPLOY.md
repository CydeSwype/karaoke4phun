# Deploying karaoke4phun

Runs as one Node process (Express + Socket.IO) behind nginx on the same Hetzner/CloudPanel server as iandmiller.com,
at its own subdomain, e.g. `https://karaoke.iandmiller.com`. After the one-time setup below, **merging to `main`
tests and deploys automatically** (`.github/workflows/deploy.yml`).

HTTPS matters here: it lets phones reach the party from anywhere (not just the home Wi-Fi) and unlocks the
one-tap "install app" prompt on Android.

## How it works

- CI runs `npm test`, then `scripts/deploy.sh` installs production dependencies (all pure JavaScript, so the server
  needs no npm) and rsyncs `server/`, `public/`, `package*.json` and `node_modules/` to the app directory.
- The script then replaces a `RELEASE` file, and a systemd path unit restarts the app (same trick as the portfolio).
- `.env` (secrets) and `data/` (the search cache) live on the server and are never overwritten.
- Parties live in memory, so a deploy restarts the app and empties the queue. The TV gets its same party code back
  and phones reconnect, so avoid deploying mid-party.

## One-time server setup

Steps 1 to 3 and 6 need your accounts (Cloudflare, CloudPanel, Hetzner console for root, GitHub).

1. **DNS (Cloudflare):** add an `A` record, `karaoke` pointing at the server's IP. Either proxy mode works, but if it
   is proxied (orange cloud) also do the real-IP step in the nginx snippet or the rate limits will see every
   visitor as Cloudflare.
2. **CloudPanel site:** create a *Reverse Proxy* site for `karaoke.iandmiller.com` with proxy URL
   `http://127.0.0.1:3000`, and issue its Let's Encrypt certificate. Note the site user CloudPanel creates
   (`SITEUSER` below). In the site's *Vhost* editor, use `deploy/nginx-vhost.conf` for the `location /` block. The
   WebSocket upgrade headers are required or phones will not connect.
3. **Deploy user:** in CloudPanel > the site > SSH/FTP, create an SSH user for CI and add the deploy public key
   (generate a new keypair just for this; never reuse a personal key). It needs write access to the app directory.
4. **App directory and config:** as `SITEUSER`:

   ```bash
   mkdir -p ~/karaoke4phun/data
   cat > ~/karaoke4phun/.env <<'EOF'
   PORT=3000
   PUBLIC_URL=https://karaoke.iandmiller.com
   TRUST_PROXY=1
   YOUTUBE_API_KEY=...
   EOF
   chmod 600 ~/karaoke4phun/.env
   ```

   The Node version on the server must be 20.6 or newer (`node -v`).
5. **systemd (needs root; Hetzner Cloud Console, since root SSH is disabled):** copy the three files in `deploy/`
   to `/etc/systemd/system/`, replace `SITEUSER` in each, then:

   ```bash
   systemctl daemon-reload
   systemctl enable --now karaoke4phun.service karaoke4phun-restart.path
   ```

   The service is not running until the first deploy puts the code in place; run
   `systemctl restart karaoke4phun` after that deploy if it is not up yet.
6. **GitHub repo settings (Settings > Secrets and variables > Actions):**
   - Secrets: `DEPLOY_SSH_KEY` (the private key from step 3) and `DEPLOY_KNOWN_HOSTS`
     (output of `ssh-keyscan -t ed25519 <server ip>`).
   - Variables: `DEPLOY_HOST` (server IP), `DEPLOY_USER` (the deploy user from step 3),
     `DEPLOY_PATH` (e.g. `/home/SITEUSER/karaoke4phun`), `DEPLOY_URL` (`https://karaoke.iandmiller.com`).

Then merge to `main` (or run the workflow manually) and open the URL.

## Checking on it

```bash
systemctl status karaoke4phun karaoke4phun-restart.path
journalctl -u karaoke4phun -n 50
```

## Limits built into the app

Because this is public with no login, the app limits abuse: 30 searches/minute and 60 QR images/minute per
address, 10 new parties/hour per address, and 500 parties at once. Over the limit, requests get HTTP 429 or the TV
shows "Too many new parties right now".

YouTube's default API quota is 10,000 units a day, and each uncached search costs 100, so about 100 new searches
a day across everyone. Results are cached for a week in `data/search-cache.json`, and pasted YouTube links do not
use search quota. If you run out regularly, request a higher quota in Google Cloud.

## Manual deploy (fallback)

```bash
DEPLOY_HOST=... DEPLOY_USER=... DEPLOY_PATH=... DEPLOY_URL=https://karaoke.iandmiller.com \
DEPLOY_KEY=~/path/to/private_key ./scripts/deploy.sh
```

## Rollback

Re-run the workflow on an older commit (the server keeps no previous copies).
