export { scanSecrets } from "./scan.js";
export { scanText, scanFiles, redact, IGNORE_MARKER } from "./text.js";
export type { FileFinding } from "./text.js";
export type { SecretFinding, SecretLocation, SecretsOptions, SecretsReport } from "./scan.js";
export { SECRET_RULES, SECRET_FILES, KNOWN_TEST_KEYS, isPrivateKeyHex } from "./patterns.js";
export type { SecretRule, SecretSeverity } from "./patterns.js";
export { bip39Checksum, findSeedPhrases, looksLikeWordlist } from "./seed.js";
export type { SeedMatch } from "./seed.js";
