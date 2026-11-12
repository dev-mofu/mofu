/**
 * What `mofu secrets` looks for. Every rule matches a value whose format is specific enough to
 * be worth a look; generic high-entropy strings aren't flagged (too many false alarms).
 */

export type SecretSeverity = "critical" | "high" | "medium" | "low";

export interface SecretRule {
  id: string;
  title: string;
  severity: SecretSeverity;
  /** Must be global. The secret is capture group 1 when present, else the whole match. */
  pattern: RegExp;
  /** Extra check on the captured value; false drops the match. */
  valid?: (value: string) => boolean;
}

const notPlaceholder = (v: string) =>
  !/(x{4,}|your|example|sample|dummy|placeholder|changeme|<|\.\.\.|\*{3,})/i.test(v);

/** secp256k1 group order: a private key must be below it and above zero. */
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
export const isPrivateKeyHex = (hex: string) => {
  const h = hex.replace(/^0x/i, "");
  if (!/^[0-9a-f]{64}$/i.test(h) || /^(.)\1+$/.test(h)) return false;
  const n = BigInt(`0x${h}`);
  return n > 0n && n < N;
};

/**
 * Keys that ship with Hardhat, Anvil and Ganache docs. Public, so not a leak, but a wallet using
 * one on a real network is drained within seconds.
 */
export const KNOWN_TEST_KEYS = new Set([
  "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
]);

export const SECRET_RULES: SecretRule[] = [
  {
    id: "pem-private-key",
    title: "Private key (PEM)",
    severity: "critical",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    id: "eth-private-key",
    title: "Wallet private key",
    severity: "critical",
    // A 64-hex value next to a name that says what it is. Bare 64-hex strings are usually hashes.
    pattern:
      /\b(?:private[_-]?key|priv[_-]?key|secret[_-]?key|wallet[_-]?key|deployer[_-]?key|signer[_-]?key|owner[_-]?key|pk)\b["']?\s*[:=]\s*["'`]?((?:0x)?[0-9a-fA-F]{64})\b/gi,
    valid: isPrivateKeyHex,
  },
  {
    id: "eth-private-key",
    title: "Wallet private key",
    severity: "critical",
    pattern:
      /(?:new\s+(?:ethers\.)?Wallet|privateKeyToAccount|fromPrivateKey|SigningKey)\(\s*["'`]((?:0x)?[0-9a-fA-F]{64})["'`]/g,
    valid: isPrivateKeyHex,
  },
  {
    id: "openrouter-key",
    title: "OpenRouter API key",
    severity: "critical",
    pattern: /\bsk-or-v1-[0-9a-f]{64}\b/g,
  },
  {
    id: "anthropic-key",
    title: "Anthropic API key",
    severity: "critical",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{32,}/g,
  },
  {
    id: "openai-key",
    title: "OpenAI API key",
    severity: "critical",
    pattern: /\bsk-(?!or-|ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{40,}/g,
  },
  {
    id: "github-token",
    title: "GitHub token",
    severity: "critical",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,})\b/g,
  },
  {
    id: "npm-token",
    title: "npm access token",
    severity: "critical",
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/g,
  },
  {
    id: "stripe-key",
    title: "Stripe live key",
    severity: "critical",
    pattern: /\b(?:sk|rk)_live_[0-9a-zA-Z]{24,}\b/g,
  },
  {
    id: "aws-secret-key",
    title: "AWS secret access key",
    severity: "critical",
    pattern: /aws_secret_access_key["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})\b/gi,
  },
  {
    id: "aws-access-key",
    title: "AWS access key ID",
    severity: "high",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    id: "google-api-key",
    title: "Google API key",
    severity: "high",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    id: "slack-token",
    title: "Slack token",
    severity: "high",
    pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g,
  },
  {
    id: "telegram-bot-token",
    title: "Telegram bot token",
    severity: "high",
    pattern: /\b\d{8,10}:AA[0-9A-Za-z_-]{33}\b/g,
  },
  {
    id: "goldrush-key",
    title: "GoldRush (Covalent) API key",
    severity: "high",
    pattern: /\bcqt_[0-9A-Za-z]{26,}\b/g,
  },
  {
    id: "generic-api-key",
    title: "Possible API key or secret",
    severity: "medium",
    pattern:
      /\b(?:api[_-]?key|api[_-]?secret|access[_-]?token|auth[_-]?token|client[_-]?secret|secret)\b["']?\s*[:=]\s*["'`]([A-Za-z0-9_\-./+=]{24,})["'`]/gi,
    valid: (v) => notPlaceholder(v) && /[0-9]/.test(v) && /[A-Za-z]/.test(v),
  },
];

/** File names that are secrets by themselves when they're committed. */
export const SECRET_FILES: Array<{ pattern: RegExp; title: string; severity: SecretSeverity }> = [
  {
    pattern: /(^|\/)\.env(\.(?!example$|sample$|template$|dist$)[\w-]+)?$/i,
    title: "A .env file is committed",
    severity: "high",
  },
  {
    pattern: /(^|\/)\.dev\.vars$/i,
    title: "A Cloudflare .dev.vars file is committed",
    severity: "high",
  },
  {
    pattern: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i,
    title: "An SSH private key file is committed",
    severity: "critical",
  },
  {
    pattern: /\.(pem|p12|pfx|key)$/i,
    title: "A key or certificate file is committed",
    severity: "medium",
  },
];
