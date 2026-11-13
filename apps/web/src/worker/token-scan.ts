/**
 * Token Scanner: reads a contract straight from Robinhood Chain and reports what it can do.
 * Everything here is deterministic code (bytecode and storage reads); no model is involved.
 *
 * Function detection looks for the 4-byte selectors of well-known function signatures in the
 * contract's dispatcher. A contract that renames these functions won't be caught, which the
 * report says plainly.
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import type { TokenCheck, TokenScanReport } from "../shared/api.js";
import { ethCall, RevertError, rpcCall } from "./chain.js";
import { tokenOrigin, topHolders, type ChainDataOptions } from "./chain-data.js";
import { codeFingerprint } from "./fingerprint.js";
import { liquidityCheck, readLiquidity } from "./liquidity.js";
import { sellTest } from "./sell-test.js";

export const CHAIN_NAME = "Robinhood Chain";

const ZERO = "0x0000000000000000000000000000000000000000";
const BURN_ADDRESSES = [ZERO, "0x000000000000000000000000000000000000dead"];
/** EIP-1967 slots: implementation and beacon. */
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export function selector(signature: string): string {
  return hex(keccak_256(new TextEncoder().encode(signature)).subarray(0, 4));
}

const GROUPS = {
  mint: [
    "mint(address,uint256)",
    "mint(uint256)",
    "mintTo(address,uint256)",
    "issue(uint256)",
    "mint(address,uint256,bytes)",
  ],
  pause: ["pause()", "unpause()", "setPaused(bool)", "pauseTransfers()", "setPause(bool)"],
  blacklist: [
    "blacklist(address)",
    "blacklist(address,bool)",
    "addToBlacklist(address)",
    "addBlacklist(address)",
    "setBlacklist(address,bool)",
    "updateBlacklist(address,bool)",
    "blacklistAddress(address,bool)",
    "setBot(address,bool)",
    "setBots(address[],bool)",
    "addBots(address[])",
    "blockAddress(address)",
    "freeze(address)",
    "freezeAccount(address,bool)",
    "setIsBlacklisted(address,bool)",
  ],
  fees: [
    "setFee(uint256)",
    "setFees(uint256,uint256)",
    "setTaxFee(uint256)",
    "setTax(uint256)",
    "setTaxes(uint256,uint256)",
    "setBuyFee(uint256)",
    "setSellFee(uint256)",
    "setBuyTax(uint256)",
    "setSellTax(uint256)",
    "updateFees(uint256,uint256)",
    "updateBuyFees(uint256,uint256,uint256)",
    "updateSellFees(uint256,uint256,uint256)",
    "setTransferFee(uint256)",
  ],
  limits: [
    "setMaxTxAmount(uint256)",
    "setMaxTx(uint256)",
    "setMaxWallet(uint256)",
    "setMaxWalletSize(uint256)",
    "setMaxWalletAmount(uint256)",
    "removeLimits()",
    "enableTrading()",
    "openTrading()",
    "startTrading()",
    "setTradingEnabled(bool)",
    "setTrading(bool)",
  ],
  upgrade: ["upgradeTo(address)", "upgradeToAndCall(address,bytes)"],
  roles: ["hasRole(bytes32,address)", "grantRole(bytes32,address)"],
  ownable: ["owner()", "transferOwnership(address)", "renounceOwnership()"],
} as const;

type Group = keyof typeof GROUPS;
const SELECTORS: Record<Group, Set<string>> = Object.fromEntries(
  Object.entries(GROUPS).map(([k, sigs]) => [k, new Set(sigs.map(selector))]),
) as Record<Group, Set<string>>;

/** Runtime code minus the Solidity metadata (CBOR) tail, which can contain any byte. */
function stripMetadata(code: Uint8Array): Uint8Array {
  if (code.length < 4) return code;
  const len = (code[code.length - 2]! << 8) | code[code.length - 1]!;
  const start = code.length - 2 - len;
  if (len > 0 && start > 0 && code[start]! >= 0xa1 && code[start]! <= 0xa5) {
    return code.subarray(0, start);
  }
  return code;
}

export interface CodeFacts {
  selectors: Set<string>;
  selfdestruct: boolean;
  delegatecall: boolean;
  /** EIP-1167 minimal proxy target, when the code is one. */
  minimalProxyTarget: string | null;
}

