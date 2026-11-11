/**
 * A tiny server for petstore-v1.yaml, used by the runner tests and manual CLI
 * runs. One endpoint is deliberately broken: GET /store/inventory returns 500.
 * Any request with an `x-delay-ms` header is delayed (for timeout tests).
 *
 * Standalone: npx tsx packages/core/test/fixtures/api/server.ts  (PORT=4010)
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

export const API_KEY = "secret-test-key";

interface Pet {
  id: number;
  name: string;
  tag?: string;
  status?: string;
}

const STATUSES = ["available", "pending", "sold"];

function send(res: ServerResponse, status: number, body?: unknown) {
  res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

const error = (res: ServerResponse, status: number, message: string) =>
  send(res, status, { code: status, message });

async function readJson(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return Symbol.for("invalid");
  }
}

export function createPetServer(): Server {
  let pets: Pet[] = [
    { id: 1, name: "Rex", tag: "dog", status: "available" },
    { id: 2, name: "Tom", tag: "cat", status: "pending" },
  ];
  let nextId = 3;

  return createServer(async (req, res) => {
    const delay = Number(req.headers["x-delay-ms"] ?? 0);
    if (delay > 0) await new Promise((r) => setTimeout(r, Math.min(delay, 30_000)));
    const url = new URL(req.url ?? "/", "http://localhost");
    const authed = req.headers["x-api-key"] === API_KEY;
    const petMatch = url.pathname.match(/^\/pets\/([^/]+)$/);

    if (url.pathname === "/pets" && req.method === "GET") {
      const limitRaw = url.searchParams.get("limit");
      const limit = limitRaw === null ? 20 : Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        return error(res, 400, "limit must be an integer from 1 to 100");
      const status = url.searchParams.get("status");
      if (status !== null && !STATUSES.includes(status)) return error(res, 400, "unknown status");
      return send(res, 200, pets.filter((p) => !status || p.status === status).slice(0, limit));
    }
    if (url.pathname === "/pets" && req.method === "POST") {
      if (!authed) return error(res, 401, "missing or wrong API key");
      const body = (await readJson(req)) as Record<string, unknown> | undefined;
      if (!body || typeof body !== "object" || typeof body.name !== "string" || !body.name)
        return error(res, 400, "name is required");
      if (body.status !== undefined && !STATUSES.includes(String(body.status)))
        return error(res, 400, "unknown status");
      const pet: Pet = {
        id: nextId++,
        name: body.name,
        ...(typeof body.tag === "string" && { tag: body.tag }),
        ...(typeof body.status === "string" && { status: body.status }),
      };
      pets.push(pet);
      return send(res, 201, pet);
    }
    if (petMatch) {
      const id = Number(petMatch[1]);
      const pet = pets.find((p) => p.id === id);
      if (req.method === "GET") return pet ? send(res, 200, pet) : error(res, 404, "pet not found");
      if (req.method === "DELETE") {
        if (!authed) return error(res, 401, "missing or wrong API key");
        if (!pet) return error(res, 404, "pet not found");
        pets = pets.filter((p) => p.id !== id);
        return send(res, 204);
      }
    }
    if (url.pathname === "/store/inventory" && req.method === "GET") {
      // Deliberate bug for the demo: the inventory service is "down".
      return error(res, 500, "inventory service unavailable");
    }
    if (url.pathname === "/store/orders" && req.method === "POST") {
      const body = (await readJson(req)) as Record<string, unknown> | undefined;
      if (
        !body ||
        !Number.isInteger(body.petId) ||
        !Number.isInteger(body.quantity) ||
        (body.quantity as number) < 1
      ) {
        return error(res, 400, "petId and quantity (>= 1) are required integers");
      }
      return send(res, 200, { id: 100, petId: body.petId, quantity: body.quantity });
    }
    return error(res, 404, "no such route");
  });
}

/** Starts the server on a free port; returns its base URL and a close function. */
export async function startPetServer(
  port = 0,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createPetServer();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  const actual = typeof address === "object" && address ? address.port : port;
  return {
    url: `http://127.0.0.1:${actual}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { url } = await startPetServer(Number(process.env.PORT ?? 4010));
  console.log(`Petstore fixture listening on ${url} (API key: ${API_KEY})`);
}
