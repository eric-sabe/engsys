<!-- pack: platform/ios -->
## iOS platform

This project ships an iOS app (Swift / SwiftUI). The Swift framework conventions live in the `lang/swift` skills (`swift-concurrency`, `swiftui-patterns`, `swift-testing`, `swiftdata`). Leith owns the iOS UX (HIG idiom); Isabelle implements with the Swift packs; Gary audits the shipped surface.

### Local xcodebuild gate (no CI for iOS)

iOS has **no CI workflow** — the only gate is a local `xcodebuild`. Run it before reporting any iOS change complete:

```
xcodebuild -project <!-- naturalize: path/to/App.xcodeproj --> \
  -scheme <!-- naturalize: scheme --> -configuration Debug \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
```

The `pre-push-xcodebuild.sh` hook (this pack) runs SwiftLint + `xcodebuild build-for-testing` automatically when iOS files change. Install once per clone with `git config core.hooksPath .githooks`. **Do not bypass with `--no-verify`.**

### MCP servers

- **xcodebuildmcp** — drives Simulator builds/runs and log capture without manual copy/paste (see the `xcodebuildmcp-simulator-logs` skill). Configure `XCODEBUILDMCP_PROJECT_PATH`, `_SCHEME`, `_SIMULATOR_ID`, and `_BUNDLE_ID` in `settings.local.json`.
- **sentry** — runtime crash/error triage for the shipped app.

<!-- naturalize: record the iOS project path, scheme, bundle id, and simulator UDID in the Project facts section. -->
