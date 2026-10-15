---
name: python-conventions
description: Python 3.12+ coding conventions (uv, ruff, pyright/ty strict typing, Pydantic v2, async I/O, and pytest). Use when writing, reviewing, or editing any *.py file or pyproject.toml.
---

# Python Coding Conventions (Python 3.12+ / 2026 Tooling)

Applies to: any `*.py` file and `pyproject.toml` in this repository. Target runtime: **Python 3.12+**.

> Naturalize: confirm the virtualenv location (`.venv/`), package manager (`uv`), type checker (`pyright` / `ty` / `mypy`), and test runner (`pytest`) in `CLAUDE.md`.

## Tooling & Environment (`uv` + `ruff` + Typecheck)

- **Environment & dependency management**: Use `uv` (`uv sync`, `uv run pytest`, `uv lock`) with the project's `.venv/`. Never install packages into the system Python.
- **Formatting & linting**: Run `ruff check` and `ruff format --check` (4-space indentation, PEP 8 top-level imports — never place `import` statements inside function bodies unless breaking a documented circular import).
- **Static type checking**: Run `pyright` or `ty` (or `mypy --strict`) before committing.

## Type Annotations & Data Validation

- **Modern builtin generics (PEP 585 / PEP 604 / PEP 695)**: Use `list[str]`, `dict[str, Any]`, `int | None`, and `type Alias = ...` — never legacy `typing.List`, `typing.Dict`, or `typing.Optional`.
- **Boundary validation with Pydantic v2**: Validate external payloads, config, and LLM/API schemas with `pydantic.BaseModel` (`model_validate`, `model_dump`, `ConfigDict(extra="forbid", frozen=True)`).

```python
import math
from pydantic import BaseModel, ConfigDict, Field


class CircleSpec(BaseModel):
    """Validated input specification for circle geometry."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    radius: float = Field(gt=0, description="Circle radius in meters.")


def calculate_area(spec: CircleSpec) -> float:
    """Return the area of a circle in square meters."""
    return math.pi * (spec.radius ** 2)
```

## Async I/O & Concurrency

- Use `async def` / `await` end-to-end on async request paths; never block the event loop with synchronous file, network (`requests`), or database calls.
- Use async-native clients: `httpx.AsyncClient` for HTTP, `pymongo.AsyncMongoClient` for MongoDB (never EOL `motor`), and `asyncpg` / `sqlalchemy.ext.asyncio` for Postgres.
- Use `asyncio.TaskGroup` for structured fan-out and `asyncio.Lock` to guard shared in-memory caches against stampedes.

## Testing (`pytest`)

- Write deterministic unit and integration tests using `pytest` and `pytest-asyncio` (`uv run pytest`).
- Cover nominal paths, boundary values (`0`, negative, empty collections, `None`), and validation rejection (`pytest.raises(ValidationError)`).

## Review Checklist

- [ ] All imports at module top level (PEP 8) and sorted by `ruff`
- [ ] Parameter and return types annotated using Python 3.12+ builtin syntax (`list[T]`, `X | None`)
- [ ] External inputs validated via Pydantic v2 models (`model_validate`, `ConfigDict`)
- [ ] Async paths use non-blocking drivers (`httpx.AsyncClient`, `pymongo.AsyncMongoClient`)
- [ ] `uv run ruff check`, typecheck, and `uv run pytest` pass cleanly
