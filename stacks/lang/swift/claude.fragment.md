<!-- pack: lang/swift -->
## Language — Swift 6 & SwiftUI

This project writes Swift 6+ targeting Apple platforms:
- **Isabelle** and **Leith** load **`swiftui-patterns`** for Model-View (`@Observable`, `@MainActor`, `@State`, `@Bindable`, `@Environment`) architecture, view composition, `.task` lifecycle, and Apple HIG alignment.
- **Isabelle** and **Bert** load **`swift-concurrency`** for Swift 6 strict concurrency (`Sendable`, `@MainActor`, actor isolation, structured tasks, `AsyncSequence`).
- **Isabelle** and **Melvin** load **`swiftdata`** when modeling `@Model` entities, `ModelContainer`/`ModelContext`, `@Query`, and schema migrations.
- **Marcelo** and **Isabelle** load **`swift-testing`** (`@Test`, `#expect`, `#require`, parameterized tests, `@Suite`) for unit and integration testing.

<!-- naturalize: record minimum OS deployment target, Swift language mode (Swift 6), and xcodebuild / swift test commands in Project facts. -->
