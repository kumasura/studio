'use client'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import ReactFlow, { Background, Controls, MiniMap, addEdge, Panel, useEdgesState, useNodesState, ReactFlowProvider } from 'reactflow'
import 'reactflow/dist/style.css'
import { motion } from 'framer-motion'

function StageNode({ data }: any) {
  return (
    <div className="rounded-2xl shadow-lg bg-white border border-zinc-200 p-3 w-64">
      <div className="text-sm font-semibold mb-1 flex items-center gap-2">
        <span className="inline-block h-2 w-2 rounded-full bg-green-500" />
        {data.label}
      </div>
      <div className="text-xs text-zinc-500">{data.subtitle}</div>
      {data.state && <pre className="mt-2 text-[10px] bg-zinc-50 p-2 rounded-xl overflow-auto max-h-28">{JSON.stringify(data.state, null, 2)}</pre>}
    </div>
  )
}
const nodeTypes = { stage: StageNode }

function StudioInner() {
  const [nodes, setNodes, onNodesChange] = useNodesState([
    { id: 'input', type: 'stage', position: { x: 0, y: 80 }, data: { label: 'Input', subtitle: 'Human / System', state: { query: 'Hello' } } },
    { id: 'planner', type: 'stage', position: { x: 300, y: 80 }, data: { label: 'Planner', subtitle: 'LLM (policy)' } },
    { id: 'tool1', type: 'stage', position: { x: 600, y: 40 }, data: { label: 'Tool', subtitle: 'Function call', tool: 'calc', params: { expression: '2+3*4' } } },
    { id: 'tool2', type: 'stage', position: { x: 600, y: 140 }, data: { label: 'Tool', subtitle: 'Function call', tool: 'weather', params: { city: 'Delhi' } } },
    { id: 'output', type: 'stage', position: { x: 900, y: 80 }, data: { label: 'Output', subtitle: 'Response' } },
  ])
  const [edges, setEdges, onEdgesChange] = useEdgesState([
    { id: 'e1', source: 'input', target: 'planner', animated: true },
    { id: 'e2', source: 'planner', target: 'tool1' },
    { id: 'e3', source: 'planner', target: 'tool2' },
    { id: 'e4', source: 'tool1', target: 'output' },
    { id: 'e5', source: 'tool2', target: 'output' },
  ])

  const reactFlowWrapper = useRef<HTMLDivElement | null>(null)
  const [rfInstance, setRfInstance] = useState<any>(null)
  const onDragStart = (event: React.DragEvent, nodeData: any) => {
    event.dataTransfer.setData('application/reactflow', JSON.stringify(nodeData))
    event.dataTransfer.effectAllowed = 'move'
  }
  const onDragOver = (event: React.DragEvent) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move' }
  const onDrop = (event: React.DragEvent) => {
    event.preventDefault()
    const bounds = reactFlowWrapper.current!.getBoundingClientRect()
    const payload = JSON.parse(event.dataTransfer.getData('application/reactflow'))
    const position = rfInstance.project({ x: event.clientX - bounds.left, y: event.clientY - bounds.top })
    const id = `${payload.type || 'stage'}-${Date.now()}`
    const newNode = { id, type: 'stage', position, data: payload }
    setNodes((nds) => nds.concat(newNode))
  }

  const onConnect = useCallback((params: any) => setEdges((eds) => addEdge(params, eds)), [setEdges])

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [logs, setLogs] = useState<any[]>([])
  const [state, setState] = useState<any>({})
  const esRef = useRef<EventSource | null>(null)

  useEffect(() => { (async () => {
    const res = await fetch('/api/sessions', { method: 'POST' })
    const json = await res.json()
    setSessionId(json.session_id)
  })() }, [])

  const runOnce = useCallback(async () => {
    if (!sessionId) return
    setRunning(true); setLogs([])
    const payload = { session_id: sessionId, graph: { nodes, edges }, input: { text: 'Weather in Delhi?' } }
    await fetch('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })

    if (esRef.current) esRef.current.close()
    const es = new EventSource(`/api/stream?session_id=${sessionId}`)
    esRef.current = es

    es.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data)
        setLogs((l) => [...l, evt])
        if (evt.type === 'state_patch' && evt.node) {
          setNodes((ns) => ns.map((n) => (n.id === evt.node ? { ...n, data: { ...n.data, state: { ...(n.data?.state || {}), ...(evt.patch || {}) } } } : n)))
        }
        if (evt.type === 'done') { setState(evt.metrics || {}); setRunning(false); es.close() }
      } catch {}
    }
    es.onerror = () => { setRunning(false); es.close() }
  }, [sessionId, nodes, edges])

  const selectedNode = nodes.find((n) => n.id === selectedId)
  const updateSelected = (patch: any) => { if (!selectedNode) return; setNodes((ns) => ns.map((n) => (n.id === selectedNode.id ? { ...n, data: { ...n.data, ...patch } } : n))) }

  return (
    <div className="h-screen w-full bg-gradient-to-b from-zinc-50 to-white">
      <div className="p-4 flex items-center justify-between">
        <div className="text-xl font-bold">PRIQ Agentic Studio</div>
        <div className="flex items-center gap-2">
          <button className="px-3 py-2 rounded-2xl shadow bg-black text-white disabled:opacity-50" onClick={runOnce} disabled={running || !sessionId}>{running ? 'Running…' : 'Run'}</button>
          <button className="px-3 py-2 rounded-2xl border" onClick={() => { setLogs([]); setState({}) }}>Reset</button>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-4 p-4">
        <div className="col-span-2">
          <div className="rounded-2xl border p-3 bg-white">
            <div className="text-sm font-semibold mb-2">Node Palette</div>
            <ul className="space-y-2 text-sm">
              <li draggable onDragStart={(e) => onDragStart(e as any, { label: 'LLM', subtitle: 'Model call' })} className="cursor-move px-2 py-1 rounded-xl border">LLM</li>
              <li draggable onDragStart={(e) => onDragStart(e as any, { label: 'Tool', subtitle: 'Function call', tool: 'calc', params: { expression: 'sin(PI/4)**2' } })} className="cursor-move px-2 py-1 rounded-xl border">Tool: Calc</li>
              <li draggable onDragStart={(e) => onDragStart(e as any, { label: 'Tool', subtitle: 'Function call', tool: 'weather', params: { city: 'Delhi' } })} className="cursor-move px-2 py-1 rounded-xl border">Tool: Weather</li>
              <li draggable onDragStart={(e) => onDragStart(e as any, { label: 'Router', subtitle: 'Conditional' })} className="cursor-move px-2 py-1 rounded-xl border">Router</li>
              <li draggable onDragStart={(e) => onDragStart(e as any, { label: 'Memory', subtitle: 'State' })} className="cursor-move px-2 py-1 rounded-xl border">Memory</li>
              <li draggable onDragStart={(e) => onDragStart(e as any, { label: 'Aggregator', subtitle: 'Reducer' })} className="cursor-move px-2 py-1 rounded-xl border">Aggregator</li>
            </ul>
          </div>
        </div>

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
            onSelectionChange={({ nodes }) => setSelectedId(nodes?.[0]?.id ?? null)}
          >
            <Background />
            <Controls />
            <MiniMap />
            <Panel position="top-left">
              <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="text-xs p-2 bg-white/80 rounded-xl shadow">Drag from the palette → drop on canvas. Edit Tool params on the right. Connect nodes, then Run.</motion.div>
            </Panel>
          </ReactFlow>
        </div>

        <div className="col-span-3 h-[75vh] grid grid-rows-2 gap-4">
          <div className="rounded-2xl border p-3 bg-white overflow-auto">
            <div className="text-sm font-semibold mb-2">Inspector</div>
            {selectedNode ? (
              <div className="space-y-2 text-sm">
                <div>ID: <code>{selectedNode.id}</code></div>
                <div className="flex items-center gap-2"><label className="w-24">Label</label><input className="border rounded px-2 py-1 w-full" value={selectedNode.data?.label || ''} onChange={(e) => updateSelected({ label: e.target.value })} /></div>
                {selectedNode.data?.label === 'Tool' && (
                  <>
                    <div className="flex items-center gap-2"><label className="w-24">Tool</label>
                      <select className="border rounded px-2 py-1 w-full" value={selectedNode.data?.tool || 'calc'} onChange={(e) => updateSelected({ tool: e.target.value })}>
                        <option value="calc">calc</option>
                        <option value="weather">weather</option>
                      </select>
                    </div>
                    {(selectedNode.data?.tool || 'calc') === 'calc' && (
                      <div className="flex items-center gap-2"><label className="w-24">Expression</label>
                        <input className="border rounded px-2 py-1 w-full" value={selectedNode.data?.params?.expression || ''} onChange={(e) => updateSelected({ params: { ...(selectedNode.data?.params || {}), expression: e.target.value } })} />
                      </div>
                    )}
                    {selectedNode.data?.tool === 'weather' && (
                      <div className="flex items-center gap-2"><label className="w-24">City</label>
                        <input className="border rounded px-2 py-1 w-full" value={selectedNode.data?.params?.city || ''} onChange={(e) => updateSelected({ params: { ...(selectedNode.data?.params || {}), city: e.target.value } })} />
                      </div>
                    )}
                  </>
                )}
                <div className="text-xs text-zinc-500">State:</div>
                <pre className="text-[11px] bg-zinc-50 p-2 rounded">{JSON.stringify(selectedNode.data?.state || {}, null, 2)}</pre>
              </div>
            ) : (<div className="text-sm text-zinc-500">Select a node to edit.</div>)}
          </div>
          <div className="rounded-2xl border p-3 bg-white overflow-auto">
            <div className="text-sm font-semibold mb-2">Event Log</div>
            <ul className="space-y-1 text-[11px]">
              {logs.map((l, i) => (
                <li key={i} className="flex items-center gap-2"><span className="inline-block h-1.5 w-1.5 rounded-full bg-blue-500" />
                  <span className="font-mono">{l.node || l.type}</span>
                  <span className="text-zinc-500">{l.message || JSON.stringify(l.patch || l)}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      <div className="p-4">
        <div className="rounded-2xl border p-3 bg-white"><div className="text-sm font-semibold mb-2">Console</div><pre className="text-[11px] whitespace-pre-wrap">Ready.</pre></div>
      </div>
    </div>
  )
}

export default function Studio() {
  return (
    <ReactFlowProvider>
      <StudioInner />
    </ReactFlowProvider>
  )
}
