---
name: android-testing
description: "Write and review Android/Kotlin tests across the pyramid: JUnit (4/5) unit tests, MockK, Turbine for Flow/StateFlow assertions, coroutine testing with runTest and test dispatchers, Robolectric JVM tests, Espresso instrumented UI tests, and Compose UI testing with createComposeRule and semantics matchers. Use when writing or fixing unit tests, testing coroutines/Flows, mocking dependencies, choosing JVM vs instrumented tests, or testing Compose UI and ViewModels on Android."
---

# Android Testing

Write and review tests for Android/Kotlin targeting JUnit, MockK, Turbine,
kotlinx-coroutines-test, Robolectric, Espresso, and Compose UI testing. Favor a
test pyramid: many fast JVM unit tests, fewer Robolectric/Compose tests, and a
thin layer of instrumented end-to-end tests. Test behavior, not implementation.

## Contents

- [Test Pyramid and Source Sets](#test-pyramid-and-source-sets)
- [Unit Tests (JUnit)](#unit-tests-junit)
- [Mocking with MockK](#mocking-with-mockk)
- [Testing Coroutines](#testing-coroutines)
- [Testing Flows with Turbine](#testing-flows-with-turbine)
- [Testing ViewModels](#testing-viewmodels)
- [Robolectric](#robolectric)
- [Compose UI Testing](#compose-ui-testing)
- [Espresso](#espresso)
- [Common Mistakes](#common-mistakes)
- [Review Checklist](#review-checklist)

## Test Pyramid and Source Sets

| Location | Runs on | Use for |
|---|---|---|
| `src/test/` | Local JVM (`testDebugUnitTest`) | Logic, ViewModels, repos, mappers, Robolectric |
| `src/androidTest/` | Device/emulator (`connectedDebugAndroidTest`) | Espresso, Compose UI, integration |

Keep most tests in `src/test/` — they are fast and run in the unit-test gate.
Reserve `src/androidTest/` for tests that genuinely need a device/emulator.

## Unit Tests (JUnit)

JUnit 4 is still the Android default; JUnit 5 is fine for pure-JVM modules with
the platform engine configured. Name tests by behavior.

```kotlin
class PriceFormatterTest {
    @Test
    fun `formats whole dollars without decimals`() {
        assertEquals("$5", PriceFormatter.format(500))
    }
}
```

Prefer a fluent assertion library (Truth or AssertK) for readable failures:

```kotlin
assertThat(result).isEqualTo(expected)
assertThat(items).containsExactly(a, b).inOrder()
```

## Mocking with MockK

MockK is the idiomatic Kotlin mocking library (handles final classes, coroutines,
and relaxed mocks). Prefer fakes for owned interfaces; use mocks for verifying
interactions or stubbing boundaries.

```kotlin
@Test
fun `loads profile from repo`() = runTest {
    val repo = mockk<ProfileRepository>()
    coEvery { repo.profile(42) } returns Profile(name = "Ada")

    val result = ProfileService(repo).load(42)

    assertThat(result.name).isEqualTo("Ada")
    coVerify(exactly = 1) { repo.profile(42) }
}
```

- Use `coEvery`/`coVerify` for suspend functions.
- Use `relaxed = true` to auto-stub return values you don't care about.
- Prefer hand-written **fakes** over mocks for repositories/data sources you own —
  they're more robust and document behavior.

## Testing Coroutines

Use `kotlinx-coroutines-test`. `runTest` provides a `TestScope` with a virtual
clock that auto-advances through `delay`.

```kotlin
@Test
fun `retries after delay`() = runTest {
    val result = withTimeout(1.seconds) { service.fetchWithRetry() }
    assertThat(result).isNotNull()
    // delay(30_000) inside fetchWithRetry is skipped — virtual time
}
```

- Inject dispatchers so tests can substitute a test dispatcher. Provide a
  `MainDispatcherRule` to swap `Dispatchers.Main` (needed for `viewModelScope`):

```kotlin
class MainDispatcherRule(
    private val dispatcher: TestDispatcher = StandardTestDispatcher(),
) : TestWatcher() {
    override fun starting(d: Description) = Dispatchers.setMain(dispatcher)
    override fun finished(d: Description) = Dispatchers.resetMain()
}
```

- `StandardTestDispatcher` queues coroutines — call `advanceUntilIdle()` /
  `runCurrent()` to run them. `UnconfinedTestDispatcher` runs eagerly — handy for
  simple cases but order-sensitive.
- Never use `Thread.sleep` or real `delay` waits in tests.

## Testing Flows with Turbine

Turbine makes Flow assertions deterministic without manual collection
boilerplate. Use it for `Flow`, `StateFlow`, and `SharedFlow`.

```kotlin
@Test
fun `emits loading then loaded`() = runTest {
    viewModel.uiState.test {
        assertThat(awaitItem()).isEqualTo(UiState.Loading)
        viewModel.load()
        assertThat(awaitItem()).isInstanceOf(UiState.Loaded::class.java)
        cancelAndIgnoreRemainingEvents()
    }
}
```

- `awaitItem()` suspends for the next emission; `awaitError()` / `awaitComplete()`
  for terminal events.
- For `StateFlow`, the first `awaitItem()` is the current value; call
  `cancelAndIgnoreRemainingEvents()` (or `expectMostRecentItem()`) to finish.
- `test {}` fails if unconsumed events remain — this catches unexpected emissions.

## Testing ViewModels

Combine the `MainDispatcherRule`, `runTest`, fakes, and Turbine:

```kotlin
class FeedViewModelTest {
    @get:Rule val mainDispatcherRule = MainDispatcherRule()

    @Test
    fun `shows error when repo throws`() = runTest {
        val repo = FakeFeedRepository(throws = IOException())
        val vm = FeedViewModel(repo)

        vm.state.test {
            assertThat(awaitItem()).isEqualTo(FeedUiState.Loading)
            assertThat(awaitItem()).isInstanceOf(FeedUiState.Error::class.java)
            cancelAndIgnoreRemainingEvents()
        }
    }
}
```

## Robolectric

Robolectric runs Android-framework-dependent code on the JVM (no emulator), so
it stays in `src/test/`. Use it when a unit test needs `Context`, resources,
`SharedPreferences`, or Android components — but the logic doesn't need a real
device.

```kotlin
@RunWith(RobolectricTestRunner::class)
class ResourceTest {
    @Test
    fun `reads string resource`() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        assertThat(context.getString(R.string.app_name)).isEqualTo("Demo")
    }
}
```

Prefer pure unit tests where possible; reach for Robolectric only when framework
types are genuinely involved. It is slower than plain JVM tests but far faster
than instrumented ones.

## Compose UI Testing

Use `createComposeRule()` (no Activity) or `createAndroidComposeRule<Activity>()`.
These can run as Robolectric tests in `src/test/` or instrumented in
`src/androidTest/`. Query by **semantics**, and add `Modifier.testTag` /
content descriptions for stable selectors.

```kotlin
class CounterTest {
    @get:Rule val composeRule = createComposeRule()

    @Test
    fun increments_on_click() {
        composeRule.setContent { Counter() }

        composeRule.onNodeWithText("Count: 0").assertIsDisplayed()
        composeRule.onNodeWithTag("increment").performClick()
        composeRule.onNodeWithText("Count: 1").assertExists()
    }
}
```

- Compose tests synchronize automatically with the runtime; avoid arbitrary
  waits. For non-Compose async, use `composeRule.waitUntil { ... }`.
- Use `onNodeWithTag`/`onNodeWithContentDescription` for robust, localized-text-
  independent selectors.
- Disable indeterminate animations or use `mainClock.autoAdvance = false` to
  control time when asserting animated states.

## Espresso

Espresso drives real instrumented UI tests (`src/androidTest/`, runs on an
emulator/device). Use for end-to-end flows and legacy View-based screens.

```kotlin
@RunWith(AndroidJUnit4::class)
class LoginFlowTest {
    @get:Rule val activityRule = ActivityScenarioRule(LoginActivity::class.java)

    @Test
    fun successful_login_navigates_home() {
        onView(withId(R.id.email)).perform(typeText("a@b.com"))
        onView(withId(R.id.submit)).perform(click())
        onView(withId(R.id.home)).check(matches(isDisplayed()))
    }
}
```

- Idle synchronization is automatic for the main thread; register an
  `IdlingResource` for custom async work.
- Keep Espresso tests few — they are slow and flaky-prone. Push coverage down to
  unit/Compose tests.

## Common Mistakes

1. **`Thread.sleep`/real delays in tests** — use `runTest` virtual time and
   Turbine/`waitUntil`.
2. **No `MainDispatcherRule`** when testing `viewModelScope` — `Dispatchers.Main`
   isn't available on the JVM and the test fails or hangs.
3. **Hardcoded dispatchers** in production code — can't substitute test
   dispatchers; inject them.
4. **Manual Flow collection** in tests — use Turbine for determinism.
5. **Over-mocking owned types** — prefer fakes; mocks couple tests to call order.
6. **Putting everything in `androidTest`** — slow; most tests belong in `test/`.
7. **Asserting on localized text** in UI tests — use `testTag`/content
   descriptions.
8. **Testing implementation details** — assert observable behavior/state.
9. **Leaking `Dispatchers.setMain`** — always `resetMain()` (the rule handles it).
10. **Ignoring Turbine unconsumed-event failures** — they reveal real bugs;
    don't blanket-`cancelAndIgnore` without checking.

## Review Checklist

- [ ] Most tests are fast JVM unit tests in `src/test/`
- [ ] Coroutine tests use `runTest`; no real sleeps/delays
- [ ] `MainDispatcherRule` present for ViewModel/`viewModelScope` tests
- [ ] Dispatchers injected for testability
- [ ] Flow assertions use Turbine (`awaitItem`/`awaitError`)
- [ ] Fakes preferred over mocks for owned dependencies; MockK for boundaries
- [ ] Robolectric used only when Android framework types are needed
- [ ] Compose tests query by semantics/`testTag`, not localized text
- [ ] Espresso reserved for true end-to-end instrumented flows
- [ ] Tests assert behavior, not implementation
- [ ] Error/cancellation paths covered, not just the happy path
