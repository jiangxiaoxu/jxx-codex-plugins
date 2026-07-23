# Figma ↔ SwiftUI

Translation between Figma designs and SwiftUI code, both directions. This file is a router — actual guidance lives in the references below.

## Pick the direction

| Direction | Trigger | Reference |
|---|---|---|
| **Design → code** | User wants SwiftUI in their iOS project from a Figma file/frame | [references/design-to-code.md](canonical:figma-swiftui/references/design-to-code.md) |
| **Code → design** | User wants to push SwiftUI views / screens / tokens into a Figma file | [references/code-to-design.md](canonical:figma-swiftui/references/code-to-design.md) |

If the request is ambiguous — a Figma URL and `.swift` files both present, no verb makes it clear — ask the user which direction before using a reference.

## Shared context (applies to both directions)

These points hold regardless of direction; the direction-specific references assume them.

1. **`figma:design-context` is the read command for Figma.** Pass `clientLanguages: "swift"` and `clientFrameworks: "swiftui"` in its JSON input so the response is framed as Swift. URL → command input: `figma.com/design/:fileKey/:fileName?node-id=:nodeId` → use `fileKey`, replace `-` with `:` in `nodeId`. For `figma.com/design/:fileKey/branch/:branchKey/:fileName`, use `branchKey` as `fileKey`.
2. **The React+Tailwind in `figma:design-context` output is a structural reference, not a literal source.** It approximates the visual. Never transliterate `position: absolute` / pixel frames / `mix-blend-mode` stacks into SwiftUI or into Figma — the capture is the source of truth in both directions.
3. **iOS HIG semantic colors are tokens, not hex.** `var(--backgrounds/primary, …)`, `var(--labels/secondary, …)`, `var(--separators/non-opaque, …)` etc. map to `Color(.systemBackground)`, `Color.secondary`, `Color(.separator)` in SwiftUI, and to variables in a semantic collection in Figma. Keep the mapping; drop the literal RGBA.
4. **SF Symbols round-trip by name in both directions — never by codepoint.** Design → code: `figma:design-context` returns Figma's SF Symbol glyph runs as `<SFSymbol>{Image(systemName: "...")}</SFSymbol>` wrappers. Use those names verbatim. Code → design: call `figma.util.getSfSymbolCharacter(name)` inside a `.figma.ts` script run with `figma:run` to convert a symbol name to the matching character — never look up codepoints by hand.
5. **Recognize the underlying iOS pattern, not the literal node / view name.** The same patterns recur in both directions: large title + back chevron + trailing action = `NavigationStack` chrome; bottom row of icon+label pairs = `TabView`; repeating same-height rows with leading/trailing chrome = `List`. Match those system patterns rather than rebuilding them from primitives.
6. **For code → design, write a `.figma.ts` script and execute it with `figma:run` against the explicit Design file.** For a full screen, follow the design assembly workflow; for components or a design system, follow the component and variable workflow.

## References

| Doc | When to load |
|---|---|
| [references/design-to-code.md](canonical:figma-swiftui/references/design-to-code.md) | Translating a Figma design / frame into SwiftUI |
| [references/code-to-design.md](canonical:figma-swiftui/references/code-to-design.md) | Pushing SwiftUI views / screens / tokens into Figma |
