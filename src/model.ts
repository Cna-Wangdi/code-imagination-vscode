export type NodeKind = 'event' | 'function' | 'call' | 'usage' | 'request' | 'config' | 'merge' | 'state' | 'setter' | 'condition' | 'async' | 'success' | 'error' | 'catch' | 'return' | 'render';

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
  expandable?: boolean;
  expanded?: boolean;
  expandId?: string;
  usageTargetId?: string;
  usagesExpanded?: boolean;
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
  rootFunctionId?: string;
  activeNodeId?: string;
  entireFile?: boolean;
  nodes: VisualNode[];
  edges: VisualEdge[];
  message?: string;
}

export interface VisualizerSettings {
  followFocus: boolean;
  focusAnimationDuration: number;
}
