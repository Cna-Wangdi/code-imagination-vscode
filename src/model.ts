export type NodeKind = 'event' | 'function' | 'state' | 'setter' | 'condition' | 'async' | 'success' | 'error' | 'render';

export interface SourceLocation {
  fileName: string;
  start: number;
  end: number;
  line: number;
}

export interface VisualNode {
  id: string;
  kind: NodeKind;
  label: string;
  detail?: string;
  location?: SourceLocation;
}

export interface VisualEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  animated?: boolean;
}

export interface VisualModel {
  fileName: string;
  languageId: string;
  activeFunction?: string;
  activeNodeId?: string;
  nodes: VisualNode[];
  edges: VisualEdge[];
  message?: string;
}

export interface VisualizerSettings {
  followFocus: boolean;
  focusAnimationDuration: number;
}
