# Open Dub — standalone NixOS VPS

The VPS now runs the runtime **and** holds the Workshop media, recordings and exports. It is not a reverse proxy to a desktop. You no longer need your desktop online or WireGuard for players to join. The app binds to `127.0.0.1:7373`; Nginx terminates HTTPS and forwards WebSocket connections. Player microphones require HTTPS.

## 1. Add the flake input to `/var/nixos-config/flake.nix`

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    opendub-online.url = "git+https://codeberg.org/melvi/opendub-online.git";
    opendub-online.inputs.nixpkgs.follows = "nixpkgs";
  };
  outputs = inputs@{ self, nixpkgs, opendub-online, ... }: {
    nixosConfigurations.pussy = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        ./hosts/pussy/configuration.nix
        opendub-online.nixosModules.default
      ];
      specialArgs = { inherit inputs; };
    };
  };
}
```

Integrate the `opendub-online` input and module into your **existing** inputs/outputs rather than replacing other imports. Committing `flake.lock` pins the runtime version. If editing Open Dub itself, deploy the changed repository before triggering Patchouli; flake fetches Codeberg, not your current workspace.

## 2. Enable the NixOS module

```nix
{ lib, ... }: {
  # Enables SteamCMD. It has a non-free license and x86 Linux compatibility constraints.
  nixpkgs.config.allowUnfreePredicate = pkg: lib.getName pkg == "steamcmd";

  services.opendub = {
    enable = true;
    domain = "dub.example.org"; # DNS A/AAAA record -> VPS
    workshopDownloader = true;
    steamcmdUsername = "anonymous";
    wireGuardAdminCidrs = [ "10.77.0.0/24" ]; # optional; omit for token-only admin
  };

  security.acme.acceptTerms = true;
  security.acme.defaults.email = "you@example.org";
  networking.firewall.allowedTCPPorts = [ 80 443 ];
}
```

Replace domain/email with real values. Nginx is configured with ACME and WebSocket proxying, and **overwrites** `X-Real-IP`. Do not use nginx `proxy_set_header X-Real-IP $http_x_real_ip`: that makes unauthenticated admin spoofable. Keep direct port 7373 closed externally. `WG_ADMIN_CIDRS` is *only* an IP-based bypass and is safe only if the WireGuard subnet cannot be claimed by ordinary internet clients. The application rejects broad/public ranges. Make sure your VPN endpoint routes to the Nginx domain through the tunnel if you want bypass on that domain. To require a token everywhere, use `wireGuardAdminCidrs = [];`.

```sh
sudo nixos-rebuild switch --flake /var/nixos-config#pussy
sudo systemctl status opendub
sudo journalctl -u opendub -f
```

Service runs as a dedicated `opendub` system user, with data rooted under `/var/lib/opendub` (packs, SteamCMD state, takes and video-cache). State persists across rebuilds. Sessions and takes from an **active room do not survive a service restart** under the current runtime session model; complete/export a match before deploying.

## 3. Admin auth (`opendub-auth`)

On first start the service creates a random 256-bit token in `/var/lib/opendub/admin-token`, mode 0600. The token is **not** written to the journal or Nix store. Read it as the service user:

```sh
sudo -u opendub opendub-auth --data-dir /var/lib/opendub
# Rotate/revoke all existing admin credentials (no service restart needed):
sudo -u opendub opendub-auth --data-dir /var/lib/opendub --rotate
```

Visit `https://dub.example.org/admin`. From the public internet the login form requires the token. On an explicitly trusted WireGuard IP, the admin UI opens automatically without a token. Player invite URLs are still independent and do not include the admin token. Keep the token out of screenshots, chats and CI logs.

## 4. Workshop downloader

Open the admin studio, create a party (or download before one) and paste a Dub Together Steam Workshop URL or numeric item ID. The application accepts only numeric IDs and the canonical Steam Community item URL, **not arbitrary URLs**. App ID is `5020310`. SteamCMD runs server-side without a shell; downloaded files are parsed before installation. Completed packs show up without restarting the server. Workshop data remains under `/var/lib/opendub/packs`.

SteamCMD anonymous access is controlled by the game's Workshop settings and **may fail with `No subscription`**. If necessary, use an account legally authorized to download the Workshop content. Authenticate **interactively**, without storing passwords in configuration or using the web admin interface:

