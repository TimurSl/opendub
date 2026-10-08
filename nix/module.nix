{ config, lib, pkgs, ... }:
let
  cfg = config.services.opendub;
  inherit (lib) mkEnableOption mkOption mkIf types;
  state = "/var/lib/opendub";
in {
  options.services.opendub = {
    enable = mkEnableOption "Open Dub standalone dubbing server";
    package = mkOption {
      type = types.package;
      default = pkgs.callPackage ./package.nix { };
      description = "Open Dub executable package.";
    };
    domain = mkOption { type = types.str; example = "dub.example.org"; description = "Public hostname for the HTTPS reverse proxy and player invites."; };
    port = mkOption { type = types.port; default = 7373; description = "Loopback-only HTTP server port, proxied by Nginx."; };
    nginx = mkOption { type = types.bool; default = true; description = "Configure a TLS Nginx reverse proxy and ACME certificate."; };
    wireGuardAdminCidrs = mkOption {
      type = types.listOf types.str; default = [ ]; example = [ "10.77.0.0/24" ];
      description = "Private WireGuard IPv4 networks permitted to use admin without a token. Requires Nginx to overwrite X-Real-IP.";
    };
    steamcmdUsername = mkOption {
      type = types.str; default = "anonymous"; example = "my_steam_login";
      description = "Steam login name, not a password. Authorize interactively as user opendub via opendub-steam login.";
    };
    workshopAppId = mkOption {
      type = types.int; default = 5020310;
      description = "Steam game App ID used for workshop_download_item. The default is Dub Together.";
    };
    workshopDir = mkOption {
      type = types.str; default = "${state}/packs";
      description = "Directory containing imported/validated Open Dub packs; must be writable by opendub.";
    };
    steamcmdDir = mkOption {
      type = types.str; default = "${state}/steamcmd";
      description = "Persistent SteamCMD working/download directory, shared with opendub-steam login.";
    };
    workshopDownloader = mkOption {
      type = types.bool; default = false;
      description = "Enable SteamCMD Workshop installation. Needs allowUnfree for pkgs.steamcmd (x86_64-linux).";
    };
  };
  config = mkIf cfg.enable {
    environment.systemPackages = [ cfg.package ] ++ lib.optionals cfg.workshopDownloader [ pkgs.steamcmd ];
    users.groups.opendub = { };
    users.users.opendub = {
      isSystemUser = true; group = "opendub";
      home = state;
      description = "Open Dub dedicated runtime";
    };
    # Extra paths outside StateDirectory are explicitly created for the
    # unprivileged service account, not at runtime as root.
    systemd.tmpfiles.rules = [
      "d ${cfg.workshopDir} 0700 opendub opendub -"
      "d ${cfg.steamcmdDir} 0700 opendub opendub -"
    ];
    systemd.services.opendub = {
      description = "Open Dub standalone dubbing runtime";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ]; wants = [ "network-online.target" ];
      path = [ pkgs.ffmpeg ] ++ lib.optionals cfg.workshopDownloader [ pkgs.steamcmd ];
      environment = {
        PORT = toString cfg.port;
        HOST = "127.0.0.1";
        DATA_DIR = state;
        HOME = state;
        WORKSHOP_DIR = cfg.workshopDir;
        STEAMCMD_DIR = cfg.steamcmdDir;
        WORKSHOP_APP_ID = toString cfg.workshopAppId;
        FFMPEG_PATH = "${pkgs.ffmpeg}/bin/ffmpeg";
        TRANSCODE_VIDEO = "1";
        STEAMCMD_USERNAME = cfg.steamcmdUsername;
        STEAMCMD_PATH = if cfg.workshopDownloader then "${pkgs.steamcmd}/bin/steamcmd" else "";
        PUBLIC_LINK = "https://${cfg.domain}";
        TRUSTED_PROXY = "127.0.0.1";
        WG_ADMIN_CIDRS = lib.concatStringsSep "," cfg.wireGuardAdminCidrs;
      };
      serviceConfig = {
        Type = "simple";
        User = "opendub"; Group = "opendub";
        StateDirectory = "opendub";
        StateDirectoryMode = "0700";
        WorkingDirectory = state;
        ExecStart = "${lib.getExe cfg.package}";
        Restart = "on-failure";
        RestartSec = 3;
        UMask = "0077";
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        ProtectKernelTunables = true;
        ProtectControlGroups = true;
        ProtectKernelModules = true;
        RestrictSUIDSGID = true;
        ReadWritePaths = lib.unique [ state cfg.workshopDir cfg.steamcmdDir ];
      };
    };
    services.nginx = mkIf cfg.nginx {
      enable = true;
      virtualHosts.${cfg.domain} = {
        enableACME = true;
        forceSSL = true;
        locations."/" = {
          proxyPass = "http://127.0.0.1:${toString cfg.port}";
          proxyWebsockets = true;
          recommendedProxySettings = false;
          extraConfig = ''
            # Overwrite untrusted client headers; required for token-free WG access.
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $remote_addr;
            proxy_set_header X-Forwarded-Proto $scheme;
            client_max_body_size 35m;
            proxy_read_timeout 1h;
            proxy_send_timeout 1h;
            proxy_request_buffering off;
          '';
        };
      };
    };
    assertions = [ {
      assertion = cfg.workshopAppId > 0 && cfg.workshopAppId <= 4294967295;
      message = "services.opendub.workshopAppId must be a positive 32-bit Steam app ID";
    } {
      assertion = builtins.all (dir: lib.hasPrefix "/" dir && !(lib.hasInfix ".." dir)) [ cfg.workshopDir cfg.steamcmdDir ];
      message = "services.opendub.workshopDir and steamcmdDir must be absolute paths without '..'";
    } {
      assertion = cfg.domain != "" && !(lib.hasInfix "/" cfg.domain) && !(lib.hasInfix ":" cfg.domain);
      message = "services.opendub.domain must be a hostname, without scheme/path/port";
    } ];
  };
}
