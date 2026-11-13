/**
 * Function names for 4-byte selectors, and the functions a contract's dispatcher really routes.
 * Used to name what a token can do beyond a plain token, and what an upgrade added or removed.
 */
import { keccak_256 } from "@noble/hashes/sha3.js";

const sel = (signature: string) =>
  Array.from(keccak_256(new TextEncoder().encode(signature)).subarray(0, 4), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

/** A plain token and the usual harmless extensions: not worth listing. */
const STANDARD_SIGNATURES = [
  // ERC-20
  "name()",
  "symbol()",
  "decimals()",
  "totalSupply()",
  "balanceOf(address)",
  "transfer(address,uint256)",
  "transferFrom(address,address,uint256)",
  "approve(address,uint256)",
  "allowance(address,address)",
  "increaseAllowance(address,uint256)",
  "decreaseAllowance(address,uint256)",
  // burn, permit, ERC-165, votes, multicall
  "burn(uint256)",
  "burnFrom(address,uint256)",
  "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)",
  "nonces(address)",
  "DOMAIN_SEPARATOR()",
  "eip712Domain()",
  "supportsInterface(bytes4)",
  "delegate(address)",
  "delegates(address)",
  "getVotes(address)",
  "getPastVotes(address,uint256)",
  "getPastTotalSupply(uint256)",
  "checkpoints(address,uint32)",
  "numCheckpoints(address)",
  "clock()",
  "CLOCK_MODE()",
  "multicall(bytes[])",
  // ownership reads
  "owner()",
  "getOwner()",
  "pendingOwner()",
];

/** Functions worth naming when a token has them (owner powers, fees, limits, upgrades, …). */
const NOTABLE_SIGNATURES = [
  "mint(address,uint256)",
  "mint(uint256)",
  "mintTo(address,uint256)",
  "issue(uint256)",
  "pause()",
  "unpause()",
  "paused()",
  "setPaused(bool)",
  "blacklist(address)",
  "blacklist(address,bool)",
  "addToBlacklist(address)",
  "setBlacklist(address,bool)",
  "isBlacklisted(address)",
  "setBot(address,bool)",
  "setBots(address[],bool)",
  "addBots(address[])",
  "freeze(address)",
  "freezeAccount(address,bool)",
  "setFee(uint256)",
  "setFees(uint256,uint256)",
  "setTaxFee(uint256)",
  "setTax(uint256)",
  "setBuyFee(uint256)",
  "setSellFee(uint256)",
  "setBuyTax(uint256)",
  "setSellTax(uint256)",
  "updateFees(uint256,uint256)",
  "setTransferFee(uint256)",
  "excludeFromFee(address)",
  "includeInFee(address)",
  "isExcludedFromFee(address)",
  "setMarketingWallet(address)",
  "setTaxWallet(address)",
  "setFeeReceiver(address)",
  "setMaxTxAmount(uint256)",
  "setMaxWallet(uint256)",
  "setMaxWalletSize(uint256)",
  "removeLimits()",
  "enableTrading()",
  "openTrading()",
  "startTrading()",
  "setTradingEnabled(bool)",
  "tradingEnabled()",
  "setSwapTokensAtAmount(uint256)",
  "manualSwap()",
  "manualSend()",
  "rescueTokens(address,uint256)",
  "rescueETH()",
  "withdraw()",
  "withdrawStuckTokens(address)",
  "airdrop(address[],uint256[])",
  "upgradeTo(address)",
  "upgradeToAndCall(address,bytes)",
  "proxiableUUID()",
  "implementation()",
  "transferOwnership(address)",
  "renounceOwnership()",
  "acceptOwnership()",
  "grantRole(bytes32,address)",
  "revokeRole(bytes32,address)",
  "renounceRole(bytes32,address)",
  "hasRole(bytes32,address)",
  "getRoleAdmin(bytes32)",
  "DEFAULT_ADMIN_ROLE()",
  "MINTER_ROLE()",
  "setRouter(address)",
  "setPair(address)",
  "uniswapV2Router()",
  "uniswapV2Pair()",
  "setAutomatedMarketMakerPair(address,bool)",
  "setBalance(address,uint256)",
  "setAllowance(address,address,uint256)",
  "selfdestruct()",
  "kill()",
];

const NAMES = new Map<string, string>();
const STANDARD = new Set<string>();
for (const s of STANDARD_SIGNATURES) {
  NAMES.set(sel(s), s);
  STANDARD.add(sel(s));
}
for (const s of NOTABLE_SIGNATURES) NAMES.set(sel(s), s);

/** The name of a selector Mofu knows, or null. */
export const nameOf = (selector: string) =>
  NAMES.get(selector.replace(/^0x/, "").toLowerCase()) ?? null;
export const isStandard = (selector: string) =>
  STANDARD.has(selector.replace(/^0x/, "").toLowerCase());

/**
 * The selectors a contract's dispatcher compares the call data against: PUSH4 followed by EQ
 * (or by DUP/SWAP and then EQ, as some compilers lay it out). Error selectors and constants are
 * PUSH4s too, but they aren't compared with EQ this way, so they stay out.
 */
export function dispatcherSelectors(codeHex: string): string[] {
  const h = codeHex.replace(/^0x/, "");
  const code = new Uint8Array(h.length / 2);
  for (let i = 0; i < code.length; i++) code[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  // Leave out the metadata tail (CBOR), which can contain any byte.
  const len = code.length >= 2 ? (code[code.length - 2]! << 8) | code[code.length - 1]! : 0;
  const end = len > 0 && len + 2 < code.length ? code.length - 2 - len : code.length;
  const out = new Set<string>();
  for (let i = 0; i < end; i++) {
    const op = code[i]!;
    if (op >= 0x60 && op <= 0x7f) {
      const n = op - 0x5f;
      if (n === 4 && i + 5 < end) {
        const next = code[i + 5]!;
        const after = code[i + 6];
        const isEq = next === 0x14 || (next >= 0x80 && next <= 0x9f && after === 0x14);
        if (isEq)
          out.add(
            Array.from(code.subarray(i + 1, i + 5), (b) => b.toString(16).padStart(2, "0")).join(
              "",
            ),
          );
      }
      i += n;
    }
  }
  // 0x00000000 and 0xffffffff show up as comparisons that aren't functions.
  out.delete("00000000");
  out.delete("ffffffff");
  return [...out].sort();
}

/** Owner powers that matter most, listed first. */
const POWER =
  /^(mint|issue|pause|unpause|setPaused|blacklist|addToBlacklist|setBlacklist|setBot|addBots|freeze|setFee|setFees|setTax|setBuy|setSell|updateFees|setMax|removeLimits|enableTrading|openTrading|upgradeTo|setBalance|setAllowance|withdraw|rescue|airdrop)/;

/** Selectors beyond a plain token: the named ones (owner powers first), and the unnamed ones. */
export function customFunctions(selectors: string[]): { named: string[]; unknown: string[] } {
  const extra = selectors.filter((s) => !isStandard(s));
  return {
    named: extra
      .map(nameOf)
      .filter((n): n is string => !!n)
      .sort((x, y) => Number(POWER.test(y)) - Number(POWER.test(x)) || x.localeCompare(y)),
    unknown: extra.filter((s) => !nameOf(s)).map((s) => `0x${s}`),
  };
}
