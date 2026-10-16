<!-- pack: platform/android -->
## Mobile platform — Android

This project ships an Android app (Kotlin / Jetpack Compose, targeting Android 16 / API 36+):
- **Isabelle** and **Aaron** load **`android-build-conventions`** when editing `build.gradle.kts`, `gradle/libs.versions.toml`, product flavors, R8/ProGuard rules, signing configs, or running the local Gradle gate.
- The Kotlin/Android framework conventions live in the `lang/kotlin` skills (`kotlin-coroutines`, `jetpack-compose`, `android-testing`).
- **Leith** owns the Android UX (Material 3 idiom); **Isabelle** implements with the Kotlin and Android packs; **Gary** audits the shipped surface.

### Local Gradle gate (no CI for Android)

Android typically has **no cloud CI for the app build** — the gate is a local `./gradlew` run before reporting any Android change complete:

```
./gradlew <!-- naturalize: :app: -->assembleDebug
./gradlew <!-- naturalize: :app: -->testDebugUnitTest
./gradlew <!-- naturalize: :app: -->lintDebug
```

Always use the project's `./gradlew` wrapper, never a global `gradle`. The `pre-push-gradle.sh` hook in this pack runs assemble + unit tests + lint automatically when Android files change on push (`git config core.hooksPath .githooks`). **Do not bypass with `--no-verify`.**

### MCP servers

None required. `settings.fragment.json` allows read-only Gradle inspection (`./gradlew tasks`, `projects`, `help`, `dependencies`) and `adb devices` without prompting.

<!-- naturalize: record these Android project facts in the Project facts section:
     - Gradle project root / ANDROID_DIR (dir containing ./gradlew)
     - app module name (GRADLE_MODULE, e.g. :app)
     - applicationId (e.g. com.example.app)
     - minSdk / targetSdk / compileSdk (API 36+)
     - product flavors / build variants, if any
-->
