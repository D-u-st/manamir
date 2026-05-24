// Credential Redaction (P0-2B): strip API keys and secrets from error messages

const API_KEY_PREFIXES = [
  'sk-', 'sk-ant-', 'sk-proj-',
  'ak-', 'pk-',
  'key-', 'api-', 'token-',
  'ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_',
  'glpat-',
  'xoxb-', 'xoxp-', 'xapp-',
  'AKIA', 'ABIA', 'ACCA', 'ASIA',
  'eyJ', // JWT
  'npm_',
  'pypi-',
  'nuget',
  'shpat_', 'shpca_', 'shppa_',
  'sq0atp-', 'sq0csp-',
  'SG.',
  'hf_',
  'r8_',
  'sntrys_',
  'dop_v1_',
  'v2/',
  'Bearer ',
  'Basic '
];

const SECRET_PATTERNS: RegExp[] = [
  // Generic long hex/base64 strings that look like tokens
  /(?:key|token|secret|password|apikey|api_key|auth)["']?\s*[:=]\s*["']?([A-Za-z0-9+/=_-]{20,})["']?/gi,
  // AWS-style keys
  /AKIA[0-9A-Z]{16}/g,
  // JWTs
  /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g
];

function maskToken(token: string): string {
  if (token.length <= 12) {
    return '***REDACTED***';
  }
  return token.slice(0, 6) + '...' + token.slice(-4);
}

export function redactCredentials(text: string): string {
  let result = text;

  for (const prefix of API_KEY_PREFIXES) {
    if (prefix === 'Bearer ' || prefix === 'Basic ') {
      const re = new RegExp(`(${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})([A-Za-z0-9+/=_.-]{8,})`, 'g');
      result = result.replace(re, (_match, p: string, token: string) => p + maskToken(token));
      continue;
    }

    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(${escaped})([A-Za-z0-9+/=_.-]{8,})`, 'g');
    result = result.replace(re, (_match, p: string, token: string) => p + maskToken(token));
  }

  for (const pattern of SECRET_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    result = result.replace(re, (match) => {
      const eqIdx = match.search(/[:=]\s*["']?/);
      if (eqIdx >= 0) {
        const keyPart = match.slice(0, eqIdx + 1);
        return keyPart + ' ***REDACTED***';
      }
      return maskToken(match);
    });
  }

  return result;
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

export function normalizeUnicode(text: string): string {
  return text.normalize('NFKC');
}
