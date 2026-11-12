import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  auditSolidity,
  bip39Checksum,
  blankCommentsAndStrings,
  execProgram,
  extractJson,
  findSeedPhrases,
  githubReviewPayload,
  isPrivateKeyHex,
  parseDiff,
  redact,
  scanSecrets,
  scanText,
  validateReview,
} from "../src/index.js";

// Fake secrets are assembled at runtime so this file doesn't trip `mofu secrets` itself.
const hex = (n: number) => randomBytes(n).toString("hex");
const GH = "gh" + "p_" + "A1b2C3d4".repeat(4) + "Zz9Y";
const OPENROUTER = "sk-" + "or-v1-" + hex(32);

describe("secret rules", () => {
  it("finds tokens with a known format and hides most of the value", () => {
    const pk = hex(32);
    const text = [
      `const token = "${GH}";`,
      `OPENROUTER_API_KEY=${OPENROUTER}`,
      `const PRIVATE_KEY = "0x${pk}";`,
      `const wallet = new ethers.Wallet("${pk}");`,
      "-----BEGIN OPENSSH " + "PRIVATE KEY-----",
      `const hash = "0x${hex(32)}"; // a tx hash, not a key`,
    ].join("\n");
    const hits = scanText(text);
    const rules = hits.map((h) => `${h.rule}@${h.line}`);
    expect(rules).toEqual(
      expect.arrayContaining([
        "github-token@1",
        "openrouter-key@2",
        "eth-private-key@3",
        "eth-private-key@4",
        "pem-private-key@5",
      ]),
    );
    expect(rules.some((r) => r.endsWith("@6"))).toBe(false);
    const gh = hits.find((h) => h.rule === "github-token")!;
    expect(gh.preview).toBe(`${GH.slice(0, 4)}…${GH.slice(-4)}`);
    expect(gh.preview).not.toContain(GH.slice(6, 20));
  });

  it("skips lines marked to ignore, placeholders and public test keys", () => {
    expect(scanText(`token = "${GH}" // mofu-secrets: ignore`)).toEqual([]);
    expect(scanText(`api_key = "your_api_key_here_xxxxxxxxxxxxxxxx"`)).toEqual([]);
    const hardhat = scanText(
      `PRIVATE_KEY=0x${"ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"}`,
    );
    expect(hardhat[0]).toMatchObject({ severity: "low", title: expect.stringContaining("test") });
  });

  it("checks private keys against the curve order", () => {
    expect(isPrivateKeyHex("0".repeat(64))).toBe(false);
    expect(isPrivateKeyHex("f".repeat(64))).toBe(false);
    expect(isPrivateKeyHex(`0x${"1".repeat(63)}2`)).toBe(true);
    expect(redact("short")).toBe("sh…");
  });
});

describe("seed phrases", () => {
  // BIP39 test vectors (public).
  const valid = "legal winner thank year wave sausage worth useful legal winner thank yellow"; // mofu-secrets: ignore
  const zoo = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong"; // mofu-secrets: ignore

  it("verifies the BIP39 checksum", () => {
    expect(bip39Checksum(valid.split(" "))).toBe(true);
    expect(bip39Checksum(zoo.split(" "))).toBe(true);
    expect(bip39Checksum([...valid.split(" ").slice(0, 11), "zoo"])).toBe(false);
    expect(bip39Checksum(["legal", "winner"])).toBe(false);
  });

  it("finds a phrase in text, including numbered lists, and rates it", () => {
    const found = findSeedPhrases(`MNEMONIC="${valid}"`);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ checksum: true, knownTest: false });
    const listed = valid
      .split(" ")
      .map((w, i) => `${i + 1}. ${w}`)
      .join("\n");
    expect(findSeedPhrases(listed)[0]?.checksum).toBe(true);
    expect(
      findSeedPhrases("This is a normal sentence about the weather and nothing else at all."),
    ).toEqual([]);
    const hit = scanText(`seed: ${valid}`).find((h) => h.rule === "seed-phrase")!;
    expect(hit).toMatchObject({ severity: "critical", preview: "legal … yellow (12 words)" });
  });
});

