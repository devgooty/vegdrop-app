# Deploying VegDrop to a free always-on VM

One VM (Oracle Cloud "Always Free", or Google Cloud `e2-micro` if your Oracle
region has no ARM capacity) runs the API. MongoDB Atlas
M0 is the database. Caddy serves the built frontend and reverse-proxies `/api`
to Express, so browser and API share one origin — required, because
`src/services/apiClient.js` calls the API with a relative path (`/api`).

Total cost: **$0/month**, or **~$1/month** if you buy a real domain instead of
a free dynamic-DNS subdomain.

> **Moving the live API off Railway?** Read [Moving from Railway](#moving-from-railway-website-stays-on-vercel)
> first. That move keeps the website on Vercel and puts only the API here,
> which changes steps 3, 4, 5 and 7 below.

## 1. Provision the VM

Create the instance (Ubuntu 22.04+ recommended) in Oracle Cloud's console —
Always Free → Ampere A1, or fall back to a Google Cloud `e2-micro` if no ARM
capacity is available in your region. Note the public IP.

```bash
ssh ubuntu@<vm-ip>

# Node 22 (matches this project; nvm keeps it out of the system package manager)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 22

# PM2 — keeps the API alive, restarts on crash and on reboot
npm install -g pm2

# Caddy — see https://caddyserver.com/docs/install for your distro; on
# Ubuntu/Debian:
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

Open ports 80 and 443 in the VM's security list / firewall (Oracle: the
subnet's Security List needs an explicit ingress rule — the OS firewall alone
is not enough). **Do not open port 5000** (the raw API) — Caddy is the only
thing that should be internet-facing.

## 2. Set up the database

Create a free cluster at [MongoDB Atlas](https://www.mongodb.com/atlas). Free
clusters are a real 3-node replica set — this app requires that for the
wallet ledger and checkout transactions; a standalone `mongod` makes
production refuse to boot. Add the VM's IP (or `0.0.0.0/0` if the VM's IP
isn't static) under Network Access, create a database user, and copy the
connection string for `MONGODB_URI` below.

## 3. Get the code onto the VM and build it

```bash
sudo mkdir -p /var/www/vegdrop /var/log/vegdrop
sudo chown -R $USER:$USER /var/www/vegdrop /var/log/vegdrop

git clone <your-repo-url> /var/www/vegdrop
cd /var/www/vegdrop
npm install
npm run build          # writes dist/ — this is what Caddy serves
```

## 4. Configure the environment

```bash
cp deploy/.env.production.example .env
nano .env               # fill in every value — see that file's comments
```

Every value in `.env.production.example` is either boot-required or changes
production behaviour; nothing in there has a placeholder you can skip. The
full optional reference is `../.env.example`.

## 5. Point Caddy at your domain

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo sed -i 's/your-domain.com/YOUR_ACTUAL_DOMAIN/' /etc/caddy/Caddyfile
```

No domain yet? Comment out the top block in the Caddyfile and uncomment the
`:80` block instead — see the comments in `deploy/Caddyfile`. Point a free
DDNS subdomain (e.g. DuckDNS) at the VM's IP once you're ready to switch to
real HTTPS, then flip the blocks back and reload.

```bash
sudo systemctl restart caddy
sudo systemctl enable caddy   # survive a reboot
```

## 6. Start the API

```bash
pm2 start deploy/ecosystem.config.js
pm2 logs                 # watch it start up cleanly
```

Confirm the startup line reports the transport you expect. `NOTIFY_TRANSPORT`
can be any real transport (`whatsapp`, `fast2sms`, `smsgate` — see CLAUDE.md,
"OTP delivery") but never `console`: production refuses to boot on the stub,
because that writes verification codes to the log instead of delivering them.

Make it survive a VM reboot:

```bash
pm2 save
pm2 startup              # run the one-line command it prints, as sudo
```

## 7. Verify

```bash
curl https://your-domain.com/api/health
# {"status":"ok","database":"connected",...}

curl -H "Authorization: Bearer wrong" https://your-domain.com/api/orders
# 401 — confirms Caddy is actually routing /api to Express, not 404ing
```

Then open `https://your-domain.com` in a browser and confirm login end to end
— the OTP should arrive on whichever transport you configured.

## Redeploying after a change

```bash
cd /var/www/vegdrop
git pull
npm install               # only needed if dependencies changed
npm run build              # only needed if frontend code changed
pm2 restart vegdrop-api  # only needed if server code changed
```

Caddy needs no restart for a frontend-only change — it serves `dist/` fresh
off disk on every request.

## What NOT to do

- Don't expose port 5000 (raw Express) to the internet. Caddy on 80/443 is the
  only public surface.
- Don't run more than one PM2 instance of `vegdrop-api` — rate limiting and
  the refresh-token flow assume a single process (see `ecosystem.config.js`).
- Don't reintroduce an unofficial WhatsApp Web client for OTP delivery. One
  used to live at `server/bot/` and was removed: sign-in is passwordless, so a
  banned number locks out every user at once with no recovery path. Use the
  Cloud API, or add an SMS provider.

## Moving from Railway (website stays on Vercel)

The live API runs on Railway and the website on Vercel, which forwards `/api/*`
to Railway through the `rewrites` entry in `vercel.json`. To move the API here,
keep that split and change only where Vercel forwards to.

**Why not move the website too:** the Android app opens a fixed URL
(`server.url` in `capacitor.config.json`, the vercel.app address). Serving the
website from this VM's domain changes that URL, and every installed APK keeps
opening the old one until a new APK ships. Left on Vercel, the switch is one
line and phones never notice.

### Before you start: the Oracle account

- **Upgrade the account to Pay As You Go** (the "upgrade" link in the console's
  Free Tier banner). On a Free Tier account Oracle stops compute it judges idle
  over a 7-day window, and a small API looks idle. Always Free resources still
  cost nothing after the upgrade.
- **Set a budget alert at a token amount** (Billing → Budgets), so that any
  charge at all sends an email rather than arriving on a statement.
- **Keep Ampere A1 at 2 OCPU / 12 GB or less in total.** Oracle halved the
  Always Free A1 allowance in 2026 (from 4 / 24). Above it, a Free Tier
  instance is shut down and a Pay As You Go one is billed. One Express process
  and Caddy fit easily.
- **Prefer A1 over the AMD `VM.Standard.E2.1.Micro`.** The Micro is also
  Always Free, but it has 1 GB of memory and a fraction of one core as its
  sustained baseline, bursting above it only briefly. The API fits — it sits at
  about 135 MB resident once every route is loaded, measured with runtime
  dependencies only — but a busy morning runs into the CPU baseline long before
  the database limit, and `npm run build` will not finish in 1 GB. If the
  Micro is what Hyderabad will give you, it is fine to start on, with three
  changes:

  ```bash
  # 2 GB of swap, so an install or a traffic spike slows down instead of
  # the kernel killing the API
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
  sudo mkswap /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

  # runtime dependencies only: no test tooling, and no mongodb-memory-server
  # downloading a whole mongod binary onto the box
  npm ci --omit=dev
  ```

  and never build the website on it (the API-only setup below does not).

### Steps that differ from the guide above

1. **Open 80 and 443 in both places.** The subnet's Security List needs ingress
   rules, *and* Oracle's Ubuntu images ship iptables rules that reject
   everything but SSH. Fixing only one looks exactly like fixing neither:

   ```bash
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
   sudo netfilter-persistent save
   ```

2. **Give the VM a hostname.** A free DuckDNS subdomain pointed at the VM's
   public IP is enough. It must be HTTPS: Vercel forwards session tokens and
   sign-in codes to it.

3. **Skip `npm run build`.** Vercel builds and serves the website; this box
   only runs `server/`.

4. **Build `.env` from the Railway service's variables, not from
   `.env.production.example`.** Copy every one, exactly. Three of them must be
   byte-for-byte identical or something breaks for good:

   | Variable | If it differs |
   |---|---|
   | `KYC_ENCRYPTION_KEY` | Every vendor's stored bank account becomes undecryptable. There is no recovery. |
   | `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | Every user is signed out at the switch. |
   | `OTP_PEPPER` | Codes already sent stop matching. |

   Then make sure of two more: `NODE_ENV=production` (Railway tells the app it
   is live by itself; this VM cannot, so this line is what keeps the payment
   and OTP safety checks on — see `requireRealServices` in
   `server/config/env.js`), and `TRUST_PROXY` copied from Railway — see the
   comment in `deploy/Caddyfile.api` for why the example file's `1` is wrong
   behind Vercel.

5. **Use `deploy/Caddyfile.api` instead of `deploy/Caddyfile`.** It proxies
   `/api/*` only and keeps the real client IP visible behind Vercel.

6. **Allow the VM in Atlas** (Network Access → the VM's public IP).

7. **Verify the VM on its own address before touching Vercel:**

   ```bash
   curl https://YOUR_API_DOMAIN/api/health
   ```

   `status` should be `ok`, `database` connected, and `revision` the commit you
   cloned.

8. **Switch.** Change the `destination` in `vercel.json` to
   `https://YOUR_API_DOMAIN/api/:path*` and deploy. Then check
   `/api/health` through the vercel.app address and confirm it reports the
   VM's `revision` and a small `uptimeSeconds`.

9. **Keep Railway running for a week** as the way back: switching back is the
   same one-line change. Both can run against the same database at once — the
   background sweeper is written for several instances
   (`server/services/sweeper.js`, "MULTI-INSTANCE SAFETY") — and only the one
   Vercel forwards to takes traffic.

10. **Check the webhook URLs.** If Meta (WhatsApp) or Razorpay webhooks point at
    the `up.railway.app` address, change them to the vercel.app address before
    you turn Railway off, or they go nowhere. If they already use the vercel.app
    address, nothing changes.
