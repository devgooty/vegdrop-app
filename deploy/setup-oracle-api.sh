#!/usr/bin/env bash
# =============================================================================
# VegDrop — set up the API on an Oracle Cloud Ubuntu VM, in one command.
#
# The website stays on Vercel; this box runs the API only, behind Caddy, and
# Vercel's /api rewrite is pointed at it once it answers. See
# deploy/README.md, "Moving from Railway", for why it is split that way.
#
# Run it as the normal login user (ubuntu), from an SSH session or Oracle's
# Cloud Shell:
#
#   curl -fsSL https://raw.githubusercontent.com/devgooty/vegdrop-app/main/deploy/setup-oracle-api.sh \
#     | bash -s -- --domain vegdrop-api.duckdns.org
#
# It runs twice. The first run installs everything and writes a starter .env,
# then stops so the Railway variables can be pasted in. The second run checks
# them, starts the API and the web server, and tests both. Running it again
# later is safe: every step checks before it changes anything, and a rerun is
# also how to update the code.
#
# It refuses, rather than guesses, when the box is already serving something
# else on ports 80, 443 or 5000, has a Caddyfile it did not write, or has a Node
# older than 22 installed — each of those means another app lives here, and
# replacing its web server or runtime would take it down.
# =============================================================================
set -euo pipefail

REPO_URL="https://github.com/devgooty/vegdrop-app.git"
BRANCH="main"
APP_DIR="/var/www/vegdrop"
LOG_DIR="/var/log/vegdrop"
CADDYFILE="/etc/caddy/Caddyfile"
MARK="# vegdrop-api: written by deploy/setup-oracle-api.sh"
DOMAIN=""

say() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\n\033[1;33m!!  %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mSTOP: %s\033[0m\n' "$*" >&2; exit 1; }

# Everything runs inside main(), which bash must read to its closing brace before
# it can start. Piped through `curl | bash`, the script IS bash's stdin, and a
# command that reads stdin part-way through would otherwise swallow the lines
# that follow it and run whatever was left.
main() {

while [ $# -gt 0 ]; do
	case "$1" in
		--domain | --branch)
			[ $# -ge 2 ] || die "$1 needs a value"
			if [ "$1" = "--domain" ]; then DOMAIN="$2"; else BRANCH="$2"; fi
			shift 2
			;;
		*) die "Unknown option: $1 (use --domain NAME, optionally --branch NAME)" ;;
	esac
done

# --- Preconditions ------------------------------------------------------------

[ "$(id -u)" -ne 0 ] || die "Run as the normal login user (ubuntu), not root. The script uses sudo where it needs to."
# shellcheck disable=SC1091
. /etc/os-release
[ "${ID:-}" = "ubuntu" ] || die "This script supports Ubuntu only. Create the VM from an Ubuntu 22.04 or 24.04 image."
[ -n "$DOMAIN" ] || die "Pass the API's hostname, for example:  --domain vegdrop-api.duckdns.org"
case "$DOMAIN" in
	*/* | *:* | *" "*) die "--domain takes a bare hostname (vegdrop-api.duckdns.org), not a URL." ;;
esac
sudo -v

port_owner() {
	sudo ss -ltnpH "sport = :$1" | sed -n 's/.*users:(("\([^"]*\)".*/\1/p' | head -n 1
}

for port in 80 443; do
	owner="$(port_owner "$port")"
	if [ -n "$owner" ] && [ "$owner" != "caddy" ]; then
		die "Port $port is already used by '$owner'. Another app is serving from this VM. Use a separate VM for VegDrop."
	fi
done

owner="$(port_owner 5000)"
if [ -n "$owner" ] && ! { command -v pm2 >/dev/null && pm2 describe vegdrop-api >/dev/null 2>&1; }; then
	die "Port 5000 is already used by '$owner', and it is not VegDrop. Use a separate VM."
fi

if [ -f "$CADDYFILE" ] && ! grep -qF "$MARK" "$CADDYFILE" \
	&& ! grep -q "The Caddyfile is an easy way to configure your Caddy web server" "$CADDYFILE"; then
	die "$CADDYFILE already holds another site's configuration. Use a separate VM for VegDrop."
fi

if command -v node >/dev/null; then
	node_major="$(node -p 'process.versions.node.split(".")[0]')"
	[ "$node_major" -ge 22 ] || die "Node $node_major is installed, probably for another app. VegDrop needs 22 or newer. Use a separate VM rather than replacing it."
fi

# --- Swap ---------------------------------------------------------------------
# The always-free AMD Micro has 1 GB. Without swap, an install or a busy minute
# ends with the kernel killing the API; with it, both just slow down.

if ! swapon --show | grep -q .; then
	mem_mb="$(awk '/MemTotal/ {print int($2 / 1024)}' /proc/meminfo)"
	if [ "$mem_mb" -lt 4000 ]; then
		say "Adding 2 GB of swap (this VM has ${mem_mb} MB of memory)"
		[ -f /swapfile ] || sudo fallocate -l 2G /swapfile
		sudo chmod 600 /swapfile
		sudo mkswap /swapfile >/dev/null
		sudo swapon /swapfile
		grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
	fi
fi

# --- System packages ----------------------------------------------------------

say "Installing system packages"
sudo apt-get update -y -q
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q \
	curl git ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https iptables-persistent

# --- Firewall on the VM itself --------------------------------------------------
# Oracle's Ubuntu images reject everything but SSH in iptables. The rules go in
# above that REJECT, or they are never reached. The Security List in the Oracle
# console is a separate, second firewall that this script cannot open.

open_port() {
	local port="$1" line
	if sudo iptables -C INPUT -p tcp --dport "$port" -m conntrack --ctstate NEW -j ACCEPT 2>/dev/null; then
		return
	fi
	line="$(sudo iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" {print $1; exit}')"
	if [ -n "$line" ]; then
		sudo iptables -I INPUT "$line" -p tcp --dport "$port" -m conntrack --ctstate NEW -j ACCEPT
	else
		sudo iptables -A INPUT -p tcp --dport "$port" -m conntrack --ctstate NEW -j ACCEPT
	fi
}

say "Opening ports 80 and 443 in the VM's firewall"
open_port 80
open_port 443
sudo netfilter-persistent save >/dev/null

# --- Node 22, PM2, Caddy ----------------------------------------------------------

if ! command -v node >/dev/null; then
	say "Installing Node 22"
	curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null
	sudo apt-get install -y -q nodejs
fi

if ! command -v pm2 >/dev/null; then
	say "Installing PM2 (keeps the API running, and restarts it after a crash or reboot)"
	sudo npm install -g pm2 --no-audit --no-fund >/dev/null
fi

if ! command -v caddy >/dev/null; then
	say "Installing Caddy (HTTPS in front of the API)"
	curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
		| sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
	curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
		| sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
	sudo apt-get update -y -q
	sudo apt-get install -y -q caddy
fi

# --- The code -----------------------------------------------------------------------

say "Fetching VegDrop ($BRANCH)"
sudo mkdir -p "$APP_DIR" "$LOG_DIR"
sudo chown -R "$USER:$USER" "$APP_DIR" "$LOG_DIR"

if [ -d "$APP_DIR/.git" ]; then
	git -C "$APP_DIR" fetch -q origin "$BRANCH"
	git -C "$APP_DIR" checkout -q "$BRANCH"
	git -C "$APP_DIR" pull -q --ff-only origin "$BRANCH"
elif [ -z "$(ls -A "$APP_DIR")" ]; then
	git clone -q --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
else
	die "$APP_DIR has files in it but is not a git checkout. Move them away and run this again."
fi

cd "$APP_DIR"

say "Installing the API's dependencies (runtime only)"
# --omit=dev leaves out the test tooling, including mongodb-memory-server, which
# would otherwise download a whole mongod binary onto the box.
npm ci --omit=dev --no-audit --no-fund

# --- .env -------------------------------------------------------------------------

ENV_FILE="$APP_DIR/.env"

if [ ! -f "$ENV_FILE" ]; then
	cat >"$ENV_FILE" <<'EOF'
# VegDrop API — production settings for this VM.
#
# Paste every variable from Railway below this comment:
#   Railway → the vegdrop-api service → Variables → Raw Editor → copy all.
#
# Copy them EXACTLY. KYC_ENCRYPTION_KEY above all: a different value makes every
# vendor's stored bank account unreadable, for good.
#
# NODE_ENV, PORT and TRUST_PROXY are set by the setup script, whatever is
# pasted here. Lines starting with RAILWAY_ are removed.

EOF
	chmod 600 "$ENV_FILE"
	cat <<EOF

=====================================================================
 Step 1 of 2 is done. Now fill in the settings:

   nano $ENV_FILE

 Paste every variable from Railway (service → Variables → Raw Editor),
 save with Ctrl+O, Enter, then exit with Ctrl+X.

 Then run the same command again to start the API.
=====================================================================
EOF
	exit 0
fi

say "Checking .env"
chmod 600 "$ENV_FILE"

# Railway's platform variables describe Railway, not this box. A leftover
# RAILWAY_GIT_COMMIT_SHA in particular would make /api/health report Railway's
# commit, and the "is the VM serving?" check below would read as a yes.
#
# NODE_ENV=production is the only thing that switches the payment and OTP
# safety checks on here: Railway announced itself to the app, this VM cannot
# (see requireRealServices in server/config/env.js). PORT must match the Caddy
# upstream. TRUST_PROXY=2 is two hops, Vercel then Caddy.
sed -i -E \
	-e '/^(export[[:space:]]+)?(NODE_ENV|PORT|TRUST_PROXY|RAILWAY_[A-Z0-9_]*)=/d' \
	-e '/^# Set by deploy\/setup-oracle-api\.sh$/d' \
	"$ENV_FILE"
# A paste without a final newline would otherwise glue its last value to ours.
[ -z "$(tail -c 1 "$ENV_FILE")" ] || echo >>"$ENV_FILE"
printf '# Set by deploy/setup-oracle-api.sh\nNODE_ENV=production\nPORT=5000\nTRUST_PROXY=2\n' >>"$ENV_FILE"

missing=()
for key in MONGODB_URI JWT_ACCESS_SECRET JWT_REFRESH_SECRET OTP_PEPPER KYC_ENCRYPTION_KEY CORS_ALLOWED_ORIGINS; do
	grep -Eq "^(export[[:space:]]+)?${key}=[^[:space:]]" "$ENV_FILE" || missing+=("$key")
done
if [ "${#missing[@]}" -gt 0 ]; then
	die "These are missing from $ENV_FILE: ${missing[*]}
     Copy them from Railway exactly (Variables → Raw Editor), then run this again."
fi

# --- Start the API ------------------------------------------------------------------

say "Starting the API"
if pm2 describe vegdrop-api >/dev/null 2>&1; then
	pm2 restart vegdrop-api --update-env >/dev/null
else
	pm2 start deploy/ecosystem.config.js >/dev/null
fi
pm2 save >/dev/null
sudo env PATH="$PATH" "$(command -v pm2)" startup systemd -u "$USER" --hp "$HOME" >/dev/null

healthy=""
for _ in $(seq 1 30); do
	if curl -fsS http://127.0.0.1:5000/api/health >/dev/null 2>&1; then
		healthy=yes
		break
	fi
	sleep 2
done
if [ -z "$healthy" ]; then
	pm2 logs vegdrop-api --lines 40 --nostream || true
	die "The API is not healthy. The lines above say why. Usually one of:
     - a missing or mistyped variable in $ENV_FILE
     - MongoDB Atlas does not allow this VM yet: Atlas → Network Access → add this VM's public IP"
fi

# --- Caddy ------------------------------------------------------------------------------
# Keep in step with deploy/Caddyfile.api, which explains each line.

say "Configuring Caddy for $DOMAIN"
sudo tee "$CADDYFILE" >/dev/null <<EOF
$MARK
# API only; the website stays on Vercel. Explained line by line in
# deploy/Caddyfile.api.
{
	servers {
		# Vercel forwards every request, so the customer's address arrives in
		# X-Forwarded-For. Without this Caddy replaces it with Vercel's, and
		# every customer shares one rate-limit bucket.
		trusted_proxies static 0.0.0.0/0 ::/0
	}
}

$DOMAIN {
	encode gzip

	handle /api/* {
		reverse_proxy 127.0.0.1:5000
	}

	handle {
		respond 404
	}
}
EOF

sudo caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null
sudo systemctl enable caddy >/dev/null 2>&1
if systemctl is-active --quiet caddy; then
	sudo systemctl reload caddy
else
	sudo systemctl start caddy
fi

# --- Check from outside ------------------------------------------------------------------

say "Checking https://$DOMAIN"

public_ip="$(curl -fsS4 --max-time 10 https://api.ipify.org || true)"
dns_ip="$(getent ahostsv4 "$DOMAIN" | awk 'NR == 1 {print $1}' || true)"
if [ -n "$public_ip" ] && [ "$dns_ip" != "$public_ip" ]; then
	warn "$DOMAIN points to '${dns_ip:-nothing}', but this VM is $public_ip.
    Point it at $public_ip (in DuckDNS), wait a minute, and run this again."
fi

external=""
for _ in $(seq 1 12); do
	if curl -fsS --max-time 10 "https://$DOMAIN/api/health" >/dev/null 2>&1; then
		external=yes
		break
	fi
	sleep 5
done

if [ -z "$external" ]; then
	warn "The API is running here, but https://$DOMAIN does not answer yet. Usually one of:
    1. Oracle console: the subnet's Security List needs ingress rules for TCP 80 and 443
       from 0.0.0.0/0. This script cannot open that one.
    2. $DOMAIN does not point at this VM yet (see above).
    3. The certificate is still being issued. Wait a minute and run this again.
    Caddy's own log: sudo journalctl -u caddy --since '10 min ago'"
	exit 1
fi

cat <<EOF

=====================================================================
 Done. The API is live at:

   https://$DOMAIN/api/health

 Customers still use Railway. To switch them over, change the
 "destination" in vercel.json to:

   https://$DOMAIN/api/:path*

 Keep Railway running for a week, so switching back is one line.

 To update the code later, run this same command again.
=====================================================================
EOF
}

main "$@"
