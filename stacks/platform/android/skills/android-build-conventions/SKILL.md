---
name: android-build-conventions
description: "Configure and verify Android Gradle builds: Kotlin DSL (build.gradle.kts), version catalogs (libs.versions.toml), build types and product flavors, R8/ProGuard shrinking and keep rules, signing configs, and the local build/verify gate (./gradlew assembleDebug, testDebugUnitTest, lintDebug). Use when editing Gradle build files, adding dependencies, setting up flavors/variants, configuring minification or signing, or running the Android build/test/lint gate before reporting a change complete."
---

# Android Build Conventions

Configure, maintain, and verify Android builds with Gradle's Kotlin DSL targeting
AGP 8.x+ and Gradle 8.x+. Use the version catalog as the single source of truth
for dependencies, keep build logic declarative, and **always run the local gate**
before reporting an Android change complete — Android typically has no cloud CI
for the app build, so the local `./gradlew` run is the gate.

## Contents

- [Local Build / Verify Gate](#local-build--verify-gate)
- [Kotlin DSL Conventions](#kotlin-dsl-conventions)
- [Version Catalogs](#version-catalogs)
- [Build Types and Product Flavors](#build-types-and-product-flavors)
- [R8 / ProGuard](#r8--proguard)
- [Signing](#signing)
- [Convention Plugins](#convention-plugins)
- [Common Mistakes](#common-mistakes)
- [Review Checklist](#review-checklist)

## Local Build / Verify Gate

Run these before reporting any Android change complete. They are fast, local, and
the de-facto gate (there is no cloud CI for the app build):

```
./gradlew assembleDebug        # compile + package the debug APK
./gradlew testDebugUnitTest    # run JVM unit tests (src/test)
./gradlew lintDebug            # Android Lint static analysis
```

Naturalize the module if the app isn't the root project (e.g.
`./gradlew :app:assembleDebug`). The `pre-push-gradle.sh` hook in this pack runs
this gate automatically when Android files change on push — **do not bypass it
with `--no-verify`.**

Notes:
- Use the project's `./gradlew` wrapper, never a globally installed `gradle`.
- Instrumented tests (`connectedDebugAndroidTest`) need an emulator/device and are
  **not** part of the fast gate — run them on demand.
- For a deeper check before release, add `./gradlew assembleRelease` (exercises
  R8/minification).

## Kotlin DSL Conventions

Use `build.gradle.kts` (Kotlin DSL), not Groovy, for new build files.

```kotlin
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)        // Compose compiler plugin (Kotlin 2.0+)
}

android {
    namespace = "com.example.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.example.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildFeatures { compose = true }

    kotlin { jvmToolchain(17) }                // pin the JDK toolchain
}

dependencies {
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.activity.compose)
    testImplementation(libs.junit)
    testImplementation(libs.turbine)
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
}
```

- Declare the Compose BOM with `platform(...)` so all Compose artifacts share one
  version. Apply the Compose compiler plugin (`org.jetbrains.kotlin.plugin.compose`)
  on Kotlin 2.0+.
- Pin the JDK with `jvmToolchain(17)` (or the project's standard) for reproducible
  builds across machines.
- Prefer `implementation` over `api` unless the dependency is part of a module's
  public API — it keeps the build graph fast.

## Version Catalogs

Keep all versions, libraries, and plugins in `gradle/libs.versions.toml`. This is
the single source of truth; never hardcode versions in `build.gradle.kts`.

```toml
[versions]
agp = "8.7.0"
kotlin = "2.1.0"
composeBom = "2025.01.00"
coroutines = "1.9.0"
turbine = "1.2.0"

[libraries]
androidx-compose-bom = { group = "androidx.compose", name = "compose-bom", version.ref = "composeBom" }
androidx-compose-material3 = { group = "androidx.compose.material3", name = "material3" }
androidx-activity-compose = { group = "androidx.activity", name = "activity-compose", version = "1.9.3" }
kotlinx-coroutines-core = { group = "org.jetbrains.kotlinx", name = "kotlinx-coroutines-core", version.ref = "coroutines" }
turbine = { group = "app.cash.turbine", name = "turbine", version.ref = "turbine" }
junit = { group = "junit", name = "junit", version = "4.13.2" }

[plugins]
android-application = { id = "com.android.application", version.ref = "agp" }
kotlin-android = { id = "org.jetbrains.kotlin.android", version.ref = "kotlin" }
kotlin-compose = { id = "org.jetbrains.kotlin.plugin.compose", version.ref = "kotlin" }
```

- Reference libraries as `libs.androidx.compose.material3` and plugins as
  `alias(libs.plugins.android.application)`.
- Use `[bundles]` to group related dependencies that are always added together.
- BOM-managed artifacts (Compose) omit a version — the BOM resolves it.

## Build Types and Product Flavors

`buildTypes` vary how the **same** code is built (debug vs release). `flavors`
vary **what** is built (free vs paid, dev vs prod backend). Their product is a
build *variant* (e.g. `freeDebug`).

```kotlin
android {
    buildTypes {
        debug {
            applicationIdSuffix = ".debug"     // install alongside release
            isDebuggable = true
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            signingConfig = signingConfigs.getByName("release")
        }
    }

    flavorDimensions += "environment"
    productFlavors {
        create("dev")  { dimension = "environment"; applicationIdSuffix = ".dev" }
        create("prod") { dimension = "environment" }
    }
}
```

- Use `applicationIdSuffix` on debug/dev so multiple variants coexist on a device.
- Keep flavor-specific code/resources in `src/<flavor>/` source sets.
- Put environment config (base URLs, keys) in `buildConfigField` or resource
  overlays, not in code branches.

## R8 / ProGuard

R8 is the default shrinker/optimizer/obfuscator for release builds (replaces
ProGuard but reads the same `proguard-rules.pro` keep rules).

- Enable for release: `isMinifyEnabled = true` and `isShrinkResources = true`.
- Add **keep rules** for anything accessed reflectively: serialization models,
  JNI, code referenced only by manifest/XML, libraries that need them.

```proguard
# Keep models used by kotlinx.serialization / Gson reflection.
-keep,allowobfuscation class com.example.app.model.** { *; }
# Keep enums used reflectively.
-keepclassmembers enum * { public static **[] values(); public static ** valueOf(java.lang.String); }
```

- Most modern libraries ship **consumer keep rules**, so you usually need few
  manual rules — add them only when release builds crash where debug doesn't.
- Always test a **release** build before shipping; minification bugs don't appear
  in `assembleDebug`.
- Enable obfuscation mapping retention so crash reports can be de-obfuscated.

## Signing

- **Never commit keystores or passwords.** Inject signing credentials from
  `local.properties`, environment variables, or a secrets manager.

```kotlin
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) load(f.inputStream())
}

android {
    signingConfigs {
        create("release") {
            storeFile = keystoreProps["storeFile"]?.let { file(it as String) }
            storePassword = keystoreProps["storePassword"] as String?
            keyAlias = keystoreProps["keyAlias"] as String?
            keyPassword = keystoreProps["keyPassword"] as String?
        }
    }
}
```

- Add `keystore.properties` and `*.keystore`/`*.jks` to `.gitignore`.
- Debug builds use the auto-generated debug keystore — fine for local work.

## Convention Plugins

For multi-module projects, extract shared build logic into convention plugins in
`build-logic/` (composite build) rather than copy-pasting config across modules.
This keeps module `build.gradle.kts` files small and consistent. Avoid the legacy
top-level `allprojects {}`/`subprojects {}` blocks.

## Common Mistakes

1. **Hardcoded versions** in `build.gradle.kts` — use the version catalog.
2. **Groovy DSL for new files** — use Kotlin DSL (`.kts`).
3. **Not running the local gate** before reporting done — always
   `assembleDebug` + `testDebugUnitTest` + `lintDebug`.
4. **Using a system `gradle`** instead of `./gradlew`.
5. **Committing keystores/passwords** — inject them; gitignore secrets.
6. **Shipping without testing a release build** — R8 issues only surface there.
7. **Missing keep rules** for reflective code — release crashes, debug fine.
8. **`api` everywhere** — leaks the dependency graph and slows builds; default to
   `implementation`.
9. **Mismatched Compose compiler / Kotlin versions** — apply the Compose compiler
   plugin matched to the Kotlin version (Kotlin 2.0+).
10. **No JDK toolchain pin** — builds differ across machines; set `jvmToolchain`.

## Review Checklist

- [ ] Build files use Kotlin DSL (`.kts`)
- [ ] All versions/libs/plugins live in `gradle/libs.versions.toml`
- [ ] Compose BOM declared via `platform(...)`; compiler plugin matched to Kotlin
- [ ] `release` build enables R8 (`isMinifyEnabled`, `isShrinkResources`)
- [ ] Keep rules present for reflective/serialized types
- [ ] Signing credentials injected, not committed; keystores gitignored
- [ ] JDK toolchain pinned (`jvmToolchain`)
- [ ] Local gate run: `assembleDebug` + `testDebugUnitTest` + `lintDebug`
- [ ] A release build was assembled before shipping
- [ ] Variants coexist on device (`applicationIdSuffix` on debug/dev)
