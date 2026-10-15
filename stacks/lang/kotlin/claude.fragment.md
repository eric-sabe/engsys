<!-- pack: lang/kotlin -->
## Language — Kotlin & Jetpack Compose

This project writes Kotlin targeting Android / JVM:
- **Isabelle** and **Leith** load **`jetpack-compose`** for Material 3 UI composition, state hoisting, `rememberSaveable`, navigation, and recomposition discipline.
- **Isabelle** and **Bert** load **`kotlin-coroutines`** for structured concurrency, `Dispatcher` injection, `StateFlow`/`SharedFlow`, and lifecycle-aware collection.
- **Marcelo** and **Isabelle** load **`android-testing`** for JUnit / Robolectric / Compose UI test rules, `runTest` + `StandardTestDispatcher`, and Turbine `Flow` assertions.

<!-- naturalize: record Kotlin version, JVM target, and test runner commands in Project facts. -->
