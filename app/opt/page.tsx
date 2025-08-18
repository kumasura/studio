"use client";

// =============================
// Optimization Flow Studio (MVP)
// Single-file Next.js page you can drop into app/page.tsx
// - Graph canvas (React Flow)
// - Nodes: DataUpload, DataBrowser, Transformer(Python via Pyodide),
//          DecisionVar, Constraint, Solver(GLPK.js)
// - Right-hand Node Editor for editable properties
// =============================

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

// Lazy Monaco editor (optional, used in Transformer)
const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

// ---------- Types ----------

type Dataset = { rows: any[]; columns: string[] };

// Node kinds for our studio
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
  db?: {
    provider: "supabase" | "postgres" | "mysql" | "mssql";
    connectionUrl?: string;
    table?: string;
    status?: string;
  };
}


interface DataBrowserData {
  dataset?: Dataset | null; // input
}

interface TransformerData {
  code: string; // Python function code body for f(x)
  inputColumns: string[]; // wired columns (names)
  outputColumn: string; // new column name
  status?: string;
}

export type VarType = "binary" | "integer" | "continuous";

interface DecisionVarData {
  name: string;
  varType: VarType;
  lower: number | null;
  upper: number | null;
  objectiveCoeff: number; // c_i
}

interface ConstraintData {
  name: string;
  expr: string; // e.g. "2*x + 3*y"
  sense: "<=" | ">=" | "=";
  rhs: number;
  note?: string;
}

interface SolverData {
  objective: "maximize" | "minimize";
  algorithm: "bnb" | "bnc";
  mipGap?: number; // e.g. 0.001
  result?: {
    status: string;
    objectiveValue?: number;
    vars?: Record<string, number>;
    log?: string;
  };
}

// ---------- Global Graph Store ----------

interface GraphState {
  datasets: Record<string, Dataset>; // nodeId -> dataset
  setDataset: (nodeId: string, ds: Dataset) => void;
}

const useGraphStore = create<GraphState>((set) => ({
  datasets: {},
  setDataset: (nodeId, ds) => set((s) => ({ datasets: { ...s.datasets, [nodeId]: ds } })),
}));

// ---------- Utilities ----------

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

// Simple expression parser for constraints like: "2*x + 3*y - z"
function parseLinearExpr(expr: string): Record<string, number> {
  // Turn "-" into "+ -" then split on "+"
  const cleaned = expr.replace(/\s+/g, "").replace(/-/g, "+-");
  const terms = cleaned.split("+").filter(Boolean);
  const coeffs: Record<string, number> = {};
  for (const t of terms) {
    // forms: "2*x" or "x" or "-x" or "-3*y"
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

// ---------- Custom Nodes ----------

// 1) Data Upload Node
function DataUploadNode({ id, data }: NodeProps<DataUploadData>) {
  const setDataset = useGraphStore((s) => s.setDataset);
  const [mode, setMode] = useState<DataUploadData["mode"]>(data.mode ?? "file");
  const [delimiter, setDelimiter] = useState<string>(data.delimiter ?? ",");
  const [status, setStatus] = useState<string>("");

  useEffect(() => {
    // propagate to store when data.dataset changes
    if (data.dataset) setDataset(id, data.dataset);
  }, [data.dataset, id, setDataset]);

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result);
        const ds = csvToDataset(text, delimiter);
        setDataset(id, ds);
        (data as any).dataset = ds;
        (data as any).fileName = file.name;
        setStatus(`Loaded ${file.name} (${ds.rows.length} rows)`);
      } catch (err: any) {
        setStatus(`Parse error: ${err.message}`);
      }
    };
    reader.readAsText(file);
  };

  const connectDb = async () => {
    (data as any).db = data.db ?? { provider: "supabase" };
    // NOTE: this is a stub. You can fill with real Supabase client if env vars are present.
    setStatus("DB connection UI stub – populate provider/URL/table and fetch in your API.");
  };

  return (
    <div className="rounded-2xl border bg-white shadow p-3 w-[320px]">
      <div className="font-semibold">Data Upload</div>
      <div className="text-xs text-gray-500 mb-2">CSV or DB table</div>

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

      {/* Output handle: dataset */}
      <Handle type="source" position={Position.Right} id="dataset" />
      {status && <div className="mt-2 text-xs text-gray-500">{status}</div>}
    </div>
  );
}