describe("scanSecrets on a repository", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it("finds a secret still in the files and one only left in history", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mofu-secrets-"));
    dirs.push(dir);
    const g = (...args: string[]) => execProgram("git", args, dir);
    await g("init", "-q");
    await g("config", "user.email", "t@example.com");
    await g("config", "user.name", "t");
    await g("config", "commit.gpgsign", "false");
    const pk = hex(32);
    await writeFile(path.join(dir, "deploy.js"), `const PRIVATE_KEY = "0x${pk}";\n`);
    await writeFile(path.join(dir, ".env"), `GITHUB_TOKEN=${GH}\n`);
    await g("add", "-A");
    await g("commit", "-qm", "one");
    await g("rm", "-q", ".env");
    await g("commit", "-qm", "two");
    const r = await scanSecrets(dir);
    expect(r.historyScanned).toBe(true);
    expect(r.commitsScanned).toBe(2);
    const key = r.findings.find((f) => f.rule === "eth-private-key")!;
    expect(key.inFiles).toEqual([{ file: "deploy.js", line: 1 }]);
    expect(key.firstCommit?.file).toBe("deploy.js");
    const token = r.findings.find((f) => f.rule === "github-token")!;
    expect(token.inFiles).toEqual([]);
    expect(token.firstCommit?.file).toBe(".env");
    expect(token.note).toContain("still in git history");
    const filesOnly = await scanSecrets(dir, { history: false });
    expect(filesOnly.findings.some((f) => f.rule === "github-token")).toBe(false);
  });
});

describe("audit", () => {
  const trap = `
pragma solidity ^0.8.20;
contract Trap is ERC20, Ownable {
    mapping(address => bool) public isBot;
    uint256 public sellTax = 5;
    address public pair;
    // function fake() { _mint(msg.sender, 1); }  <- a comment, not code
    constructor() ERC20("Trap", "TRAP") { _mint(msg.sender, 1e27); }
    function mint(address to, uint256 a) external onlyOwner { _mint(to, a); }
    function setBots(address a, bool v) external onlyOwner { isBot[a] = v; }
    function setSellTax(uint256 t) external onlyOwner { sellTax = t; }
    function setCappedFee(uint256 t) external onlyOwner { require(t <= 10, "max"); sellTax = t; }
    function _update(address f, address t, uint256 v) internal override {
        require(!isBot[f]);
        if (t == pair) require(f == owner(), "no sells");
        super._update(f, t, v);
    }
    function claim() external { require(tx.origin == owner()); payable(msg.sender).call{value: 1}(""); }
    mapping(address => uint256) credit;
    function withdraw() external {
        (bool ok, ) = msg.sender.call{value: credit[msg.sender]}("");
        require(ok);
        credit[msg.sender] = 0;
    }
    function setBalance(address a, uint256 v) external onlyOwner { _balances[a] = v; }
}`;

  it("predicts the scanner's flags with line numbers", () => {
    const r = auditSolidity("Trap.sol", trap);
    const status = Object.fromEntries(r.checks.map((c) => [c.id, c.status]));
    expect(status).toMatchObject({
      mint: "risk",
      blacklist: "risk",
      fees: "risk",
      sells: "warn",
      balances: "risk",
      pause: "ok",
      destroy: "ok",
      owner: "info",
    });
    expect(r.verdict).toBe("risky");
    expect(r.checks.find((c) => c.id === "mint")!.lines).toEqual([9]);
    expect(r.checks.find((c) => c.id === "fees")!.detail).toContain("setSellTax()");
    const issues = r.issues.map((i) => `${i.id}@${i.line}`);
    expect(issues).toEqual(
      expect.arrayContaining([
        "tx-origin@18",
        "unchecked-call@18",
        "reentrancy@21",
        "floating-pragma@2",
      ]),
    );
  });

  it("calls a fixed-supply token clean and ignores comments and strings", () => {
    const clean = `pragma solidity 0.8.24;
// _mint(owner, 1) in a comment and "selfdestruct(" in a string don't count
contract Clean is ERC20 {
    string constant NOTE = "selfdestruct(x); tx.origin";
    constructor() ERC20("Clean", "CLN") { _mint(msg.sender, 1e24); }
}`;
    const r = auditSolidity("Clean.sol", clean);
    expect(r.verdict).toBe("clean");
    expect(r.issues).toEqual([]);
    expect(blankCommentsAndStrings('a = "x"; // y').trimEnd()).toBe('a = " ";');
  });

  it("flags old compilers", () => {
    const r = auditSolidity("Old.sol", "pragma solidity ^0.6.12;\ncontract A {}");
    expect(r.issues[0]).toMatchObject({ id: "old-compiler", severity: "medium" });
  });
});

