# Repository Guidelines

## Project Structure & Module Organization

VoidMaker is a Python 3.12 desktop assistant using a `src` layout. Application code lives in `src/voidmaker/`: `agent/` contains Claude and Codex backend integration, `ui/` the PySide6 desktop interface, `voice/` speech clients, `perception/` screen and homelab inputs, `character/` character loading, and `storage/` persistence. Tests are in `tests/` and generally mirror features rather than package paths. Documentation and sample configuration live in `docs/`; `characters/` documents the character-pack format, but copyrighted portrait and voice assets must not be committed.

## Build, Test, and Development Commands

- `nix develop`: create/sync `.venv` from `uv.lock`, install development dependencies, and activate the reproducible shell.
- `python -m voidmaker`: run the desktop UI.
- `python -m voidmaker --cli`: run the terminal conversation client.
- `python -m voidmaker --admin`: run the local administration UI.
- `pytest`: execute the full test suite.
- `pytest tests/test_reply.py`: run one focused test module.
- `ruff check src tests`: lint production and test code.

Manage dependencies through `pyproject.toml` and `uv.lock`; do not use ad hoc `pip install`. Keep inference systems such as GPT-SoVITS outside this repository and access them over HTTP.

## Coding Style & Naming Conventions

Use four-space indentation, type annotations for public interfaces, and a 120-character maximum line length. Follow standard Python naming: `snake_case` for modules, functions, and variables; `PascalCase` for classes; `UPPER_SNAKE_CASE` for constants. Keep UI work in `ui/`, external-service boundaries in dedicated clients, and LLM entry points under `agent/`. Run Ruff before submitting.

## Testing Guidelines

Tests use pytest with `pytest-asyncio` in automatic mode. Name files `test_<feature>.py` and tests `test_<behavior>`. Add regression coverage for bug fixes and exercise failure/fallback paths, especially reply parsing, permissions, IPC, and optional services. After agent-flow changes, also validate one conversation with `python -m voidmaker --cli`.

## Commit & Pull Request Guidelines

Recent commits use short, imperative Chinese subjects prefixed by the affected area, such as `UI:...`, `修复:...`, `配置:...`, or `STT:...`. Keep each commit focused. Pull requests should explain user-visible behavior, list verification commands, link relevant issues, and include screenshots or recordings for UI changes. Call out configuration, dependency, or Wayland-specific impacts explicitly.

## Security & Platform Constraints

Never commit local configuration, internal network addresses, chat data, or character assets. The admin server must remain bound to localhost. Preserve Wayland/niri behavior: window placement belongs in compositor rules, not application-side positioning or always-on-top flags.
