// SPDX-License-Identifier: MIT
// Built against the exact WebRTC source and library pinned by flake.lock.
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fcntl.h>
#include <unistd.h>
#include <time.h>
#include <api/audio/echo_canceller3_config.h>
#include <modules/audio_processing/aec3/echo_canceller3.h>

struct VmAecSettings {
  webrtc::EchoCanceller3Config config;
  FILE *linear = nullptr;
  FILE *stats = nullptr;
  unsigned frames = 0;
  ~VmAecSettings() { if (linear) fclose(linear); if (stats) fclose(stats); }

  bool number(const spa_dict *args, const char *key, float &value, float low, float high) {
    const char *text = spa_dict_lookup(args, key);
    if (!text) return true;
    char *end = nullptr;
    const float parsed = strtof(text, &end);
    if (end == text || *end || !std::isfinite(parsed) || parsed < low || parsed > high) return false;
    value = parsed;
    return true;
  }

  bool init(const spa_dict *args, uint32_t channels) {
    auto &near = config.suppressor.dominant_nearend_detection;
    // Parameters are opt-in; absent values retain the pinned upstream defaults.
    if (!number(args, "webrtc.aec3.nearend-snr", near.snr_threshold, 1, 100) ||
        !number(args, "webrtc.aec3.nearend-enr", near.enr_threshold, 0.01f, 10) ||
        !number(args, "webrtc.aec3.initial-seconds", config.filter.initial_state_seconds, 0, 10)) return false;
    float trigger = near.trigger_threshold, hold = near.hold_duration;
    if (!number(args, "webrtc.aec3.nearend-trigger", trigger, 1, 100) ||
        !number(args, "webrtc.aec3.nearend-hold", hold, 1, 500) ||
        floorf(trigger) != trigger || floorf(hold) != hold) return false;
    near.trigger_threshold = static_cast<int>(trigger);
    near.hold_duration = static_cast<int>(hold);
    if (const char *initial = spa_dict_lookup(args, "webrtc.aec3.nearend-initial")) {
      if (strcmp(initial, "true") && strcmp(initial, "false")) return false;
      near.use_during_initial_phase = strcmp(initial, "true") == 0;
    }
    float strength = 1;
    if (!number(args, "webrtc.aec3.nearend-transparency", strength, 1, 8)) return false;
    auto &tuning = config.suppressor.nearend_tuning;
    tuning.mask_lf.enr_transparent *= strength;
    tuning.mask_lf.enr_suppress *= strength;
    tuning.mask_hf.enr_transparent *= strength;
    tuning.mask_hf.enr_suppress *= strength;
    if (const char *path = spa_dict_lookup(args, "webrtc.aec3.linear-dump")) {
      if (path[0] != '/' || channels != 1) return false;
      const int fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
      if (fd < 0) return false;
      linear = fdopen(fd, "wb");
      if (!linear) { close(fd); return false; }
      config.filter.export_linear_aec_output = true;
    }
    if (const char *path = spa_dict_lookup(args, "webrtc.aec3.stats-dump")) {
      if (path[0] != '/') return false;
      const int fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
      if (fd < 0) return false;
      stats = fdopen(fd, "wb");
      if (!stats) { close(fd); return false; }
    }
    return true;
  }

  bool dump(webrtc::AudioProcessing *apm) {
    if (stats && ++frames % 100 == 0) {
      const auto metrics = apm->GetStatistics();
      const auto finite = [](double value) { return std::isfinite(value) ? value : -1; };
      struct timespec now;
      clock_gettime(CLOCK_MONOTONIC, &now);
      const double monotonic_ms = now.tv_sec * 1000.0 + now.tv_nsec / 1000000.0;
      if (fprintf(stats, "{\"seconds\":%u,\"monotonicMs\":%.3f,\"delayMs\":%d,\"erl\":%.6f,\"erle\":%.6f}\n",
          frames / 100, monotonic_ms, metrics.delay_ms.value_or(-1), finite(metrics.echo_return_loss.value_or(-1)),
          finite(metrics.echo_return_loss_enhancement.value_or(-1))) < 0) return false;
    }
    if (!linear) return true;
    std::array<float, 160> samples;
    if (!apm->GetLinearAecOutput(rtc::ArrayView<std::array<float, 160>>(&samples, 1))) return false;
    // Diagnostic only: mono little-endian float32, 16 kHz, no WAV header.
    return fwrite(samples.data(), sizeof(float), samples.size(), linear) == samples.size();
  }
};

class VmEchoFactory final : public webrtc::EchoControlFactory {
  const webrtc::EchoCanceller3Config config;
public:
  explicit VmEchoFactory(const webrtc::EchoCanceller3Config &value) : config(value) {}
  std::unique_ptr<webrtc::EchoControl> Create(int rate, int render, int capture) override {
    return std::make_unique<webrtc::EchoCanceller3>(config, std::nullopt, rate, render, capture);
  }
};