describe("review", () => {
  const diff = `diff --git a/pay.js b/pay.js
--- a/pay.js
+++ b/pay.js
@@ -1,3 +1,4 @@
 function split(total, list) {
-  for (let i = 0; i < list.length; i++) {
+  for (let i = 0; i <= list.length; i++) {
+    log(i);
     pay(list[i]);
`;

  it("knows which new-side lines are in the diff", () => {
    const [f] = parseDiff(diff);
    expect(f!.path).toBe("pay.js");
    expect([...f!.added]).toEqual([2, 3]);
    expect([...f!.lines].sort()).toEqual([1, 2, 3, 4]);
  });

  it("keeps findings on changed lines inline and moves the rest to the summary", () => {
    const answer = extractJson(
      'Here you go:\n```json\n{"summary":"Off by one.","findings":[' +
        '{"file":"pay.js","line":2,"severity":"bug","title":"Off by one","body":"<= reads past the end.","suggestion":"for (let i = 0; i < list.length; i++) {"},' +
        '{"file":"pay.js","line":40,"severity":"nit","title":"Far away","body":"x"},' +
        '{"file":"other.js","line":1,"severity":"bug","title":"Not in diff","body":"x"}]}\n```',
    );
    const r = validateReview(answer, parseDiff(diff));
    expect(r.findings.map((f) => [f.title, f.onDiff])).toEqual([
      ["Off by one", true],
      ["Far away", false],
    ]);
    expect(r.dropped).toBe(1);
    const payload = githubReviewPayload(r, "abc123");
    expect(payload.comments).toEqual([
      { path: "pay.js", line: 2, side: "RIGHT", body: expect.stringContaining("```suggestion") },
    ]);
    expect(payload.body).toContain("<!-- mofu-review -->");
    expect(payload.body).toContain("pay.js:40");
    expect(() => validateReview({ summary: 1 }, [])).toThrow();
  });
});

describe("commit and pull request writer", () => {
  it("parses a commit message and keeps the subject to one clean line", async () => {
    const { parseCommitMessage, commitText, parsePullRequest } = await import("../src/index.js");
    const c = parseCommitMessage(
      '```json\n{"subject": "Fix the split loop bound.\nextra", "body": "It read one past the end."}\n```',
    );
    expect(c).toEqual({ subject: "Fix the split loop bound", body: "It read one past the end." });
    expect(commitText(c)).toBe("Fix the split loop bound\n\nIt read one past the end.");
    expect(commitText({ subject: "Bump version", body: "" })).toBe("Bump version");
    const long = parseCommitMessage(JSON.stringify({ subject: "x".repeat(100) }));
    expect(long.subject).toHaveLength(72);
    const pr = parsePullRequest('{"title": "Add split()", "body": "## Summary\nAdds it."}');
    expect(pr).toEqual({ title: "Add split()", body: "## Summary\nAdds it." });
    expect(() => parseCommitMessage("no json here")).toThrow();
  });
});

describe("scanFiles (browser and MCP)", () => {
  it("scans given text and flags secret file names", async () => {
    const { scanFiles } = await import("../src/index.js");
    const found = scanFiles([
      { path: String.raw`src\config.js`, content: `const t = "${GH}";` },
      { path: ".env.production", content: "" },
      { path: ".env.example", content: "" },
    ]);
    expect(found.map((f) => `${f.rule}:${f.file}`).sort()).toEqual([
      "github-token:src/config.js",
      "secret-file:.env.production",
    ]);
  });
});
