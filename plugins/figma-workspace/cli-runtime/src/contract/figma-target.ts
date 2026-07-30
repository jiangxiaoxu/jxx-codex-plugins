export const FIGMA_FILE_KEY_PATTERN = "^[0-9a-zA-Z]{22,128}$";
export const SIMPLE_NODE_ID_PATTERN = "^\\d+[:-]\\d+$";
export const COMPOSITE_CAPABLE_NODE_ID_PATTERN = "^(?:\\d+[:-]\\d+|[IT]\\d+[:-]\\d+(?:;\\d+[:-]\\d+)*)$";

const FIGMA_FILE_KEY_REGEXP = new RegExp(FIGMA_FILE_KEY_PATTERN, "u");
const SIMPLE_NODE_ID_REGEXP = new RegExp(SIMPLE_NODE_ID_PATTERN, "u");
const COMPOSITE_CAPABLE_NODE_ID_REGEXP = new RegExp(COMPOSITE_CAPABLE_NODE_ID_PATTERN, "u");

export function isFigmaFileKey(value: string): boolean {
  return FIGMA_FILE_KEY_REGEXP.test(value);
}

export function isSimpleFigmaNodeId(value: string): boolean {
  return SIMPLE_NODE_ID_REGEXP.test(value);
}

export function isCompositeCapableFigmaNodeId(value: string): boolean {
  return COMPOSITE_CAPABLE_NODE_ID_REGEXP.test(value);
}
