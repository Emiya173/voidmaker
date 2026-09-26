// SPDX-License-Identifier: MIT
// Three explicit capture targets, one monotonic clock, bounded nonblocking IPC.
// Protocol VM01: 104-byte little-endian header + mono 16 kHz S16LE PCM.
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <pipewire/pipewire.h>
#include <spa/param/audio/format-utils.h>
#include <spa/buffer/meta.h>

#define CAPACITY (256 * 1024)
#define HEADER 104
#define HAS_TIME (1u << 28)
#define HAS_META (1u << 29)
struct app;
struct input {
  struct app *app;
  struct pw_stream *stream;
  uint32_t id;
  uint64_t sequence;
  bool format_ok;
};
struct app {
  struct pw_main_loop *main;
  struct spa_source *output;
  struct input inputs[3];
  unsigned char queue[CAPACITY];
  size_t head, count;
  int result;
  bool stopping;
};
static void fail(struct app *app, const char *message) {
  if (!app->result) fprintf(stderr, "audio capture: %s\n", message);
  app->result = 1;
  pw_main_loop_quit(app->main);
}
static void flush(void *userdata, int fd, uint32_t mask) {
  struct app *app = userdata;
  (void)mask;
  while (app->count) {
    const size_t bytes = SPA_MIN(app->count, CAPACITY - app->head);
    ssize_t n = write(fd, app->queue + app->head, bytes);
    if (n < 0 && errno == EINTR) continue;
    if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) break;
    if (n <= 0) { fail(app, "output pipe closed"); return; }
    app->head = (app->head + n) % CAPACITY;
    app->count -= n;
  }
  pw_loop_update_io(pw_main_loop_get_loop(app->main), app->output, app->count ? SPA_IO_OUT : 0);
}
static void append(struct app *app, const void *source, size_t size) {
  const size_t tail = (app->head + app->count) % CAPACITY;
  const size_t first = SPA_MIN(size, CAPACITY - tail);
  memcpy(app->queue + tail, source, first);
  memcpy(app->queue, (const char *)source + first, size - first);
  app->count += size;
}
static void le32(unsigned char *to, uint32_t value) {
  for (int i = 0; i < 4; i++) to[i] = value >> (8 * i);
}
static void le64(unsigned char *to, uint64_t value) {
  for (int i = 0; i < 8; i++) to[i] = value >> (8 * i);
}
static void process(void *userdata) {
  struct input *input = userdata;
  struct app *app = input->app;
  if (app->result) return;
  struct pw_buffer *b = pw_stream_dequeue_buffer(input->stream);
  if (!b) return;
  struct spa_buffer *buffer = b->buffer;
  if (!input->format_ok || buffer->n_datas != 1) { fail(app, "invalid format"); goto done; }
  struct spa_data *data = &buffer->datas[0];
  if (!data->data || !data->chunk || data->chunk->size % 2 || data->chunk->offset > data->maxsize ||
      data->chunk->size > data->maxsize - data->chunk->offset) {
    fail(app, "invalid PCM buffer"); goto done;
  }
  uint32_t size = data->chunk->size;
  if (!size) goto done;
  if (size > 65536 || HEADER + size > CAPACITY - app->count) {
    fail(app, "bounded IPC queue overflow; refusing to drop audio"); goto done;
  }
  struct spa_meta_header *meta = spa_buffer_find_meta_data(buffer, SPA_META_Header, sizeof(*meta));
  struct pw_time time = {0};
  bool has_time = pw_stream_get_time_n(input->stream, &time, sizeof(time)) >= 0;
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  unsigned char header[HEADER] = {'V', 'M', '0', '1'};
  le32(header + 4, size);
  le32(header + 8, input->id);
  le32(header + 12, (meta ? meta->flags | HAS_META : 0) | (has_time ? HAS_TIME : 0));
  le64(header + 16, input->sequence++);
  le64(header + 24, meta ? meta->seq : 0);
  le64(header + 32, meta ? meta->pts : -1);
  le64(header + 40, b->time);
  le64(header + 48, (uint64_t)now.tv_sec * 1000000000 + now.tv_nsec);
  le64(header + 56, time.now);
  le64(header + 64, time.ticks);
  le64(header + 72, time.delay);
  le64(header + 80, time.buffered);
  le32(header + 88, time.rate.num);
  le32(header + 92, time.rate.denom);
  le32(header + 96, time.queued_buffers);
  append(app, header, sizeof(header));
  append(app, (char *)data->data + data->chunk->offset, size);
  flush(app, STDOUT_FILENO, 0);
done:
  pw_stream_queue_buffer(input->stream, b);
}
static void format(void *userdata, uint32_t id, const struct spa_pod *param) {
  struct input *input = userdata;
  if (id != SPA_PARAM_Format || !param) return;
  struct spa_audio_info_raw info = {0};
  input->format_ok = spa_format_audio_raw_parse(param, &info) >= 0 &&
    info.format == SPA_AUDIO_FORMAT_S16_LE && info.rate == 16000 && info.channels == 1;
  if (!input->format_ok) fail(input->app, "expected mono 16 kHz S16LE");
}
static void state(void *userdata, enum pw_stream_state old, enum pw_stream_state next, const char *error) {
  struct input *input = userdata;
  if (input->app->stopping) return;
  if (next == PW_STREAM_STATE_ERROR || (next == PW_STREAM_STATE_UNCONNECTED && old != PW_STREAM_STATE_UNCONNECTED))
    fail(input->app, error ? error : "capture target disconnected");
}
static const struct pw_stream_events events = {
  PW_VERSION_STREAM_EVENTS, .state_changed = state, .param_changed = format, .process = process,
};
static void stop(void *userdata, int signal) {
  (void)signal;
  struct app *app = userdata;
  app->stopping = true;
  pw_main_loop_quit(app->main);
}
int main(int argc, char **argv) {
  if (argc != 4) { fprintf(stderr, "usage: capture RAW_NODE CLEAN_NODE SINK_NODE\n"); return 2; }
  pw_init(NULL, NULL);
  struct app app = {0};
  app.main = pw_main_loop_new(NULL);
  if (!app.main) return 3;
  struct pw_loop *loop = pw_main_loop_get_loop(app.main);
  signal(SIGPIPE, SIG_IGN);
  pw_loop_add_signal(loop, SIGINT, stop, &app);
  pw_loop_add_signal(loop, SIGTERM, stop, &app);
  int flags = fcntl(STDOUT_FILENO, F_GETFL);
  if (flags < 0 || fcntl(STDOUT_FILENO, F_SETFL, flags | O_NONBLOCK) < 0) { app.result = 3; goto cleanup; }
  app.output = pw_loop_add_io(loop, STDOUT_FILENO, 0, false, flush, &app);
  if (!app.output) { app.result = 3; goto cleanup; }
  for (int i = 0; i < 3; i++) {
    struct input *input = &app.inputs[i];
    input->app = &app; input->id = i;
    struct pw_properties *props = pw_properties_new(
      PW_KEY_MEDIA_TYPE, "Audio", PW_KEY_MEDIA_CATEGORY, "Capture", PW_KEY_MEDIA_ROLE, "Communication",
      PW_KEY_TARGET_OBJECT, argv[i + 1], "node.dont-fallback", "true", "node.dont-reconnect", "true",
      "state.restore-props", "false", PW_KEY_NODE_LATENCY, "320/16000", NULL);
    pw_properties_setf(props, PW_KEY_NODE_NAME, "voidmaker-audio-tap-%d-%d", getpid(), i);
    if (i == 2) pw_properties_set(props, PW_KEY_STREAM_CAPTURE_SINK, "true");
    input->stream = pw_stream_new_simple(loop, "VoidMaker audio tap", props, &events, input);
    if (!input->stream) { app.result = 3; goto cleanup; }
    uint8_t buffer[1024];
    struct spa_pod_builder builder = SPA_POD_BUILDER_INIT(buffer, sizeof(buffer));
    const struct spa_pod *params[] = {spa_format_audio_raw_build(&builder, SPA_PARAM_EnumFormat,
      &SPA_AUDIO_INFO_RAW_INIT(.format = SPA_AUDIO_FORMAT_S16_LE, .rate = 16000, .channels = 1,
        .position = {SPA_AUDIO_CHANNEL_MONO}))};
    // Process on this main loop, never block the realtime graph thread on stdout.
    if (pw_stream_connect(input->stream, PW_DIRECTION_INPUT, PW_ID_ANY,
        PW_STREAM_FLAG_AUTOCONNECT | PW_STREAM_FLAG_MAP_BUFFERS | PW_STREAM_FLAG_DONT_RECONNECT,
        params, 1) < 0) { app.result = 3; goto cleanup; }
  }
  pw_main_loop_run(app.main);
cleanup:
  app.stopping = true;
  for (int i = 0; i < 3; i++) if (app.inputs[i].stream) pw_stream_destroy(app.inputs[i].stream);
  pw_main_loop_destroy(app.main);
  pw_deinit();
  return app.result;
}
