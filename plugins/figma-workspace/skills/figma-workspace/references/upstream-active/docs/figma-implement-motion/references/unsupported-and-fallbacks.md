# Unsupported Features and Fallbacks

Feature status is point-in-time. Verify the current `figma:motion-context` result before declaring a feature unsupported; a returned snippet is authoritative.

- Arc paths, generated shader effects, animated masks, complex vector networks, boolean operations, and component transitions may not reproduce faithfully in code.
- For complex vector motion, use a flattened SVG with wrapper transforms, a video fallback, or a runtime such as Lottie.
- For path trims that cannot round-trip, preserve the SVG and simplify the reveal or recommend a library.
- When fidelity is ambiguous, ask whether to use a simpler approximation, a library, or a video fallback instead of silently approximating.
