/**
 * APIForge tool declarations and their zod schemas. Kept free of heavy
 * dependencies (spec parser, JSON Schema validator) so the Worker and the
 * main web bundle can import them cheaply.
 */
import { z } from "zod";

export const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

const Scalar = z.union([z.string(), z.number(), z.boolean()]);

export const TestCaseSchema = z.object({
  id: z
    .string()
    .regex(/^[A-Za-z0-9_.-]{1,60}$/, "use letters, digits, _ . - (max 60)")
    .describe("Unique, e.g. 'getPet-happy'."),
  endpoint: z
    .string()
    .startsWith("/")
    .describe("The path exactly as in the spec, e.g. /pets/{petId}."),
  method: z.enum(HTTP_METHODS.map((m) => m.toUpperCase()) as [string, ...string[]]),
  category: z.enum(["happy_path", "validation", "not_found", "unauthorized", "other"]),
  description: z.string().min(1).max(300),
  request: z.object({
    pathParams: z.record(z.string(), Scalar).default({}),
    query: z.record(z.string(), z.union([Scalar, z.array(Scalar)])).default({}),
    headers: z.record(z.string(), z.string()).default({}),
    body: z.unknown().optional(),
  }),
  expect: z.object({
    status: z.number().int().min(100).max(599),
    bodyMatches: z
      .object({
        responseSchema: z
          .boolean()
          .optional()
          .describe("Check the body against the spec's schema for this status."),
        keys: z
          .array(z.string())
          .max(20)
          .optional()
          .describe("Dot paths that must exist, e.g. 'id' or 'items[0].name'."),
        equals: z
          .record(z.string(), z.union([Scalar, z.null()]))
          .optional()
          .describe("Dot path → exact value."),
      })
      .optional(),
    maxLatencyMs: z.number().int().positive().max(60_000).optional(),
  }),
});
export type TestCase = z.infer<typeof TestCaseSchema>;

export const CreateTestCasesInput = z.object({
  group: z.string().describe("The endpoint group (tag) these cases cover."),
  cases: z.array(TestCaseSchema).min(1).max(30),
});

export const WriteEndpointDocsInput = z.object({
  group: z.string(),
  descriptions: z
    .array(
      z.object({
        endpoint: z.string().describe('The endpoint key, e.g. "GET /pets/{petId}".'),
        description: z
          .string()
          .min(1)
          .max(600)
          .describe("One to three plain sentences: what it does and when to use it."),
      }),
    )
    .min(1)
    .max(40),
});

export const GetEndpointGroupInput = z.object({
  group: z.string().describe("A group (tag) name from the endpoint list."),
});

export interface ApiToolSpec {
  name: string;
  description: string;
  inputSchema: z.ZodType;
}

export const API_TOOL_SPECS: ApiToolSpec[] = [
  {
    name: "get_endpoint_group",
    description:
      "Get full detail (parameters, request and response schemas, security) for one endpoint group. Work one group at a time.",
    inputSchema: GetEndpointGroupInput,
  },
  {
    name: "create_test_cases",
    description:
      "Add test cases for one group. Per endpoint: a happy path, validation failures (missing required fields, wrong types) and not-found/unauthorized cases only when the spec documents those statuses. " +
      "Use realistic values. Each case is checked against the spec in code; fix and resend only the rejected ones.",
    inputSchema: CreateTestCasesInput,
  },
  {
    name: "write_endpoint_docs",
    description:
      "Write a short plain-English description for each endpoint of one group. Parameter/response tables and examples are generated from the spec automatically.",
    inputSchema: WriteEndpointDocsInput,
  },
];

export const API_TOOL_NAMES = new Set(API_TOOL_SPECS.map((s) => s.name));
