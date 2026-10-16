---
name: android-build-conventions
description: "Configure and verify Android Gradle builds (2026 baseline: Android 16 / API 36, AGP 9.x, Kotlin 2.2+, Compose BOM 2026.x): Kotlin DSL (build.gradle.kts), version catalogs (libs.versions.toml), build types and product flavors, R8 shrinking and keep rules, signing configs, and the local build/verify gate (./gradlew assembleDebug, testDebugUnitTest, lintDebug)."
---

# Android Build Conventions (2026 Baseline — API 36 / AGP 9.x / Kotlin 2.2+)

Configure, maintain, and verify Android builds with Gradle's Kotlin DSL targeting **Android 16 (API 36)**, **AGP 9.x**, and **Kotlin 2.2+**. Use `gradle/libs.versions.toml` as the single source of truth for dependencies and **always run the local Gradle gate** before reporting an Android change complete.

## Local Build / Verify Gate

Run these commands via the project's `./gradlew` wrapper before reporting any Android change complete:

```bash
./gradlew assembleDebug        # compile + package the debug APK
./gradlew testDebugUnitTest    # run JVM unit tests (src/test)
./gradlew lintDebug            # Android Lint static analysis
```

Naturalize the module prefix when needed (e.g., `./gradlew :app:assembleDebug`). The `pre-push-gradle.sh` hook runs this gate automatically on push — **do not bypass it with `--no-verify`.**

## Kotlin DSL Conventions (`build.gradle.kts`)

Use `build.gradle.kts` (never Groovy `.gradle`) and target **API 36** (required by Google Play in 2026):

```kotlin
plugins {
    // AGP 9.0+ includes built-in Kotlin support by default (do not apply org.jetbrains.kotlin.android)
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "com.example.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.example.app"
        minSdk = 28
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildFeatures { compose = true }

    kotlin { jvmToolchain(21) }
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

## Version Catalogs (`gradle/libs.versions.toml`)

Keep all versions, libraries, and plugins in `gradle/libs.versions.toml`:

```toml
[versions]
agp = "9.0.0"
kotlin = "2.2.0"
composeBom = "2026.02.00"
coroutines = "1.10.1"
turbine = "1.2.0"

[libraries]
androidx-compose-bom = { group = "androidx.compose", name = "compose-bom", version.ref = "composeBom" }
androidx-compose-material3 = { group = "androidx.compose.material3", name = "material3" }
androidx-activity-compose = { group = "androidx.activity", name = "activity-compose", version = "1.10.1" }
kotlinx-coroutines-core = { group = "org.jetbrains.kotlinx", name = "kotlinx-coroutines-core", version.ref = "coroutines" }
turbine = { group = "app.cash.turbine", name = "turbine", version.ref = "turbine" }
junit = { group = "junit", name = "junit", version = "4.13.2" }

[plugins]
android-application = { id = "com.android.application", version.ref = "agp" }
kotlin-compose = { id = "org.jetbrains.kotlin.plugin.compose", version.ref = "kotlin" }
```

## Build Types, Flavors, R8 & Signing

- **Build Types & Flavors**: Set `applicationIdSuffix = ".debug"` / `".dev"` so debug and dev variants install alongside release builds.
- **R8 Full Mode**: Enable `isMinifyEnabled = true` and `isShrinkResources = true` on `release`, maintain keep rules in `proguard-rules.pro` for reflective/serialized models, and test `./gradlew assembleRelease` before shipping.
- **Signing Security**: Never commit `*.keystore`, `*.jks`, or passwords. Load signing credentials from untracked `keystore.properties` or CI secret stores.
- **Multi-Module Convention Plugins**: Share build logic via `build-logic/` convention plugins rather than legacy `allprojects {}` / `subprojects {}` blocks.

## Review Checklist

- [ ] `compileSdk = 36` and `targetSdk = 36` (2026 Google Play API 36 requirement)
- [ ] All versions/libraries/plugins declared in `gradle/libs.versions.toml` (`AGP 9.x`, `Kotlin 2.2+`, `Compose BOM 2026.x`)
- [ ] Compose BOM declared via `platform(...)` and `kotlin-compose` plugin applied
- [ ] `release` enables R8 (`isMinifyEnabled = true`, `isShrinkResources = true`)
- [ ] Signing credentials injected externally and gitignored
- [ ] Local gate verified: `./gradlew assembleDebug testDebugUnitTest lintDebug`