/** Walks the bytecode, skipping PUSH data, collecting 3–4 byte pushes and notable opcodes. */
export function analyzeCode(codeHex: string): CodeFacts {
  const clean = codeHex.startsWith("0x") ? codeHex.slice(2) : codeHex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  const minimal = /^363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i.exec(clean);
  const code = stripMetadata(bytes);
  const selectors = new Set<string>();
  let selfdestruct = false;
  let delegatecall = false;
  for (let i = 0; i < code.length; i++) {
    const op = code[i]!;
    if (op >= 0x60 && op <= 0x7f) {
      const n = op - 0x5f;
      if (n === 4 || n === 3) {
        const data = code.subarray(i + 1, i + 1 + n);
        if (data.length === n) selectors.add(hex(n === 3 ? Uint8Array.of(0, ...data) : data));
      }
      i += n;
    } else if (op === 0xff) selfdestruct = true;
    else if (op === 0xf4) delegatecall = true;
  }
  return {
    selectors,
    selfdestruct,
    delegatecall,
    minimalProxyTarget: minimal ? `0x${minimal[1]!.toLowerCase()}` : null,
  };
}

const has = (facts: CodeFacts, group: Group) =>
  [...SELECTORS[group]].some((s) => facts.selectors.has(s));

/** Decodes an ABI string return value (or a bytes32 one, as some old tokens use). */
export function decodeString(result: string): string | null {
  const h = result.startsWith("0x") ? result.slice(2) : result;
  if (h.length < 64) return null;
  const toText = (hx: string) => {
    const b = new Uint8Array(hx.length / 2);
    for (let i = 0; i < b.length; i++) b[i] = Number.parseInt(hx.slice(i * 2, i * 2 + 2), 16);
    return new TextDecoder().decode(b).replace(/\0+$/, "");
  };
  try {
    if (h.length >= 128) {
      const offset = Number.parseInt(h.slice(0, 64), 16) * 2;
      const len = Number.parseInt(h.slice(offset, offset + 64), 16);
      if (len > 0 && len <= 200)
        return toText(h.slice(offset + 64, offset + 64 + len * 2)).slice(0, 80);
    }
    const s = toText(h.slice(0, 64));
    return s && /^[\x20-\x7e]+$/.test(s) ? s.slice(0, 80) : null;
  } catch {
    return null;
  }
}

const word = (result: string) => {
  const h = result.startsWith("0x") ? result.slice(2) : result;
  return h.length >= 64 ? BigInt(`0x${h.slice(0, 64)}`) : null;
};
const addressFromWord = (result: string) => {
  const h = result.startsWith("0x") ? result.slice(2) : result;
  return h.length >= 64 ? `0x${h.slice(24, 64).toLowerCase()}` : null;
};
const padAddress = (a: string) => a.toLowerCase().slice(2).padStart(64, "0");

/** eth_call that answers null instead of throwing when the function doesn't exist (reverts). */
async function tryCall(urls: readonly string[], to: string, data: string, fetchFn: typeof fetch) {
  try {
    const r = await ethCall(urls, to, data, fetchFn);
    return r && r !== "0x" ? r : null;
  } catch (err) {
    if (err instanceof RevertError) return null;
    throw err;
  }
}

const percent = (part: bigint, total: bigint) =>
  total > 0n ? Number((part * 1_000_000n) / total) / 10_000 : null;

