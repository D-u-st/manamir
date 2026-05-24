// Error Classifier (P0-2A): classify API errors for retry/failover decisions

export enum FailoverReason {
  Auth = 'auth',
  Billing = 'billing',
  RateLimit = 'rate_limit',
  Overloaded = 'overloaded',
  ServerError = 'server_error',
  Timeout = 'timeout',
  ContextOverflow = 'context_overflow',
  PayloadTooLarge = 'payload_too_large',
  ModelNotFound = 'model_not_found',
  FormatError = 'format_error',
  Unknown = 'unknown'
}

export interface ClassifiedError {
  reason: FailoverReason;
  retryable: boolean;
  shouldCompress: boolean;
  shouldRotateCredential: boolean;
  shouldFallback: boolean;
  originalMessage: string;
  httpStatus?: number;
}

interface ErrorBody {
  error?: {
    code?: string;
    message?: string;
    type?: string;
  };
  message?: string;
  code?: string;
  type?: string;
}

function extractErrorBody(error: unknown): { status?: number; body: ErrorBody; message: string } {
  if (error instanceof Error) {
    const msg = error.message;
    const statusMatch = msg.match(/API error (\d+):/);
    const status = statusMatch ? parseInt(statusMatch[1], 10) : undefined;

    let body: ErrorBody = {};
    const jsonStart = msg.indexOf('{');
    if (jsonStart >= 0) {
      try {
        body = JSON.parse(msg.slice(jsonStart));
      } catch { /* not JSON */ }
    }

    return { status, body, message: msg };
  }

  const msg = String(error);
  return { body: {}, message: msg };
}

const BILLING_PATTERNS = [
  /insufficient.?(credits?|funds?|balance)/i,
  /payment.?required/i,
  /billing/i,
  /quota.?exceeded/i,
  /exceeded.*quota/i,
  /account.*suspended/i,
  /余额不足/,
  /欠费/
];

const RATE_LIMIT_PATTERNS = [
  /too many requests/i,
  /rate.?limit/i,
  /throttl/i,
  /请求过于频繁/,
  /频率限制/,
  /requests? per (minute|second|hour)/i,
  /slow down/i,
  /concurrency/i
];

const CONTEXT_OVERFLOW_PATTERNS = [
  /context.?(length|window|limit)/i,
  /token.?(limit|count|length)/i,
  /maximum.?context/i,
  /prompt.?too.?long/i,
  /input.?too.?long/i,
  /超过最大长度/,
  /exceed.*max.*tokens?/i,
  /max_tokens/i,
  /string_above_max_length/i
];

const TRANSPORT_PATTERNS = [
  /timeout/i,
  /timed? ?out/i,
  /econnreset/i,
  /econnrefused/i,
  /enotfound/i,
  /connection.?(reset|refused|closed|aborted)/i,
  /socket.?hang.?up/i,
  /network/i,
  /fetch failed/i,
  /连接超时/
];

const AUTH_PATTERNS = [
  /unauthorized/i,
  /invalid.?(api|auth).?key/i,
  /authentication/i,
  /forbidden/i,
  /access.?denied/i,
  /invalid.*token/i,
  /认证失败/
];

const MODEL_NOT_FOUND_PATTERNS = [
  /model.*not.*found/i,
  /model.*does.*not.*exist/i,
  /unknown.*model/i,
  /不支持.*模型/
];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(text));
}

function classify(reason: FailoverReason, message: string, status?: number): ClassifiedError {
  const base: ClassifiedError = {
    reason,
    retryable: false,
    shouldCompress: false,
    shouldRotateCredential: false,
    shouldFallback: false,
    originalMessage: message,
    httpStatus: status
  };

  switch (reason) {
    case FailoverReason.Auth:
      return { ...base, shouldRotateCredential: true, shouldFallback: true };
    case FailoverReason.Billing:
      return { ...base, shouldRotateCredential: true, shouldFallback: true };
    case FailoverReason.RateLimit:
      return { ...base, retryable: true };
    case FailoverReason.Overloaded:
      return { ...base, retryable: true, shouldFallback: true };
    case FailoverReason.ServerError:
      return { ...base, retryable: true };
    case FailoverReason.Timeout:
      return { ...base, retryable: true };
    case FailoverReason.ContextOverflow:
      return { ...base, shouldCompress: true };
    case FailoverReason.PayloadTooLarge:
      return { ...base, shouldCompress: true };
    case FailoverReason.ModelNotFound:
      return { ...base, shouldFallback: true };
    case FailoverReason.FormatError:
      return { ...base };
    case FailoverReason.Unknown:
      return { ...base, retryable: true };
  }
}

