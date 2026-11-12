/**
 * A trading agent skeleton that asks Mofu before every buy.
 *
 *   node agent.ts 0xTOKEN [0xTOKEN…]
 *
 * Plug your own idea into `findCandidates` and your own wallet code into `executeBuy`. The check
 * lives in `buy()`, so no strategy (and no AI model calling it as a tool) can skip it.
 * Out of the box it's a dry run: nothing is signed and nothing is sent.
 */
import { checkBeforeBuy, DEFAULT_POLICY, type Policy } from "./mofu.ts";
import { isPaused } from "./paused.ts";

const POLICY: Policy = { ...DEFAULT_POLICY };
const BUY_ETH = "0.001";

/** Your strategy: which tokens look interesting. Here: the addresses given on the command line. */
async function findCandidates(): Promise<string[]> {
  return process.argv.slice(2).filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
}

/**
 * Your execution: swap ETH for the token with your own wallet library (viem, ethers…).
 * Keep keys out of this repo: read them from the environment or a signer you trust.
 */
async function executeBuy(token: string, amountEth: string): Promise<void> {
  console.log(`  [dry run] would buy ${amountEth} ETH of ${token}`);
}

export async function buy(token: string, amountEth: string): Promise<boolean> {
  const paused = isPaused(token);
  if (paused) {
    console.log(`  skip ${token}: paused by a Mofu webhook (${paused.reason})`);
    return false;
  }
  const d = await checkBeforeBuy(token, POLICY);
  const name = d.report?.token.symbol ? `$${d.report.token.symbol}` : token;
  if (!d.allowed) {
    console.log(`  skip ${name}:`);
    for (const r of d.reasons) console.log(`    - ${r}`);
    return false;
  }
  console.log(`  ok ${name}: verdict ${d.report!.verdict}, sell test passed`);
  await executeBuy(token, amountEth);
  return true;
}

async function main() {
  const candidates = await findCandidates();
  if (candidates.length === 0) {
    console.log("Usage: node agent.ts 0xTOKEN [0xTOKEN…]");
    process.exitCode = 1;
    return;
  }
  for (const token of candidates) {
    console.log(`Checking ${token}…`);
    await buy(token, BUY_ETH);
  }
}

if (process.argv[1]?.endsWith("agent.ts")) {
  await main();
}
