// SPDX-License-Identifier: MIT
// File-only SPA harness. No PipeWire connection or device APIs.
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <dlfcn.h>
#include <fcntl.h>
#include <unistd.h>
#include <spa/support/plugin.h>
#include <spa/interfaces/audio/aec.h>

int main(int argc, char **argv) {
  if (argc < 5 || argc > 25) {
    fprintf(stderr, "plugin capture.f32 reference.f32 output.f32 [key=value ...]\n");
    return 2;
  }
  void *library = dlopen(argv[1], RTLD_NOW);
  if (!library) { fprintf(stderr, "%s\n", dlerror()); return 3; }
  int (*enumerate)(const struct spa_handle_factory **, uint32_t *) = dlsym(library, "spa_handle_factory_enum");
  const struct spa_handle_factory *factory;
  uint32_t index = 0;
  if (!enumerate || enumerate(&factory, &index) != 1) return 4;
  struct spa_handle *handle = calloc(1, factory->get_size(factory, NULL));
  if (!handle || factory->init(factory, handle, NULL, NULL, 0) < 0) return 5;
  struct spa_audio_aec *aec;
  if (spa_handle_get_interface(handle, SPA_TYPE_INTERFACE_AUDIO_AEC, (void **)&aec) < 0) return 6;
  struct spa_dict_item items[22] = {
    {"webrtc.gain_control", "false"}, {"webrtc.noise_suppression", "false"}
  };
  for (int i = 5; i < argc; i++) {
    char *equals = strchr(argv[i], '=');
    if (!equals) return 2;
    *equals = 0;
    items[i - 3] = (struct spa_dict_item){argv[i], equals + 1};
  }
  struct spa_dict args = SPA_DICT_INIT(items, argc - 3);
  struct spa_audio_info_raw info = {.format = SPA_AUDIO_FORMAT_F32P, .rate = 48000,
    .channels = 1, .position = {SPA_AUDIO_CHANNEL_MONO}};
  if (spa_audio_aec_init(aec, &args, &info) < 0) return 7;
  FILE *rec = fopen(argv[2], "rb"), *ref = fopen(argv[3], "rb");
  int fd = open(argv[4], O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
  FILE *out = fd < 0 ? NULL : fdopen(fd, "wb");
  if (!rec || !ref || !out) return 8;
  float r[480], p[480], o[480];
  const float *rp[] = {r}, *pp[] = {p};
  float *op[] = {o};
  size_t count;
  while ((count = fread(r, 1, sizeof(r), rec)) > 0) {
    if (count != sizeof(r) || fread(p, 1, sizeof(p), ref) != sizeof(p)) return 9;
    if (spa_audio_aec_run(aec, rp, pp, op, 480) < 0) return 10;
    if (fwrite(o, sizeof(float), 480, out) != 480) return 11;
  }
  if (ferror(rec) || fgetc(ref) != EOF || ferror(ref)) return 12;
  fclose(rec); fclose(ref);
  if (fclose(out)) return 13;
  spa_handle_clear(handle); free(handle); dlclose(library);
  return 0;
}
