# Normalizers must match on write and read, be idempotent, and run in linear time

**Trigger:** You write or edit a function that normalizes a user-supplied identifier (email, domain, slug, host, key prefix) later matched, deduped, or looked up against stored values. Or you apply a regex with a quantifier (`+`, `*`, `{n,}`) to attacker-controlled input, especially on a registration or auth path.

**Failure mode:**
- **Not a fixpoint.** A helper stripped exactly one trailing dot, so `a.com..` normalized to `a.com.` at write time but to `a.com` at match time. An allowlist entry looks successfully saved and can never match. The docstring claimed idempotency; it was false for that input.
- **Write and read normalizers diverge** by even one transformation: a stored value becomes permanently unmatchable.
- **Polynomial ReDoS.** The natural fix `/\.+$/` backtracks superlinearly on untrusted input (hundreds of ms at tens of thousands of characters). Build, lint, and unit tests do not catch it; only a static analyzer does, post-push, as a merge-blocking finding.

**Correct behavior:**
- One shared normalizer, applied identically on the write path and the read path. Fix at the primitive so every caller inherits the fix.
- Prove the fixpoint: assert `normalize(normalize(x)) === normalize(x)` on adversarial inputs (repeated, leading, and trailing separators; scheme and path noise). A single clean input cannot catch a non-fixpoint.
- Replace superlinear regexes on untrusted input with a linear scan (walk from the end with a char-code loop) with identical behavior and a large-input regression test. If a quantifier must stay, bound it and length-cap the input first; sweep sibling regexes in the module for the same shape.

**Check:** Do `write(x)` and `match(x)` call the same function, and does a 200k-character input finish instantly?

**Seen in:** recurring in allowlist, dedup, and slug-generation code guarding auth surfaces.
