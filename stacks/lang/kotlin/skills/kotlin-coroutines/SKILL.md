---
name: kotlin-coroutines
description: "Write data-safe asynchronous Kotlin with coroutines, Flow, and structured concurrency on Android. Use when fixing coroutine cancellation or leak bugs, choosing dispatchers (Default/IO/Main), designing suspend functions, modeling streams with Flow/StateFlow/SharedFlow, scoping work to viewModelScope/lifecycleScope, handling exceptions with CoroutineExceptionHandler/supervisorScope, or converting callback/RxJava APIs to coroutines. Covers Kotlin 2.x, kotlinx.coroutines structured concurrency discipline, and the Android main-safety contract."
---

# Kotlin Coroutines

Review, fix, and write concurrent Kotlin targeting Kotlin 2.1+ and
kotlinx.coroutines 1.9+. Apply structured concurrency, correct dispatcher
choice, and cooperative cancellation with minimal behavior changes. This is the
Kotlin equivalent of Swift's structured-concurrency discipline: scopes are the
unit of lifetime, cancellation is cooperative, and main-safety is non-negotiable.

## Contents

- [Triage Workflow](#triage-workflow)
- [Structured Concurrency](#structured-concurrency)
- [Coroutine Scopes](#coroutine-scopes)
- [Dispatchers and Main-Safety](#dispatchers-and-main-safety)
- [Cancellation](#cancellation)
- [Exception Handling](#exception-handling)
- [Flow](#flow)
- [StateFlow and SharedFlow](#stateflow-and-sharedflow)
- [Bridging Callback APIs](#bridging-callback-apis)
- [Common Mistakes](#common-mistakes)
- [Review Checklist](#review-checklist)

## Triage Workflow

When diagnosing a coroutine issue, follow this sequence:

### Step 1: Capture context

- Identify the scope the coroutine runs in (`viewModelScope`, `lifecycleScope`,
  a custom `CoroutineScope`, or an unscoped `GlobalScope` — a red flag).
- Identify the dispatcher in effect and whether the work is CPU-bound,
  IO-bound, or UI-bound.
- Determine whether the work must survive configuration changes / navigation, or
  should be cancelled with the screen.
- Copy any stack trace; note whether it is a `CancellationException` (normal) or
  a real failure.

### Step 2: Apply the smallest safe fix

| Situation | Recommended fix |
|---|---|
| Work tied to a screen | Launch in `viewModelScope`; never `GlobalScope`. |
| Blocking IO (disk, network, DB) | `withContext(Dispatchers.IO) { ... }`. |
| Heavy CPU work (parse, sort, image) | `withContext(Dispatchers.Default) { ... }`. |
| UI / state update | Stay on `Dispatchers.Main` (the default for `viewModelScope`). |
| One child failure must not kill siblings | Use `supervisorScope` / `SupervisorJob`. |
| Long loop never cancels | Add `ensureActive()` / `yield()` or use cancellable APIs. |
| Callback API | Wrap with `suspendCancellableCoroutine` or `callbackFlow`. |

### Step 3: Verify

- Confirm cancellation propagates (the work stops when the scope is cancelled).
- Confirm no work runs on the main thread that blocks it.
- Confirm exceptions surface (not silently swallowed) and `CancellationException`
  is never caught-and-ignored.

## Structured Concurrency

Every coroutine has a parent. A parent does not complete until all children
complete; cancelling a parent cancels all children. This is the core safety
guarantee — never break out of it.

- Prefer `coroutineScope { }` to launch concurrent children that all must finish
  before the function returns.
- Use `async`/`await` for concurrent work that produces values.
- Use `launch` for fire-and-forget work *within a scope* (not detached).

```kotlin
suspend fun loadDashboard(): Dashboard = coroutineScope {
    val profile = async { repo.profile() }      // runs concurrently
    val feed = async { repo.feed() }            // runs concurrently
    Dashboard(profile.await(), feed.await())    // both joined here
}
```

If either child throws, the scope cancels the sibling and rethrows — no leaks.

**Never** use `GlobalScope.launch`. It has no parent, no lifecycle, no
cancellation. It is the coroutine equivalent of a detached, unowned thread.

## Coroutine Scopes

| Scope | Lifecycle | Use for |
|---|---|---|
| `viewModelScope` | Cleared when the `ViewModel` clears | All ViewModel async work |
| `lifecycleScope` | Tied to a `Lifecycle` (Activity/Fragment) | UI-layer work bound to a screen |
| `rememberCoroutineScope()` | Tied to a composable's lifetime | Launching from Compose event callbacks |
| custom `CoroutineScope` | You manage `cancel()` | Long-lived components (cancel explicitly) |

For a custom scope, always pair a `SupervisorJob` with a dispatcher and cancel it
when the owner is destroyed:

```kotlin
class Connection {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    fun close() = scope.cancel()   // cancels all children — no leaks
}
```

In Compose, collect with `collectAsStateWithLifecycle()` (not `collectAsState()`)
so collection stops when the app is in the background.

## Dispatchers and Main-Safety

A suspend function should be **main-safe**: callable from the main thread without
blocking it. Push the thread switch *down* into the function, not up to callers.

- `Dispatchers.Main` — UI updates. The default for `viewModelScope`.
- `Dispatchers.Default` — CPU-bound work (parsing, sorting, image processing).
  Backed by a pool sized to CPU cores.
- `Dispatchers.IO` — blocking IO (disk, network sockets, JDBC, file). Backed by
  a large elastic pool.
- `Dispatchers.Main.immediate` — runs inline if already on the main thread,
  avoiding an unnecessary re-dispatch (use for state emission).

```kotlin
// Main-safe: caller can invoke from the main thread.
suspend fun parseLargeJson(raw: String): Model = withContext(Dispatchers.Default) {
    json.decodeFromString(raw)
}
```

Rules:
1. Never block the main thread (`Thread.sleep`, blocking network, `runBlocking`).
2. Use `withContext`, not `launch`, to switch dispatchers for a value-returning
   step — `withContext` returns to the original dispatcher when done.
3. Don't hardcode dispatchers in the call site you want to test; inject a
   dispatcher (or a `CoroutineDispatcher` provider) so tests can substitute
   `StandardTestDispatcher`.

## Cancellation

Cancellation is cooperative. A coroutine only stops at a suspension point or when
it checks cooperatively.

```kotlin
suspend fun process(items: List<Item>) {
    for (item in items) {
        ensureActive()          // throws CancellationException if cancelled
        heavyWork(item)         // CPU loops won't cancel on their own
    }
}
```

- Suspending functions from kotlinx.coroutines (`delay`, `withContext`, Flow
  operators) are cancellable automatically.
- Tight CPU loops are **not** — insert `ensureActive()` or `yield()`.
- `CancellationException` is special: it signals normal cancellation. Never catch
  it and swallow it. If you catch `Exception` broadly, rethrow it:

```kotlin
try {
    risky()
} catch (e: CancellationException) {
    throw e                      // must rethrow — never swallow
} catch (e: Exception) {
    handle(e)
}
```

- For cleanup that must run even after cancellation, use
  `withContext(NonCancellable) { ... }` inside a `finally`.

## Exception Handling

- In `coroutineScope` / `async`, exceptions propagate to the awaiting caller —
  handle with `try/catch` around `await()`.
- In `launch`, an uncaught exception propagates up and cancels the scope. Install
  a `CoroutineExceptionHandler` on the **root** scope for last-resort handling.
- `supervisorScope` / `SupervisorJob` isolate child failures so one failing child
  does not cancel its siblings:

```kotlin
supervisorScope {
    launch { mightFail() }       // failure here does NOT cancel the sibling
    launch { mustSucceed() }
}
```

- A `CoroutineExceptionHandler` only works on root `launch` coroutines, never on
  `async` (whose exception surfaces at `await`).

## Flow

`Flow<T>` is a cold asynchronous stream — it does nothing until collected, and
re-runs its producer for each collector. It is the Kotlin analogue of an
`AsyncSequence`.

```kotlin
fun searchResults(query: String): Flow<List<Result>> = flow {
    emit(emptyList())                       // initial
    emit(repo.search(query))                // suspends, emits result
}
```

Key operators:
- Transform: `map`, `filter`, `transform`, `flatMapLatest` (cancel-previous —
  ideal for search-as-you-type), `flatMapConcat`, `flatMapMerge`.
- Combine: `combine`, `zip`, `merge`.
- Lifecycle: `onStart`, `onEach`, `onCompletion`, `catch` (upstream errors only),
  `retry`.
- Backpressure/threading: `flowOn(Dispatchers.IO)` changes the **upstream**
  dispatcher; `buffer`, `conflate`, `debounce`, `sample`.

```kotlin
fun results(query: Flow<String>): Flow<UiState> = query
    .debounce(300)
    .distinctUntilChanged()
    .flatMapLatest { q -> repo.search(q) }   // cancels stale searches
    .map(UiState::Loaded)
    .catch { emit(UiState.Error(it)) }
    .flowOn(Dispatchers.Default)
```

Rules:
- Use `flowOn` to set the producer dispatcher; never call `withContext` inside a
  `flow { }` builder (it breaks context preservation — the builder enforces this).
- Put `catch` *downstream* of the operators whose errors you want to handle;
  collector-side errors are not caught by `catch`.

## StateFlow and SharedFlow

These are **hot** flows for UI state and events.

- `StateFlow<T>` — holds a single current value, conflates, always has a value.
  The standard holder for screen UI state. Emit via `MutableStateFlow`.
- `SharedFlow<T>` — broadcasts events to multiple collectors; configurable
  replay. Use for one-shot events (navigation, snackbars) with `replay = 0`.

```kotlin
class FeedViewModel(private val repo: FeedRepository) : ViewModel() {
    private val _state = MutableStateFlow<FeedUiState>(FeedUiState.Loading)
    val state: StateFlow<FeedUiState> = _state.asStateFlow()

    init {
        viewModelScope.launch {
            _state.value = try {
                FeedUiState.Loaded(repo.feed())
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                FeedUiState.Error(e.message)
            }
        }
    }
}
```

Convert a cold flow to a lifecycle-aware hot `StateFlow` with `stateIn`:

```kotlin
val items: StateFlow<List<Item>> = repo.observeItems()
    .stateIn(
        scope = viewModelScope,
        started = SharingStarted.WhileSubscribed(5_000),  // stop 5s after last collector
        initialValue = emptyList()
    )
```

`WhileSubscribed(5_000)` keeps the upstream alive briefly across configuration
changes while still stopping when nothing observes — the standard choice.

For one-shot events prefer a `Channel` consumed as a flow, or a `SharedFlow` with
`replay = 0`; do **not** model events as `StateFlow` (state is re-delivered on
recomposition and replays stale events).

## Bridging Callback APIs

Single value:

```kotlin
suspend fun awaitLocation(): Location = suspendCancellableCoroutine { cont ->
    val cb = LocationCallback { loc -> cont.resume(loc) }
    locationManager.request(cb)
    cont.invokeOnCancellation { locationManager.remove(cb) }   // clean up
}
```

Stream of values:

```kotlin
fun locationUpdates(): Flow<Location> = callbackFlow {
    val cb = LocationCallback { loc -> trySend(loc) }
    locationManager.request(cb)
    awaitClose { locationManager.remove(cb) }   // required — cleans up on cancel
}
```

## Common Mistakes

1. **`GlobalScope.launch`** — no lifecycle, leaks. Use a real scope.
2. **`runBlocking` in production code** — blocks the thread; it is for `main()`
   and tests only.
3. **Swallowing `CancellationException`** — breaks structured cancellation;
   always rethrow it.
4. **Blocking the main thread** — `Thread.sleep`, blocking IO, or heavy CPU on
   `Dispatchers.Main`.
5. **`withContext` inside a `flow { }` builder** — use `flowOn` instead.
6. **Collecting flows with `collectAsState()` in Compose** — use
   `collectAsStateWithLifecycle()` so collection pauses in the background.
7. **Hardcoded dispatchers** — inject them so tests can swap in test
   dispatchers.
8. **Modeling one-shot events as `StateFlow`** — they replay stale events; use a
   `Channel`/`SharedFlow(replay = 0)`.
9. **Launching independent work that should be concurrent sequentially** — use
   `async`/`await` in a `coroutineScope`.
10. **Catching exceptions on `async` with a `CoroutineExceptionHandler`** — it
    does not fire for `async`; catch at `await`.
11. **Forgetting `awaitClose` in `callbackFlow`** — leaks the callback.

## Review Checklist

- [ ] No `GlobalScope`; work runs in `viewModelScope`/`lifecycleScope`/owned scope
- [ ] No `runBlocking` outside `main`/tests
- [ ] Suspend functions are main-safe (`withContext` pushes the switch down)
- [ ] CPU loops check cancellation (`ensureActive`/`yield`)
- [ ] `CancellationException` is rethrown, never swallowed
- [ ] Child-failure isolation uses `supervisorScope`/`SupervisorJob` where needed
- [ ] `flowOn` sets upstream dispatcher; no `withContext` inside `flow {}`
- [ ] UI state exposed as immutable `StateFlow` (backed by `MutableStateFlow`)
- [ ] `stateIn` uses `WhileSubscribed(5_000)` for screen state
- [ ] One-shot events are not modeled as `StateFlow`
- [ ] `callbackFlow`/`suspendCancellableCoroutine` clean up on cancellation
- [ ] Dispatchers injected for testability
