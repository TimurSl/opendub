> **Legacy desktop proxy mode.** For a standalone VPS, use [NixOS Standalone](NIXOS_STANDALONE.md) instead. Public admin access is now possible with `opendub-auth` tokens; the old local-only statements below refer to a former security restriction. Do **not** enable `WG_ADMIN_CIDRS` on a proxy that passes untrusted client headers.

# Desktop + VPS as Proxy

Run gameplay, Workshop discovery, and recording storage on your desktop. Use your existing WireGuard tunnel to let Nginx on the VPS expose the player app through public HTTPS. The VPS forwards traffic; it does not understand packs, lines, or session rules and does not store pack files or takes.

```text
Players: https://dub.zenisoft.net.ua
                 |
VPS: public HTTPS / Nginx, WireGuard 10.77.0.1
                 |
        existing WireGuard tunnel
                 |
Desktop: HTTP runtime, 10.77.0.3:7373
Host admin: http://localhost:7373/admin
```

Replace these example addresses and names with your own:

- `dub.zenisoft.net.ua`: public hostname, with a DNS A record pointing to the VPS public IP.
- `10.77.0.1`: VPS WireGuard address.
- `10.77.0.3`: desktop WireGuard address.
- `wg0`: WireGuard interface name on the desktop.

Only create a DNS AAAA record if the VPS also accepts public IPv6 traffic on the required ports. The desktop needs no router port forwarding.

## 1. Check the existing WireGuard path

Keep your existing tunnel configuration. The VPS needs a peer route to `10.77.0.3`; the desktop needs a peer route to `10.77.0.1`. These are relevant portions of an example configuration, not replacement files:

```ini
# Desktop
[Interface]
Address = 10.77.0.3/32
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
AllowedIPs = 10.77.0.3/32
```

If the tunnel already carries other networks, retain those existing `AllowedIPs` entries too. The desktop's outbound connection and `PersistentKeepalive` keep the NAT mapping available to the VPS. Check the latest handshake with `sudo wg show`. Nginx initiates its own connection to the desktop, so this scheme requires neither a full-tunnel route nor IP forwarding/NAT of player packets.

## 2. Start the desktop runtime with explicit proxy trust

Public HTTPS may terminate at Nginx and travel over HTTP inside WireGuard. Configure the runtime to trust the **VPS source address** on that tunnel, while preserving the public Host header. For example, if the VPS is `10.77.0.1` and the desktop runtime is `10.77.0.3`:

```sh
WORKSHOP_DIR="/path/to/workshop/packs" \
DATA_DIR="/path/to/runtime-data" \
HOST=0.0.0.0 PORT=7373 \
TRUSTED_PROXY=10.77.0.1 \
PUBLIC_LINK=https://dub.zenisoft.net.ua \
npm start
```

Substitute your VPS's actual WireGuard source IP for `10.77.0.1`. On the VPS, `ip route get 10.77.0.3` reports the `src` address used for the upstream connection. `10.77.0.3` is the desktop's destination address, so it does not belong in `TRUSTED_PROXY`. Restart the runtime after changing its environment. `PUBLIC_LINK` sets the copied invitation origin and does not authorize forwarded headers.

`TRUSTED_PROXY` accepts exact IPv4 or IPv6 addresses separated by commas. Trust applies only to the socket's directly connected peer. Requests from other sources continue to use the actual transport scheme even when they send forwarded headers. Native TLS connections always use HTTPS. Admin access requires the admin token unless a source belongs to an explicitly configured WireGuard admin CIDR.

Add `TRANSCODE_VIDEO=1` if browser compatibility requires the optional whole-video MP4 cache and ffmpeg is installed. Keep the process running while the room is active. Open `http://localhost:7373/admin` on the desktop to manage the room; public players use the HTTPS invitation.

## 3. Scope the firewall

Allow desktop TCP port 7373 only from the VPS WireGuard peer on the WireGuard interface, while retaining localhost access. For UFW with incoming traffic denied by default:

```sh
# Desktop; substitute the actual interface and VPS tunnel address.
sudo ufw allow in on wg0 from 10.77.0.1 to any port 7373 proto tcp
```

Remove any broad allow rule for port 7373 and keep it closed on the desktop's public interface and router. Adapt the rule to your existing firewall. On the VPS, retain SSH and WireGuard rules and allow public HTTPS:

```sh
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

Public VPS port 7373 stays closed. Nginx connects to it inside WireGuard.

## 4. Configure Nginx on the VPS

Preserve the browser's Host, replace its forwarded protocol header with the proxy's scheme, and forward WebSocket upgrades. The `map` belongs in Nginx's `http` context. This example assumes the public certificate already exists:

```nginx
map $http_upgrade $dub_connection_upgrade {
    default upgrade;
    '' close;
}

