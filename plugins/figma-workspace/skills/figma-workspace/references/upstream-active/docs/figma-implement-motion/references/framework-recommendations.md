# Framework Recommendations

Prefer the target repository's established animation stack. For React, use the returned motion.dev snippet when the project has no existing alternative. For non-React web targets, use the returned CSS keyframes. For SwiftUI, translate the returned CSS or structured keyframe data to verified native SwiftUI APIs; do not invent easing APIs.

For glass, particles, physics, or scroll-linked effects, recommend a mature library when it better preserves accessibility, performance, and browser behavior than hand-written keyframes. Preserve timing and easing values from `figma:motion-context` rather than replacing them with defaults.
