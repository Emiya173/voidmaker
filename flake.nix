{
  description = "VoidMaker TypeScript voice assistant on NixOS/niri";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs = { self, nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      aecPlugin = import ./nix/aec-plugin.nix { inherit pkgs; };
      mmdTools = pkgs.fetchzip {
        url = "https://codeload.github.com/MMD-Blender/blender_mmd_tools/tar.gz/refs/tags/v4.5.14";
        hash = "sha256-BVvfphkvzHld2901h3gjyWuJinRIoXIRxv2OHSv3i/U=";
        extension = "tar.gz";
      };
      mmdPython = pkgs.runCommand "mmd-tools-python" { nativeBuildInputs = [ pkgs.unzip ]; } ''
        mkdir -p $out
        unzip -q ${mmdTools}/mmd_tools/wheels/opencc_python_reimplemented-0.1.7-py2.py3-none-any.whl -d $out
      '';
    in
    {
      packages.${system}.aec-plugin = aecPlugin;
      devShells.${system} = {
        default = pkgs.mkShell {
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
        # Blender's own Python is used only for the offline DCC adapter.
        character = pkgs.mkShell {
          inputsFrom = [ self.devShells.${system}.default ];
          packages = [ pkgs.blender ];
          VOIDMAKER_MMD_TOOLS = "${mmdTools}";
          VOIDMAKER_MMD_PYTHON = "${mmdPython}";
        };
      };
    };
}
