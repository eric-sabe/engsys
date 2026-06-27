---
name: python-conventions
description: Python coding conventions for this repo (Python 3.12+, type hints, PEP 257/8). Use when writing, reviewing, or editing any *.py file. Covers type hints, docstrings, formatting, exception handling, async I/O, virtualenv discipline, and test expectations.
---

# Python Coding Conventions

Applies to: any `*.py` file in this repo. Target: Python 3.12+.

> Naturalize: confirm the venv location, package manager (uv / pip / poetry), and test runner in `CLAUDE.md`. The defaults below assume a `uv`-managed `.venv/` and `pytest`.

## Function-level expectations

- Descriptive function names; type hints on parameters and returns (use builtin generics on modern targets, e.g. `list[str]`, `dict[str, int]`; fall back to `typing.List` / `typing.Dict` only on older runtimes).
- PEP 257 docstrings placed immediately after `def` / `class`.
- Break complex functions into smaller, single-purpose helpers.
- Handle edge cases explicitly; raise or return meaningful errors rather than silently swallowing.

## General

- Readability and clarity over cleverness.
- For non-obvious algorithms, include a short comment explaining the approach.
- Mention third-party library usage and purpose at the import site if non-obvious.
- Consistent naming; follow language idioms.

## Style

- **PEP 8.** 4-space indents. Keep lines reasonable (the classic guideline is 79; many repos tolerate longer for clarity — match surrounding code and any configured formatter, e.g. `ruff`/`black`).
- Blank lines to separate functions, classes, and logical blocks.

## Async I/O

- For async code, use `async def` / `await` end-to-end; don't block the event loop with sync I/O.
- Prefer async-native drivers (e.g. an async DB/HTTP client) over wrapping sync calls in threads.
- Use `asyncio.Lock` / structured task management for shared mutable state; guard caches against concurrent rebuilds.

## Environment & dependencies

- Use the project venv (commonly `.venv/`, often `uv`-managed). If a stale top-level `venv/` exists, prefer the project-documented one — check `CLAUDE.md`.
- Load config from the environment (e.g. `python-dotenv`); quote `.env` values containing spaces so `source .env` doesn't break in zsh.

## Edge cases and testing

- Cover critical paths with tests; include empty inputs, invalid types, and large-input cases where relevant.
- Prefer `pytest`. Run from the project venv.

## Example

```python
def calculate_area(radius: float) -> float:
    """Calculate the area of a circle given the radius.

    Parameters:
        radius: The radius of the circle.

    Returns:
        The area, computed as pi * radius**2.
    """
    import math
    return math.pi * radius ** 2
```
