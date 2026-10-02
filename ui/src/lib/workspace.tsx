import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

/** What is being analysed: the EXPLAIN output and, when known, the query that produced it. */
export type Source = { plan: string; sql?: string; title?: string };

export type DbTable = { name: string; rows: number; bytes: number; columns: string[]; indexes: string[] };
export type LiveInfo = { live: false } | { live: true; database: { database: string; version: string; tables: DbTable[] } };

export type Trial = { before: unknown; after: unknown; ddl: string; buildMs: number; indexBytes: number };

type Workspace = {
  source: Source | null;
  setSource: (s: Source | null) => void;
  /** Null while loading or when there is no backend at all (static hosting). */
  info: LiveInfo | null;
};

/** Absolute, so it works from any route and under a sub-path. */
const API = `${import.meta.env.BASE_URL}api/`;

const Ctx = createContext<Workspace>({ source: null, setSource: () => {}, info: null });

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [source, setSource] = useState<Source | null>(null);
  const [info, setInfo] = useState<LiveInfo | null>(null);
  useEffect(() => {
    // On static hosting there is no /api: the app simply stays in paste mode.
    fetch(`${API}info`)
      .then((r) => (r.ok && r.headers.get("content-type")?.includes("json") ? r.json() : { live: false }))
      .then(setInfo)
      .catch(() => setInfo({ live: false }));
  }, []);
  const value = useMemo(() => ({ source, setSource, info }), [source, info]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useWorkspace = () => useContext(Ctx);

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `erro ${res.status}`);
  return data as T;
}

export const api = {
  explain: (sql: string) => post<{ plan: unknown }>(`${API}explain`, { sql }),
  tryIndex: (sql: string, index: unknown) => post<Trial>(`${API}try-index`, { sql, index }),
};

// ---- share links ------------------------------------------------------------

function toB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const fromB64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([data as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** Packs a source into a URL fragment: the plan travels in the link, no server involved. */
export async function encodeSource(s: Source): Promise<string> {
  const raw = new TextEncoder().encode(JSON.stringify({ p: s.plan, q: s.sql, t: s.title }));
  return toB64(await pipe(raw, new CompressionStream("deflate-raw")));
}

export async function decodeSource(fragment: string): Promise<Source | null> {
  try {
    const raw = await pipe(fromB64(fragment), new DecompressionStream("deflate-raw"));
    const data = JSON.parse(new TextDecoder().decode(raw)) as { p?: string; q?: string; t?: string };
    return typeof data.p === "string" ? { plan: data.p, sql: data.q, title: data.t } : null;
  } catch {
    return null;
  }
}