server {
    listen 80;
    server_name dub.zenisoft.net.ua;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name dub.zenisoft.net.ua;
    ssl_certificate /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location ~* ^/(?:admin(?:[/.]|$)|api/admin(?:/|$)) {
        return 403;
    }

    location / {
        proxy_pass http://10.77.0.3:7373;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $dub_connection_upgrade;
        client_max_body_size 32m;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
}
```

Define `Host` and `X-Forwarded-Proto` once for this location. The runtime rejects multiple or comma-separated forwarded protocol values from trusted peers. It ignores `X-Forwarded-Host`, so the real upstream Host must remain `dub.zenisoft.net.ua` rather than the WireGuard destination.

For NixOS, the corresponding virtual host is:

```nix
services.nginx.virtualHosts."dub.zenisoft.net.ua" = {
  forceSSL = true;
  enableACME = true;
  locations."~* ^/(?:admin(?:[/.]|$)|api/admin(?:/|$))".extraConfig = ''
    return 403;
  '';
  locations."/" = {
    recommendedProxySettings = false;
    proxyPass = "http://10.77.0.3:7373";
    proxyWebsockets = true;
    extraConfig = ''
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-Proto $scheme;
      client_max_body_size 32m;
      proxy_buffering off;
      proxy_request_buffering off;
      proxy_read_timeout 1h;
      proxy_send_timeout 1h;
    '';
  };
};
```

The explicit location setting `recommendedProxySettings = false` prevents NixOS from adding its recommended proxy headers alongside the manual headers shown above, even if `services.nginx.recommendedProxySettings` is enabled globally. Keep `proxyWebsockets = true` and the manual Host and protocol headers. Alternatively, enable the recommended settings for this location and remove every manually supplied header already defined by them: Host, `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto`, `X-Forwarded-Host`, and `X-Forwarded-Server`. Keep your existing ACME email/terms settings, firewall configuration, and unrelated virtual hosts. Upstream `proxy_ssl_*` directives apply to `https://` upstreams and are unnecessary for this `http://` destination.

Public admin routes require the token; an explicitly approved WireGuard source may bypass it. Nginx must overwrite `X-Real-IP`, never trust a client-supplied header. Nginx forwards cookies, recording uploads, and HTTP range requests through the same location.

A verified HTTPS upstream remains an alternative: configure the runtime's `TLS_CERT` and `TLS_KEY`, proxy to `https://10.77.0.3:7373`, preserve Host, and verify its certificate against a trusted CA and matching certificate name. That transport requires no `TRUSTED_PROXY`. Keep upstream certificate verification enabled.

## 5. Share the public player invitation

Select a pack and open the lobby in the local admin interface. With `PUBLIC_LINK` configured, copied invitations already use the public hostname. To change an existing invitation, replace only the origin:

```text
http://localhost:7373/join/ROOM_ID#token=JOIN_TOKEN
https://dub.zenisoft.net.ua/join/ROOM_ID#token=JOIN_TOKEN
```

Keep the room ID and token fragment unchanged. Never share the admin token. Players join through the public HTTPS address, permit microphone access, and record their queues independently. Workshop files and take storage remain on the desktop; media streams through the VPS to player browsers.

## Check and troubleshoot

From the VPS, verify the tunnel route and HTTP listener:

```sh
ip route get 10.77.0.3
curl http://10.77.0.3:7373/
```

`https://dub.zenisoft.net.ua/` should load the player page. `/admin` should return `403`. `/api/state` returns `401` before a player joins. After joining, `/ws?viewer=player` should receive HTTP `101` and media range requests should return `206`.

- **`403 Origin does not match runtime` or proxy-settings notice:** confirm the running desktop process has `TRUSTED_PROXY` set to the VPS source IP, then check the preserved public Host and single `X-Forwarded-Proto: https`. A page can load successfully while browser mutations and WebSocket upgrades fail this check.
- **`403 Invalid proxy protocol header`:** the source IP matched `TRUSTED_PROXY`, but its protocol header was malformed. NixOS recommended settings plus a manual `proxy_set_header X-Forwarded-Proto` can send two values, which arrive as `https, https`. Set `services.nginx.virtualHosts."dub.zenisoft.net.ua".locations."/".recommendedProxySettings = false`, retain the manual headers, and rebuild/reload Nginx. The proxy must send exactly one `http` or `https` value. Use `sudo nginx -T` on the VPS to check the generated location and its included header configuration.
- **Nginx `502`:** check the WireGuard handshake, scoped desktop firewall, runtime process, upstream address, and Nginx logs.
- **Microphone unavailable:** use the public HTTPS invitation and allow microphone permission. Direct remote HTTP access does not grant microphone access.
- **Upload rejected:** the runtime default is 25 MiB per take (`MAX_UPLOAD_MB`); keep Nginx's body limit above that plus multipart overhead. A local take remains available for retry after connection loss.
- **Live updates stop:** enable WebSocket proxying (`proxyWebsockets = true` on NixOS), forward the upgrade headers, and retain a suitable idle timeout.

The desktop must stay awake, the runtime must stay running, and the tunnel must remain connected.
