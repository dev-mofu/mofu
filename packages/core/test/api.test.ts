import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ApiWorkspace,
  checkCases,
  classifyTarget,
  diffSpecs,
  exampleFromSchema,
  formatDiffMarkdown,
  formatGroupForModel,
  formatIndexForModel,
  loadSpec,
  parseAuthHeader,
  parseSuiteJson,
  renderDocs,
  runSuite,
  toHttpFile,
  toSuiteJson,
  toVitestFile,
  trimSchema,
  type ApiIndex,
  type TestCase,
} from "../src/api/index.js";
import { API_KEY, startPetServer } from "./fixtures/api/server.js";

const fixture = (name: string) =>
  readFileSync(path.join(import.meta.dirname, "fixtures/api", name), "utf8");

async function index(name: string): Promise<ApiIndex> {
  const loaded = await loadSpec(fixture(name));
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.problems));
  return loaded.index;
}

const tc = (over: Partial<TestCase> & Pick<TestCase, "id" | "endpoint" | "method">): TestCase => ({
  category: "happy_path",
  description: "test",
  request: { pathParams: {}, query: {}, headers: {} },
  expect: { status: 200 },
  ...over,
});

describe("loading specs", () => {
  it("parses OpenAPI 3.0 YAML, 3.1 YAML and Swagger 2.0 JSON into one shape", async () => {
    const v30 = await index("petstore-v1.yaml");
    const v31 = await index("petstore-v2.yaml");
    const v20 = await index("petstore-swagger2.json");
    expect([v30.specVersion, v31.specVersion, v20.specVersion]).toEqual(["3.0.3", "3.1.0", "2.0"]);
    expect(v30.endpoints.map((e) => e.key)).toEqual([
      "GET /pets",
      "POST /pets",
      "GET /pets/{petId}",
      "DELETE /pets/{petId}",
      "GET /store/inventory",
      "POST /store/orders",
    ]);
    expect(v20.endpoints.map((e) => e.key)).toEqual([
      "GET /pets",
      "POST /pets",
      "GET /pets/{petId}",
    ]);
    // Swagger 2 body parameters become a request body; host/basePath become a server.
    const create20 = v20.endpoints.find((e) => e.key === "POST /pets")!;
    expect(create20.requestBody?.required).toBe(true);
    expect(create20.requestBody?.schema.required).toEqual(["name"]);
    expect(v20.servers[0]).toContain("localhost:4010");
  });

  it("indexes parameters, bodies, responses and security, with $refs resolved", async () => {
    const api = await index("petstore-v1.yaml");
    const getPet = api.endpoints.find((e) => e.key === "GET /pets/{petId}")!;
    // Path-level parameters are merged into each operation.
    expect(getPet.parameters).toMatchObject([
      { name: "petId", in: "path", required: true, type: "integer" },
    ]);
    expect(getPet.responses.map((r) => r.status)).toEqual(["200", "404"]);
    expect(JSON.stringify(api.endpoints)).not.toContain("$ref");
    const status = api.endpoints[0]!.parameters.find((p) => p.name === "status")!;
    expect(status.schema.enum).toEqual(["available", "pending", "sold"]);
    expect(status.type).toBe("string enum");
    const create = api.endpoints.find((e) => e.key === "POST /pets")!;
    expect(create.security).toEqual([["apiKey"]]);
    expect(api.endpoints[0]!.security).toEqual([]);
    expect(api.securitySchemes).toEqual({ apiKey: "apiKey in header (X-API-Key)" });
    expect(create.requestBody).toMatchObject({ required: true, contentType: "application/json" });
  });

  it("reports validation errors with their paths", async () => {
    const bad = await loadSpec(`openapi: 3.1.0
info: { title: x, version: "1" }
paths:
  /a:
    get:
      parameters:
        - { name: q, in: nowhere }
      responses: { "200": { description: ok } }
`);
    expect(bad.ok).toBe(false);
    if (!bad.ok)
      expect(bad.problems).toContainEqual(
        expect.objectContaining({ path: "/paths/~1a/get/parameters/0/in" }),
      );
    const broken = await loadSpec({
      openapi: "3.0.3",
      info: { title: "x", version: "1" },
      paths: { "/a": { get: { responses: { "200": { $ref: "#/components/responses/Nope" } } } } },
    });
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.problems[0]!.message).toMatch(/Nope/);
    expect(await loadSpec("{ not json")).toMatchObject({ ok: false });
    expect(await loadSpec("title: just yaml")).toMatchObject({
      ok: false,
      problems: [{ message: expect.stringMatching(/Not an OpenAPI/) }],
    });
  });

  it("handles recursive schemas without hanging", async () => {
    const loaded = await loadSpec({
      openapi: "3.1.0",
      info: { title: "Tree", version: "1" },
      paths: {
        "/node": {
          get: {
            responses: {
              "200": {
                description: "ok",
                content: { "application/json": { schema: { $ref: "#/components/schemas/Node" } } },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Node: {
            type: "object",
            properties: {
              name: { type: "string" },
              children: { type: "array", items: { $ref: "#/components/schemas/Node" } },
            },
          },
        },
      },
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const trimmed = JSON.stringify(trimSchema(loaded.index.endpoints[0]!.responses[0]!.schema));
    expect(trimmed.length).toBeLessThan(5000);
    expect(formatGroupForModel(loaded.index, "default")).toContain("GET /node");
  });

  it("formats a compact index and per-group detail for the model", async () => {
    const api = await index("petstore-v1.yaml");
    const text = formatIndexForModel(api);
    expect(text).toContain('## Group "pets" (4)');
    expect(text).toContain("POST /pets — Add a pet → 201, 400, 401 [auth: apiKey]");
    const group = formatGroupForModel(api, "store")!;
    expect(group).toContain("POST /store/orders");
    expect(group).not.toContain("GET /pets");
    expect(formatGroupForModel(api, "nope")).toBeNull();
  });
});

describe("breaking-change diff", () => {
  it("classifies every rule in the v1 → v2 fixture", async () => {
    const diff = diffSpecs(await index("petstore-v1.yaml"), await index("petstore-v2.yaml"));
    const has = (breaking: boolean, rule: string, endpoint: string, location?: string) =>
      expect(
        (breaking ? diff.breaking : diff.nonBreaking).some(
          (c) =>
            c.rule === rule && c.endpoint === endpoint && (!location || c.location === location),
        ),
        `${breaking ? "breaking" : "safe"} ${rule} ${endpoint} ${location ?? ""}\n${formatDiffMarkdown(diff)}`,
      ).toBe(true);
    has(true, "endpoint-removed", "DELETE /pets/{petId}");
    has(true, "response-removed", "POST /store/orders", "response 400");
    has(true, "parameter-added-required", "GET /pets/{petId}", "header parameter X-Request-Id");
    has(true, "parameter-became-required", "GET /pets", "query parameter limit");
    has(true, "field-added-required", "POST /pets", "request body: category");
    has(true, "field-removed", "GET /pets/{petId}", "response 200: tag");
    has(true, "type-changed", "GET /pets/{petId}", "path parameter petId");
    has(true, "enum-narrowed", "GET /pets", "query parameter status");
    has(true, "enum-narrowed", "POST /pets", "request body: status");
    has(true, "security-changed", "GET /store/inventory", "security");
    has(false, "endpoint-added", "GET /pets/{petId}/photos");
    has(false, "parameter-added", "GET /pets", "query parameter sort");
    has(false, "field-added", "GET /pets/{petId}", "response 200: createdAt");
    has(false, "field-removed", "POST /pets", "request body: tag");
    // Narrowing an enum in a response is safe for clients.
    has(false, "enum-narrowed", "GET /pets/{petId}", "response 200: status");
    expect(formatDiffMarkdown(diff)).toContain("## Breaking");
  });

  it("finds no changes between identical specs, and making an endpoint public is safe", async () => {
    const v1 = await index("petstore-v1.yaml");
    expect(diffSpecs(v1, v1)).toMatchObject({ breaking: [], nonBreaking: [] });
    const open = structuredClone(v1);
    open.endpoints.find((e) => e.key === "POST /pets")!.security = [];
    expect(diffSpecs(v1, open).nonBreaking).toContainEqual(
      expect.objectContaining({ rule: "security-changed", breaking: false }),
    );
  });

  it("treats wider request types as safe and wider response enums as breaking", async () => {
    const v1 = await index("petstore-v1.yaml");
    const v2 = structuredClone(v1);
    const order = v2.endpoints.find((e) => e.key === "POST /store/orders")!;
    (
      order.requestBody!.schema.properties as Record<string, Record<string, unknown>>
    ).quantity!.type = ["integer", "string"];
    const inv = v2.endpoints.find((e) => e.key === "GET /pets/{petId}")!;
    // Pet is an allOf; widen status in the response copy.
    (
      inv.responses[0]!.schema as {
        allOf: Array<{ properties?: Record<string, { enum?: string[] }> }>;
      }
    ).allOf[0]!.properties!.status!.enum = ["available", "pending", "sold", "lost"];
    const diff = diffSpecs(v1, v2);
    expect(diff.nonBreaking).toContainEqual(
      expect.objectContaining({ rule: "type-changed", location: "request body: quantity" }),
    );
    expect(diff.breaking).toContainEqual(
      expect.objectContaining({ rule: "enum-widened", location: "response 200: status" }),
    );
  });
});

describe("test cases", () => {
  it("accepts valid cases and rejects invalid ones with reasons", async () => {
    const api = await index("petstore-v1.yaml");
    const { valid, invalid } = checkCases(
      [
        tc({
          id: "create-ok",
          endpoint: "/pets",
          method: "POST",
          request: {
            pathParams: {},
            query: {},
            headers: {},
            body: { name: "Rex", status: "available" },
          },
          expect: { status: 201 },
        }),
        tc({
          id: "create-bad-body",
          endpoint: "/pets",
          method: "POST",
          request: { pathParams: {}, query: {}, headers: {}, body: { name: 5, status: "lost" } },
          expect: { status: 201 },
        }),
        tc({ id: "create-no-body", endpoint: "/pets", method: "POST", expect: { status: 201 } }),
        tc({
          id: "missing-validation",
          endpoint: "/pets",
          method: "POST",
          category: "validation",
          request: { pathParams: {}, query: {}, headers: {}, body: {} },
          expect: { status: 400 },
        }),
        tc({ id: "get-no-param", endpoint: "/pets/{petId}", method: "GET" }),
        tc({ id: "nope", endpoint: "/nope", method: "GET" }),
        tc({
          id: "undocumented",
          endpoint: "/pets/{petId}",
          method: "GET",
          category: "other",
          request: { pathParams: { petId: 1 }, query: {}, headers: {} },
          expect: { status: 418 },
        }),
        tc({
          id: "unauth-public",
          endpoint: "/pets",
          method: "GET",
          category: "unauthorized",
          expect: { status: 400 },
        }),
        tc({ id: "create-ok", endpoint: "/pets", method: "GET" }),
      ],
      api,
    );
    expect(valid.map((c) => c.id)).toEqual(["create-ok", "missing-validation"]);
    const reasons = Object.fromEntries(invalid.map((p) => [p.id, p.problems.join(" | ")]));
    expect(reasons["create-bad-body"]).toMatch(/request body \/name/);
    expect(reasons["create-bad-body"]).toMatch(/\/status/);
    expect(reasons["create-no-body"]).toMatch(/missing the required request body/);
    expect(reasons["get-no-param"]).toMatch(/missing path parameter petId/);
    expect(reasons.nope).toMatch(/isn't in the spec/);
    expect(reasons.undocumented).toMatch(/status 418 isn't documented/);
    expect(reasons["unauth-public"]).toMatch(/needs no auth/);
    expect(invalid.find((p) => p.problems.some((x) => /duplicate/.test(x)))?.id).toBe("create-ok");
  });

  it("exports JSON (round-trips), a Vitest file and an .http file", async () => {
    const cases = [
      tc({
        id: "get-1",
        endpoint: "/pets/{petId}",
        method: "GET",
        request: { pathParams: { petId: 1 }, query: {}, headers: {} },
        expect: { status: 200, bodyMatches: { keys: ["id"] } },
      }),
      tc({
        id: "create",
        endpoint: "/pets",
        method: "POST",
        request: { pathParams: {}, query: {}, headers: {}, body: { name: "Rex" } },
        expect: { status: 201 },
      }),
    ];
    const suite = { title: "Petstore", apiVersion: "1.0.0", cases };
    expect(parseSuiteJson(toSuiteJson(suite))).toEqual(cases);
    const vitest = toVitestFile(suite);
    expect(vitest).toContain('import { describe, expect, it } from "vitest";');
    expect(vitest).toContain('"id": "get-1"');
    expect(vitest).toContain("API_BASE_URL");
    const http = toHttpFile(suite, "http://localhost:4010");
    expect(http).toContain("@baseUrl = http://localhost:4010");
    expect(http).toContain("GET {{baseUrl}}/pets/1");
    expect(http).toContain(
      'POST {{baseUrl}}/pets\nContent-Type: application/json\n# Authorization: {{auth}}\n\n{\n  "name": "Rex"\n}',
    );
  });
});

describe("docs", () => {
  it("renders deterministic tables and examples, with model descriptions", async () => {
    const api = await index("petstore-v1.yaml");
    const md = renderDocs(
      api,
      new Map([["GET /pets/{petId}", "Fetches a single pet by its numeric id."]]),
    );
    expect(md).toContain("# Petstore 1.0.0");
    expect(md).toContain("## pets");
    expect(md).toContain("Fetches a single pet by its numeric id.");
    expect(md).toContain("| `limit` | query | integer | no | How many pets to return (1-100). |");
    expect(md).toContain("GET http://localhost:4010/pets/1");
    expect(md).toContain('"name": "Rex"');
    expect(md).toContain("**Auth:** apiKey");
    expect(exampleFromSchema({ type: "string", format: "email" })).toBe("user@example.com");
  });
});

describe("workspace tools", () => {
  it("serves one group at a time and collects valid cases and descriptions", async () => {
    const ws = new ApiWorkspace(await index("petstore-v1.yaml"));
    expect(ws.groups).toEqual(["pets", "store"]);
    expect(ws.run("get_endpoint_group", { group: "nope" })).toMatchObject({
      error: expect.stringContaining("pets, store"),
    });
    expect(ws.run("get_endpoint_group", { group: "store" })).toMatchObject({
      group: "store",
      endpoints: expect.stringContaining("/store/orders"),
    });
    const result = ws.run("create_test_cases", {
      group: "store",
      cases: [
        tc({
          id: "order-ok",
          endpoint: "/store/orders",
          method: "POST",
          request: { pathParams: {}, query: {}, headers: {}, body: { petId: 1, quantity: 2 } },
        }),
        tc({
          id: "order-bad",
          endpoint: "/store/orders",
          method: "POST",
          request: { pathParams: {}, query: {}, headers: {}, body: { petId: "one" } },
        }),
      ],
    }) as { accepted: number; rejected: unknown[]; remainingGroups: string[] };
    expect(result.accepted).toBe(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.remainingGroups).toEqual(["pets", "store"]);
    expect(() => ws.run("create_test_cases", { group: "store", cases: [{ id: "x" }] })).toThrow();
    ws.run("write_endpoint_docs", {
      group: "store",
      descriptions: [
        { endpoint: "post /store/orders", description: "Places an order." },
        { endpoint: "GET /nope", description: "x" },
      ],
    });
    expect(ws.descriptions.get("POST /store/orders")).toBe("Places an order.");
    expect(ws.docs()).toContain("Places an order.");
    expect(ws.suite().cases.map((c) => c.id)).toEqual(["order-ok"]);
  });
});

describe("test runner", () => {
  let server: { url: string; close: () => Promise<void> };
  beforeAll(async () => {
    server = await startPetServer();
  });
  afterAll(() => server.close());

  it("reports passes, failing assertions and timeouts", async () => {
    const api = await index("petstore-v1.yaml");
    const cases = [
      tc({
        id: "get-ok",
        endpoint: "/pets/{petId}",
        method: "GET",
        request: { pathParams: { petId: 1 }, query: {}, headers: {} },
        expect: {
          status: 200,
          bodyMatches: { responseSchema: true, keys: ["id", "name"], equals: { name: "Rex" } },
        },
      }),
      // Body assertions are skipped after a status mismatch, so only the status is reported.
      tc({
        id: "inventory",
        endpoint: "/store/inventory",
        method: "GET",
        expect: { status: 200, bodyMatches: { keys: ["available"], responseSchema: true } },
      }),
      tc({
        id: "wrong-body",
        endpoint: "/pets/{petId}",
        method: "GET",
        request: { pathParams: { petId: 2 }, query: {}, headers: {} },
        expect: { status: 200, bodyMatches: { equals: { name: "Rex" }, keys: ["owner.id"] } },
      }),
      tc({
        id: "slow",
        endpoint: "/pets",
        method: "GET",
        request: { pathParams: {}, query: {}, headers: { "x-delay-ms": "2000" } },
        expect: { status: 200 },
      }),
      tc({
        id: "create-auth",
        endpoint: "/pets",
        method: "POST",
        request: { pathParams: {}, query: {}, headers: {}, body: { name: "Kit" } },
        expect: { status: 201 },
      }),
      tc({
        id: "create-unauth",
        endpoint: "/pets",
        method: "POST",
        category: "unauthorized",
        request: { pathParams: {}, query: {}, headers: {}, body: { name: "Kit" } },
        expect: { status: 401 },
      }),
    ];
    const seen: string[] = [];
    const report = await runSuite(cases, {
      baseUrl: server.url,
      index: api,
      timeoutMs: 400,
      concurrency: 3,
      authHeader: parseAuthHeader(`X-API-Key: ${API_KEY}`),
      onResult: (r) => seen.push(r.id),
    });
    const byId = Object.fromEntries(report.results.map((r) => [r.id, r]));
    expect(report.results.map((r) => r.id)).toEqual(cases.map((c) => c.id));
    expect(seen.sort()).toEqual(cases.map((c) => c.id).sort());
    expect(byId["get-ok"]!.passed).toBe(true);
    expect(byId.inventory!.failures).toEqual(["expected status 200, got 500"]);
    expect(byId.inventory!.bodySnippet).toContain("inventory service unavailable");
    expect(byId["wrong-body"]!.failures).toEqual([
      "body is missing owner.id",
      'body name: expected "Rex", got "Tom"',
    ]);
    expect(byId.slow!.failures).toEqual(["timed out after 400 ms"]);
    expect(byId["create-auth"]!.passed).toBe(true);
    // The auth header isn't sent for "unauthorized" cases.
    expect(byId["create-unauth"]!.passed).toBe(true);
    expect(report).toMatchObject({ total: 6, passed: 3, failed: 3 });
    expect(report.latency.max).toBeGreaterThanOrEqual(report.latency.p50);
  });

  it("warns about non-local targets", async () => {
    expect(await classifyTarget("http://localhost:3000")).toEqual({
      host: "localhost",
      local: true,
    });
    expect(await classifyTarget("http://127.0.0.1:4010")).toMatchObject({ local: true });
    expect(await classifyTarget("http://10.1.2.3")).toMatchObject({ local: true });
    expect(await classifyTarget("https://api.example.com", async () => ["93.184.215.14"])).toEqual({
      host: "api.example.com",
      local: false,
    });
    expect(
      await classifyTarget("http://dev.internal.test", async () => ["192.168.1.20"]),
    ).toMatchObject({ local: true });
    // Unknown resolution counts as public, so the user is warned.
    expect(await classifyTarget("https://nowhere.example", async () => [])).toMatchObject({
      local: false,
    });
    expect(() => parseAuthHeader("Bearer abc")).toThrow(/Authorization/);
  });
});