/**
 * Classify an API error for retry/failover decisions.
 *
 * Priority order (highest → lowest):
 *   1. HTTP status code   (most authoritative — server told us exactly what's wrong)
 *   2. Error code         (structured signal from response body)
 *   3. Billing patterns   (financial issues — must not retry blindly)
 *   4. Rate limit         (must back off)
 *   5. Context overflow   (must compress, not retry as-is)
 *   6. Auth patterns      (credential rotation — checked BEFORE transport so that
 *                          messages like "unauthorized: connection closed" classify
 *                          as Auth rather than Transport)
 *   7. Transport          (network — last meaningful pattern layer)
 *   8. Unknown            (fallback, retryable)
 */
export function classifyApiError(
  error: unknown,
  _provider?: string,
  _model?: string,
  _approxTokens?: number
): ClassifiedError {
  const { status, body, message } = extractErrorBody(error);
  const errorCode = body.error?.code || body.code || '';
  const errorMessage = body.error?.message || body.message || message;
  const combined = `${errorCode} ${errorMessage}`;

  // Layer 1: HTTP status code
  if (status !== undefined) {
    if (status === 401 || status === 403) {
      return classify(FailoverReason.Auth, message, status);
    }
    if (status === 402) {
      return classify(FailoverReason.Billing, message, status);
    }
    if (status === 429) {
      return classify(FailoverReason.RateLimit, message, status);
    }
    if (status === 413) {
      return classify(FailoverReason.PayloadTooLarge, message, status);
    }
    if (status === 404) {
      if (matchesAny(combined, MODEL_NOT_FOUND_PATTERNS)) {
        return classify(FailoverReason.ModelNotFound, message, status);
      }
    }
    if (status === 400) {
      if (matchesAny(combined, CONTEXT_OVERFLOW_PATTERNS)) {
        return classify(FailoverReason.ContextOverflow, message, status);
      }
      return classify(FailoverReason.FormatError, message, status);
    }
    if (status === 422) {
      return classify(FailoverReason.FormatError, message, status);
    }
    if (status === 529 || status === 503) {
      return classify(FailoverReason.Overloaded, message, status);
    }
    if (status >= 500) {
      return classify(FailoverReason.ServerError, message, status);
    }
  }

  // Layer 2: Error code from body
  if (errorCode) {
    if (errorCode === 'insufficient_quota' || errorCode === 'billing_hard_limit_reached') {
      return classify(FailoverReason.Billing, message, status);
    }
    if (errorCode === 'rate_limit_exceeded') {
      return classify(FailoverReason.RateLimit, message, status);
    }
    if (errorCode === 'context_length_exceeded' || errorCode === 'string_above_max_length') {
      return classify(FailoverReason.ContextOverflow, message, status);
    }
    if (errorCode === 'model_not_found') {
      return classify(FailoverReason.ModelNotFound, message, status);
    }
    if (errorCode === 'invalid_api_key') {
      return classify(FailoverReason.Auth, message, status);
    }
  }

  // Layer 3: Billing patterns
  if (matchesAny(combined, BILLING_PATTERNS)) {
    return classify(FailoverReason.Billing, message, status);
  }

  // Layer 4: Rate limit patterns
  if (matchesAny(combined, RATE_LIMIT_PATTERNS)) {
    return classify(FailoverReason.RateLimit, message, status);
  }

  // Layer 5: Context overflow patterns
  if (matchesAny(combined, CONTEXT_OVERFLOW_PATTERNS)) {
    return classify(FailoverReason.ContextOverflow, message, status);
  }

  // Layer 6: Auth patterns (checked BEFORE transport — see priority docstring)
  if (matchesAny(combined, AUTH_PATTERNS)) {
    return classify(FailoverReason.Auth, message, status);
  }

  // Layer 7: Transport errors
  if (matchesAny(combined, TRANSPORT_PATTERNS)) {
    return classify(FailoverReason.Timeout, message, status);
  }

  // Layer 8: Fallback — unknown, retryable
  return classify(FailoverReason.Unknown, message, status);
}
