/** Shared scalar limits and patterns used by JSON contracts and argument guards. */
export const INLINE_RESULT_LIMIT_MIN = 0;
export const INLINE_RESULT_LIMIT_MAX = 10_000;
export const MAX_MANIFEST_ITEMS = 64;
export const FIGMA_WORKSPACE_IMAGE_SCALE_MODES = ["FILL", "FIT", "CROP", "TILE"] as const;
export const FIGMA_WORKSPACE_IMAGE_SCALE_MODE_PATTERN = "^(?:[Ff][Ii][Ll][Ll]|[Ff][Ii][Tt]|[Cc][Rr][Oo][Pp]|[Tt][Ii][Ll][Ee])$";
