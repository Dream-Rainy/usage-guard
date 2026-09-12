# Usage Guard

[![test](https://github.com/Dream-Rainy/usage-guard/actions/workflows/test.yml/badge.svg)](https://github.com/Dream-Rainy/usage-guard/actions/workflows/test.yml)

Usage Guard is a cross-platform Codex plugin that checks Codex usage at lifecycle boundaries, narrows expensive work as limits approach, and preserves bounded checkpoint and reporting paths.

The runtime uses only Node.js built-in modules and supports Windows, macOS, and Linux. Node.js 18 or newer and the Codex CLI must be available on `PATH`.

## Policy model

Usage Guard keeps the short (5-hour) and weekly (7-day) windows independent:

- The short window is a resumable scheduling boundary: `RUN`, `CONSERVE`, `CRITICAL`, then an 8% interruption reserve before suspension.
- The weekly window is the total budget: `HEALTHY`, `LOW`, `FINALIZE`, and `STOP` below 5%. Weekly `STOP` never creates a heartbeat.
- A same-thread heartbeat is requested only after a verified `docs/plan/usage-guard-checkpoint.json` marker. The marker is registered by `PostToolUse` and each recovery cycle gets a new schedule key.

## Install from GitHub

```bash
codex plugin marketplace add Dream-Rainy/usage-guard --ref main
codex plugin add usage-guard@usage-guard
```

Start a new Codex task after installation and review the lifecycle hooks when Codex asks you to trust them.

## Upgrade

```bash
codex plugin marketplace upgrade usage-guard
codex plugin add usage-guard@usage-guard
```

## Local verification

```bash
npm test
npm run check
```

The test suite covers policy thresholds, lifecycle hook contracts, fail-open behavior, state compatibility, concurrency, stale-lock recovery, and auto-resume scheduling boundaries. The legacy PowerShell equivalence snapshot runs on Windows; macOS and Linux run the JavaScript suite without requiring PowerShell.

## Repository layout

```text
.agents/plugins/marketplace.json     Git marketplace manifest
plugins/usage-guard/                 Installable plugin
.github/workflows/test.yml           Node.js 18/22 test matrix
docs/plan/                           Local planning files, ignored by Git
dist/                                Local release archives, ignored by Git
```

Usage Guard never consumes a usage-reset credit automatically. Hook coverage is a practical guardrail and cannot interrupt an inference that is already running.

## License

[MIT](LICENSE)
