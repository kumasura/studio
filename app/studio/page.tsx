// app/studio/page.tsx — Studio with connectable ports (handles)
'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  addEdge,
  Panel,
  useEdgesState,
  useNodesState,
  ReactFlowProvider,
  Handle,
  Position,
  Connection,
  Edge,
  Node,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { motion } from 'framer-motion';

// -------- Types --------
type NodeData = {
  label?: string;
  subtitle?: string;
  state?: Record<string, any>;
  tool?: 'calc' | 'weather' | string;
  params?: Record<string, any>;
};

// -------- Custom Nodes --------
function StageNode({ data }: { data: NodeData }) {
  return (
    <div className="relative rounded-2xl shadow bg-white border border-zinc-200 p-3 w-64">
      {/* IN */}
      <Handle
        type="target"
        position={Position.Left}
        id="in"
        style={{ width: 10, height: 10, background: '#111', borderRadius: 8 }}
      />

      <div className="text-sm font-semibold mb-1 flex items-center gap-2">
        <span className="inline-block h-2 w-2 rounded-full bg-green-500" />
        {data.label}
      </div>
      <div className="text-xs text-zinc-500">{data.subtitle}</div>

      {data.state && (
        <pre className="mt-2 text-[10px] bg-zinc-50 p-2 rounded-xl overflow-auto max-h-28">
          {JSON.stringify(data.state, null, 2)}
        </pre>
      )}

      {/* OUT */}
      <Handle
        type="source"
        position={Position.Right}
        id="out"
        style={{ width: 10, height: 10, background: '#2563eb', borderRadius: 8 }}
      />
    </div>
  );
}

function RouterNode({ data }: { data: NodeData }) {
  return (
    <div className="relative rounded-2xl shadow bg-white border border-zinc-200 p-3 w-64">
      {/* IN */}
      <Handle
        type="target"
        position={Position.Left}
        id="in"
        style={{ width: 10, height: 10, background: '#111', borderRadius: 8 }}
      />
      <div className="text-sm font-semibold mb-1">Router</div>
      <div className="text-xs text-zinc-500">Conditional branch</div>

      {/* OUT: yes / no */}
      <Handle
        type="source"
        position={Position.Bottom}
        id="yes"
        style={{ left: 20, width: 10, height: 10, background: '#16a34a', borderRadius: 8 }}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        id="no"
        style={{ left: 60, width: 10, height: 10, background: '#dc2626', borderRadius: 8 }}
      />
    </div>
  );
}

const nodeTypes = { stage: StageNode, router: RouterNode };

