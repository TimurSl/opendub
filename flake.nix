{
  description = "Open Dub standalone runtime, CLI and NixOS service";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f (import nixpkgs { inherit system; }));
    in {
      packages = forAllSystems (pkgs: {
        default = pkgs.callPackage ./nix/package.nix { };
        opendub = pkgs.callPackage ./nix/package.nix { };
      });
      apps = forAllSystems (pkgs: {
        default = { type = "app"; program = "${self.packages.${pkgs.system}.default}/bin/opendub"; };
        auth = { type = "app"; program = "${self.packages.${pkgs.system}.default}/bin/opendub-auth"; };
        steam = { type = "app"; program = "${self.packages.${pkgs.system}.default}/bin/opendub-steam"; };
      });
      nixosModules.default = import ./nix/module.nix;
      nixosModules.opendub = self.nixosModules.default;
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell { packages = [ pkgs.nodejs_22 pkgs.ffmpeg ]; };
      });
    };
}
