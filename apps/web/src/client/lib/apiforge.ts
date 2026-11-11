import type { ApiIndex, ApiWorkspace, SpecDiff, SpecProblem } from "@mofu/core/apiforge";

/** The spec parser and validator are heavy; load them only when APIForge is used. */
export const loadApiForge = () => import("@mofu/core/apiforge");

export interface LoadedApi {
  name: string;
  index: ApiIndex;
  workspace: ApiWorkspace;
  warnings: SpecProblem[];
}

export interface ApiDiffState {
  name: string;
  diff: SpecDiff;
}

export class SpecError extends Error {
  constructor(readonly problems: SpecProblem[]) {
    super(problems[0]?.message ?? "Invalid spec");
  }
}

export const MAX_SPEC_BYTES = 2_000_000;

/** Parses and validates a spec in the browser; throws SpecError with paths when invalid. */
export async function parseApi(name: string, text: string): Promise<LoadedApi> {
  const forge = await loadApiForge();
  const loaded = await forge.loadSpec(text);
  if (!loaded.ok) throw new SpecError(loaded.problems);
  return {
    name,
    index: loaded.index,
    workspace: new forge.ApiWorkspace(loaded.index),
    warnings: loaded.warnings,
  };
}

export async function diffApis(from: LoadedApi, name: string, text: string): Promise<ApiDiffState> {
  const forge = await loadApiForge();
  const loaded = await forge.loadSpec(text);
  if (!loaded.ok) throw new SpecError(loaded.problems);
  return { name, diff: forge.diffSpecs(from.index, loaded.index) };
}

/** Context for the model: the endpoint list, plus the diff when there is one. */
export async function apiContextText(api: LoadedApi, diff: ApiDiffState | null): Promise<string> {
  const forge = await loadApiForge();
  const index = forge.formatIndexForModel(api.index, diff ? 7_000 : 14_000);
  return diff ? `${index}\n\n${forge.formatDiffForModel(diff.diff, 7_000)}` : index;
}
