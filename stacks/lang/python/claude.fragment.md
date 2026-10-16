<!-- pack: lang/python -->
## Language — Python (3.12+)

This project writes Python 3.12+:
- **Isabelle**, **Bert**, and **Marcelo** load **`python-conventions`** before writing or reviewing `*.py` files.
- Use `uv` (`.venv/`), `ruff` (lint + format), strict type annotations (builtin generics `list[T]`, `dict[K, V]`, `X | None`), Pydantic v2 for boundary validation, `async def` / `await` end-to-end on async paths, and `pytest` for testing.

<!-- naturalize: confirm the virtualenv path (.venv/), package manager (uv / poetry / pip), typechecker (pyright / ty / mypy), and pytest invocation in Project facts. -->
