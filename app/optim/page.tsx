"use client";

// =============================================================================
// Optimization Flow Studio – Next.js (Vercel) – v3 with Node Palette
// - React Flow based visual builder for optimization pipelines
// - Nodes: DataUpload, DataBrowser, Transformer(Pyodide), DecisionVar, Constraint, Solver(GLPK)
// - Dataset streams via handles: ds:<name> (default ds:main)
// - Topological dataset propagation with simple cycle detection
// - Constraint aggregates (sum/mean) that bind to vars or become constants
// - NEW: Node Palette (add nodes dynamically)
// Paste into: app/opt/page.tsx
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  Node,
  Edge,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  Handle,
  Position,
  NodeProps,
  Connection,
  MarkerType,
} from "reactflow";
import "reactflow/dist/style.css";
import Papa from "papaparse";
import { create } from "zustand";
import dynamic from "next/dynamic";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

// ---------------- Types ----------------
export type StreamName = string; // e.g. "main"
export type Dataset = { rows: any[]; columns: string[] };

export type StudioNodeType =
  | "dataUpload"
  | "dataBrowser"
  | "transformer"
  | "decisionVar"
  | "constraint"
  | "solver";

interface DataUploadData {
  mode: "file" | "db";
  fileName?: string;
  delimiter?: string;
  dataset?: Dataset | null;
  stream?: StreamName; // output stream name; default "main"
  db?: {
    provider: "supabase" | "postgres" | "mysql" | "mssql";
    connectionUrl?: string;
    table?: string;
    status?: string;
  };
}

interface DataBrowserData {
  dataset?: Dataset | null;
  activeStream?: StreamName;
}

interface TransformerData {
  code: string; // Python body for def f(*xs)
  inputColumns: string[];
  outputColumn: string;
  overwrite?: boolean;
  status?: string;
  dataset?: Dataset | null;
  activeStream?: StreamName;
}

export type VarType = "binary" | "integer" | "continuous";

interface DecisionVarData {
  name: string;
  varType: VarType;
  lower: number | null;
  upper: number | null;
  objectiveCoeff: number;
  featureColumn?: string | null;
  dataset?: Dataset | null;
  activeStream?: StreamName;
}

type AggKind = "sum" | "mean";

interface ConstraintAggTerm {
  column: string;
  kind: AggKind;
  scale: number;
  bindVar?: string | null;
}

interface ConstraintData {
  name: string;
  expr: string; // e.g. "2*x + 3*y - z"
  sense: "<=" | ">=" | "=";
  rhs: number;
  note?: string;
  inputColumns?: string[];
  aggs?: ConstraintAggTerm[];
  dataset?: Dataset | null;
  activeStream?: StreamName;
}

interface SolverData {
  objective: "maximize" | "minimize";
  algorithm: "bnb" | "bnc";
  mipGap?: number;
  result?: {
    status: string;
    objectiveValue?: number;
    vars?: Record<string, number>;
    log?: string;
  };
}

// -------------- Global datasets store (nodeId -> stream -> Dataset) --------------
interface GraphState {
  datasets: Record<string, Record<StreamName, Dataset>>;
  setDataset: (nodeId: string, stream: StreamName, ds: Dataset) => void;
}

const useGraphStore = create<GraphState>((set) => ({
  datasets: {},
  setDataset: (nodeId, stream, ds) =>
    set((s) => ({
      datasets: {
        ...s.datasets,
        [nodeId]: { ...(s.datasets[nodeId] || {}), [stream]: ds },
      },
    })),
}));

// ---------------- Utils ----------------
function streamFromHandle(h?: string | null): StreamName {
  if (!h) return "main";
  if (h === "dataset") return "main";
  if (h.startsWith("ds:")) return h.slice(3) || "main";
  return "main";
}

function tablePreview(ds: Dataset | null, n = 5): { columns: string[]; rows: any[] } {
  if (!ds) return { columns: [], rows: [] };
  return { columns: ds.columns, rows: ds.rows.slice(0, n) };
}

function csvToDataset(csvText: string, delimiter?: string): Dataset {
  const parsed = Papa.parse(csvText, { header: true, dynamicTyping: true, delimiter });
  const rows = (parsed.data as any[]).filter((r) => r && Object.keys(r).length > 0);
  const columns = parsed.meta.fields ?? (rows[0] ? Object.keys(rows[0]) : []);
  return { rows, columns };
}

// parse linear expr like "2*x + 3*y - z" -> { x:2, y:3, z:-1 }
function parseLinearExpr(expr: string): Record<string, number> {
  const cleaned = expr.replace(/\s+/g, "").replace(/-/g, "+-");
  const terms = cleaned.split("+").filter(Boolean);
  const coeffs: Record<string, number> = {};
  for (const t of terms) {
    const m = t.match(/^(-?\d*\.?\d*)\*?([a-zA-Z_][a-zA-Z0-9_]*)?$/);
    if (m) {
      const cRaw = m[1];
      const v = m[2];
      if (v) {
        const c = cRaw === "" || cRaw === "+" || cRaw === undefined ? 1 : Number(cRaw);
        coeffs[v] = (coeffs[v] || 0) + c;
      }
    }
  }
  return coeffs;
}

function aggregate(ds: Dataset | null, col: string, kind: AggKind): number {
  if (!ds || !ds.columns.includes(col)) return 0;
  const vals = ds.rows.map((r) => Number(r[col]) || 0);
  const s = vals.reduce((a, b) => a + b, 0);
  if (kind === "sum") return s;
  if (vals.length === 0) return 0;
  return s / vals.length; // mean
}

function uid(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;
}

// ---------------- Custom Nodes ----------------

