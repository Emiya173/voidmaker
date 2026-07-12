{
  description = "VoidMaker dev shell (NixOS/niri): 桌面角色 AI 助手";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs = { nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      py = pkgs.python312;

      # PySide6 pip wheel 自带 Qt(含 wayland 平台插件),但在 NixOS 上仍需这些系统库
      # 供其 dlopen。xcb 一组是 QT_QPA_PLATFORM 回退到 xcb 时用的。
      runtimeLibs = pkgs.lib.makeLibraryPath [
        pkgs.stdenv.cc.cc.lib
        pkgs.zlib
        pkgs.zstd          # libzstd.so.1 — PySide6 wheel dlopen 依赖
        pkgs.glib
        pkgs.libGL
        pkgs.fontconfig
        pkgs.freetype
        pkgs.libxkbcommon
        pkgs.wayland
        pkgs.dbus.lib
        pkgs.libx11
        pkgs.libxcb
        pkgs.libxcb-util
        pkgs.libxcb-wm
        pkgs.libxcb-image
        pkgs.libxcb-keysyms
        pkgs.libxcb-render-util
        pkgs.xcb-util-cursor
      ];
    in
    {
      devShells.${system}.default = pkgs.mkShell {
        packages = with pkgs; [
          (py.withPackages (ps: [ ps.pip ]))
          uv
          ruff
          git
          # 屏幕感知(niri 支持 wlr-screencopy → grim 可用;不行则换 xdg-desktop-portal)
          grim
          slurp
          # TTS 音频播放(外部播放器,避免引入 QtMultimedia 依赖链)
          mpv
          # 语音输入录音(连接宿主 PipeWire)
          pipewire
        ];

        shellHook = ''
          export LD_LIBRARY_PATH=${runtimeLibs}:$LD_LIBRARY_PATH
          # nixpkgs 的 python site-packages 可能泄漏到 PYTHONPATH 遮蔽 venv,清掉
          unset PYTHONPATH
          # wayland 优先,失败回退 xcb
          export QT_QPA_PLATFORM="wayland;xcb"

          export UV_PROJECT_ENVIRONMENT=.venv
          if [ -f uv.lock ]; then
            uv sync --frozen --extra dev --python ${py}/bin/python3
          else
            uv sync --extra dev --python ${py}/bin/python3
          fi
          . "$UV_PROJECT_ENVIRONMENT/bin/activate"

          echo "VoidMaker dev shell ready."
          echo "  桌宠 UI:    python -m voidmaker            (--services 先拉起 TTS/STT)"
          echo "  终端对话:   python -m voidmaker --cli"
          echo "  管理后台:   python -m voidmaker --admin"
          echo "  测试/lint:  pytest / ruff check src tests"
        '';
      };
    };
}
