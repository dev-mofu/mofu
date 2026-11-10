import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NodePythonSandbox, type DatasetProfile } from "../src/index.js";

/** Real Pyodide in a worker thread. The first run downloads pandas (~30 MB), then it's cached. */
const cacheDir = path.join(os.homedir(), ".mofu", "pyodide-cache");

const MESSY_CSV = [
  "date,region,units,price",
  "2024-01-05,North,10,9.5",
  "2024-01-06,South,12,9.5",
  "07/01/2024,North,ten,9.5", // text in a number column
  "2024-01-08,East,11,9.5",
  "2024-01-08,East,11,9.5",
  "2024-01-09,South,13,9.5",
  "2024-01-10,North,9,9.5",
  "2024-01-11,South,10,950",
  "2024-01-12,East,14,9.5",
  "2024-01-13,North,12,9.5",
].join("\n");

describe("NodePythonSandbox (real Pyodide)", () => {
  let sandbox: NodePythonSandbox;
  let profile: DatasetProfile;

  beforeAll(async () => {
    sandbox = new NodePythonSandbox({ cacheDir, timeoutMs: 8_000 });
    profile = await sandbox.load("sales.csv", new TextEncoder().encode(MESSY_CSV));
  }, 300_000);

  afterAll(async () => {
    await sandbox.close();
  });

  it("profiles columns and flags problems", () => {
    expect(profile.rows).toBe(10);
    const byName = Object.fromEntries(profile.columns.map((c) => [c.name, c]));
    expect(byName.date?.kind).toBe("datetime");
    expect(byName.price).toMatchObject({ kind: "numeric", max: 950 });
    expect(byName.region?.kind).toBe("categorical");
    expect(profile.sample).toHaveLength(5);
    const problems = profile.problems.join("\n");
    expect(problems).toMatch(/1 duplicate rows/);
    expect(problems).toMatch(/units: mixed types/);
    expect(problems).toMatch(/price: \d+ extreme outliers/);
    expect(problems).toMatch(/date: mixed date formats/);
  });

  it("runs code, returns the last value, stdout and charts", async () => {
    const run = await sandbox.run(
      'print("hello")\nfig, ax = plt.subplots()\ndf.groupby("region")["price"].mean().plot.bar(ax=ax)\ndf["region"].nunique()',
    );
    expect(run.stdout).toContain("hello");
    expect(run.result).toBe("3");
    expect(run.error).toBeNull();
    expect(run.figures).toHaveLength(1);
    expect(Buffer.from(run.figures[0]!, "base64").subarray(1, 4).toString()).toBe("PNG");
  }, 60_000);

  it("keeps variables between runs and reports errors without crashing", async () => {
    await sandbox.run("total = int(df['units'].apply(pd.to_numeric, errors='coerce').sum())");
    expect((await sandbox.run("total")).result).toBe("102");
    const bad = await sandbox.run("df['nope']");
    expect(bad.error).toMatch(/KeyError/);
  }, 60_000);

  it("truncates large output", async () => {
    const run = await sandbox.run("print('x' * 50_000)");
    expect(run.stdout.length).toBeLessThan(7_000);
    expect(run.stdout).toMatch(/truncated/);
  }, 60_000);

  it("reads files written into /data and exports DataFrames", async () => {
    await sandbox.write("/data/extra.csv", "region,manager\nNorth,Ana\nSouth,Bo\n");
    const run = await sandbox.run(
      "m = df.merge(pd.read_csv('/data/extra.csv'), on='region', how='left')\nm['manager'].notna().sum()",
    );
    expect(run.result).toBe("7"); // 4 North + 3 South rows
    const csv = await sandbox.exportCsv("m");
    expect(csv.split("\n")[0]).toBe("date,region,units,price,manager");
    await expect(sandbox.write("/etc/passwd", "x")).rejects.toThrow(/only be written to \/data/);
  }, 60_000);

  it("has no network access from Python", async () => {
    const run = await sandbox.run("import js\nhasattr(js, 'fetch')");
    expect(run.result).toBe("False");
  }, 60_000);

  it("stops runaway code, restarts and reloads the dataset", async () => {
    const stuck = await sandbox.run("while True:\n    pass");
    expect(stuck.error).toMatch(/longer than 8 seconds/);
    const after = await sandbox.run("len(df)");
    expect(after.result).toBe("10");
    expect(after.stdout).toMatch(/restarted/);
  }, 300_000);
});
