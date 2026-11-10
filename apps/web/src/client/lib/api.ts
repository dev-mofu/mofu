import {
  BYOK_HEADER,
  parseApiError,
  type ApiError,
  type KeyCheckResponse,
  type PublicConfig,
  type SessionResponse,
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
