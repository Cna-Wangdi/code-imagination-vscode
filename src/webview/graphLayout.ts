import dagre from '@dagrejs/dagre';
import type { VisualModel } from '../model';

export interface GraphPoint {
  x: number;
  y: number;
}

export const NODE_WIDTH = 180;
export const NODE_HEIGHT = 76;

export function calculateNodePositions(model: VisualModel): Map<string, GraphPoint> {
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({
    rankdir: 'LR',
    ranker: 'network-simplex',
    align: 'UL',
    nodesep: 42,
    ranksep: 72,
    edgesep: 22,
    marginx: 32,
    marginy: 32
  });

  for (const node of model.nodes) graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const edge of model.edges) graph.setEdge(edge.source, edge.target);
  dagre.layout(graph);

  return new Map(model.nodes.map((node) => {
    const point = graph.node(node.id) as GraphPoint;
    return [node.id, { x: point.x - NODE_WIDTH / 2, y: point.y - NODE_HEIGHT / 2 }];
  }));
}
