/**
 * The pino `redact` paths of the worker (S08 rule C1): order codes, wherever an outcome or an
 * attempt is logged, as one of a log object's keys up to three levels down. Codes are never
 * logged on purpose; this is the net under that rule.
 */
export const LOG_REDACT_PATHS = ['codes', '*.codes', '*.*.codes', '*.*.*.codes'];
