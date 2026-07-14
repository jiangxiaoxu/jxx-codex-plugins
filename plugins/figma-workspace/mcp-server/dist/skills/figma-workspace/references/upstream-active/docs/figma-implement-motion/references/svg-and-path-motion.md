# SVG and Path-Level Motion

Use this reference when `figma:motion-context` returns a vector-path snippet while `figma:design-context` represents the vector as an `<img>` asset.

Inline the SVG before applying path-level motion. Preserve the surrounding layout wrapper, sizing, `data-node-id`, `viewBox`, `preserveAspectRatio`, and referenced `<defs>`. Whole-element transforms can remain on the existing wrapper; inlining is required only when the animation targets path geometry.

For Motion.dev output, apply wrapper values to `motion.svg` and path values to `motion.path`. Keep both layers if both animate. For CSS path trim, add `pathLength="1"` when required, apply the returned dash styles to the path, and emit each `@keyframes` rule once. Do not collapse path animation into wrapper animation.

If the path timing cannot round-trip, preserve the SVG and use a simplified dash animation or recommend a purpose-built library.