```sh
# With a suitable interactive TTY (for example sudo -iu opendub if the account allows shell):
sudo -u opendub -H steamcmd +login YOUR_STEAM_USERNAME +quit
```

Then set `services.opendub.steamcmdUsername = "YOUR_STEAM_USERNAME";` and rebuild. SteamCMD must reuse cached authorization for that exact service user. You may need to complete Steam Guard interactively. Some games/items cannot be downloaded headlessly even with an account. Respect Workshop authors' rights; do not redistribute packs or copyrighted videos without permission.

### Manual packs / recovery

Put each pack folder (with `_pack_info.ini`, `dub_video.ogv`, `_backing_track.ogg` and matching `.ini`/`.mp3` lines) under `/var/lib/opendub/packs/`. Keep files owned by `opendub:opendub` and non-world-readable. Refresh packs in admin UI. Uploading via SCP as root and fixing ownership is a fallback when SteamCMD cannot fetch an item.

## 5. Patchouli Deployment (your existing deployment service)

This uses your existing [Patchouli Deployment](https://zenisoft.net.ua/projects/patchouli-deployment/) as intended: **no SSH keys for CI and no user-controlled commands in the webhook body**. Your host's `/var/nixos-config` owns the pinned Open Dub input. Add to your host's existing Patchouli settings:

```nix
{ config, ... }: {
  services.patchouli-deployment = {
    enable = true;
    # If webhook is ALREADY configured on your host, keep the existing setting;
    # do not create a second webhook listener on the same port.
    instances.opendub = {
      flakePath = "/var/nixos-config";
      flakeRef = "/var/nixos-config#pussy";
      user = "licking";
      inputs = [ "opendub-online" ];
      dates = "daily"; # fallback polling
    };
    webhook.projects.opendub = {
      tokenFile = config.age.secrets."opendub-cd-token".path;
      instance = "opendub";
    };
  };
}
```

Provision an agenix secret called `opendub-cd-token` **in the VPS Nix configuration**, containing a long random bearer token. Configure the same value as the `PATCHOULI_DEPLOYMENT_TOKEN` secret in the Open Dub Codeberg repository. This repo includes `.forgejo/workflows/patchouli-deploy.yml` for a main-branch push, which calls `https://cd.zenisoft.net.ua/patchouli-deployment` with a bearer token. The webhook must already route to Patchouli on the VPS (and the Codeberg runner name must match the runner you actually have). Patchouli then updates only `opendub-online` in `/var/nixos-config/flake.lock` and rebuilds your `pussy` generation. Rollback behavior is provided by Patchouli; do not run an additional `git reset`/`nixos-rebuild` script in CI.

For an initial deployment, manually run `sudo nixos-rebuild switch --flake /var/nixos-config#pussy` once after adding the module and creating DNS/ACME secrets. Afterwards pushes on `main` can trigger Patchouli. Keep the webhook secret **separate** from the Open Dub admin token.

## 6. Troubleshooting / security

- `opendub-auth` returns the **admin** secret, not a party invitation; access is bearer cookie or approved WireGuard IP.
- `401 Admin authorization required`: wrong/revoked token or browser cookie missing. Run `opendub-auth` and log in again.
- `403 Origin does not match runtime`: check `https://` Nginx forwarding and unchanged `Host`, and never forward untrusted `X-Forwarded-Proto`.
- Microphone permission blocked: use real HTTPS with a trusted certificate; HTTP LAN/WG URLs alone do not qualify.
- `SteamCMD finished, but pack files were not found`: inspect `journalctl -u opendub` / SteamCMD account and Workshop eligibility. The downloader never accepts arbitrary SteamCMD arguments.
- Port 7373 should listen only on `127.0.0.1`; firewall expose 80/443, not the Node service.
- Plan VPS disk for Workshop video, conversion cache, uploads and exports. `ffmpeg` transcodes user-supplied media and should remain sandboxed as an unprivileged service. Back up `/var/lib/opendub/packs` and completed exports externally if desired.

This module has not been deployed to your VPS from this environment. Check `nix flake check` and `nixos-rebuild build --flake /var/nixos-config#pussy` against your actual Nixpkgs revision before switching.
