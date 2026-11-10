# Phase 7 — APIForge

Read `prompts/00-project-brief.md` first. Phases 1–6 must be complete.

## Goal

Understand an API from its OpenAPI/Swagger spec. Generate test cases and readable documentation, detect breaking changes between two versions of a spec, and in the CLI run the tests against a live server and report the results.

## Scope

### 1. Spec handling (core, deterministic)

- Accept OpenAPI 3.0/3.1 and Swagger 2.0, in JSON or YAML, from upload, paste, a project file (CLI) or a URL (same SSRF guard as phase 6).
- Validate the spec and dereference `$ref`s.
  - Use a library that works in both the browser and Node. Check that it runs in a browser/Worker context before choosing it.
  - Report validation errors with paths.
- Build an endpoint index: method, path, operation ID, summary, parameters (with location, type, required), request body schema, response codes and schemas, security requirements.

### 2. Breaking-change diff (deterministic)

Compare two specs and classify changes as breaking or non-breaking. At minimum:
- removed endpoints or methods
- removed response codes
- new required parameters or request fields
- removed response fields
- type changes
- narrowed enums
- changed security requirements

Output a typed `SpecDiff`. The model explains the impact and suggests a migration note, but never decides what's breaking.

### 3. Test generation

The model generates test cases as structured output validated with zod:

```
{ id, endpoint, method, description,
  request: { pathParams, query, headers, body },
  expect:  { status, bodyMatches? (JSON schema or key assertions), maxLatencyMs? } }
```

Coverage per endpoint:
- a happy path
- validation failures (missing required fields, wrong types)
- not-found / unauthorized cases when the spec defines them

Request bodies must validate against the spec's schemas. Check them in code and regenerate only the invalid ones.

Exports:
- the test suite as JSON
- a ready-to-run Vitest file using `fetch`
- an `.http` file for REST-client extensions

### 4. Documentation generation

- Markdown docs grouped by tag, with:
  - a short description per endpoint (model-written)
  - parameter and response tables (rendered deterministically from the index)
  - one example request/response per endpoint
- Downloadable.

### 5. Running tests (CLI only)

`mofu api test <spec> --base-url <url>`:
- Shows the target host and the number of requests, and asks for approval. Warn clearly if the host isn't localhost or a private address.
- Optional auth header via flag or environment variable, never echoed.
- Runs tests with concurrency and timeout limits.
- Reports pass/fail per test with the failing assertion, plus overall latency stats.
- Writes a JSON + Markdown report to `./mofu-output/`.
- The model summarizes failures and suggests likely causes. It may offer to open the relevant handler code via the RepoPilot tools if the API lives in the current repository.

The web app never sends requests to user APIs. It shows the CLI command instead.

### 6. UX

**Web (Dev Tools mode)**
- Upload or paste a spec, see the endpoint index and validation result immediately.
- Then: Generate tests, Generate docs, Compare with another version.
- Results shown as tables with downloads.

**CLI**
- `mofu api docs <spec>`
- `mofu api tests <spec>` (generate)
- `mofu api test <spec> --base-url …` (run)
- `mofu api diff <old> <new>`

## Out of scope

GraphQL, gRPC, Postman import, load testing, mocking servers, running tests from the web.

## Cost discipline

- Send the model one endpoint group at a time, with dereferenced but trimmed schemas.
- Docs tables are deterministic.
- No more than about 20 live calls total, using a small fixture spec (a petstore-style example) and a tiny local test server you write for the fixture.

## Verification

1. Build, lint, typecheck and tests pass.
2. Tests cover:
   - parsing/validation for 2.0, 3.0 and 3.1 fixtures
   - `$ref` dereferencing
   - each breaking-change rule
   - request-body validation of generated cases
   - the test runner against the local fixture server (pass, fail, timeout)
   - the non-localhost warning
3. Manual web run in Chrome: index, tests, docs and diff for the fixture specs.
4. Manual CLI run: generate and run tests against the local fixture server, including at least one deliberately failing endpoint.

## Report

Follow "How to work on a phase" in the brief, plus the sample diff output and the test run report.
