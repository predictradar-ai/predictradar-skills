/**
 * CopyHunter - Structured Failure Metadata
 */

export type FailureCode =
  | 'dependency_unavailable'
  | 'dependency_timeout'
  | 'dependency_invalid_response'
  | 'dependency_command_failed'
  | 'dependency_network_error'
  | 'dependency_http_error'
  | 'runtime_error';

export type FailureSource =
  | 'polymarket_cli'
  | 'polymarket_data_api'
  | 'watch_engine'
  | 'follow_engine'
  | 'leader_stats'
  | 'unknown';

export interface FailureInfo {
  code: FailureCode;
  source: FailureSource;
  operation: string;
  message: string;
  retryable: boolean;
  occurredAt: number;
  details?: Record<string, string | number | boolean | null>;
}

export class StructuredFailure extends Error {
  readonly info: FailureInfo;

  constructor(info: FailureInfo, cause?: unknown) {
    super(info.message, cause === undefined ? undefined : { cause });
    this.name = 'StructuredFailure';
    this.info = info;
  }
}

export function isStructuredFailure(error: unknown): error is StructuredFailure {
  return error instanceof StructuredFailure;
}

export function createFailureInfo(
  info: Omit<FailureInfo, 'occurredAt'> & { occurredAt?: number }
): FailureInfo {
  return {
    ...info,
    occurredAt: info.occurredAt ?? Date.now(),
  };
}

export function toFailureInfo(
  error: unknown,
  fallback: Omit<FailureInfo, 'message' | 'occurredAt'> & { message?: string; occurredAt?: number }
): FailureInfo {
  if (isStructuredFailure(error)) {
    return error.info;
  }

  const message = error instanceof Error ? error.message : String(error);
  return createFailureInfo({
    ...fallback,
    message: fallback.message ?? message,
  });
}