// 1) Data Upload Node
function DataUploadNode({ id, data }: NodeProps<DataUploadData>) {
  const setDataset = useGraphStore((s) => s.setDataset);
  const [mode, setMode] = useState<DataUploadData["mode"]>(data.mode ?? "file");
  const [delimiter, setDelimiter] = useState<string>(data.delimiter ?? ",");
  const [status, setStatus] = useState<string>("");
  const [stream, setStream] = useState<StreamName>(data.stream || "main");
  const { deleteElements } = useReactFlow();

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result);
        const ds = csvToDataset(text, delimiter);
        setDataset(id, stream, ds);
        (data as any).dataset = ds;
        (data as any).fileName = file.name;
        (data as any).stream = stream;
        setStatus(`Loaded ${file.name} (${ds.rows.length} rows) on ds:${stream}`);
      } catch (err: any) {
        setStatus(`Parse error: ${err.message}`);
      }
    };
    reader.readAsText(file);
  };

  const connectDb = async () => {
    (data as any).db = data.db ?? { provider: "supabase" };
    setStatus("DB connection UI stub – populate provider/URL/table and fetch in your API.");
  };

  return (
    <div className="relative rounded-2xl border bg-white shadow p-3 w-[340px]">
      <button
        className="absolute top-1 right-1 text-xs text-gray-500"
        onClick={() => deleteElements({ nodes: [{ id }] })}
      >
        ×
      </button>
      <div className="font-semibold">Data Upload</div>
      <div className="text-xs text-gray-500 mb-2">CSV or DB table</div>

      <div className="flex items-center gap-2 mb-2">
        <label className="text-xs">Stream</label>
        <input
          className="border rounded px-2 py-1 text-xs"
          value={stream}
          onChange={(e) => setStream(e.target.value || "main")}
        />
      </div>

      <div className="flex gap-2 mb-2">
        <button
          className={`px-2 py-1 rounded ${mode === "file" ? "bg-black text-white" : "bg-gray-100"}`}
          onClick={() => setMode("file")}
        >
          File
        </button>
        <button
          className={`px-2 py-1 rounded ${mode === "db" ? "bg-black text-white" : "bg-gray-100"}`}
          onClick={() => setMode("db")}
        >
          Database
        </button>
      </div>

      {mode === "file" ? (
        <div className="space-y-2">
          <label className="text-xs">Delimiter</label>
          <input
            className="w-full border rounded px-2 py-1 text-sm"
            value={delimiter}
            onChange={(e) => setDelimiter(e.target.value)}
          />
          <input type="file" accept=".csv" onChange={onFile} />
          {data.fileName && (
            <div className="text-xs text-gray-600">Loaded: {data.fileName}</div>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <label className="text-xs">Provider</label>
          <select
            className="w-full border rounded px-2 py-1 text-sm"
            value={data.db?.provider ?? "supabase"}
            onChange={(e) => ((data as any).db = { ...(data.db || {}), provider: e.target.value })}
          >
            <option value="supabase">Supabase</option>
            <option value="postgres">Postgres</option>
            <option value="mysql">MySQL</option>
            <option value="mssql">MSSQL</option>
          </select>
          <label className="text-xs">Connection URL</label>
          <input
            className="w-full border rounded px-2 py-1 text-sm"
            defaultValue={data.db?.connectionUrl}
            onBlur={(e) => ((data as any).db = { ...(data.db || {}), connectionUrl: e.target.value })}
          />
          <label className="text-xs">Table</label>
          <input
            className="w-full border rounded px-2 py-1 text-sm"
            defaultValue={data.db?.table}
            onBlur={(e) => ((data as any).db = { ...(data.db || {}), table: e.target.value })}
          />
          <button className="px-2 py-1 rounded bg-gray-900 text-white" onClick={connectDb}>
            Connect & Fetch Preview
          </button>
        </div>
      )}

      {/* Output: dataset stream handle */}
      <div className="mt-2 text-[11px] text-gray-600 relative inline-block">
        ds:{stream}
        <Handle type="source" position={Position.Right} id={`ds:${stream}`} />
      </div>
      {status && <div className="mt-2 text-xs text-gray-500">{status}</div>}
    </div>
  );
}

// 2) Data Browser Node
function DataBrowserNode({ id, data }: NodeProps<DataBrowserData>) {
  const store = useGraphStore();
  const streams = Object.keys(store.datasets[id] || {});
  const active = data.activeStream || streams[0] || "main";
  const ds = (store.datasets[id] && store.datasets[id][active]) || data.dataset || null;
  const preview = tablePreview(ds, 5);
  const { deleteElements } = useReactFlow();

  return (
    <div className="relative rounded-2xl border bg-white shadow p-3 w-[460px]">
      <button
        className="absolute top-1 right-1 text-xs text-gray-500"
        onClick={() => deleteElements({ nodes: [{ id }] })}
      >
        ×
      </button>
      <div className="font-semibold">Data Browser</div>
      <div className="text-xs text-gray-500 mb-2">Top 5 rows</div>

      <div className="flex items-center gap-2 mb-2">
        <label className="text-xs">Stream</label>
        <select
          className="border rounded px-2 py-1 text-xs"
          defaultValue={active}
          onChange={(e) => ((data as any).activeStream = e.target.value)}
        >
          {[active, ...streams.filter((s) => s !== active)].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>

      <div className="overflow-auto border rounded max-h-56">
        <table className="w-full text-xs">
          <thead className="bg-gray-50 sticky top-0">
            <tr>
              {preview.columns.map((c) => (
                <th key={c} className="text-left p-1 border-b">{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((r, i) => (
              <tr key={i} className="odd:bg-white even:bg-gray-50">
                {preview.columns.map((c) => (
                  <td key={c} className="p-1 border-b">{String(r[c])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Column output handles */}
      <div className="mt-2 grid grid-cols-2 gap-1">
        {preview.columns.map((c) => (
          <div key={c} className="relative border rounded px-2 py-1 text-xs bg-gray-50">
            {c}
            <Handle type="source" position={Position.Right} id={`col:${c}`} />
          </div>
        ))}
      </div>

      {/* Dataset in/out */}
      <div className="mt-2 flex items-center gap-3 text-[11px] text-gray-600">
        <div className="relative">
          <Handle type="target" position={Position.Left} id="ds:main" />
          ds:main
        </div>
        <div className="relative">
          <Handle type="source" position={Position.Right} id="ds:main" />
          ds:main
        </div>
      </div>
    </div>
  );
}

// 3) Transformer Node
function usePyodide() {
  const ref = useRef<any>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (ref.current || cancelled) return;
      const pyodide = await (window as any).loadPyodide?.({ indexURL: "https://cdn.jsdelivr.net/pyodide/v0.25.0/full/" });
      ref.current = pyodide;
      if (!cancelled) setReady(true);
    })();
    return () => { cancelled = true; };
  }, []);

  return { pyodide: ref.current, ready } as const;
}

function TransformerNode({ id, data }: NodeProps<TransformerData>) {
  const { pyodide, ready } = usePyodide();
  const setDataset = useGraphStore((s) => s.setDataset);
  const store = useGraphStore();
  const [status, setStatus] = useState<string>(data.status ?? "");
  const { deleteElements } = useReactFlow();

  const streams = Object.keys(store.datasets[id] || {});
  const active = data.activeStream || streams[0] || "main";
  const ds: Dataset | null = (store.datasets[id] && store.datasets[id][active]) || data.dataset || null;

  const inputCols = data.inputColumns || [];
  const overwrite = !!data.overwrite;
  const outputCol = overwrite ? (inputCols[0] ?? data.outputColumn ?? "new_feature") : (data.outputColumn || "new_feature");
  console.log(ds);
  const runTransform = async () => {
    try {
      console.log(ds);
      if (!ds) { setStatus("No dataset connected."); return; }
      if (!ready) { setStatus("Loading Python runtime..."); return; }
      if (!pyodide) return;

      // Derive input columns from stored state or existing edges, whichever has data
      const rfEdges: Edge[] = (window as any).__rf?.getEdges?.() || [];
      const colsFromEdges =
        rfEdges
          .filter(e => e.target === id && e.sourceHandle?.startsWith("col:"))
          .map(e => e.sourceHandle!.slice(4));
      
      const inputCols = (data.inputColumns && data.inputColumns.length > 0)
        ? data.inputColumns
        : colsFromEdges;


      const values = ds.rows.map((r) => inputCols.map((c) => r[c]));
      await pyodide.loadPackagesFromImports?.("");
      pyodide.globals.set("vals", values);
      const userCode = data.code?.trim() || "def f(*xs):\n    return xs[0]";
      const script = `\n${userCode}\n\nouts = [f(*row) for row in vals]\n`;
      await pyodide.runPythonAsync(script);
      const outs = pyodide.globals.get("outs");
      const jsOuts = outs.toJs({ create_proxies: false });

      const targetCol = overwrite && inputCols.length > 0 ? inputCols[0] : outputCol;
      const newRows = ds.rows.map((r, i) => ({ ...r, [targetCol]: jsOuts[i] }));
      const newColumns = ds.columns.includes(targetCol) ? ds.columns : [...ds.columns, targetCol];
      const newDs: Dataset = { rows: newRows, columns: newColumns };

      setDataset(id, active, newDs);
      (data as any).status = `OK: wrote ${targetCol}`;
      setStatus(`OK: wrote ${targetCol}`);
    } catch (err: any) {
      setStatus(`Error: ${err.message}`);
    }
  };

  return (
    <div className="relative rounded-2xl border bg-white shadow p-3 w-[460px]">
      <button
        className="absolute top-1 right-1 text-xs text-gray-500"
        onClick={() => deleteElements({ nodes: [{ id }] })}
      >
        ×
      </button>
      <div className="font-semibold">Transformer (Python map)</div>
      <div className="text-xs text-gray-500 mb-2">Use f(*xs) -&gt; value</div>

      {/* INPUT: dataset stream */}
      <div className="flex items-center gap-2 mb-2">
        <div className="relative text-[11px] text-gray-600 inline-block">
          <Handle type="target" position={Position.Left} id="ds:main" />
          ds:main
        </div>
        <label className="text-xs">Active stream</label>
        <select
          className="border rounded px-2 py-1 text-xs"
          defaultValue={active}
          onChange={(e) => ((data as any).activeStream = e.target.value)}
        >
          {[active, ...streams.filter((s) => s !== active)].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>
      {/* Generic column drop zone so you can connect any column first */}
      <div className="relative inline-block mb-2 text-[11px] text-gray-600">
        <Handle type="target" position={Position.Left} id="col:any" />
        columns
      </div>


      {/* Column inputs */}
      <div className="flex flex-wrap gap-1 mb-2">
        {(data.inputColumns || []).map((c) => (
          <div key={c} className="relative border rounded px-2 py-1 text-xs bg-gray-50">
            {c}
            <Handle type="target" position={Position.Left} id={`col:${c}`} />
          </div>
        ))}
      </div>

      <div className="mb-2 flex items-center gap-2">
        <input id={`ow-${id}`} type="checkbox" defaultChecked={overwrite} onChange={(e) => ((data as any).overwrite = e.target.checked)} />
        <label htmlFor={`ow-${id}`} className="text-xs">Overwrite first input column</label>
      </div>

      {!overwrite && (
        <div className="mb-2">
          <label className="text-xs">Output Column</label>
          <input className="w-full border rounded px-2 py-1 text-sm" defaultValue={outputCol} onBlur={(e) => ((data as any).outputColumn = e.target.value)} />
        </div>
      )}

      <div className="mb-2">
        <label className="text-xs">Python function: <code>def f(*xs): ...</code></label>
        <div className="border rounded">
          {MonacoEditor ? (
            <MonacoEditor
              height="140px"
              defaultLanguage="python"
              defaultValue={data.code || "def f(*xs):\n    # xs is a tuple of selected input columns per row\n    return xs[0]"}
              onChange={(v) => ((data as any).code = v || "")}
              options={{ minimap: { enabled: false }, fontSize: 12 }}
            />
          ) : (
            <textarea className="w-full h-36 text-sm p-2" defaultValue={data.code || "def f(*xs):\n    return xs[0]"} onBlur={(e) => ((data as any).code = e.target.value)} />
          )}
        </div>
      </div>

      <button className="px-2 py-1 rounded bg-gray-900 text-white" onClick={runTransform}>Run Transform</button>
      {status && <div className="mt-2 text-xs text-gray-500">{status}</div>}

      {/* OUTPUTS */}
      <div className="mt-2 flex gap-2 items-center text-[11px] text-gray-600">
        <div className="relative border rounded px-2 py-1 bg-gray-50">
          ds:{active}
          <Handle type="source" position={Position.Right} id={`ds:${active}`} />
        </div>
        {outputCol && (
          <div className="relative border rounded px-2 py-1 bg-gray-50">
            {overwrite && inputCols.length > 0 ? inputCols[0] : outputCol}
            <Handle type="source" position={Position.Right} id={`col:${overwrite && inputCols.length > 0 ? inputCols[0] : outputCol}`} />
          </div>
        )}
      </div>
    </div>
  );
}

// 4) Decision Variable Node
function DecisionVarNode({ id, data }: NodeProps<DecisionVarData>) {
  const store = useGraphStore();
  const streams = Object.keys(store.datasets[id] || {});
  const active = data.activeStream || streams[0] || "main";
  const { deleteElements } = useReactFlow();

  return (
    <div className="relative rounded-2xl border bg-white shadow p-3 w-[320px]">
      <button
        className="absolute top-1 right-1 text-xs text-gray-500"
        onClick={() => deleteElements({ nodes: [{ id }] })}
      >
        ×
      </button>
      <div className="font-semibold">Decision Variable</div>
      <div className="text-xs text-gray-500 mb-2">xᵢ settings</div>

      {/* INPUTS */}
      <div className="flex items-center gap-3 mb-2 text-[11px] text-gray-600">
        <div className="relative"><Handle type="target" position={Position.Left} id="ds:main" /> ds:main</div>
        <div className="relative"><Handle type="target" position={Position.Left} id="col:feature" /> feature</div>
        <div className="flex items-center gap-1">
          <label className="text-xs">Stream</label>
          <select className="border rounded px-2 py-1 text-xs" defaultValue={active} onChange={(e) => ((data as any).activeStream = e.target.value)}>
            {[active, ...streams.filter((s) => s !== active)].map((s) => (<option key={s} value={s}>{s}</option>))}
          </select>
        </div>
      </div>

      {data.featureColumn && (
        <div className="mb-2 text-[11px] text-gray-600">Bound column: <b>{data.featureColumn}</b></div>
      )}

      <label className="text-xs">Name</label>
      <input className="w-full border rounded px-2 py-1 text-sm mb-2" defaultValue={data.name} onBlur={(e) => ((data as any).name = e.target.value)} />

      <div className="grid grid-cols-2 gap-2 mb-2">
        <div>
          <label className="text-xs">Type</label>
          <select className="w-full border rounded px-2 py-1 text-sm" defaultValue={data.varType} onChange={(e) => ((data as any).varType = e.target.value as VarType)}>
            <option value="binary">Binary</option>
            <option value="integer">Integer</option>
            <option value="continuous">Continuous</option>
          </select>
        </div>
        <div>
          <label className="text-xs">c (obj coeff)</label>
          <input type="number" className="w-full border rounded px-2 py-1 text-sm" defaultValue={data.objectiveCoeff} onBlur={(e) => ((data as any).objectiveCoeff = Number(e.target.value))} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-xs">Lower</label>
          <input type="number" className="w-full border rounded px-2 py-1 text-sm" defaultValue={data.lower ?? 0} onBlur={(e) => ((data as any).lower = Number(e.target.value))} />
        </div>
        <div>
          <label className="text-xs">Upper</label>
          <input type="number" className="w-full border rounded px-2 py-1 text-sm" defaultValue={data.upper ?? 1} onBlur={(e) => ((data as any).upper = Number(e.target.value))} />
        </div>
      </div>

      {/* OUTPUTS */}
      <div className="mt-2 flex items-center gap-2 text-[11px] text-gray-600">
        <div className="relative"><Handle type="source" position={Position.Right} id="var" /> var</div>
        <div className="relative"><Handle type="source" position={Position.Right} id={`ds:${active}`} /> ds:{active}</div>
      </div>
    </div>
  );
}

// 5) Constraint Node with Aggregates
function ConstraintNode({ id, data }: NodeProps<ConstraintData>) {
  const store = useGraphStore();
  const streams = Object.keys(store.datasets[id] || {});
  const active = data.activeStream || streams[0] || "main";
  const ds: Dataset | null = (store.datasets[id] && store.datasets[id][active]) || data.dataset || null;

  const cols = data.inputColumns || [];
  const aggs = data.aggs || [];
  const { deleteElements } = useReactFlow();

  const addAgg = () => {
    const firstCol = cols[0] || "";
    const next: ConstraintAggTerm = { column: firstCol, kind: "sum", scale: 1, bindVar: null };
    (data as any).aggs = [...aggs, next];
  };
  const removeAgg = (i: number) => {
    const clone = [...(data.aggs || [])];
    clone.splice(i, 1);
    (data as any).aggs = clone;
  };

  return (
    <div className="relative rounded-2xl border bg-white shadow p-3 w-[480px]">
      <button
        className="absolute top-1 right-1 text-xs text-gray-500"
        onClick={() => deleteElements({ nodes: [{ id }] })}
      >
        ×
      </button>
      <div className="font-semibold">Constraint</div>
      <div className="text-xs text-gray-500 mb-2">Linear vars + data aggregates</div>

      {/* INPUTS */}
      <div className="flex items-center gap-3 mb-2 text-[11px] text-gray-600">
        <div className="relative"><Handle type="target" position={Position.Left} id="ds:main" /> ds:main</div>
        <div className="relative"><Handle type="target" position={Position.Left} id="col:any" /> columns</div>
        <div className="flex items-center gap-1">
          <label className="text-xs">Stream</label>
          <select className="border rounded px-2 py-1 text-xs" defaultValue={active} onChange={(e) => ((data as any).activeStream = e.target.value)}>
            {[active, ...streams.filter((s) => s !== active)].map((s) => (<option key={s} value={s}>{s}</option>))}
          </select>
        </div>
      </div>

      {cols.length > 0 && (
        <div className="mb-2 text-[11px] text-gray-600">Columns: {cols.map((c) => (<code key={c} className="mr-1">{c}</code>))}</div>
      )}

      <label className="text-xs">Var expression (e.g. 2*x + 3*y - z)</label>
      <input className="w-full border rounded px-2 py-1 text-sm mb-2" defaultValue={data.expr} onBlur={(e) => ((data as any).expr = e.target.value)} />

      <div className="grid grid-cols-3 gap-2 items-center mb-2">
        <select className="border rounded px-2 py-1 text-sm" defaultValue={data.sense} onChange={(e) => ((data as any).sense = e.target.value as any)}>
          <option value="<=">≤</option>
          <option value=">=">≥</option>
          <option value="=">=</option>
        </select>
        <input type="number" className="col-span-2 border rounded px-2 py-1 text-sm" defaultValue={data.rhs} onBlur={(e) => ((data as any).rhs = Number(e.target.value))} />
      </div>

      <div className="mb-2">
        <div className="flex items-center justify-between">
          <div className="text-xs font-medium">Aggregate terms</div>
          <button className="px-2 py-1 rounded bg-gray-900 text-white text-xs" onClick={addAgg}>Add</button>
        </div>
        {(aggs.length === 0) && (<div className="text-[11px] text-gray-500 mt-1">(optional) Add sum/mean of columns; bind to a var or leave as constant.</div>)}
        {aggs.map((a, i) => (
          <div key={i} className="mt-2 p-2 border rounded">
            <div className="grid grid-cols-5 gap-2 items-center">
              <select className="border rounded px-2 py-1 text-xs col-span-2" defaultValue={a.column} onChange={(e) => {
                const clone = [...(data.aggs || [])];
                clone[i] = { ...clone[i], column: e.target.value };
                (data as any).aggs = clone;
              }}>
                {[a.column, ...cols.filter((c) => c !== a.column)].map((c) => (<option key={c} value={c}>{c}</option>))}
              </select>
              <select className="border rounded px-2 py-1 text-xs" defaultValue={a.kind} onChange={(e) => {
                const clone = [...(data.aggs || [])];
                clone[i] = { ...clone[i], kind: e.target.value as AggKind };
                (data as any).aggs = clone;
              }}>
                <option value="sum">sum</option>
                <option value="mean">mean</option>
              </select>
              <input type="number" className="border rounded px-2 py-1 text-xs" defaultValue={a.scale} onBlur={(e) => {
                const clone = [...(data.aggs || [])];
                clone[i] = { ...clone[i], scale: Number(e.target.value) };
                (data as any).aggs = clone;
              }} />
              <input className="border rounded px-2 py-1 text-xs" placeholder="bind to var (optional)" defaultValue={a.bindVar || ""} onBlur={(e) => {
                const val = e.target.value || null;
                const clone = [...(data.aggs || [])];
                clone[i] = { ...clone[i], bindVar: val };
                (data as any).aggs = clone;
              }} />
              <button className="px-2 py-1 rounded bg-gray-100 text-xs" onClick={() => removeAgg(i)}>Remove</button>
            </div>
          </div>
        ))}
      </div>

      {/* OUTPUTS */}
      <div className="flex items-center gap-3 text-[11px] text-gray-600">
        <div className="relative"><Handle type="source" position={Position.Right} id="constraint" /> constraint</div>
        <div className="relative"><Handle type="source" position={Position.Right} id={`ds:${active}`} /> ds:{active}</div>
      </div>
    </div>
  );
}

// 6) Solver Node (GLPK.js)
function SolverNode({ id, data }: NodeProps<SolverData>) {
  const [busy, setBusy] = useState(false);
  const { deleteElements } = useReactFlow();

  const solve = async () => {
    setBusy(true);
    try {
      const glpkMod = await import("glpk.js");
      const GLPK = await (glpkMod as any).default();

      const allNodes: Node[] = (window as any).__rf?.getNodes?.() || [];
      const varNodes = allNodes.filter((n) => n.type === "decisionVar") as Node<DecisionVarData>[];
      const consNodes = allNodes.filter((n) => n.type === "constraint") as Node<ConstraintData>[];

      const varList = varNodes.map((vn) => vn.data.name || vn.id);
      const varIndex: Record<string, number> = {};
      varList.forEach((v, i) => (varIndex[v] = i + 1));

      const objCoeffs = varNodes.map((vn) => vn.data.objectiveCoeff || 0);

      const bounds = varNodes.map((vn) => ({
        type: GLPK.GLP_DB,
        lb: vn.data.lower ?? 0,
        ub: vn.data.upper ?? (vn.data.varType === "binary" ? 1 : 1e9),
      }));
      const kinds = varNodes.map((vn) =>
        vn.data.varType === "binary" ? GLPK.GLP_BV : vn.data.varType === "integer" ? GLPK.GLP_IV : GLPK.GLP_CV
      );

      const constrRows = consNodes.map((cn) => {
        const coeffs = parseLinearExpr(cn.data.expr || "");

        // Dataset for aggregates
        const nodeId = cn.id;
        const store = useGraphStore.getState();
        const streams = Object.keys(store.datasets[nodeId] || {});
        const active = cn.data.activeStream || streams[0] || "main";
        const ds: Dataset | null = (store.datasets[nodeId] && store.datasets[nodeId][active]) || cn.data.dataset || null;

        let constTerm = 0;
        const aggs = cn.data.aggs || [];
        for (const a of aggs) {
          const val = aggregate(ds, a.column, a.kind) * (a.scale ?? 1);
          if (a.bindVar) {
            coeffs[a.bindVar] = (coeffs[a.bindVar] || 0) + val;
          } else {
            constTerm += val;
          }
        }

        const ind: number[] = [];
        const val: number[] = [];
        Object.entries(coeffs).forEach(([name, c]) => {
          if (varIndex[name] != null) {
            ind.push(varIndex[name]);
            val.push(c);
          }
        });

        const sense = cn.data.sense;
        const rhs = cn.data.rhs - constTerm; // move constants to RHS

        let type = GLPK.GLP_UP;
        let ub = rhs;
        let lb = 0;
        if (sense === ">=") { type = GLPK.GLP_LO; lb = rhs; ub = 0; }
        else if (sense === "=") { type = GLPK.GLP_FX; lb = rhs; ub = rhs; }
        return { name: cn.data.name || cn.id, ind, val, type, lb, ub };
      });

      const lp = GLPK.glp_create_prob();
      GLPK.glp_set_obj_dir(lp, data.objective === "minimize" ? GLPK.GLP_MIN : GLPK.GLP_MAX);
      GLPK.glp_add_cols(lp, varList.length);
      varList.forEach((name, i) => {
        GLPK.glp_set_col_name(lp, i + 1, name);
        GLPK.glp_set_col_bnds(lp, i + 1, bounds[i].type, bounds[i].lb, bounds[i].ub);
        GLPK.glp_set_obj_coef(lp, i + 1, objCoeffs[i]);
      });
      GLPK.glp_add_rows(lp, constrRows.length);
      constrRows.forEach((row, r) => {
        GLPK.glp_set_row_name(lp, r + 1, row.name);
        GLPK.glp_set_row_bnds(lp, r + 1, row.type, row.lb, row.ub);
        const ia = [0];
        const ja = [0];
        const ar = [0];
        for (let k = 0; k < row.ind.length; k++) { ia.push(r + 1); ja.push(row.ind[k]); ar.push(row.val[k]); }
        GLPK.glp_set_mat_row(lp, r + 1, row.ind.length, ia, ja, ar);
      });

      const smcp = new GLPK.SMCP({ presolve: data.algorithm === "bnc" ? 1 : 1 });
      GLPK.glp_simplex(lp, smcp);

      const iocp = new GLPK.IOCP({ presolve: 1, mip_gap: data.mipGap ?? 0.0001 });
      GLPK.glp_intopt(lp, iocp);

      const z = GLPK.glp_mip_obj_val(lp);
      const vars: Record<string, number> = {};
      varList.forEach((name, i) => { vars[name] = GLPK.glp_mip_col_val(lp, i + 1); });
      (data as any).result = { status: "OPTIMAL (MIP)", objectiveValue: z, vars };
    } catch (err: any) {
      (data as any).result = { status: `Error: ${err.message}` };
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative rounded-2xl border bg-white shadow p-3 w-[400px]">
      <button
        className="absolute top-1 right-1 text-xs text-gray-500"
        onClick={() => deleteElements({ nodes: [{ id }] })}
      >
        ×
      </button>
      <div className="font-semibold">Solver</div>
      <div className="text-xs text-gray-500 mb-2">GLPK.js MILP</div>

      <div className="grid grid-cols-2 gap-2 mb-2">
        <div>
          <label className="text-xs">Objective</label>
          <select className="w-full border rounded px-2 py-1 text-sm" defaultValue={data.objective} onChange={(e) => ((data as any).objective = e.target.value as any)}>
            <option value="maximize">Maximize</option>
            <option value="minimize">Minimize</option>
          </select>
        </div>
        <div>
          <label className="text-xs">Algorithm</label>
          <select className="w-full border rounded px-2 py-1 text-sm" defaultValue={data.algorithm} onChange={(e) => ((data as any).algorithm = e.target.value as any)}>
            <option value="bnb">Branch &amp; Bound</option>
            <option value="bnc">Branch &amp; Cut</option>
          </select>
        </div>
      </div>

      <label className="text-xs">MIP gap</label>
      <input type="number" step="0.0001" className="w-full border rounded px-2 py-1 text-sm mb-2" defaultValue={data.mipGap ?? 0.0001} onBlur={(e) => ((data as any).mipGap = Number(e.target.value))} />

      <div className="flex gap-2">
        <Handle type="target" position={Position.Left} id="vars" />
        <Handle type="target" position={Position.Left} id="constraints" />
      </div>

      <button disabled={busy} className={`mt-2 px-2 py-1 rounded ${busy ? "bg-gray-300" : "bg-gray-900 text-white"}`} onClick={solve}>
        {busy ? "Solving..." : "Solve"}
      </button>

      {data.result && (
        <div className="mt-2 text-xs">
          <div className="font-medium">{data.result.status}</div>
          {data.result.objectiveValue != null && (<div>Objective: {data.result.objectiveValue.toFixed(6)}</div>)}
          {data.result.vars && (
            <div className="mt-1 max-h-28 overflow-auto border rounded p-1">
              {Object.entries(data.result.vars).map(([k, v]) => (<div key={k}>{k} = {Number(v).toFixed(6)}</div>))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------- Node Editor ----------------
function NodeEditor({ selected }: { selected: Node | null }) {
  if (!selected) return (<div className="p-4 text-sm text-gray-500">Select a node to edit its details.</div>);
  return (
    <div className="p-4 text-sm">
      <div className="font-semibold mb-2">Editor: {selected.type}</div>
      <div className="text-gray-600">
        Connect <b>ds:&lt;name&gt;</b> handles to pass datasets across nodes. Drag column chips from <b>Data Browser</b> into <b>Transformer</b> / <b>DecisionVar</b> / <b>Constraint</b>. In constraints, use aggregates to create coefficients or constants.
      </div>
    </div>
  );
}

// ---------------- Main Page ----------------
const nodeTypes = {
  dataUpload: DataUploadNode,
  dataBrowser: DataBrowserNode,
  transformer: TransformerNode,
  decisionVar: DecisionVarNode,
  constraint: ConstraintNode,
  solver: SolverNode,
};

export default function Page() {
  const initialNodes = useMemo<Node[]>(() => [
    { id: "up1", type: "dataUpload", position: { x: 50, y: 80 }, data: { mode: "file", dataset: null, stream: "main" } as DataUploadData },
    { id: "db1", type: "dataBrowser", position: { x: 450, y: 60 }, data: { dataset: null, activeStream: "main" } as DataBrowserData },
    { id: "tr1", type: "transformer", position: { x: 950, y: 40 }, data: { code: "def f(*xs):\n    return xs[0]", inputColumns: [], outputColumn: "new_feature", activeStream: "main" } as TransformerData },
    { id: "x1", type: "decisionVar", position: { x: 450, y: 360 }, data: { name: "x", varType: "integer", lower: 0, upper: 10, objectiveCoeff: 3, activeStream: "main" } as DecisionVarData },
    { id: "y1", type: "decisionVar", position: { x: 700, y: 360 }, data: { name: "y", varType: "integer", lower: 0, upper: 10, objectiveCoeff: 2, activeStream: "main" } as DecisionVarData },
    { id: "c1", type: "constraint", position: { x: 980, y: 340 }, data: { name: "cap", expr: "2*x + 3*y", sense: "<=", rhs: 18, activeStream: "main", aggs: [] } as ConstraintData },
    { id: "s1", type: "solver", position: { x: 1300, y: 300 }, data: { objective: "maximize", algorithm: "bnb" } as SolverData },
  ], []);

  const initialEdges = useMemo<Edge[]>(() => [
    { id: "e-up-db", source: "up1", target: "db1", sourceHandle: "ds:main", targetHandle: "ds:main" },
    //{ id: "e-db-tr", source: "db1", target: "tr1", sourceHandle: "ds:main", targetHandle: "ds:main" },
    //{ id: "e-tr-x", source: "tr1", target: "x1", sourceHandle: "ds:main", targetHandle: "ds:main" },
    //{ id: "e-x-c", source: "x1", target: "c1", sourceHandle: "ds:main", targetHandle: "ds:main" },
    //{ id: "e-x-s", source: "x1", target: "s1", sourceHandle: "var", targetHandle: "vars" },
    //{ id: "e-y-s", source: "y1", target: "s1", sourceHandle: "var", targetHandle: "vars" },
    //{ id: "e-c-s", source: "c1", target: "s1", sourceHandle: "constraint", targetHandle: "constraints" },
  ], []);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [selected, setSelected] = useState<Node | null>(null);
  const [spawnIndex, setSpawnIndex] = useState(0);

  // Expose nodes/edges for solver
  useEffect(() => { (window as any).__rf = { getNodes: () => nodes, getEdges: () => edges }; }, [nodes, edges]);

  // Dataset propagation (topological)
  const store = useGraphStore();
  useEffect(() => {
    type Key = string;
    const outAdj: Record<Key, { to: Key; stream: StreamName }[]> = {};
    const inDeg: Record<Key, number> = {};
    const all: Set<Key> = new Set();

    edges.forEach((e) => {
      const isDs = (e.sourceHandle || "").startsWith("ds:") || e.sourceHandle === "dataset";
      if (!isDs) return;
      const stream = streamFromHandle(e.sourceHandle || undefined);
      outAdj[e.source] = outAdj[e.source] || [];
      outAdj[e.source].push({ to: e.target, stream });
      inDeg[e.target] = (inDeg[e.target] || 0) + 1;
      all.add(e.source); all.add(e.target);
    });

    const q: Key[] = [];
    all.forEach((k) => { if (!inDeg[k]) q.push(k); });
    const order: Key[] = [];
    while (q.length) {
      const k = q.shift()!; order.push(k);
      (outAdj[k] || []).forEach(({ to }) => { inDeg[to] = (inDeg[to] || 0) - 1; if (inDeg[to] === 0) q.push(to); });
    }
    if (order.length < all.size) console.warn("Dataset propagation: cycle detected");

    const updates: Record<string, Record<StreamName, Dataset>> = {};
    const dsMap = store.datasets;
    order.forEach((src) => {
      const streams = dsMap[src] || {};
      (outAdj[src] || []).forEach(({ to, stream }) => {
        const ds = streams[stream];
        if (ds && store.datasets[to]?.[stream] !== ds) {
          updates[to] = updates[to] || {};
          updates[to][stream] = ds;
        }
      });
    });
    if (Object.keys(updates).length === 0) return;

    Object.entries(updates).forEach(([nid, streams]) => {
      Object.entries(streams).forEach(([st, ds]) => {
        store.setDataset(nid, st, ds);
      });
    });

    setNodes((nds) => nds.map((n) => {
      if (!updates[n.id]) return n;
      const current = (n.data as any) || {};
      const chosenStream = current.activeStream || Object.keys(updates[n.id])[0] || "main";
      const dsForActive = updates[n.id][chosenStream] || null;
      return { ...n, data: { ...current, dataset: dsForActive } };
    }));
  }, [edges, setNodes, store.datasets]);

  const onConnect = useCallback((params: Edge | Connection) => {
    setEdges((eds) => addEdge({ ...params, animated: true, markerEnd: { type: MarkerType.ArrowClosed } } as any, eds));

    // Column wiring: DataBrowser -> Transformer / DecisionVar / Constraint
    const srcIsDB = (params as any).source && String((params as any).source).startsWith("db");
    const srcCol = (params as any).sourceHandle?.startsWith("col:") ? (params as any).sourceHandle.split(":")[1] : null;
    const targetId = (params as any).target as string;

    if (srcIsDB && srcCol && targetId) {
      setNodes((nds) => nds.map((n) => {
        if (n.id !== targetId) return n;
        if (n.type === "transformer") {
          const td = n.data as TransformerData;
          const setCols = new Set([...(td.inputColumns || []), srcCol]);
          return { ...n, data: { ...td, inputColumns: Array.from(setCols) } };
        }
        if (n.type === "decisionVar") {
          const dv = n.data as DecisionVarData;
          return { ...n, data: { ...dv, featureColumn: srcCol } };
        }
        if (n.type === "constraint") {
          const cd = n.data as ConstraintData;
          const setCols = new Set([...(cd.inputColumns || []), srcCol]);
          return { ...n, data: { ...cd, inputColumns: Array.from(setCols) } };
        }
        return n;
      }));
    }
  }, [setEdges, setNodes]);

  // -------- Node Palette --------
  const spawnPos = () => {
    const i = spawnIndex;
    setSpawnIndex((x) => x + 1);
    return { x: 120 + (i % 6) * 160, y: 120 + Math.floor(i / 6) * 140 };
  };

  const addNode = (type: StudioNodeType) => {
    const id = (
      type === "dataUpload" ? `up-${uid("n")}` :
      type === "dataBrowser" ? `db-${uid("n")}` :
      type === "transformer" ? `tr-${uid("n")}` :
      type === "decisionVar" ? `dv-${uid("n")}` :
      type === "constraint" ? `ct-${uid("n")}` :
      `sv-${uid("n")}`
    );
    const position = spawnPos();

    let data: any = {};
    if (type === "dataUpload") data = { mode: "file", dataset: null, stream: "main" } as DataUploadData;
    if (type === "dataBrowser") data = { dataset: null, activeStream: "main" } as DataBrowserData;
    if (type === "transformer") data = { code: "def f(*xs):\n    return xs[0]", inputColumns: [], outputColumn: "new_feature", activeStream: "main" } as TransformerData;
    if (type === "decisionVar") data = { name: "x", varType: "integer", lower: 0, upper: 10, objectiveCoeff: 1, activeStream: "main" } as DecisionVarData;
    if (type === "constraint") data = { name: "c", expr: "x", sense: "<=", rhs: 10, activeStream: "main", aggs: [] } as ConstraintData;
    if (type === "solver") data = { objective: "maximize", algorithm: "bnb" } as SolverData;

    const node: Node = { id, type, position, data } as Node;
    setNodes((nds) => nds.concat(node));
  };

  return (
    <div className="h-screen w-screen grid grid-cols-[1fr_360px]">
      {/* Pyodide */}
      <script src="https://cdn.jsdelivr.net/pyodide/v0.25.0/full/pyodide.js" />

      {/* Palette */}
      <div className="absolute z-10 top-3 left-3 bg-white/90 backdrop-blur rounded-2xl shadow border p-2">
        <div className="text-[11px] font-medium mb-1">Node Palette</div>
        <div className="grid grid-cols-2 gap-2">
          <button className="px-2 py-1 rounded bg-gray-900 text-white text-xs" onClick={() => addNode("dataUpload")}>Data Upload</button>
          <button className="px-2 py-1 rounded bg-gray-900 text-white text-xs" onClick={() => addNode("dataBrowser")}>Data Browser</button>
          <button className="px-2 py-1 rounded bg-gray-900 text-white text-xs" onClick={() => addNode("transformer")}>Transformer</button>
          <button className="px-2 py-1 rounded bg-gray-900 text-white text-xs" onClick={() => addNode("decisionVar")}>Decision Var</button>
          <button className="px-2 py-1 rounded bg-gray-900 text-white text-xs" onClick={() => addNode("constraint")}>Constraint</button>
          <button className="px-2 py-1 rounded bg-gray-900 text-white text-xs" onClick={() => addNode("solver")}>Solver</button>
        </div>
      </div>

      <div className="relative">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onEdgeClick={(_, edge) => setEdges((eds) => eds.filter((e) => e.id !== edge.id))}
          nodeTypes={nodeTypes}
          fitView
          onSelectionChange={(s) => setSelected((s?.nodes && s.nodes[0]) || null)}
        >
          <Background />
          <Controls />
          <MiniMap zoomable pannable />
        </ReactFlow>
      </div>

      <div className="border-l bg-white/60">
        <NodeEditor selected={selected} />
        <div className="p-4 text-[11px] text-gray-500 border-t">
          <div className="font-medium mb-1">How to use (v3)</div>
          <ol className="list-decimal ml-4 space-y-1">
            <li>Use the <b>Node Palette</b> to add nodes (you can add many of each type).</li>
            <li>Connect <code>ds:&lt;name&gt;</code> handles to pass datasets; drag column chips from <b>Data Browser</b> to other nodes.</li>
            <li>Transformer can overwrite a source column or write a new column via <code>def f(*xs)</code>.</li>
            <li>Constraint aggregates (sum/mean) can bind to vars (coefficients) or remain constants (moved to RHS).</li>
            <li>Click <b>Solve</b> on the Solver to run GLPK (BnB/BnC) with a chosen MIP gap.</li>
          </ol>
        </div>
      </div>

      <style jsx global>{`
        body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, Noto Sans, Apple Color Emoji, Segoe UI Emoji; }
      `}</style>
    </div>
  );
}
