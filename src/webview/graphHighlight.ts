import type { VisualEdge } from '../model';

export interface EdgePresentation {
  active: boolean;
  animated: boolean;
  color: string;
  strokeWidth: number;
}

export function getEdgePresentation(
  edge: Pick<VisualEdge, 'source' | 'target'>,
  activeNodeId?: string
): EdgePresentation {
  const active = Boolean(activeNodeId && (edge.source === activeNodeId || edge.target === activeNodeId));
  return {
    active,
    animated: active,
    color: active ? '#f0f6fc' : '#8b949e',
    strokeWidth: active ? 3 : 2
  };
}
