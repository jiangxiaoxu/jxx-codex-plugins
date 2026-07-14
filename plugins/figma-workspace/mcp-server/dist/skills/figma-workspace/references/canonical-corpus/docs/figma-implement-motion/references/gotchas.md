# Motion implementation failure boundaries

Treat motion data as a visual contract, not as a reason to add generic browser animation. Before adapting an animated file, query its first-class motion data and keep the returned context with the task's persistent state file.

```text
npm --silent run figma:motion-context -- --session-id <session-id> --state-file C:/work/project/.figma-workspace/state.json
```

Use the returned timing, values, easing, and origin data when available. A local `.figma.ts` script is for inspecting or changing Figma nodes; `figma:script:run` should not invent an exported web-motion representation that the motion context does not support. Capture the relevant node after a Figma-side edit and inspect the image locally with `view_image`.

## Preserve these semantics

| Observed case | Required adaptation |
| --- | --- |
| `HOLD` easing | Use `step-end` or `steps(1, jump-end)`, never a linear ramp. On the final segment, preserve the final value. |
| Zero-duration track | Apply its final value as static state; omit an animation block to avoid mount flashes or layout jumps. |
| Spring with two keyframes | Keep a spring in the target motion system; do not approximate it with a cubic-bezier. |
| Spring or custom easing with 3+ keyframes | Preserve the emitted per-segment easing sequence rather than collapsing it to one curve. |
| Saturated color transition | Prefer the supplied color-space behavior; when hand-authoring, use a perceptual space such as OKLCH rather than naïve RGB interpolation. |

## Known structural traps

An animated Figma group may be represented in a target UI as `display: contents`. That wrapper has no box, so transform, opacity, scale, rotation, and transform-origin do not reliably apply to its visible descendants. Preserve a static `display: contents` wrapper, but when the group itself animates, introduce a real layout-preserving wrapper with explicit visual bounds. Keep child offsets in the same coordinate system and verify the static frame before assessing the animation.

Do not put a class-based layout transform and an animation-library transform on the same element. For example, a centering class using `translateX(-50%)` can be overwritten by an inline rotate/scale animation. Put static positioning on an outer wrapper and animated transforms on an inner wrapper, or encode the positional offset in every animation keyframe.

Rotation origins require visual validation. An origin expressed as a positive multiple of element height can represent a shared scene pivot; copying it literally into CSS can orbit the object off-screen. If that happens, test the resolved origin through a full loop. A useful diagnostic hypothesis is to negate `(originY - 1) * 100%`, but it is not a universal conversion rule.

Static exported assets may already contain the timeline's t=0 opacity or transform. If an element remains invisible despite a correct parent animation, inspect the asset bytes for baked `opacity` or `transform`; strip or replace the static state only when that is confirmed, or animate an outer wrapper whose static content begins visible.

## Unsupported and verification path

Animating a group behind a mask is supported when the mask is only following the group. Animating mask image, size, or position itself is not equivalent and should be surfaced as unsupported rather than simulated as if it were faithful.

Apply `will-change` only to currently animating target elements. It allocates compositing resources and is not a blanket quality fix.

For node changes, run the small `.figma.ts` transaction through `figma:script:run`, return changed ids and validation notes, then use `figma:capture` and `view_image`. A capture verifies a still frame only; it cannot prove timeline interpolation or looping behavior. Test the full motion in the target runtime before claiming fidelity. If motion context is missing or conflicts with visual evidence, stop at the documented data, report the ambiguity, and do not fabricate timing or easing.
