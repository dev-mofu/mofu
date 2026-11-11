/**
 * APIForge tools and the state they build up (test suite, docs descriptions).
 * The same workspace backs the browser (tools run client-side) and the CLI.
 */
import { checkCases, type TestSuite } from "./cases.js";
import { renderDocs } from "./docs.js";
import {
  CreateTestCasesInput,
  GetEndpointGroupInput,
  WriteEndpointDocsInput,
  type TestCase,
} from "./specs.js";
import { formatGroupForModel, groupByTag, type ApiIndex } from "./spec.js";

export class ApiWorkspace {
  readonly cases: TestCase[] = [];
  readonly descriptions = new Map<string, string>();
  private readonly groupsDone = { tests: new Set<string>(), docs: new Set<string>() };

  constructor(readonly index: ApiIndex) {}

  get groups(): string[] {
    return [...groupByTag(this.index).keys()];
  }

  suite(): TestSuite {
    return { title: this.index.title, apiVersion: this.index.version, cases: this.cases };
  }

  docs(): string {
    return renderDocs(this.index, this.descriptions);
  }

  /** Runs one APIForge tool. Throws on invalid input (zod), which goes back to the model. */
  run(name: string, input: unknown): unknown {
    if (name === "get_endpoint_group") {
      const { group } = GetEndpointGroupInput.parse(input);
      const detail = formatGroupForModel(this.index, group);
      if (!detail) return { error: `No group named "${group}". Groups: ${this.groups.join(", ")}` };
      return { group, endpoints: detail };
    }
    if (name === "create_test_cases") {
      const { group, cases } = CreateTestCasesInput.parse(input);
      const { valid, invalid } = checkCases(
        cases,
        this.index,
        this.cases.map((c) => c.id),
      );
      this.cases.push(...valid);
      if (!invalid.length) this.groupsDone.tests.add(group);
      const remaining = this.groups.filter((g) => !this.groupsDone.tests.has(g));
      return {
        accepted: valid.length,
        totalCases: this.cases.length,
        ...(invalid.length && {
          rejected: invalid,
          note: "Fix only these cases and call create_test_cases again with them.",
        }),
        remainingGroups: remaining,
      };
    }
    if (name === "write_endpoint_docs") {
      const { group, descriptions } = WriteEndpointDocsInput.parse(input);
      const known = new Set(this.index.endpoints.map((e) => e.key));
      const unknown: string[] = [];
      for (const d of descriptions) {
        const key = d.endpoint.replace(/^(\w+)\s+/, (m, verb: string) => `${verb.toUpperCase()} `);
        if (known.has(key)) this.descriptions.set(key, d.description.trim());
        else unknown.push(d.endpoint);
      }
      this.groupsDone.docs.add(group);
      return {
        saved: descriptions.length - unknown.length,
        ...(unknown.length && { unknownEndpoints: unknown }),
        remainingGroups: this.groups.filter((g) => !this.groupsDone.docs.has(g)),
      };
    }
    throw new Error(`Unknown APIForge tool ${name}`);
  }
}
