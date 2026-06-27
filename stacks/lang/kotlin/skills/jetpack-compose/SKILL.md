---
name: jetpack-compose
description: "Build Android UIs with Jetpack Compose: composition, state hoisting, remember/rememberSaveable/derivedStateOf, recomposition correctness and performance, side-effect APIs (LaunchedEffect/DisposableEffect/rememberCoroutineScope/produceState/snapshotFlow), Material 3 theming, and Compose navigation. Use when writing or reviewing @Composable functions, fixing recomposition or state bugs, hoisting state, choosing a side-effect API, applying Material 3, or improving Compose performance and stability."
---

# Jetpack Compose

Build and review Android UIs with Jetpack Compose targeting the current Compose
BOM (2025.x) and Material 3. Composables are pure descriptions of UI for a given
state; the runtime re-invokes them (recomposes) when the state they read
changes. Treat composition as a function of state, keep composables side-effect
free except through the official effect APIs, and hoist state so UI is testable
and reusable. This is Android's analogue of declarative SwiftUI.

## Contents

- [Composition Model](#composition-model)
- [State and remember](#state-and-remember)
- [State Hoisting](#state-hoisting)
- [derivedStateOf](#derivedstateof)
- [Recomposition Pitfalls](#recomposition-pitfalls)
- [Side-Effect APIs](#side-effect-apis)
- [Collecting Flows](#collecting-flows)
- [Stability and Performance](#stability-and-performance)
- [Material 3](#material-3)
- [ViewModel Integration](#viewmodel-integration)
- [Common Mistakes](#common-mistakes)
- [Review Checklist](#review-checklist)

## Composition Model

- A `@Composable` function emits UI. It may run often, in any order, in parallel,
  and be skipped. **It must be idempotent and free of side effects.**
- Never mutate external state, perform IO, or launch work directly in the body of
  a composable. Use the effect APIs for anything that must happen *as a result*
  of composition.
- Recomposition is driven by reads of *snapshot state* (`State<T>` /
  `MutableState<T>`). Reading a state value subscribes that composition scope to
  it; when it changes, only scopes that read it recompose.

## State and remember

| API | Use for |
|---|---|
| `remember { }` | Keep an object across recompositions (not config changes). |
| `rememberSaveable { }` | Survive config changes and process death (Bundle-able). |
| `mutableStateOf(x)` | Observable state that triggers recomposition on change. |
| `derivedStateOf { }` | Computed state derived from other state (see below). |
| `produceState` | Convert non-Compose async source into `State`. |

```kotlin
@Composable
fun Counter() {
    var count by rememberSaveable { mutableStateOf(0) }   // survives rotation
    Button(onClick = { count++ }) { Text("Count: $count") }
}
```

- Use `by` delegation (`var x by remember { mutableStateOf(...) }`) for ergonomic
  reads/writes.
- `remember(key1, key2) { ... }` recomputes when a key changes — use keys to
  reset remembered state when inputs change.
- Prefer `rememberSaveable` for anything the user would be annoyed to lose on
  rotation (text input, scroll selection, expanded state).

## State Hoisting

Make composables **stateless** by lifting state up to the caller. A hoisted
composable takes the value as a parameter and exposes changes via a callback —
the "state down, events up" pattern.

```kotlin
// Stateless, reusable, testable
@Composable
fun SearchField(query: String, onQueryChange: (String) -> Unit) {
    TextField(value = query, onValueChange = onQueryChange)
}

// Stateful caller owns the state
@Composable
fun SearchScreen(viewModel: SearchViewModel) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    SearchField(query = state.query, onQueryChange = viewModel::onQueryChange)
}
```

Hoist to the lowest common ancestor that needs the state. State that belongs to
the screen's logic lives in the `ViewModel`; ephemeral UI state (animations,
focus, scroll) can stay local with `remember`.

## derivedStateOf

Use `derivedStateOf` when state should be *computed* from other state and you
want to recompute only when the **result** changes, not on every read of the
inputs. The classic case: deriving a boolean from a frequently changing value.

```kotlin
val listState = rememberLazyListState()
// Recomposes only when the boolean flips, not on every scroll pixel.
val showButton by remember {
    derivedStateOf { listState.firstVisibleItemIndex > 0 }
}
```

Do **not** use `derivedStateOf` for a plain transformation of a single state that
changes at the same rate as the result (e.g. `val upper = text.uppercase()`) —
that is just a normal calculation and the extra machinery is wasteful.

## Recomposition Pitfalls

- **Reading state too high** hurts performance; read it as deep as possible so
  fewer composables recompose. Defer reads with lambdas (e.g. pass
  `{ offset }` rather than `offset`) for high-frequency values like scroll/drag.
- **Unstable lambdas** allocated in the body cause child recomposition — prefer
  stable method references (`viewModel::onClick`) where possible.
- **Backwards writes** — writing to state you already read in the same
  composition causes an infinite recomposition loop. Never do it.
- **Side effects in the body** (logging, mutation, IO) run on every recomposition
  and in undefined order. Move them into effects.
- **`Modifier` ordering matters** — order changes layout and draw; it is not
  commutative.
- Always supply a stable `key` in `LazyColumn`/`LazyRow` `items(list, key = {...})`
  so items keep identity across data changes (analogous to a stable
  `Identifiable` id).

## Side-Effect APIs

Choose the narrowest effect that fits:

| API | When |
|---|---|
| `LaunchedEffect(key)` | Run a suspend function when entering composition / when `key` changes; cancelled on leave. |
| `rememberCoroutineScope()` | Launch coroutines from **event callbacks** (button clicks), not composition. |
| `DisposableEffect(key)` | Register/unregister non-suspend resources; `onDispose { }` cleans up. |
| `SideEffect { }` | Publish Compose state to non-Compose code after every successful recomposition. |
| `produceState` | Turn a callback/Flow source into observable `State`. |
| `snapshotFlow { }` | Convert reads of snapshot state into a cold `Flow`. |
| `rememberUpdatedState` | Capture the latest value inside a long-lived effect without restarting it. |

```kotlin
// Run once on enter (key = Unit), re-run when userId changes:
LaunchedEffect(userId) {
    viewModel.load(userId)            // suspend; auto-cancelled on leave/key change
}

// Observe a lifecycle/listener and clean it up:
DisposableEffect(lifecycleOwner) {
    val observer = LifecycleEventObserver { _, e -> handle(e) }
    lifecycleOwner.lifecycle.addObserver(observer)
    onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
}

// React to snapshot state as a flow:
LaunchedEffect(listState) {
    snapshotFlow { listState.firstVisibleItemIndex }
        .distinctUntilChanged()
        .collect { analytics.logScroll(it) }
}
```

Rules:
- The `key` of `LaunchedEffect`/`DisposableEffect` controls restart. Use a stable,
  meaningful key — never `Unit` if the work depends on a changing input.
- Don't launch coroutines in the composable body; use `LaunchedEffect` (tied to
  composition) or `rememberCoroutineScope` (tied to events).
- Use `rememberUpdatedState` to read the freshest callback inside a
  `LaunchedEffect(Unit)` that should not restart.

## Collecting Flows

Always collect with lifecycle awareness so collection stops in the background:

```kotlin
val uiState by viewModel.uiState.collectAsStateWithLifecycle()
```

`collectAsStateWithLifecycle()` (from `lifecycle-runtime-compose`) is preferred
over `collectAsState()` on Android — it stops collecting when the lifecycle drops
below `STARTED`, avoiding wasted work and leaks.

## Stability and Performance

- The compiler skips recomposition of a composable when all its parameters are
  **stable** and unchanged. Prefer stable types: immutable `data class`es,
  primitives, and `@Immutable`/`@Stable`-annotated types.
- `List<T>` is treated as unstable. Prefer `kotlinx.collections.immutable`
  (`ImmutableList`/`PersistentList`) for list parameters, or wrap in a `@Immutable`
  holder.
- The **Compose Compiler reports / strong-skipping** help find unstable params.
  Strong skipping (default in recent compilers) skips even some unstable params by
  comparing instances, but stable types remain the reliable path.
- Use `LazyColumn`/`LazyRow`/`LazyVerticalGrid` for large/scrolling collections;
  never render large lists with a `Column` inside a `verticalScroll`.
- Defer high-frequency state reads (scroll offset, drag) into draw/layout lambdas
  to avoid recomposing on every frame.
- Avoid `Modifier.composed { }` for new code; prefer `Modifier.Node` based
  modifiers for custom modifiers.

## Material 3

Use `androidx.compose.material3` (Material 3 / Material You) for new UIs.

```kotlin
@Composable
fun AppTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val colors = if (supportsDynamicColor() && dark) {
        dynamicDarkColorScheme(LocalContext.current)      // Material You, Android 12+
    } else if (dark) darkColorScheme() else lightColorScheme()

    MaterialTheme(colorScheme = colors, typography = AppTypography, content = content)
}
```

- Theme through `MaterialTheme` (`colorScheme`, `typography`, `shapes`); read
  values via `MaterialTheme.colorScheme.*` rather than hardcoding colors.
- Support **dynamic color** on Android 12+ via `dynamicLightColorScheme` /
  `dynamicDarkColorScheme` where the product wants Material You.
- Use Material 3 components (`Scaffold`, `TopAppBar`, `NavigationBar`,
  `FilledTonalButton`, etc.) and honor `WindowInsets` / edge-to-edge.
- Respect the platform: this is Material, not iOS — don't port HIG idioms wholesale.

## ViewModel Integration

- Obtain the screen `ViewModel` with `viewModel()` (or Hilt's `hiltViewModel()`).
- Expose a single immutable UI-state object as `StateFlow`; collect with
  `collectAsStateWithLifecycle()`.
- Pass state down and events up (method references to the `ViewModel`). Keep
  composables free of business logic.
- Use Compose Navigation (`NavHost`/`NavController`) or Navigation 3 if the
  project has adopted it; hoist the `NavController` to the app root.

## Common Mistakes

1. **Side effects in the composable body** — IO, mutation, logging. Use effects.
2. **`collectAsState()` instead of `collectAsStateWithLifecycle()`** on Android.
3. **No `key` in lazy list `items`** — breaks item identity and animations.
4. **`derivedStateOf` for a 1:1 transform** — unnecessary; just compute it.
5. **`remember` where `rememberSaveable` is needed** — state lost on rotation.
6. **Launching coroutines in the body** — use `LaunchedEffect`/event scope.
7. **`LaunchedEffect(Unit)` that depends on a changing value** — stale captures;
   key it properly or use `rememberUpdatedState`.
8. **Unstable parameters** (`List`, lambdas allocated inline) defeating skipping.
9. **Reading high-frequency state too high** in the tree — recomposes too much.
10. **Backwards writes** — writing state already read this composition (infinite
    loop).
11. **Big scrollable `Column`** instead of `LazyColumn`.
12. **Hoisting nothing** — monolithic stateful composables that can't be tested
    or previewed.

## Review Checklist

- [ ] Composables are side-effect free; effects use the proper effect API
- [ ] State hoisted appropriately (stateless leaf composables, state in ViewModel)
- [ ] `rememberSaveable` used for state that must survive config changes
- [ ] `derivedStateOf` used only for derived state that changes less than inputs
- [ ] Flows collected with `collectAsStateWithLifecycle()`
- [ ] `LaunchedEffect`/`DisposableEffect` keyed correctly; resources disposed
- [ ] Coroutines launched from events via `rememberCoroutineScope`, not body
- [ ] Lazy lists use stable `key`s
- [ ] Parameters are stable (immutable data classes / ImmutableList)
- [ ] Material 3 theming via `MaterialTheme`; dynamic color where wanted
- [ ] No backwards writes; no IO/mutation in composition
- [ ] High-frequency reads deferred (lambdas) to limit recomposition
