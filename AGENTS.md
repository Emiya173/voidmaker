# Repository Guidelines

## Structure and architecture

VoidMaker targets NixOS + niri + Quickshell. The active application is TypeScript:
`apps/host/` composes effects, `apps/shell/` contains declarative QML views, `apps/tools/` contains developer tools,
`packages/domain/` contains pure immutable transitions and rules, `packages/contracts/` owns protocol/config schemas,
and `packages/adapters/` contains database, Codex, HTTP and process boundaries. PostgreSQL migrations live in
`db/migrations/`. Tests are in `tests/*.test.ts`; docs and sample configuration are in `docs/`.

`src/voidmaker/`, Python tests, `pyproject.toml` and `uv.lock` are legacy reference material pending removal.
Do not add new application logic or compatibility layers there. No Claude or Whisper integration in the new application.
Keep local inference systems outside this repository, with their own pinned environments, and communicate over HTTP.

## Commands and verification

- `nix develop`: reproducible Node/pnpm, PostgreSQL, Quickshell and audio tools.
- `pnpm install --frozen-lockfile`: install locked dependencies.
- `pnpm check`: TypeScript and Biome checks.
- `pnpm test`: regression tests; set `VOIDMAKER_TEST_DATABASE_URL` to a dedicated PostgreSQL test database for DB coverage.
- `VOIDMAKER_HOST_TEST_DATABASE_URL`: use a second, separate test database for Host crash/recovery IPC tests.
- `pnpm work:smoke`: opt-in real Codex task in a temporary project; run separately from DB tests, without microphone use.
- `pnpm build`: compile the application.
- `pnpm dev:host` / `pnpm start:host`: development / compiled Host.
- `quickshell --path apps/shell/shell.qml`: active UI.
- `VOIDMAKER_AUDIO_SMOKE=1 pnpm test tests/audio-process.test.ts`: real mpv IPC with null audio output.

Validate meaningful failure/cancellation paths after agent or voice changes. Live model/device acceptance must be
reported separately from fake-service tests. Do not activate the microphone as part of unattended automated tests.
For any remaining Python edits, use the locked legacy environment and run `ruff check src tests` and relevant pytest tests.

## Style and boundaries

Use strict TypeScript, ESM imports, two-space indentation and Biome formatting. Prefer discriminated unions,
readonly data, pure functions and declarative QML bindings. Keep business state in the Host/domain, not QML controls.
Carry generation IDs and AbortSignals across async operations; stale completions must not resurrect cancelled work.
Do not introduce inheritance hierarchies for domain behavior. Validate external data at service boundaries.

## Changes and platform constraints

Use focused commits with short imperative Chinese subjects such as `语音:接入本地识别与播放` or `修复:清理取消的轮次`.
Summarize user-visible behavior, checks, remaining acceptance gaps and configuration/Wayland impacts.
Never commit local configuration, internal network addresses, recordings, chat data, model weights or character assets.
Admin/model HTTP listeners must remain on loopback; UI IPC uses a private Unix socket.
Keep niri window placement in compositor rules. Quickshell panels may use layer-shell anchors; do not add
application-side positioning or always-on-top flags for ordinary windows.