// -------- Page --------
function StudioInner() {
  // Graph
  const [nodes, setNodes, onNodesChange] = useNodesState<NodeData>([
    {
      id: 'input',
      type: 'stage',
      position: { x: 0, y: 80 },
      data: { label: 'Input', subtitle: 'Human / System', state: { query: 'Hello' } },
    },
    { id: 'planner', type: 'stage', position: { x: 300, y: 80 }, data: { label: 'Planner', subtitle: 'LLM (policy)' } },
    { id: 'router1', type: 'router', position: { x: 560, y: 80 }, data: {} },
    {
      id: 'tool1',
      type: 'stage',
      position: { x: 820, y: 20 },
      data: { label: 'Tool', subtitle: 'Function call', tool: 'calc', params: { expression: '2+3*4' } },
    },
    {
      id: 'tool2',
      type: 'stage',
      position: { x: 820, y: 160 },
      data: { label: 'Tool', subtitle: 'Function call', tool: 'weather', params: { city: 'Delhi' } },
    },
    { id: 'output', type: 'stage', position: { x: 1100, y: 80 }, data: { label: 'Output', subtitle: 'Response' } },
  ]);

  const [edges, setEdges, onEdgesChange] = useEdgesState([
    { id: 'e1', source: 'input', sourceHandle: 'out', target: 'planner', targetHandle: 'in', type: 'smoothstep', animated: true },
    { id: 'e2', source: 'planner', sourceHandle: 'out', target: 'router1', targetHandle: 'in', type: 'smoothstep' },
    { id: 'e3', source: 'router1', sourceHandle: 'yes', target: 'tool1', targetHandle: 'in', type: 'smoothstep' },
    { id: 'e4', source: 'router1', sourceHandle: 'no', target: 'tool2', targetHandle: 'in', type: 'smoothstep' },
    { id: 'e5', source: 'tool1', sourceHandle: 'out', target: 'output', targetHandle: 'in', type: 'smoothstep' },
    { id: 'e6', source: 'tool2', sourceHandle: 'out', target: 'output', targetHandle: 'in', type: 'smoothstep' },
  ]);

  // DnD
  const reactFlowWrapper = useRef<HTMLDivElement | null>(null);
  const [rfInstance, setRfInstance] = useState<any>(null);

  const onDragStart = (event: React.DragEvent, nodeData: any) => {
    event.dataTransfer.setData('application/reactflow', JSON.stringify(nodeData));
    event.dataTransfer.effectAllowed = 'move';
  };
  const onDragOver = (event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  };
  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    const bounds = reactFlowWrapper.current!.getBoundingClientRect();
    const payload = JSON.parse(event.dataTransfer.getData('application/reactflow'));
    const position = rfInstance.project({ x: event.clientX - bounds.left, y: event.clientY - bounds.top });
    const id = `${payload.type || 'stage'}-${Date.now()}`;
    const newNode: Node<NodeData> = {
      id,
      type: payload.type || 'stage',
      position,
      data: payload.data || payload,
    };
    setNodes((nds) => nds.concat(newNode));
  };

  // Connect
  const onConnect = useCallback((params: Edge | Connection) => {
    setEdges((eds) => addEdge({ ...params, type: 'smoothstep' }, eds));
  }, [setEdges]);

  // Selection + delete (edge/node)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      if (selectedEdgeId) {
        setEdges((eds) => eds.filter((e) => e.id !== selectedEdgeId));
        setSelectedEdgeId(null);
      } else if (selectedNodeId) {
        setNodes((ns) => ns.filter((n) => n.id !== selectedNodeId));
        setEdges((eds) => eds.filter((e) => e.source !== selectedNodeId && e.target !== selectedNodeId));
        setSelectedNodeId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedEdgeId, selectedNodeId, setEdges, setNodes]);

  // Fake run to show state updates
  const [logs, setLogs] = useState<any[]>([]);
  const [running, setRunning] = useState(false);

  const runOnce = useCallback(async () => {
    setRunning(true);
    setLogs([]);
    const fake = [
      { type: 'node_enter', node: 'planner', message: 'Planning…' },
      { type: 'state_patch', node: 'tool1', patch: { status: 'running', tool: 'calc' } },
      { type: 'state_patch', node: 'tool1', patch: { status: 'done', result: { result: 14 } } },
      { type: 'state_patch', node: 'tool2', patch: { status: 'running', tool: 'weather' } },
      { type: 'state_patch', node: 'tool2', patch: { status: 'done', result: { tempC: 32, condition: 'Cloudy' } } },
      { type: 'done', metrics: { tokens: 0, cost: 0 } },
    ] as const;

    for (const evt of fake) {
      await new Promise((r) => setTimeout(r, 400));
      setLogs((l) => [...l, evt as any]);
      if (evt.type === 'state_patch') {
        setNodes((ns) =>
          ns.map((n) =>
            n.id === (evt as any).node
              ? { ...n, data: { ...n.data, state: { ...(n.data?.state || {}), ...((evt as any).patch || {}) } } }
              : n
          )
        );
      }
    }
    setRunning(false);
  }, [setNodes]);

  return (
    <div className="h-screen w-full bg-gradient-to-b from-zinc-50 to-white">
      <div className="p-4 flex items-center justify-between">
        <div className="text-xl font-bold">Studio (Vercel)</div>
        <div className="flex items-center gap-2">
          <button
            className="px-3 py-2 rounded-2xl shadow bg-black text-white disabled:opacity-50"
            onClick={runOnce}
            disabled={running}
          >
            {running ? 'Running…' : 'Run'}
          </button>
          <button className="px-3 py-2 rounded-2xl border" onClick={() => setLogs([])}>
            Reset
          </button>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-4 p-4">
        {/* Palette */}
        <div className="col-span-2">
          <div className="rounded-2xl border p-3 bg-white">
            <div className="text-sm font-semibold mb-2">Node Palette</div>
            <ul className="space-y-2 text-sm">
              <li
                draggable
                onDragStart={(e) => onDragStart(e as any, { type: 'stage', data: { label: 'LLM', subtitle: 'Model call' } })}
                className="cursor-move px-2 py-1 rounded-xl border"
              >
                LLM
              </li>
              <li
                draggable
                onDragStart={(e) =>
                  onDragStart(e as any, { type: 'stage', data: { label: 'LLM', subtitle: 'Model call', state: { query: 'What tools do I need to answer: weather in Delhi and 2+3*4?' } } })
                }
                className="cursor-move px-2 py-1 rounded-xl border"
              >
                LLM (ChatOpenAI)
              </li>

              <li
                draggable
                onDragStart={(e) =>
                  onDragStart(e as any, {
                    type: 'stage',
                    data: { label: 'Tool', subtitle: 'Function call', tool: 'calc', params: { expression: 'sin(PI/4)**2' } },
                  })
                }
                className="cursor-move px-2 py-1 rounded-xl border"
              >
                Tool: Calc
              </li>
              <li
                draggable
                onDragStart={(e) =>
                  onDragStart(e as any, {
                    type: 'stage',
                    data: { label: 'Tool', subtitle: 'Function call', tool: 'weather', params: { city: 'Delhi' } },
                  })
                }
                className="cursor-move px-2 py-1 rounded-xl border"
              >
                Tool: Weather
              </li>
              <li
                draggable
                onDragStart={(e) => onDragStart(e as any, { type: 'router', data: {} })}
                className="cursor-move px-2 py-1 rounded-xl border"
              >
                Router (yes/no)
              </li>
              <li
                draggable
                onDragStart={(e) => onDragStart(e as any, { type: 'stage', data: { label: 'Memory', subtitle: 'State' } })}
                className="cursor-move px-2 py-1 rounded-xl border"
              >
                Memory
              </li>
              <li
                draggable
                onDragStart={(e) => onDragStart(e as any, { type: 'stage', data: { label: 'Aggregator', subtitle: 'Reducer' } })}
                className="cursor-move px-2 py-1 rounded-xl border"
              >
                Aggregator
              </li>
            </ul>
          </div>
        </div>

        {/* Canvas */}
        <div className="col-span-7 h-[75vh] rounded-2xl overflow-hidden border bg-white" ref={reactFlowWrapper}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            nodeTypes={nodeTypes}
            fitView
            onInit={setRfInstance}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onSelectionChange={({
              nodes: selNodes,
              edges: selEdges,
            }: {
              nodes?: Node<NodeData>[];
              edges?: Edge[];
            }) => {
              setSelectedNodeId(selNodes?.[0]?.id ?? null);
              setSelectedEdgeId(selEdges?.[0]?.id ?? null);
            }}
            onEdgeDoubleClick={(_, edge) => setEdges((eds) => eds.filter((e) => e.id !== edge.id))}
          >
            <Background />
            <Controls />
            <MiniMap />
            <Panel position="top-left">
              <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                className="text-xs p-2 bg-white/80 rounded-xl shadow"
              >
                Drag from blue port → black port to connect. Select an edge and press Delete/Backspace (or double-click it) to
                remove.
              </motion.div>
            </Panel>
          </ReactFlow>
        </div>

        {/* Inspector & Log */}
        <div className="col-span-3 h-[75vh] grid grid-rows-2 gap-4">
          <div className="rounded-2xl border p-3 bg-white overflow-auto">
            <div className="text-sm font-semibold mb-2">Inspector</div>
            <div className="text-sm text-zinc-500">Select a node to edit.</div>
          </div>

          <div className="rounded-2xl border p-3 bg-white overflow-auto">
            <div className="text-sm font-semibold mb-2">Event Log</div>
            <ul className="space-y-1 text-[11px]">
              {logs.map((l, i) => (
                <li key={i} className="flex items-center gap-2">
                  <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: '#3b82f6' }} />
                  <span className="font-mono">{(l as any).node || (l as any).type}</span>
                  <span className="text-zinc-500">{(l as any).message || JSON.stringify((l as any).patch || l)}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function StudioPage() {
  return (
    <ReactFlowProvider>
      <StudioInner />
    </ReactFlowProvider>
  );
}
