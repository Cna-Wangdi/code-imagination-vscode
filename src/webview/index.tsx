import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Background, Controls, Edge, MarkerType, Node, Position, ReactFlow, ReactFlowInstance } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './style.css';
import type { VisualModel, VisualNode } from '../model';
import { calculateNodePositions, NODE_HEIGHT, NODE_WIDTH } from './graphLayout';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscode = acquireVsCodeApi();

const empty: VisualModel = { fileName: '', languageId: '', nodes: [], edges: [], message: 'Open a React file to begin.' };
const colors: Record<VisualNode['kind'], string> = {
  event: '#39c5cf', function: '#58a6ff', state: '#3fb950', setter: '#ffa657', condition: '#d2a8ff',
  async: '#79c0ff', success: '#56d364', error: '#ff7b72', render: '#f778ba'
};

function App(): React.ReactElement {
  const [model, setModel] = useState<VisualModel>(empty);
  const [activeNodeId, setActiveNodeId] = useState<string>();
  const [flow, setFlow] = useState<ReactFlowInstance>();
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.data?.type === 'model') {
        setModel(event.data.model);
        setActiveNodeId(event.data.model.activeNodeId);
      }
      if (event.data?.type === 'activeNode') setActiveNodeId(event.data.nodeId);
    };
    window.addEventListener('message', listener);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', listener);
  }, []);

  useEffect(() => {
    if (!flow || !activeNodeId) return;
    const timer = window.setTimeout(() => {
      const activeNode = flow.getNode(activeNodeId);
      if (activeNode) {
        void flow.fitView({
          nodes: [activeNode],
          duration: 350,
          padding: 1.1,
          minZoom: 0.65,
          maxZoom: 1.15
        });
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [flow, activeNodeId]);

  const laidOutGraph = useMemo(() => layout(model), [model]);
  const graph = useMemo(() => highlightGraph(laidOutGraph, activeNodeId), [laidOutGraph, activeNodeId]);
  return <main>
    <header>
      <div><strong>{model.activeFunction ? `${model.activeFunction}()` : 'Live mental model'}</strong><span>{model.fileName || 'Code Imagination'}</span></div>
      <span className="live"><i /> LIVE</span>
    </header>
    {model.nodes.length === 0 ? <section className="empty"><div className="brain">⌘</div><p>{model.message}</p><small>Try writing a function that calls a React state setter.</small></section> :
      <section className="canvas">
        <ReactFlow nodes={graph.nodes} edges={graph.edges} onInit={setFlow} fitView fitViewOptions={{ padding: 0.25 }} nodesDraggable={false}
          nodesConnectable={false} elementsSelectable onNodeClick={(_, node) => node.data.location && vscode.postMessage({ type: 'reveal', location: node.data.location })}>
          <Background gap={18} size={1} color="var(--vscode-editorIndentGuide-background)" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </section>}
    <footer>Click a node to reveal its code.</footer>
  </main>;
}

interface RenderedGraph {
  nodes: Node[];
  edges: Edge[];
}

function layout(model: VisualModel): RenderedGraph {
  const positions = calculateNodePositions(model);

  return {
    nodes: model.nodes.map((node) => {
      const point = positions.get(node.id) ?? { x: 0, y: 0 };
      return {
        id: node.id,
        position: point,
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        data: {
          label: <div className="node-label"><b>{node.label}</b>{node.detail && <small>{node.detail}</small>}</div>,
          location: node.location,
          nodeColor: colors[node.kind]
        },
        style: {
          borderColor: colors[node.kind],
          borderWidth: 1,
          boxShadow: `0 0 0 1px ${colors[node.kind]}33`,
          background: 'var(--vscode-editorWidget-background)',
          color: 'var(--vscode-editor-foreground)',
          width: NODE_WIDTH,
          minHeight: NODE_HEIGHT
        }
      };
    }),
    edges: model.edges.map((edge) => {
      const color = edge.animated ? '#58a6ff' : '#8b949e';
      return { ...edge, type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed, color }, style: { stroke: color, strokeWidth: 2 }, labelStyle: { fill: 'var(--vscode-descriptionForeground)', fontSize: 11 } };
    })
  };
}

function highlightGraph(graph: RenderedGraph, activeNodeId?: string): RenderedGraph {
  return {
    nodes: graph.nodes.map((node) => {
      const active = node.id === activeNodeId;
      const nodeColor = String(node.data.nodeColor);
      return {
        ...node,
        className: active ? 'active-node' : undefined,
        style: {
          ...node.style,
          borderWidth: active ? 3 : 1,
          boxShadow: active ? `0 0 18px ${nodeColor}aa` : `0 0 0 1px ${nodeColor}33`
        }
      };
    }),
    edges: graph.edges.map((edge) => {
      const active = edge.source === activeNodeId || edge.target === activeNodeId;
      const color = active ? '#f0f6fc' : edge.animated ? '#58a6ff' : '#8b949e';
      return {
        ...edge,
        animated: active || edge.animated,
        markerEnd: { type: MarkerType.ArrowClosed, color },
        style: { stroke: color, strokeWidth: active ? 3 : 2 }
      };
    })
  };
}

createRoot(document.getElementById('root')!).render(<App />);
