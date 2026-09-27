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
          qt6.qtquick3d
          ffmpeg
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
          export NIXPKGS_QT6_QML_IMPORT_PATH=${pkgs.qt6.qtquick3d}/lib/qt-6/qml:''${NIXPKGS_QT6_QML_IMPORT_PATH:-}
          export QT_PLUGIN_PATH=${pkgs.qt6.qtquick3d}/lib/qt-6/plugins:''${QT_PLUGIN_PATH:-}
          echo "VoidMaker TypeScript shell ready"
          echo "  pnpm install && pnpm check && pnpm test"
          echo "  pnpm db:migrate && pnpm dev:host"
          echo "  quickshell --path apps/shell/shell.qml"
        '';
      };
    };
}
