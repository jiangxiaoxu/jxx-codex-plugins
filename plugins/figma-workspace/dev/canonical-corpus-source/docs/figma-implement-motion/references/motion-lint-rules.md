# Motion Lint Rules

Treat current `figma:motion-context` output as authoritative when it supplies a supported snippet. Warnings still matter because they describe fidelity or accessibility gaps that should be reported to the user.

- Smart Animate and prototype transitions may require product-specific state handling rather than a canvas keyframe translation.
- GIF and animated SVG output may be unavailable. Use video for a faithful animated raster, or use a runtime such as Motion.dev or Lottie for an animated vector.
- Honor `prefers-reduced-motion` for every delivered implementation.
