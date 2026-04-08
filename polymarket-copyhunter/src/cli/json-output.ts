/**
 * CopyHunter - CLI JSON Output Helpers
 */

export interface JsonOutputOptions {
  output?: string;
  json?: boolean;
}

export interface JsonErrorDetail {
  code: string;
  message: string;
}

export interface JsonSuccessResponse {
  ok: true;
  code: string;
  message: string;
  [key: string]: unknown;
}

export interface JsonErrorResponse {
  ok: false;
  error: JsonErrorDetail;
  [key: string]: unknown;
}

export type JsonValueResponse<TKey extends string, TValue, TExtra extends object = {}> =
  TExtra & { [P in TKey]: TValue };

export type JsonArrayResponse<TKey extends string, TValue, TExtra extends object = {}> =
  JsonValueResponse<TKey, TValue[], TExtra>;

export function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

export function markCommandFailed(exitCode = 1): void {
  process.exitCode = exitCode;
}

export function createJsonSuccess(
  code: string,
  message: string,
  extra: object = {}
): JsonSuccessResponse {
  return {
    ok: true,
    code,
    message,
    ...extra,
  };
}

export function createJsonError(
  code: string,
  message: string,
  extra: object = {}
): JsonErrorResponse {
  return {
    ok: false,
    error: {
      code,
      message,
    },
    ...extra,
  };
}

export function printJsonSuccess<TExtra extends object = {}>(
  code: string,
  message: string,
  extra?: TExtra
): void {
  printJson(createJsonSuccess(code, message, extra ?? {}));
}

export function printJsonError<TExtra extends object = {}>(
  code: string,
  message: string,
  extra?: TExtra
): void {
  markCommandFailed();
  printJson(createJsonError(code, message, extra ?? {}));
}

export function createJsonValueResponse<TKey extends string, TValue, TExtra extends object = {}>(
  key: TKey,
  value: TValue,
  extra?: TExtra
): JsonValueResponse<TKey, TValue, TExtra> {
  return {
    ...(extra ?? {} as TExtra),
    [key]: value,
  } as JsonValueResponse<TKey, TValue, TExtra>;
}

export function createJsonArrayResponse<TKey extends string, TValue, TExtra extends object = {}>(
  key: TKey,
  items: TValue[],
  extra?: TExtra
): JsonArrayResponse<TKey, TValue, TExtra> {
  return createJsonValueResponse(key, items, extra);
}

export function isJsonOutput(options: JsonOutputOptions): boolean {
  return options.output === 'json' || options.json === true;
}
