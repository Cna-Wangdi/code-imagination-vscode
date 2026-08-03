import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Background, Controls, Edge, MarkerType, Node, Position, ReactFlow, ReactFlowInstance } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './style.css';
import type { VisualModel, VisualNode } from '../model';

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

  const graph = useMemo(() => layout(model, activeNodeId), [model, activeNodeId]);
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

function layout(model: VisualModel, activeNodeId?: string): { nodes: Node[]; edges: Edge[] } {
  const rank: Record<VisualNode['kind'], number> = {
    event: 0, function: 1, condition: 2, async: 3, success: 4, error: 4, setter: 5, state: 6, render: 7
  };
  const rows = new Map<number, number>();
  return {
    nodes: model.nodes.map((node) => {
      const column = rank[node.kind];
      const count = rows.get(column) ?? 0;
      rows.set(column, count + 1);
      const active = node.id === activeNodeId;
      return {
        id: node.id,
        position: { x: 40 + column * 220, y: 45 + count * 125 },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        className: active ? 'active-node' : undefined,
        data: { label: <div className="node-label"><b>{node.label}</b>{node.detail && <small>{node.detail}</small>}</div>, location: node.location },
        style: {
          borderColor: colors[node.kind],
          borderWidth: active ? 3 : 1,
          boxShadow: active ? `0 0 18px ${colors[node.kind]}aa` : `0 0 0 1px ${colors[node.kind]}33`,
          background: 'var(--vscode-editorWidget-background)',
          color: 'var(--vscode-editor-foreground)',
          width: 180
        }
      };
    }),
    edges: model.edges.map((edge) => {
      const active = edge.source === activeNodeId || edge.target === activeNodeId;
      const color = active ? '#f0f6fc' : edge.animated ? '#58a6ff' : '#8b949e';
      return {
        ...edge,
        animated: active || edge.animated,
        type: 'smoothstep',
        markerEnd: { type: MarkerType.ArrowClosed, color },
        style: { stroke: color, strokeWidth: active ? 3 : 2 },
        labelStyle: { fill: 'var(--vscode-descriptionForeground)', fontSize: 11 }
      };
    })
  };
}

createRoot(document.getElementById('root')!).render(<App />);
