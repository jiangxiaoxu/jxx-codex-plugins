import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";

import {
  getFigmaJsonCommandContract,
} from "./json-command-contracts.js";

/** Ajv 为 JSON command document 生成的一条诊断. */
export type FigmaJsonCommandValidationError = ErrorObject;

/** 校验一个 public command JSON document 的结果. */
export interface FigmaJsonCommandValidationResult {
  /** 选中 input contract 的 command name. */
  command: string;
  /** document 是否满足 command 的 JSON Schema. */
  valid: boolean;
  /** 供使用 result envelope 常规 `ok` 字段的 caller 使用的 alias. */
  ok: boolean;
  /** Ajv 诊断; document 有效时为 `null`. */
  errors: readonly FigmaJsonCommandValidationError[] | null;
}

/** JSON command document 不满足 contract 时抛出的 Error. */
export class FigmaJsonCommandValidationException extends Error {
  readonly command: string;
  readonly errors: readonly FigmaJsonCommandValidationError[];

  constructor(command: string, errors: readonly FigmaJsonCommandValidationError[]) {
    super(`Invalid --input JSON for figma:${command}: ${formatFigmaJsonCommandValidationErrors(errors)}`);
    this.name = "FigmaJsonCommandValidationException";
    this.command = command;
    this.errors = errors;
  }
}

/**
 * 在进程内配置一次 Ajv, 确保所有 JSON command 使用相同的 strict schema
 * 和 format 语义. 校验不会转换值, 填充默认值或删除 additional properties.
 */
const AJV = new Ajv({
  allErrors: true,
  strict: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
});
// `ajv-formats` 以 CommonJS 发布, 而本 package 输出 NodeNext ESM. 这里的
// cast 明确 TypeScript NodeNext declaration 与 Node interop shape, 避免启用
// 全局 coercion 或 synthetic API.
const addFormats = addFormatsModule as unknown as (ajv: Ajv) => unknown;
addFormats(AJV);

const SCHEMA_VALIDATORS = new WeakMap<object, ValidateFunction>();

/**
 * 根据已注册的 input contract 校验 public command JSON document. 复制 Ajv
 * 诊断, 避免后续校验修改此前返回的 result.
 */
export function validateFigmaJsonCommand(
  command: string,
  value: unknown,
): FigmaJsonCommandValidationResult {
  const contract = getFigmaJsonCommandContract(command);
  if (!contract) {
    const errors: readonly FigmaJsonCommandValidationError[] = [{
      instancePath: "",
      schemaPath: "",
      keyword: "command",
      params: { command },
      message: "must identify a registered JSON command",
    }];
    return { command, valid: false, ok: false, errors };
  }

  return validateFigmaJsonSchema(command, contract.inputSchema, value);
}

/**
 * 使用同一个 strict Ajv instance 校验显式传入的 JSON Schema. 供内部
 * direct API envelope 复用 public contract 中派生的 schema.
 */
export function validateFigmaJsonSchema(
  command: string,
  schema: Record<string, unknown>,
  value: unknown,
): FigmaJsonCommandValidationResult {
  const validator = getSchemaValidator(schema);
  const valid = validator(value);
  const rawErrors = validator.errors;
  const errors = !rawErrors
    ? null
    : rawErrors.map((error) => ({ ...error, params: { ...error.params } }));
  return { command, valid, ok: valid, errors };
}

/**
 * 校验 document, 并在 malformed 时抛出一个供 usage 层显示的 Error. value
 * 保持不变; normalization 与 cross-field business check 仍由 command
 * argument validator 负责.
 */
export function assertValidFigmaJsonCommand(
  command: string,
  value: unknown,
): asserts value is Record<string, unknown> {
  const result = validateFigmaJsonCommand(command, value);
  if (!result.valid) {
    throw new FigmaJsonCommandValidationException(command, result.errors ?? []);
  }
}

/** 校验显式 schema, 并在失败时抛出 usage-facing Error. */
export function assertValidFigmaJsonSchema(
  command: string,
  schema: Record<string, unknown>,
  value: unknown,
): asserts value is Record<string, unknown> {
  const result = validateFigmaJsonSchema(command, schema, value);
  if (!result.valid) {
    throw new FigmaJsonCommandValidationException(command, result.errors ?? []);
  }
}

/** 将 Ajv errors 格式化为紧凑且可读的 JSON path 和 keyword. */
export function formatFigmaJsonCommandValidationErrors(
  errors: readonly FigmaJsonCommandValidationError[] | FigmaJsonCommandValidationResult | null | undefined,
): string {
  if (isValidationResult(errors)) return formatFigmaJsonCommandValidationErrors(errors.errors);
  if (!errors || errors.length === 0) return "";
  return errors.map(formatFigmaJsonCommandValidationError).join("; ");
}

/** 格式化一条 Ajv 诊断, 供渲染结构化 help 的 caller 使用. */
export function formatFigmaJsonCommandValidationError(
  error: FigmaJsonCommandValidationError,
): string {
  const path = formatErrorPath(error);
  const message = error.message ?? "must satisfy the schema";
  return `${path} ${message} [${error.keyword}]`;
}

// 保留显式名称供 public consumer 使用, 同时提供短 alias 方便 command/runtime
// call site.
export const formatFigmaJsonCommandErrors = formatFigmaJsonCommandValidationErrors;
export const formatJsonCommandValidationErrors = formatFigmaJsonCommandValidationErrors;

function getSchemaValidator(schema: Record<string, unknown>): ValidateFunction {
  const cached = SCHEMA_VALIDATORS.get(schema);
  if (cached) return cached;
  const validator = AJV.compile(schema);
  SCHEMA_VALIDATORS.set(schema, validator);
  return validator;
}

function formatErrorPath(error: FigmaJsonCommandValidationError): string {
  let path = formatJsonPointer(error.instancePath ?? "");
  if (error.keyword === "required" && isRecord(error.params) && typeof error.params.missingProperty === "string") {
    path = appendPath(path, error.params.missingProperty);
  } else if (error.keyword === "additionalProperties" && isRecord(error.params) && typeof error.params.additionalProperty === "string") {
    path = appendPath(path, error.params.additionalProperty);
  }
  return path;
}

function formatJsonPointer(pointer: string): string {
  if (!pointer) return "$";
  const segments = pointer.split("/").slice(1).map((segment) => segment.replace(/~1/gu, "/").replace(/~0/gu, "~"));
  return segments.reduce(appendPath, "$");
}

function appendPath(path: string, segment: string): string {
  if (/^(?:0|[1-9]\d*)$/u.test(segment)) return `${path}[${segment}]`;
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(segment)) return `${path}.${segment}`;
  return `${path}[${JSON.stringify(segment)}]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isValidationResult(value: unknown): value is FigmaJsonCommandValidationResult {
  return isRecord(value)
    && typeof value.command === "string"
    && typeof value.valid === "boolean"
    && (value.errors === null || Array.isArray(value.errors));
}
