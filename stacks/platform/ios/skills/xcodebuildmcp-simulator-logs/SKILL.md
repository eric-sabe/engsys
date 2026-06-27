---
name: xcodebuildmcp-simulator-logs
description: Use XcodeBuildMCP to run iOS simulator workflows and capture logs without manual copy/paste. Use when asked to build or run the iOS app in Simulator, inspect session defaults, start or stop simulator log capture, collect app logs for debugging, or troubleshoot StoreKit and runtime issues from simulator output.
---

# XcodeBuildMCP Simulator Logs

Manage simulator runs and capture logs directly through the XcodeBuildMCP server. The user does not need to paste console output by hand.

> Requires the `xcodebuildmcp` MCP server (configured in `.mcp.json`). It will prompt for approval on first use this session.

## When to Use This Skill

- The user wants simulator logs captured or analyzed.
- The user asks to run or verify the iOS app in Simulator.
- The user wants ongoing debugging without copy/pasting log output.
- The user is troubleshooting StoreKit, auth, crash, or runtime behavior in Simulator.

## Core Rules

1. Before the first simulator build, run, or test call in a session, call `session_show_defaults`.
2. If defaults are missing or wrong, discover projects and schemes first, then proceed with simulator workflows.
3. Do **not** call `boot_sim` or `open_sim` as prerequisites for `build_run_sim` — `build_run_sim` handles boot and opening automatically.
4. For ongoing logs, call `start_sim_log_cap` and keep the returned `logSessionId` for later retrieval.
5. To read captured output, call `stop_sim_log_cap` with the `logSessionId`, then immediately start a new capture if continuous monitoring is needed.

## Workflow: Connect to Simulator Log Stream

1. `session_show_defaults` — verify active project/workspace, scheme, simulator.
2. `start_sim_log_cap` with `subsystemFilter: app` unless broader logs are needed.
3. Ask the user to reproduce the issue.
4. `stop_sim_log_cap` to retrieve logs.
5. Parse and summarize findings.
6. If debugging continues, start a new capture immediately and keep monitoring.

## Workflow: Build, Run, and Capture

1. `session_show_defaults`.
2. If defaults are valid, `build_run_sim`.
3. Start simulator log capture.
4. Reproduce the target scenario.
5. Stop capture and analyze logs.

## Suggested Filters

- `app` — primary app and relevant runtime logs.
- `all` — broad capture for deep investigations.
- `swiftui` — UI lifecycle or rendering issues.

## Troubleshooting

| Symptom | Likely Cause | Action |
|---|---|---|
| No logs captured | Capture not started or wrong filter | Start capture again with `subsystemFilter: app` or `all` |
| `build_run_sim` fails immediately | Missing or wrong session defaults | Run `session_show_defaults`, then set/correct defaults |
| Logs too noisy | Filter too broad | Use `subsystemFilter: app` |
| Need continuous monitoring | Capture ended after stop | Restart capture immediately after each stop |

## Notes

- Session defaults reduce repeated arguments and keep simulator workflows deterministic.
- Capture/stop cycles are the practical way to maintain ongoing visibility during iterative debugging.

## Repository Scripts (if the project ships them)

Some projects wrap the capture/stop cycle in helper scripts so the loop is one command. If present, check `CLAUDE.md` / `scripts/` for names like:

- a `sim-log-capture` script — start, stop, pull, status, clear.
- a topic-focused pull-and-restart script (e.g. StoreKit logs).

### Recommended Usage

1. Start continuous capture (`start_sim_log_cap`, or the project's capture script).
2. Reproduce the issue in Simulator.
3. Pull + restart capture.
4. Inspect extracted logs (projects commonly write them under `tmp/xcodebuildmcp/`).
