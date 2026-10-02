# Desktop + VPS as Proxy

Run gameplay, Workshop discovery, and recording storage on your desktop. Use your existing WireGuard tunnel to let Caddy on the VPS expose the player app through public HTTPS. The VPS forwards traffic; it does not understand packs, lines, or session rules and does not store pack files or takes.

```text
Players: https://dub.example.com
                 |
VPS: public HTTPS / Caddy, WireGuard 10.77.0.1
                 |
        existing WireGuard tunnel
                 |
Desktop: HTTPS runtime, 10.77.0.2:7373
Host admin: https://localhost:7373/admin
```

Replace these example addresses and names with your own:

- `dub.example.com`: public hostname, with a DNS A record pointing to the VPS public IP.
- `10.77.0.1`: VPS WireGuard address.
- `10.77.0.2`: desktop WireGuard address.
- `wg0`: WireGuard interface name on the desktop.
- `desktop-dub.internal`: name used to verify the desktop's private TLS certificate; it does not need public DNS.

Only create a DNS AAAA record if the VPS also accepts public IPv6 traffic on the required ports. The desktop needs no router port forwarding.

## 1. Check the existing WireGuard path

Keep your existing tunnel configuration. The VPS needs a peer route to `10.77.0.2`; the desktop needs a peer route to `10.77.0.1`. These are relevant portions of an example configuration, not replacement files:

```ini
# Desktop
[Interface]
Address = 10.77.0.2/32
PrivateKey = <DESKTOP_PRIVATE_KEY>

[Peer]
PublicKey = <VPS_PUBLIC_KEY>
Endpoint = <VPS_PUBLIC_IP>:51820
AllowedIPs = 10.77.0.1/32
PersistentKeepalive = 25
```

```ini
# Peer on the VPS's existing WireGuard interface
[Peer]
PublicKey = <DESKTOP_PUBLIC_KEY>
AllowedIPs = 10.77.0.2/32
```

If the tunnel already carries other networks, retain those existing `AllowedIPs` entries too. The desktop's outbound connection and `PersistentKeepalive` keep the NAT mapping available to the VPS. Check the latest handshake with `sudo wg show`. Caddy initiates its own connection to the desktop, so this scheme requires neither a full-tunnel route nor IP forwarding/NAT of player packets.

## 2. Create a private desktop certificate

The runtime requires HTTPS on the upstream connection as well as at the public proxy. Its origin checks compare the actual connection scheme and HTTP Host header. Forwarding public HTTPS requests into an HTTP runtime would return `403` for browser mutations and WebSocket upgrades.

Run these example commands **on the desktop**, with OpenSSL installed:

```sh
mkdir -p "$HOME/.config/open-dub/tls"
chmod 700 "$HOME/.config/open-dub/tls"
cd "$HOME/.config/open-dub/tls"
umask 077

# OpenSSL prompts for a passphrase protecting this issuer key.
openssl req -x509 -newkey rsa:3072 -sha256 -days 3650 \
  -keyout desktop-ca.key -out desktop-ca.crt \
  -subj "/CN=Open Dub Desktop CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign"

openssl req -new -newkey rsa:3072 -nodes \
  -keyout desktop.key -out desktop.csr \
  -subj "/CN=desktop-dub.internal"

cat > desktop.ext <<'EOF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:desktop-dub.internal,DNS:localhost,IP:10.77.0.2,IP:127.0.0.1
EOF

openssl x509 -req -in desktop.csr \
  -CA desktop-ca.crt -CAkey desktop-ca.key -CAcreateserial \
  -out desktop.crt -days 365 -sha256 -extfile desktop.ext

chmod 600 desktop.key desktop-ca.key
```

Keep `desktop.key` and the issuer private key `desktop-ca.key` on the desktop, outside the repository. The runtime uses only the leaf certificate and `desktop.key`; the issuer key can remain offline after signing. Trust `desktop-ca.crt` in the host's OS/browser certificate store so local HTTPS admin access has no certificate error. Renew the leaf certificate before it expires.

Copy **only the public certificate** `desktop-ca.crt` to the VPS using your usual file transfer method. On the VPS, install the copied certificate where the Caddy service can read it:

```sh
sudo install -m 0644 /path/to/copied/desktop-ca.crt /etc/caddy/dub-desktop-ca.pem
```

Neither desktop private key belongs on the VPS. Players do not need to install this private CA: they receive Caddy's public certificate instead.

## 3. Start the desktop runtime and scope its firewall

From this project's directory on the desktop:

```sh
WORKSHOP_DIR="/path/to/workshop/packs" \
DATA_DIR="/path/to/runtime-data" \
HOST=0.0.0.0 PORT=7373 \
TLS_CERT="$HOME/.config/open-dub/tls/desktop.crt" \
TLS_KEY="$HOME/.config/open-dub/tls/desktop.key" \
npm start
```

