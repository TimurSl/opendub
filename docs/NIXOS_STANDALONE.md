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
    steamcmdUsername = "MY_STEAM_LOGIN"; # login name only; no password or 2FA in Nix
    workshopAppId = 5020310;         # Dub Together's Steam app ID
    workshopDir = "/var/lib/opendub/packs";        # validated/imported packs
    steamcmdDir = "/var/lib/opendub/steamcmd";      # SteamCMD downloads/cache
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

Open the admin studio, create a party (or download before one) and paste a Steam Workshop URL or numeric item ID. The server allows only numeric IDs and canonical Steam Community Workshop links, **not arbitrary URLs**. The configured `workshopAppId` selects the owning game for `workshop_download_item`. For Dub Together the Steam App ID is **5020310** ([Steam store](https://store.steampowered.com/app/5020310/Dub_Together/)). Workshop item IDs are a **different** number taken from the Workshop link.

Authenticated SteamCMD is supported. SteamCMD may require an account that owns the game or otherwise has access to the item. Authenticate **once interactively on the VPS as the service user**. No login details are ever submitted through the admin UI or saved in Nix, environment variables or command arguments:

```sh
# First deploy with workshopDownloader = true so the opendub user and steamcmd exist.
sudo nixos-rebuild switch --flake /var/nixos-config#pussy

# The login name MUST match services.opendub.steamcmdUsername.
sudo -u opendub -H opendub-steam login MY_STEAM_LOGIN
# Enter password / Steam Guard only into the interactive SteamCMD prompt.
```

The `opendub-steam` command starts SteamCMD with the **same** HOME (`/var/lib/opendub`) and persistent working directory (`/var/lib/opendub/steamcmd`) that the service uses; it needs an interactive terminal and does not take a password or Steam Guard code as arguments. If you set a nondefault `services.opendub.steamcmdDir`, pass `--steamcmd-dir /YOUR/ABSOLUTE/PATH` to the login command so it shares the service's working directory. `sudo -iu opendub` is **not necessary**, and can fail for a system account with a non-login shell. Re-run the command when Steam expires its session or asks for another Steam Guard confirmation. Keep `/var/lib/opendub` mode 0700, since Steam stores account credentials there. Steam may invalidate or challenge a SteamCMD session if the same account is used concurrently on another device.

The NixOS configuration separates two locations:

- `steamcmdDir`: SteamCMD's working/download directory; under it (or Steam's persistent data path) are the raw `steamapps/workshop/content/<AppID>/<ItemID>` files and manifests.
- `workshopDir`: the destination containing **validated**, locally imported pack directories, which the application displays in its admin UI. This directory may be an absolute path such as `/srv/opendub/packs`; it does **not** need to be the raw Steam Workshop cache.

You can customize both in `services.opendub` and their directories are created with permissions for the `opendub` user. Keep them outside `/home` because the service enables systemd `ProtectHome`. Avoid changing `steamcmdDir` or `opendub`'s HOME after signing in: authentication and downloaded files will no longer be in the expected location. For a non-NixOS deployment, set `STEAMCMD_USERNAME`, `WORKSHOP_APP_ID`, `STEAMCMD_DIR`, and `WORKSHOP_DIR` alongside `HOME` (and `STEAMCMD_PATH`).

The server launches SteamCMD non-interactively without a shell or password and explicitly suppresses password prompts. If authentication expires, downloads fail with an error asking the operator to log in on the VPS; no Steam auth prompts are exposed to remote players. Downloads are parsed and staged before replacing a working pack, and completed packs show up without restarting the server. SteamCMD sometimes returns exit status 0 after a Workshop error, so the downloader also checks its output for failure messages. Downloading a pack with a purchased account does **not** automatically grant redistribution or public hosting rights to third-party media; check the Workshop item license and author permissions.

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
- `SteamCMD did not provide Workshop item` or `SteamCMD authentication required`: re-run `sudo -u opendub -H opendub-steam login MY_STEAM_LOGIN`; inspect `journalctl -u opendub`, SteamCMD logs and item eligibility. The downloader never accepts arbitrary SteamCMD arguments.
- Port 7373 should listen only on `127.0.0.1`; firewall expose 80/443, not the Node service.
- Plan VPS disk for Workshop video, conversion cache, uploads and exports. `ffmpeg` transcodes user-supplied media and should remain sandboxed as an unprivileged service. Back up `/var/lib/opendub/packs` and completed exports externally if desired.

This module has not been deployed to your VPS from this environment. Check `nix flake check` and `nixos-rebuild build --flake /var/nixos-config#pussy` against your actual Nixpkgs revision before switching.
