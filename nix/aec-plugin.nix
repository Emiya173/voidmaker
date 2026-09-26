{ pkgs }:
pkgs.stdenv.mkDerivation {
  pname = "voidmaker-aec";
  version = "0.1.0";
  src = pkgs.pipewire.src;
  nativeBuildInputs = [ pkgs.pkg-config pkgs.makeWrapper ];
  buildInputs = [ pkgs.pipewire.dev pkgs.webrtc-audio-processing ];
  patches = [ ../native/aec/pipewire.patch ];
  postPatch = ''
    cp ${../native/aec/voidmaker-aec.hpp} spa/plugins/aec/voidmaker-aec.hpp
    cp ${../native/aec/replay.c} replay.c
    cp ${../native/aec/capture.c} capture.c
  '';
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    printf '#define HAVE_WEBRTC2 1\n' > config.h
    $CXX -std=c++17 -O2 -fPIC -shared -I. -DWEBRTC_APM_DEBUG_DUMP=0 \
      $(pkg-config --cflags libspa-0.2 webrtc-audio-processing-2) \
      -I${pkgs.webrtc-audio-processing.src}/webrtc \
      spa/plugins/aec/aec-webrtc.cpp \
      $(pkg-config --libs webrtc-audio-processing-2) \
      -o libspa-aec-voidmaker.so
    $CC -O2 $(pkg-config --cflags libspa-0.2) replay.c -ldl -o voidmaker-aec-replay
    $CC -std=gnu11 -O2 -Wall -Wextra $(pkg-config --cflags libpipewire-0.3) capture.c \
      $(pkg-config --libs libpipewire-0.3) -o voidmaker-audio-capture
    runHook postBuild
  '';
  installPhase = ''
    mkdir -p $out/lib/spa-0.2/aec
    cp libspa-aec-voidmaker.so $out/lib/spa-0.2/aec/
    mkdir -p $out/bin
    cp voidmaker-aec-replay $out/bin/
    cp voidmaker-audio-capture $out/bin/
    makeWrapper ${pkgs.pipewire}/bin/pw-cli $out/bin/voidmaker-aec-pw-cli \
      --set SPA_PLUGIN_DIR "$out/lib/spa-0.2:${pkgs.pipewire}/lib/spa-0.2"
  '';
}
