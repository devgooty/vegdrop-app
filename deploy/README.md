# Deploying VegDrop to a free always-on VM

One VM (Oracle Cloud "Always Free", or Google Cloud `e2-micro` if your Oracle
region has no ARM capacity) runs the API. MongoDB Atlas
M0 is the database. Caddy serves the built frontend and reverse-proxies `/api`
to Express, so browser and API share one origin — required, because
`src/services/apiClient.js` calls the API with a relative path (`/api`).

Total cost: **$0/month**, or **~$1/month** if you buy a real domain instead of
a free dynamic-DNS subdomain.

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
must be `whatsapp` here — production refuses to boot on the `console` stub,
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
