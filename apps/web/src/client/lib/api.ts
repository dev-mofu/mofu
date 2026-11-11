import {
  BYOK_HEADER,
  parseApiError,
  type ApiError,
  type FetchedPageResponse,
  type HolderChallengeResponse,
  type HolderStatus,
  type KeyCheckResponse,
  type PublicConfig,
  type SessionResponse,
  type TokenScanResponse,
  type TxResponse,
  type VoteResponse,
  type UsageInfo,
} from "../../shared/api.js";

export class ApiRequestError extends Error {
  constructor(readonly error: ApiError) {
    super(error.message);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "same-origin", ...init });
  const text = await res.text();
  if (!res.ok) {
    throw new ApiRequestError(
      parseApiError(text) ?? {
        code: "server_error",
        message: "Something went wrong. Please try again.",
      },
    );
  }
  return JSON.parse(text) as T;
}

export const fetchConfig = () => request<PublicConfig>("/api/config");
export const fetchUsage = () => request<UsageInfo>("/api/usage");

export const createSession = (token: string) =>
  request<SessionResponse>("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });

export const checkKey = (key: string) =>
  request<KeyCheckResponse>("/api/key/check", { method: "POST", headers: { [BYOK_HEADER]: key } });

/** kind "document" returns raw JSON/YAML (an API spec) instead of readable page text. */
export const fetchPage = (url: string, kind: "page" | "document" = "page") =>
  request<FetchedPageResponse>("/api/fetch-page", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, kind }),
  });

export const holderChallenge = (address: string) =>
  request<HolderChallengeResponse>("/api/holder/challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address }),
  });

export const holderVerify = (challenge: string, signature: string) =>
  request<HolderStatus>("/api/holder/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ challenge, signature }),
  });

export const holderDisconnect = () =>
  request<{ ok: true }>("/api/holder/disconnect", { method: "POST" });

export const scanTokenAddress = (address: string) =>
  request<TokenScanResponse>("/api/token-scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address }),
  });

export const explainTx = (hash: string) =>
  request<TxResponse>("/api/tx", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hash }),
  });

export const fetchVote = () => request<VoteResponse>("/api/vote");

export const castVote = (option: string) =>
  request<VoteResponse>("/api/vote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ option }),
  });