Add `TRANSCODE_VIDEO=1` if browser compatibility requires the optional whole-video MP4 cache and ffmpeg is installed. Keep the process running while the room is active.

Allow desktop TCP port 7373 **only from the VPS WireGuard peer on the WireGuard interface**, while retaining localhost access. For an existing UFW setup with incoming traffic denied by default:

```sh
# Desktop; substitute the actual interface and VPS tunnel address.
sudo ufw allow in on wg0 from 10.77.0.1 to any port 7373 proto tcp
```

Remove any existing broad allow rule for port 7373; do not expose it through the desktop's router or public interface. Adapt this rule to your existing firewall rather than resetting it. On the VPS, keep the existing WireGuard UDP-port rule and permit public Caddy traffic:

```sh
# VPS; retain existing SSH and WireGuard rules.
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

Do not open public VPS port 7373. Caddy reaches that port through WireGuard. Open `https://localhost:7373/admin` on the desktop and enter the runtime's admin token.

## 4. Configure Caddy on the VPS

Use a current Caddy version supporting `tls_trust_pool file`; see the official [reverse_proxy documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#examples) for its verified HTTPS-upstream examples. Add this site to the VPS's Caddyfile:

```caddyfile
dub.example.com {
    @admin path /admin /admin/ /admin/* /admin.html /api/admin /api/admin/*
    handle @admin {
        respond "Admin access is local to the desktop." 403
    }

    handle {
        reverse_proxy https://10.77.0.2:7373 {
            header_up Host {host}
            transport http {
                tls_server_name desktop-dub.internal
                tls_trust_pool file /etc/caddy/dub-desktop-ca.pem
            }
        }
    }
}
```

Caddy obtains and renews a public Let's Encrypt certificate automatically when DNS and ports 80/443 are reachable. Its public certificate and private key stay under Caddy's normal protected storage. The `tls_trust_pool` verifies the desktop certificate using your public CA certificate; `tls_server_name` checks its `desktop-dub.internal` SAN. Keep certificate verification enabled. No `tls_insecure_skip_verify` setting is needed.

`header_up Host {host}` preserves `dub.example.com` for the runtime's origin check, while the TLS certificate name remains `desktop-dub.internal`. HTTPS upstream plus the preserved Host allows public browser requests without trusting forwarded headers or changing the server's origin policy.

Caddy automatically forwards WebSocket upgrades, multipart uploads, cookies, and HTTP range requests. No gameplay-specific proxy code or separate media routes are needed. The public admin deny rules provide a second boundary: the runtime also rejects admin access from the VPS's non-loopback address and normalizes encoded admin paths before serving static files.

Validate and reload using your existing Caddy service:

```sh
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

## 5. Share the public player invitation

Select a pack in the local admin interface. Copy its invitation and replace **only the origin**:

```text
https://localhost:7373/join/ROOM_ID#token=JOIN_TOKEN
https://dub.example.com/join/ROOM_ID#token=JOIN_TOKEN
```

Keep the room ID and token fragment unchanged. Never share the admin token. Players join through the public HTTPS address, permit microphone access, and record their queues independently. Workshop files and take storage remain on the desktop; media streams through the VPS to player browsers.

## Check and troubleshoot

From the VPS, verify the upstream route and certificate:

```sh
curl --cacert /etc/caddy/dub-desktop-ca.pem \
  --resolve desktop-dub.internal:7373:10.77.0.2 \
  https://desktop-dub.internal:7373/
```

`https://dub.example.com/` should load the player page. `/admin` should return `403`. `/api/state` returns `401` before a player joins; that is expected. After joining, the browser's `/ws?viewer=player` connection should receive HTTP `101`.

- **`403 Origin does not match runtime`:** check HTTPS upstream and `header_up Host {host}`. Do not rewrite the Host to the WireGuard IP or internal certificate name.
- **Caddy `502`:** check the WireGuard handshake, scoped desktop firewall, runtime process, and Caddy logs. Certificate errors mean the CA file, certificate expiry, or `desktop-dub.internal` SAN needs correction; do not bypass verification.
- **Microphone unavailable:** use the public HTTPS URL and allow microphone permission. The host's local admin browser must trust the desktop CA separately.
- **Upload rejected:** the default limit is 25 MiB per take (`MAX_UPLOAD_MB`); requests must complete within the runtime's upload timeout. Check any additional limits imposed by your VPS environment. A local take remains available for retry after connection loss.
- **Live updates stop:** ensure traffic passes directly through Caddy's `reverse_proxy`, which handles WebSockets. Browser clients reconnect and fetch authoritative state; a dropped socket does not impose recording turns or change take timestamps.

The desktop must stay awake, the runtime must stay running, and the tunnel must remain connected. This is a proxy deployment of the standalone runtime, not the future gameplay-independent relay implementation.
