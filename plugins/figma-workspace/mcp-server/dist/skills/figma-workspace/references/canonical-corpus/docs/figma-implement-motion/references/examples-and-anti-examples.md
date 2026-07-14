# Motion Implementation Examples

Each example joins `figma:design-context` structure with `figma:motion-context` animation data by `data-node-id`. Run both commands with the same absolute `--state-file` and file session.

## One element

Treat `figma:design-context` as the structural record and the matching `figma:motion-context` entry as the animation record. Keep the element's text, attributes, classes, layout, and `data-node-id`; add the returned `initial`, `animate`, and `transition` values to the matching motion-capable element.

## Plain elements are not necessarily static

Every node returned by `figma:motion-context` is animated, even when `figma:design-context` emitted a plain `div`, `p`, or `span`. Locate its exact `data-node-id`, then convert or wrap that element without changing its content or placement.

## Interleaved transforms

Keep the outer motion wrapper, the static-transform wrapper, and the inner node separate. Apply wrapper transform tracks to `data-motion-wrapper-for`, inner tracks to `data-node-id`, and offset absolute rotation values by the static base rotation. Do not let animated transforms overwrite layout transforms used for centering.

## SVG path motion

When `figma:motion-context` targets a path inside an SVG asset, inline the SVG, preserve its layout wrapper and `data-node-id`, and apply wrapper and path animation at their respective layers. See [svg-and-path-motion.md](svg-and-path-motion.md).

## Component instances

Match exact `nodeId` before `fallbackNodeId`. A fallback represents a reusable component body and must not accidentally apply one instance's root animation to all component instances.
