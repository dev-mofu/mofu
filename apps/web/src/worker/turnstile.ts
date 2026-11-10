const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Asks Cloudflare whether a Turnstile token is genuine. */
export async function verifyTurnstile(
  secret: string,
  token: string,
  ip: string | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);
  try {
    const res = await fetchFn(VERIFY_URL, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { success?: unknown };
    return data.success === true;
  } catch {
    return false;
  }
}
