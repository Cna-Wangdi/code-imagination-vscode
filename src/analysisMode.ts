export type AnalysisScope = 'syntax' | 'imports' | 'project';

export const importResolutionPrefix = 'resolve-call:';

export function getAnalysisScope(
  expandedNodeIds: ReadonlySet<string>,
  expandedUsageCount: number
): AnalysisScope {
  if (expandedUsageCount > 0) return 'project';
  if ([...expandedNodeIds].some((id) => id.startsWith(importResolutionPrefix))) return 'imports';
  return 'syntax';
}