export async function scanToken(
  urls: readonly string[],
  address: string,
  fetchFn: typeof fetch,
  /** GoldRush access for holders and origin; without it the report says they're unavailable. */
  data?: ChainDataOptions & { now: number },
): Promise<TokenScanReport> {
  const addr = address.toLowerCase();
  const code = await rpcCall<string>(urls, "eth_getCode", [addr, "latest"], fetchFn);
  // An EIP-7702 wallet has a delegation designator (0xef0100…) as code: a wallet, not a contract.
  const delegated = !!code && code.toLowerCase().startsWith("0xef0100");
  const codeSize = code && code !== "0x" && !delegated ? (code.length - 2) / 2 : 0;
  const base: Omit<TokenScanReport, "checks" | "verdict" | "distribution" | "origin"> = {
    address: addr,
    chainName: CHAIN_NAME,
    isContract: codeSize > 0,
    codeSize,
    token: { name: null, symbol: null, decimals: null, totalSupply: null },
    owner: { status: "none", address: null, holdsPercent: null },
    proxy: { kind: "none", implementation: null },
    burnedPercent: null,
    sellTest: null,
    lookalikes: [],
    fingerprint: codeSize > 0 ? await codeFingerprint(code) : null,
    codeMatch: null,
    limits: [
      "Checks look for common function names in the contract's code. A contract that hides or renames them can't be fully judged this way.",
      "Price and trading activity aren't part of this scan. Liquidity depth is measured only where a sell can be simulated.",
    ],
  };
  const noDistribution = {
    status: "unavailable" as const,
    top10Percent: null,
    largestWallet: null,
    holders: [],
  };
  if (codeSize === 0) {
    return {
      ...base,
      checks: [
        {
          id: "owner",
          label: "Is this a contract?",
          status: "risk",
          detail: `There is no contract at this address on ${CHAIN_NAME}. It's a regular wallet, or the address is wrong.`,
        },
      ],
      verdict: "risky",
      distribution: noDistribution,
      origin: null,
    };
  }

  let facts = analyzeCode(code);
  const own = analyzeCode(code);

  // Proxies: the logic lives elsewhere, so read and analyze the implementation as well.
  let implementation: string | null = facts.minimalProxyTarget;
  let proxyKind: TokenScanReport["proxy"]["kind"] = implementation ? "minimal" : "none";
  if (!implementation) {
    const slot = await rpcCall<string>(
      urls,
      "eth_getStorageAt",
      [addr, IMPL_SLOT, "latest"],
      fetchFn,
    ).catch(() => null);
    const impl = slot ? addressFromWord(slot) : null;
    if (impl && impl !== ZERO) {
      implementation = impl;
      proxyKind = "eip1967";
    } else {
      const bslot = await rpcCall<string>(
        urls,
        "eth_getStorageAt",
        [addr, BEACON_SLOT, "latest"],
        fetchFn,
      ).catch(() => null);
      const beacon = bslot ? addressFromWord(bslot) : null;
      if (beacon && beacon !== ZERO) {
        proxyKind = "beacon";
        const implRes = await tryCall(
          urls,
          beacon,
          `0x${selector("implementation()")}`,
          fetchFn,
        ).catch(() => null);
        implementation = implRes ? addressFromWord(implRes) : null;
      }
    }
  }
  if (implementation) {
    const implCode = await rpcCall<string>(
      urls,
      "eth_getCode",
      [implementation, "latest"],
      fetchFn,
    ).catch(() => "0x");
    const implFacts = analyzeCode(implCode);
    facts = {
      selectors: new Set([...facts.selectors, ...implFacts.selectors]),
      selfdestruct: facts.selfdestruct || implFacts.selfdestruct,
      delegatecall: true,
      minimalProxyTarget: facts.minimalProxyTarget,
    };
  }

  const call = (data: string) => tryCall(urls, addr, data, fetchFn).catch(() => null);
  const [nameR, symbolR, decimalsR, supplyR, ownerR, getOwnerR] = await Promise.all([
    call("0x06fdde03"),
    call("0x95d89b41"),
    call("0x313ce567"),
    call("0x18160ddd"),
    call("0x8da5cb5b"),
    call("0x893d20e8"),
  ]);
  const decimalsBig = decimalsR ? word(decimalsR) : null;
  const decimals = decimalsBig !== null && decimalsBig <= 36n ? Number(decimalsBig) : null;
  const supply = supplyR ? word(supplyR) : null;
  const unit = 10n ** BigInt(decimals ?? 18);
  const token = {
    name: nameR ? decodeString(nameR) : null,
    symbol: symbolR ? decodeString(symbolR) : null,
    decimals,
    totalSupply: supply !== null ? (supply / unit).toString() : null,
  };

  // Owner: owner() or getOwner(); zero or dead address means ownership was given up.
  const ownerAddr = ownerR
    ? addressFromWord(ownerR)
    : getOwnerR
      ? addressFromWord(getOwnerR)
      : null;
  let owner: TokenScanReport["owner"] = { status: "none", address: null, holdsPercent: null };
  if (ownerAddr) {
    if (BURN_ADDRESSES.includes(ownerAddr))
      owner = { status: "renounced", address: ownerAddr, holdsPercent: null };
    else {
      const bal = supply ? await call(`0x70a08231${padAddress(ownerAddr)}`) : null;
      owner = {
        status: "active",
        address: ownerAddr,
        holdsPercent: bal && supply ? percent(word(bal) ?? 0n, supply) : null,
      };
    }
  }

  let burnedPercent: number | null = null;
  if (supply && supply > 0n) {
    const burns = await Promise.all(BURN_ADDRESSES.map((b) => call(`0x70a08231${padAddress(b)}`)));
    const burned = burns.reduce((sum, r) => sum + (r ? (word(r) ?? 0n) : 0n), 0n);
    burnedPercent = percent(burned, supply);
  }

  const roles = has(facts, "roles");
  const controlled = owner.status === "active" || roles || proxyKind !== "none";
  const who =
    owner.status === "active"
      ? `the owner wallet (${owner.address})`
      : roles
        ? "wallets granted a role"
        : "an admin";
  const capability = (
    id: TokenCheck["id"],
    group: Group,
    label: string,
    found: string,
    clean: string,
  ): TokenCheck => {
    if (!has(facts, group)) return { id, label, status: "ok", detail: clean };
    return controlled
      ? { id, label, status: "risk", detail: `Yes. ${found} This can be done by ${who}.` }
      : {
          id,
          label,
          status: "warn",
          detail: `${found} There's no active owner, so it may be locked, but the function is still in the code.`,
        };
  };

  const checks: TokenCheck[] = [
    capability(
      "mint",
      "mint",
      "Can new tokens be created?",
      "The contract has a mint function, so the supply can grow.",
      "No mint function found. The supply looks fixed.",
    ),
    capability(
      "pause",
      "pause",
      "Can transfers be paused?",
      "The contract has a pause switch that can stop all transfers.",
      "No pause switch found.",
    ),
    capability(
      "blacklist",
      "blacklist",
      "Can wallets be blocked?",
      "The contract can block specific wallets from moving their tokens.",
      "No blacklist or wallet-blocking function found.",
    ),
    capability(
      "fees",
      "fees",
      "Can fees or taxes be changed?",
      "The contract has functions to set fees or taxes on transfers.",
      "No fee or tax settings found.",
    ),
    capability(
      "limits",
      "limits",
      "Can trading limits be set?",
      "The contract can set max transaction or wallet sizes, or switch trading on and off.",
      "No trading limits or trading switch found.",
    ),
    proxyKind !== "none" || has(facts, "upgrade")
      ? {
          id: "upgrade",
          label: "Can the code be changed?",
          status: "risk",
          detail:
            proxyKind !== "none"
              ? `Yes. This is an upgradeable proxy (${proxyKind === "eip1967" ? "EIP-1967" : proxyKind === "beacon" ? "beacon" : "minimal clone"}); its logic lives at ${implementation ?? "another address"} and can be swapped for new code.`
              : "Yes. The contract has an upgrade function, so its logic can be replaced.",
        }
      : {
          id: "upgrade",
          label: "Can the code be changed?",
          status: "ok",
          detail: "Not upgradeable. The code you see is the code that runs.",
        },
    owner.status === "active"
      ? {
          id: "owner",
          label: "Who controls the contract?",
          status: "warn",
          detail: `An owner wallet is set: ${owner.address}.${owner.holdsPercent !== null ? ` It holds ${owner.holdsPercent}% of the supply.` : ""}`,
        }
      : owner.status === "renounced"
        ? {
            id: "owner",
            label: "Who controls the contract?",
            status: "ok",
            detail: "Ownership was renounced. No wallet has owner powers.",
          }
        : roles
          ? {
              id: "owner",
              label: "Who controls the contract?",
              status: "warn",
              detail:
                "No single owner, but the contract uses roles: some wallets may have special powers.",
            }
          : {
              id: "owner",
              label: "Who controls the contract?",
              status: "ok",
              detail:
                "No owner function. Nobody has admin powers through the standard owner pattern.",
            },
    own.selfdestruct || facts.selfdestruct
      ? {
          id: "destroy",
          label: "Can the contract be destroyed?",
          status: "warn",
          detail:
            "The code contains SELFDESTRUCT. On current Ethereum rules it can no longer wipe a contract, but it's unusual in a token.",
        }
      : {
          id: "destroy",
          label: "Can the contract be destroyed?",
          status: "ok",
          detail: "No self-destruct instruction in the code.",
        },
  ];

  // Who holds the supply and who made the token (GoldRush). Failures just leave them out.
  let distribution: TokenScanReport["distribution"] = noDistribution;
  let origin: TokenScanReport["origin"] = null;
  if (data && supply !== null) {
    const [holders, from] = await Promise.all([
      topHolders(data, addr, 10).catch(() => null),
      tokenOrigin(data, addr, supply, decimals ?? 18, data.now).catch(() => null),
    ]);
    origin = from;
    if (holders && holders.length) {
      const real = holders.filter((h) => h.kind !== "burn");
      const largest = holders.find((h) => h.kind === "wallet") ?? null;
      distribution = {
        status: "full",
        top10Percent: Math.round(real.reduce((n, h) => n + h.percent, 0) * 100) / 100,
        largestWallet: largest ? { address: largest.address, percent: largest.percent } : null,
        holders,
      };
      const pools = holders.filter((h) => h.kind === "contract" && h.percent >= 5);
      const poolNote = pools.length
        ? ` Contracts hold ${pools.map((p) => `${Number(p.percent.toFixed(2))}%`).join(" and ")}: usually the liquidity pool or launch curve.`
        : "";
      const lw = Number((largest?.percent ?? 0).toFixed(2));
      checks.push(
        lw > 20
          ? {
              id: "concentration",
              label: "Does one wallet hold too much?",
              status: "risk",
              detail: `Yes. One wallet (${largest!.address}) holds ${lw}% of the supply and could move the market on its own.${poolNote}`,
            }
          : lw > 10
            ? {
                id: "concentration",
                label: "Does one wallet hold too much?",
                status: "warn",
                detail: `The biggest wallet (${largest!.address}) holds ${lw}% of the supply.${poolNote}`,
              }
            : {
                id: "concentration",
                label: "Does one wallet hold too much?",
                status: "ok",
                detail: `No wallet holds more than 10% (the biggest has ${lw}%).${poolNote}`,
              },
      );
    }
  }
  if (distribution.status === "unavailable")
    base.limits.push("Holder distribution couldn't be read right now.");

  // Can it be sold? A simulated buy and sell where it trades (needs the holder list to find it).
  let sold: TokenScanReport["sellTest"] = null;
  if (distribution.status === "full") {
    sold = await sellTest(urls, fetchFn, addr, distribution.holders, decimals ?? 18).catch(
      () => null,
    );
  }
  if (sold) {
    const worst = Math.max(sold.buyTaxPercent ?? 0, sold.sellTaxPercent ?? 0);
    checks.push({
      id: "sell",
      label: "Can you sell it?",
      status: sold.status === "failed" || worst >= 50 ? "risk" : worst >= 10 ? "warn" : "ok",
      detail: sold.detail,
    });
  } else if (distribution.status === "full") {
    base.limits.push(
      "No launch curve or pool was found among the top holders, so a buy and sell couldn't be simulated.",
    );
  }

  // Where the liquidity is, and whether a wallet can pull it.
  const liquidity =
    distribution.status === "full"
      ? await readLiquidity(urls, fetchFn, addr, {
          holders: distribution.holders,
          sold,
          origin,
          data,
        })
      : null;
  if (liquidity) checks.push(liquidityCheck(liquidity));

  const verdict = checks.some((c) => c.status === "risk")
    ? "risky"
    : checks.some((c) => c.status === "warn")
      ? "caution"
      : "clean";
  return {
    ...base,
    token,
    owner,
    proxy: { kind: proxyKind, implementation },
    burnedPercent,
    checks,
    verdict,
    distribution,
    origin,
    sellTest: sold,
    liquidity,
    // A proxy's own code is the shared proxy template, not the token: no fingerprint for it.
    fingerprint: proxyKind === "none" ? base.fingerprint : null,
  };
}

/** The free version of a report: holder summary only, no list and no origin. */
export function summaryOnly(r: TokenScanReport): TokenScanReport {
  if (r.distribution.status !== "full") return r;
  return {
    ...r,
    distribution: { ...r.distribution, status: "summary", holders: [] },
    origin: null,
  };
}
