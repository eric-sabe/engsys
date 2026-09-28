# React: a lazy `useState` initializer freezes a value derived from async data

**Stack:** react. Skip if the project does not use React.

**Trigger:** You derive a UI default (collapsed or expanded, active tab, default filter) from data that loads asynchronously, and write `useState(() => f(asyncValue))`.

**Failure mode:** The initializer runs once, on the first render (dev strict mode may call it twice), and never again. On that first render the async value is still `null` or a placeholder, so the state is permanently frozen at the loading-time result. When real data arrives, nothing updates. Example: "auto-collapse the picker when a strong match exists" always initialized to expanded because the match was always `null` at first render. Fixtures that resolve instantly never render the loading state, so tests miss it; it shows up only under real latency.

**Correct behavior:**
- Derive the value on every render (a plain expression or `useMemo`) whenever the source can change after mount.
- Reserve lazy initializers for values genuinely fixed at mount (a stable random id, an expensive default independent of async data).
- For a user override that should persist, keep it as separate state that participates in the derivation (`const showAll = userExpanded || derivedFrom(value)`), and reset it only on a real identity change.
- Test the actual loading-to-resolved transition with `rerender`, not a fixture that starts resolved.

**Check:** `grep -rn "useState(() =>"`; for each hit, does the initializer read a prop, state, or context value that can still be loading on first render?

**Seen in:** recurring in progressive-disclosure and default-selection UI backed by fetched data.