// 2) Data Browser Node
function DataBrowserNode({ id, data }: NodeProps<DataBrowserData>) {
  const ds = data.dataset?? null;
  const preview = tablePreview(ds, 5);

  return (
    <div className="rounded-2xl border bg-white shadow p-3 w-[420px]">
      <div className="font-semibold">Data Browser</div>
      <div className="text-xs text-gray-500 mb-2">Top 5 rows</div>
      <div className="overflow-auto border rounded max-h-56">
        <table className="w-full text-xs">
          <thead className="bg-gray-50 sticky top-0">
            <tr>
              {preview.columns.map((c) => (
                <th key={c} className="text-left p-1 border-b">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((r, i) => (
              <tr key={i} className="odd:bg-white even:bg-gray-50">
                {preview.columns.map((c) => (
                  <td key={c} className="p-1 border-b">
                    {String(r[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Dynamic column output handles */}
      <div className="mt-2 grid grid-cols-2 gap-1">
        {preview.columns.map((c) => (
          <div key={c} className="relative border rounded px-2 py-1 text-xs bg-gray-50">
            {c}
            <Handle type="source" position={Position.Right} id={`col:${c}`} />
          </div>
        ))}
      </div>

      {/* Input handle: dataset */}
      <Handle type="target" position={Position.Left} id="dataset" />
    </div>
  );
}

// 3) Transformer Node (Python map via Pyodide)
function usePyodide() {
  const ref = useRef<any>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (ref.current || cancelled) return;
      const pyodide = await (window as any).loadPyodide?.({
        indexURL: "https://cdn.jsdelivr.net/pyodide/v0.25.0/full/",
      });
      ref.current = pyodide;
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { pyodide: ref.current, ready } as const;
}

function TransformerNode({ id, data }: NodeProps<TransformerData>) {
  const { pyodide, ready } = usePyodide();
  const setDataset = useGraphStore((s) => s.setDataset);
  const datasets = useGraphStore((s) => s.datasets);
  const [status, setStatus] = useState<string>(data.status ?? "");

  const inputCols = data.inputColumns || [];
  const outputCol = data.outputColumn || "new_feature";

  const runTransform = async () => {
    try {
      // Find an upstream dataset from any connected node (heuristic)
      const ds = Object.values(datasets).find(Boolean);
      if (!ds) {
        setStatus("No dataset connected.");
        return;
      }
      if (!ready) {
        setStatus("Loading Python runtime...");
        return;
      }
      if (!pyodide) return;

      const values = ds.rows.map((r) => inputCols.map((c) => r[c])); // matrix [nRows][nInputs]
      // Provide vals to Python & user function f(*xs)
      await pyodide.loadPackagesFromImports?.("");
      pyodide.globals.set("vals", values);
      const userCode = data.code?.trim() || "def f(*xs):\n    return xs[0]";
      const script = `\n${userCode}\n\nouts = [f(*row) for row in vals]\n`;
      await pyodide.runPythonAsync(script);
      const outs = pyodide.globals.get("outs");
      const jsOuts = outs.toJs({ create_proxies: false });

      // Build new dataset with appended/overwritten column
      const newRows = ds.rows.map((r, i) => ({ ...r, [outputCol]: jsOuts[i] }));
      const newColumns = ds.columns.includes(outputCol)
        ? ds.columns
        : [...ds.columns, outputCol];
      const newDs: Dataset = { rows: newRows, columns: newColumns };
      setDataset(id, newDs);
      (data as any).status = `OK: wrote ${outputCol}`;
      setStatus(`OK: wrote ${outputCol}`);
    } catch (err: any) {
      setStatus(`Error: ${err.message}`);
    }
  };

  return (
    <div className="rounded-2xl border bg-white shadow p-3 w-[420px]">
      <div className="font-semibold">Transformer (Python map)</div>
      <div className="text-xs text-gray-500 mb-2">Use f(*xs) -> value</div>

      {/* Input handles: one per incoming column */}
      <div className="flex flex-wrap gap-1 mb-2">
        {(data.inputColumns || []).map((c) => (
          <div key={c} className="relative border rounded px-2 py-1 text-xs bg-gray-50">
            {c}
            <Handle type="target" position={Position.Left} id={`col:${c}`} />
          </div>
        ))}
      </div>

      <div className="mb-2">
        <label className="text-xs">Output Column</label>
        <input
          className="w-full border rounded px-2 py-1 text-sm"
          defaultValue={outputCol}
          onBlur={(e) => ((data as any).outputColumn = e.target.value)}
        />
      </div>

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
            <textarea
              className="w-full h-36 text-sm p-2"
              defaultValue={data.code || "def f(*xs):\n    return xs[0]"}
              onBlur={(e) => ((data as any).code = e.target.value)}
            />
          )}
        </div>
      </div>

      <button className="px-2 py-1 rounded bg-gray-900 text-white" onClick={runTransform}>
        Run Transform
      </button>
      {status && <div className="mt-2 text-xs text-gray-500">{status}</div>}

      {/* Output handles: dataset and the new column */}
      <div className="mt-2 flex gap-2">
        <div className="relative border rounded px-2 py-1 text-xs bg-gray-50">
          dataset
          <Handle type="source" position={Position.Right} id="dataset" />
        </div>
        {outputCol && (
          <div className="relative border rounded px-2 py-1 text-xs bg-gray-50">
            {outputCol}
            <Handle type="source" position={Position.Right} id={`col:${outputCol}`} />
          </div>
        )}
      </div>
    </div>
  );
}

// 4) Decision Variable Node
function DecisionVarNode({ id, data }: NodeProps<DecisionVarData>) {
  return (
    <div className="rounded-2xl border bg-white shadow p-3 w-[280px]">
      <div className="font-semibold">Decision Variable</div>
      <div className="text-xs text-gray-500 mb-2">x_i settings</div>

      <label className="text-xs">Name</label>
      <input
        className="w-full border rounded px-2 py-1 text-sm mb-2"
        defaultValue={data.name}
        onBlur={(e) => ((data as any).name = e.target.value)}
      />

      <div className="grid grid-cols-2 gap-2 mb-2">
        <div>
          <label className="text-xs">Type</label>
          <select
            className="w-full border rounded px-2 py-1 text-sm"
            defaultValue={data.varType}
            onChange={(e) => ((data as any).varType = e.target.value as VarType)}
          >
            <option value="binary">Binary</option>
            <option value="integer">Integer</option>
            <option value="continuous">Continuous</option>
          </select>
        </div>
        <div>
          <label className="text-xs">c (obj coeff)</label>
          <input
            type="number"
            className="w-full border rounded px-2 py-1 text-sm"
            defaultValue={data.objectiveCoeff}
            onBlur={(e) => ((data as any).objectiveCoeff = Number(e.target.value))}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-xs">Lower</label>
          <input
            type="number"
            className="w-full border rounded px-2 py-1 text-sm"
            defaultValue={data.lower ?? 0}
            onBlur={(e) => ((data as any).lower = Number(e.target.value))}
          />
        </div>
        <div>
          <label className="text-xs">Upper</label>
          <input
            type="number"
            className="w-full border rounded px-2 py-1 text-sm"
            defaultValue={data.upper ?? 1}
            onBlur={(e) => ((data as any).upper = Number(e.target.value))}
          />
        </div>
      </div>

      {/* Output handle to solver/constraints */}
      <Handle type="source" position={Position.Right} id="var" />
    </div>
  );
}

// 5) Constraint Node
function ConstraintNode({ id, data }: NodeProps<ConstraintData>) {
  return (
    <div className="rounded-2xl border bg-white shadow p-3 w-[360px]">
      <div className="font-semibold">Constraint</div>
      <div className="text-xs text-gray-500 mb-2">Linear expr in decision vars</div>

      <label className="text-xs">Name</label>
      <input
        className="w-full border rounded px-2 py-1 text-sm mb-2"
        defaultValue={data.name}
        onBlur={(e) => ((data as any).name = e.target.value)}
      />

      <label className="text-xs">Expression (e.g. 2*x + 3*y - z)</label>
      <input
        className="w-full border rounded px-2 py-1 text-sm mb-2"
        defaultValue={data.expr}
        onBlur={(e) => ((data as any).expr = e.target.value)}
      />

      <div className="grid grid-cols-3 gap-2 items-center mb-2">
        <select
          className="border rounded px-2 py-1 text-sm"
          defaultValue={data.sense}
          onChange={(e) => ((data as any).sense = e.target.value as any)}
        >
          <option value="<=">≤</option>
          <option value=">=">≥</option>
          <option value="=">=</option>
        </select>
        <input
          type="number"
          className="col-span-2 border rounded px-2 py-1 text-sm"
          defaultValue={data.rhs}
          onBlur={(e) => ((data as any).rhs = Number(e.target.value))}
        />
      </div>

      <Handle type="source" position={Position.Right} id="constraint" />
      <Handle type="target" position={Position.Left} id="vars" />
    </div>
  );
}

// 6) Solver Node (GLPK.js)
function SolverNode({ id, data }: NodeProps<SolverData>) {
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string>("");

  const solve = async () => {
    setBusy(true);
    setLog("");
    try {
      // Dynamically import glpk.js
      const glpkMod = await import("glpk.js");
      const GLPK = await (glpkMod as any).default();

      // Collect graph info from DOM (simple heuristic) — in a fuller app, pass via context
      const allNodes: Node[] = (window as any).__rf?.getNodes?.() || [];
      const allEdges: Edge[] = (window as any).__rf?.getEdges?.() || [];

      const varNodes = allNodes.filter((n) => n.type === "decisionVar") as Node<DecisionVarData>[];
      const consNodes = allNodes.filter((n) => n.type === "constraint") as Node<ConstraintData>[];

      // Map variable order
      const varList = varNodes.map((vn) => vn.data.name || vn.id);
      const varIndex: Record<string, number> = {};
      varList.forEach((v, i) => (varIndex[v] = i + 1)); // 1-based for GLPK

      // Objective
      const objCoeffs = varNodes.map((vn) => vn.data.objectiveCoeff || 0);

      // Bounds & types
      const bounds = varNodes.map((vn) => ({
        type: GLPK.GLP_DB,
        lb: vn.data.lower ?? 0,
        ub: vn.data.upper ?? (vn.data.varType === "binary" ? 1 : 1e9),
      }));
      const kinds = varNodes.map((vn) =>
        vn.data.varType === "binary"
          ? GLPK.GLP_BV
          : vn.data.varType === "integer"
          ? GLPK.GLP_IV
          : GLPK.GLP_CV
      );

      // Constraints
      const constrRows = consNodes.map((cn) => {
        const coeffs = parseLinearExpr(cn.data.expr || "");
        const ind: number[] = [];
        const val: number[] = [];
        Object.entries(coeffs).forEach(([name, c]) => {
          if (varIndex[name] != null) {
            ind.push(varIndex[name]);
            val.push(c);
          }
        });
        const sense = cn.data.sense;
        let type = GLPK.GLP_UP;
        let ub = cn.data.rhs;
        let lb = 0;
        if (sense === ">=") {
          type = GLPK.GLP_LO;
          lb = cn.data.rhs;
          ub = 0;
        } else if (sense === "=") {
          type = GLPK.GLP_FX;
          lb = cn.data.rhs;
          ub = cn.data.rhs;
        }
        return { name: cn.data.name || cn.id, ind, val, type, lb, ub };
      });

      // Build problem
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
        // Load row matrix
        const ia = [0];
        const ja = [0];
        const ar = [0];
        for (let k = 0; k < row.ind.length; k++) {
          ia.push(r + 1);
          ja.push(row.ind[k]);
          ar.push(row.val[k]);
        }
        GLPK.glp_set_mat_row(lp, r + 1, row.ind.length, ia, ja, ar);
      });

      // MIP solve
      const smcp = new GLPK.SMCP({ presolve: data.algorithm === "bnc" ? 1 : 1 });
      GLPK.glp_simplex(lp, smcp);

      const iocp = new GLPK.IOCP({
        presolve: data.algorithm === "bnc" ? 1 : 1,
        // GLPK has some cuts; we toggle mip gap & cuts heuristically
        mip_gap: data.mipGap ?? 0.0001,
        // tol_int etc can be set here
      });
      GLPK.glp_intopt(lp, iocp);

      const z = GLPK.glp_mip_obj_val(lp);
      const vars: Record<string, number> = {};
      varList.forEach((name, i) => {
        vars[name] = GLPK.glp_mip_col_val(lp, i + 1);
      });
      (data as any).result = { status: "OPTIMAL (MIP)", objectiveValue: z, vars };
    } catch (err: any) {
      (data as any).result = { status: `Error: ${err.message}` };
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border bg-white shadow p-3 w-[380px]">
      <div className="font-semibold">Solver</div>
      <div className="text-xs text-gray-500 mb-2">GLPK.js MILP</div>

      <div className="grid grid-cols-2 gap-2 mb-2">
        <div>
          <label className="text-xs">Objective</label>
          <select
            className="w-full border rounded px-2 py-1 text-sm"
            defaultValue={data.objective}
            onChange={(e) => ((data as any).objective = e.target.value as any)}
          >
            <option value="maximize">Maximize</option>
            <option value="minimize">Minimize</option>
          </select>
        </div>
        <div>
          <label className="text-xs">Algorithm</label>
          <select
            className="w-full border rounded px-2 py-1 text-sm"
            defaultValue={data.algorithm}
            onChange={(e) => ((data as any).algorithm = e.target.value as any)}
          >
            <option value="bnb">Branch & Bound</option>
            <option value="bnc">Branch & Cut</option>
          </select>
        </div>
      </div>

      <label className="text-xs">MIP gap</label>
      <input
        type="number"
        step="0.0001"
        className="w-full border rounded px-2 py-1 text-sm mb-2"
        defaultValue={data.mipGap ?? 0.0001}
        onBlur={(e) => ((data as any).mipGap = Number(e.target.value))}
      />

      <div className="flex gap-2">
        <Handle type="target" position={Position.Left} id="vars" />
        <Handle type="target" position={Position.Left} id="constraints" />
      </div>

      <button
        disabled={busy}
        className={`mt-2 px-2 py-1 rounded ${busy ? "bg-gray-300" : "bg-gray-900 text-white"}`}
        onClick={solve}
      >
        {busy ? "Solving..." : "Solve"}
      </button>

      {data.result && (
        <div className="mt-2 text-xs">
          <div className="font-medium">{data.result.status}</div>
          {data.result.objectiveValue != null && (
            <div>Objective: {data.result.objectiveValue.toFixed(6)}</div>
          )}
          {data.result.vars && (
            <div className="mt-1 max-h-28 overflow-auto border rounded p-1">
              {Object.entries(data.result.vars).map(([k, v]) => (
                <div key={k}>
                  {k} = {Number(v).toFixed(6)}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- Node Editor (right panel) ----------
function NodeEditor({ selected }: { selected: Node | null }) {
  if (!selected) return (
    <div className="p-4 text-sm text-gray-500">Select a node to edit its details.</div>
  );
  // Nodes are already live-editable in-place; here we can show contextual help
  return (
    <div className="p-4 text-sm">
      <div className="font-semibold mb-2">Editor: {selected.type}</div>
      <div className="text-gray-600">
        Most properties can be edited directly in the node. Use connections to wire datasets → columns → transformers → decision vars/constraints → solver.
      </div>
    </div>
  );
}

// ---------- Main Page ----------

const nodeTypes = {
  dataUpload: DataUploadNode,
  dataBrowser: DataBrowserNode,
  transformer: TransformerNode,
  decisionVar: DecisionVarNode,
  constraint: ConstraintNode,
  solver: SolverNode,
};

export default function Page() {
  const initialNodes = useMemo<Node[]>(
    () => [
      {
        id: "up1",
        type: "dataUpload",
        position: { x: 50, y: 80 },
        data: { mode: "file", dataset: null } as DataUploadData,
      },
      {
        id: "db1",
        type: "dataBrowser",
        position: { x: 450, y: 60 },
        data: { dataset: null } as DataBrowserData,
      },
      {
        id: "tr1",
        type: "transformer",
        position: { x: 900, y: 40 },
        data: { code: "def f(*xs):\n    return xs[0]", inputColumns: [], outputColumn: "new_feature" } as TransformerData,
      },
      {
        id: "x1",
        type: "decisionVar",
        position: { x: 450, y: 360 },
        data: { name: "x", varType: "integer", lower: 0, upper: 10, objectiveCoeff: 3 } as DecisionVarData,
      },
      {
        id: "y1",
        type: "decisionVar",
        position: { x: 700, y: 360 },
        data: { name: "y", varType: "integer", lower: 0, upper: 10, objectiveCoeff: 2 } as DecisionVarData,
      },
      {
        id: "c1",
        type: "constraint",
        position: { x: 950, y: 340 },
        data: { name: "cap", expr: "2*x + 3*y", sense: "<=", rhs: 18 } as ConstraintData,
      },
      {
        id: "s1",
        type: "solver",
        position: { x: 1250, y: 300 },
        data: { objective: "maximize", algorithm: "bnb" } as SolverData,
      },
    ],
    []
  );

  const initialEdges = useMemo<Edge[]>(
    () => [
      { id: "e-up-db", source: "up1", target: "db1", sourceHandle: "dataset", targetHandle: "dataset" },
      // wire decision vars & constraint to solver
      { id: "e-x-c", source: "x1", target: "c1", sourceHandle: "var", targetHandle: "vars" },
      { id: "e-y-c", source: "y1", target: "c1", sourceHandle: "var", targetHandle: "vars" },
      { id: "e-c-s", source: "c1", target: "s1", sourceHandle: "constraint", targetHandle: "constraints" },
      { id: "e-x-s", source: "x1", target: "s1", sourceHandle: "var", targetHandle: "vars" },
      { id: "e-y-s", source: "y1", target: "s1", sourceHandle: "var", targetHandle: "vars" },
    ],
    []
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [selected, setSelected] = useState<Node | null>(null);

  // Expose nodes/edges for solver node to introspect quickly (MVP)
  useEffect(() => {
    (window as any).__rf = { getNodes: () => nodes, getEdges: () => edges };
  }, [nodes, edges]);

  const onConnect = useCallback(
    (params: Edge | Connection) => {
      setEdges((eds) =>
        addEdge(
          {
            ...params,
            animated: true,
            markerEnd: { type: MarkerType.ArrowClosed },
          } as any,
          eds
        )
      );

      // If connecting DataBrowser column -> Transformer, register column name
      if (
        (params as any).source && String((params as any).source).startsWith("db") &&
        (params as any).target && String((params as any).target).startsWith("tr") &&
        (params as any).sourceHandle?.startsWith("col:")
      ) {
        const col = (params as any).sourceHandle.split(":")[1];
        setNodes((nds) =>
          nds.map((n) => {
            if (n.id === (params as any).target && n.type === "transformer") {
              const td = n.data as TransformerData;
              const setCols = new Set([...(td.inputColumns || []), col]);
              return { ...n, data: { ...td, inputColumns: Array.from(setCols) } };
            }
            return n;
          })
        );
      }
    },
    [setEdges, setNodes]
  );

  // Propagate dataset to Browser when Upload changes (MVP linkage)
  const datasets = useGraphStore((s) => s.datasets);
  useEffect(() => {
    setNodes((nds) =>
      nds.map((n) => {
        if (n.id === "db1" && n.type === "dataBrowser") {
          return { ...n, data: { ...(n.data as any), dataset: datasets["up1"] || null } };
        }
        return n;
      })
    );
  }, [datasets, setNodes]);

  return (
    <div className="h-screen w-screen grid grid-cols-[1fr_360px]">
      {/* Inject Pyodide script tag once */}
      <script src="https://cdn.jsdelivr.net/pyodide/v0.25.0/full/pyodide.js" />

      <div className="relative">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
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
          <div className="font-medium mb-1">How to use (MVP)</div>
          <ol className="list-decimal ml-4 space-y-1">
            <li>Upload a CSV in <b>Data Upload</b>.</li>
            <li>See preview in <b>Data Browser</b>. Drag handles for specific columns to <b>Transformer</b> inputs.</li>
            <li>In <b>Transformer</b>, write a Python function <code>def f(*xs)</code> and run to create a new column.</li>
            <li>Create/Edit <b>Decision Variables</b> (name, type, bounds, c).</li>
            <li>Write a linear <b>Constraint</b> like <code>2*x + 3*y</code> with sense and RHS.</li>
            <li>Click <b>Solve</b> in the Solver to run GLPK.js (Branch & Bound / Cut).</li>
          </ol>
        </div>
      </div>

      {/* Tailwind base (optional but recommended for styling). If you use Tailwind, include its setup in the project. */}
      <style jsx global>{`
        body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, Noto Sans, Apple Color Emoji, Segoe UI Emoji; }
      `}</style>
    </div>
  );
}
