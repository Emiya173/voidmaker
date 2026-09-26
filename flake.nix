{
  description = "VoidMaker TypeScript voice assistant on NixOS/niri";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs = { nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      aecPlugin = import ./nix/aec-plugin.nix { inherit pkgs; };
    in
    {
      packages.${system}.aec-plugin = aecPlugin;
      devShells.${system}.default = pkgs.mkShell {
        packages = with pkgs; [
          nodejs_22
          pnpm
          postgresql_17
          quickshell
          pipewire
          mpv
          grim
          playerctl
          systemd
          dbus
          slurp
          git
          bubblewrap
        ];

        shellHook = ''
          echo "VoidMaker TypeScript shell ready"
          echo "  pnpm install && pnpm check && pnpm test"
          echo "  pnpm db:migrate && pnpm dev:host"
          echo "  quickshell --path apps/shell/shell.qml"
        '';
      };
    };
}
