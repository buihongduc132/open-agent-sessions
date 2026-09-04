/**
 * PII redaction + cmd_signature derivation (OT30 rank5 GDPR).
 *
 * Resolves:
 *   OT30 (a): ingestion-stage regex redaction on write
 *   OT30 (b): cmd_signature = PII-free sha256 hash of redacted cmd
 *
 * @file src/parse/pii.ts
 */

/** Redact PII from a shell command string. Returns cmd with PII replaced. */
export function redact(cmd: string): string {
  if (!cmd) return cmd;
  let r = cmd;

  // 1. Bearer tokens: Authorization: Bearer <token> or -H 'Authorization: Bearer X'
  r = r.replace(
    /[Bb]earer\s+[A-Za-z0-9._\-]+/g,
    "Bearer [REDACTED:token]",
  );

  // 2. AWS access keys: AKIA followed by 16 uppercase alphanumeric
  r = r.replace(
    /AKIA[0-9A-Z]{16}/g,
    "[REDACTED:aws_key]",
  );

  // 3. git+https user:password URLs: https://user:pw@host
  r = r.replace(
    /https?:\/\/[^:/@\s]+:[^:/@\s]+@/g,
    "https://[REDACTED:git_creds]@",
  );

  // 4. sshpass -p <pw> (quote-aware: handles 'pw', "pw", pw)
  r = r.replace(
    /sshpass\s+-p\s+(?:'[^']*'|"[^"]*"|[^\s]+)/g,
    "sshpass -p [REDACTED:sshpass]",
  );

  // 5. env assigns matching *TOKEN*|*KEY*|*SECRET*|*PASSWORD* (case-insensitive)
  //    Shapes: VAR=value, export VAR=value, VAR=value cmd
  //    Value can be quoted, unquoted (until whitespace), or backtick-quoted.
  //    Var name may END with or CONTAIN the PII keyword (TOKEN alone, FOO_TOKEN,
  //    TOKEN_SECRET all match).
  //    Lookahead ensures var name CONTAINS one of the PII keywords.
  //    Skip if value already redacted (e.g. AWS_KEY=[REDACTED:aws_key] from step 2).
  const piiVarRe =
    /(\b(?:export\s+)?(?=[A-Za-z_]?[A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD))[A-Za-z_][A-Za-z0-9_]*\s*=\s*)(?!\[REDACTED:)(?:'[^']*'|"[^"]*"|`[^`]*`|[^\s;&|]+)/gi;

  r = r.replace(piiVarRe, (match: string, prefix: string) => {
    const upper = match.toUpperCase();
    let tag = "env_secret";
    if (upper.includes("TOKEN")) tag = "env_token";
    else if (upper.includes("PASSWORD")) tag = "env_password";
    else if (upper.includes("KEY")) tag = "env_key";
    else if (upper.includes("SECRET")) tag = "env_secret";
    return `${prefix}[REDACTED:${tag}]`;
  });

  // 6. Credit-card patterns: 13-16 consecutive digits (avoid matching integers < 13 digits)
  //    Use word boundaries to avoid mangling long timestamps/git-hashes.
  r = r.replace(
    /\b\d{13,16}\b/g,
    "[REDACTED:cc]",
  );

  return r;
}

/**
 * Compute cmd_signature = sha256(redact(cmd))[:32].
 *
 * PII-free because redact() runs first. Stable across re-ingest.
 */
export function computeSignature(cmd: string): string {
  const { createHash } = require("node:crypto");
  const redacted = redact(cmd);
  return createHash("sha256").update(redacted).digest("hex").slice(0, 32);
}
