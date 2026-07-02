<!-- pack: platform/android -->
## Mobile platform — Android

This project ships an Android app (Kotlin / Jetpack Compose). The Kotlin/Android
framework conventions live in the `lang/kotlin` skills (`kotlin-coroutines`,
`jetpack-compose`, `android-testing`). Leith owns the Android UX (Material idiom);
Isabelle implements with the Kotlin packs; Gary audits the shipped surface.

### Local Gradle gate (no CI for Android)

Android has **no cloud CI for the app build** — the gate is a local `./gradlew`
run. Run it before reporting any Android change complete:

```
./gradlew <!-- naturalize: :app: -->assembleDebug
./gradlew <!-- naturalize: :app: -->testDebugUnitTest
./gradlew <!-- naturalize: :app: -->lintDebug
```

Always use the project's `./gradlew` wrapper, never a global `gradle`.
Instrumented tests (`connectedDebugAndroidTest`) need an emulator and are not part
of the fast gate.

The `pre-push-gradle.sh` hook (this pack) runs assemble + unit tests + lint
automatically when Android files change on push. Install once per clone with
`git config core.hooksPath .githooks`. **Do not bypass with `--no-verify`.** The
hook reads `ANDROID_DIR`, `ANDROID_PATH_PREFIX`, and `GRADLE_MODULE` knobs.

### MCP servers

None required. `settings.fragment.json` allows read-only Gradle inspection
(`./gradlew tasks`, `projects`, `help`, `dependencies`) and `adb devices` without
prompting; it adds no Android MCP server.

<!-- naturalize: record these Android project facts in the Project facts section:
     - Gradle project root / ANDROID_DIR (dir containing ./gradlew)
     - app module name (GRADLE_MODULE, e.g. :app)
     - applicationId (e.g. com.example.app)
     - minSdk / targetSdk / compileSdk
     - product flavors / build variants, if any
-->
