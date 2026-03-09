/**
 * engram.ts — persistent context graph for opencode sessions
 * Drop in ~/.config/opencode/plugins/ (global) or .opencode/plugins/ (project).
 *
 * Two stores, always separate:
 *
 *   ~/.config/engram/global.db
 *     Cross-project conventions, personal patterns, long-form preferences.
 *     Nodes here belong to no single project.
 *
 *   ~/.config/engram/projects/<sha1>.db
 *     Scoped to the current git repo, identified by remote URL.
 *     label = raw remote URL (e.g. "github.com/you/myapp") — used for display and store identity
 *     DB filename = slugDbKey(label) — SHA-1 hash, 20 hex chars, filesystem-safe
 *     Falls back to absolute git root path, then cwd.
 *
 * A node lives in exactly one store. Edges can cross stores — a project node
 * may depend-on a global node. The edge lives in the project DB; traversal
 * resolves targets by checking project first, then global.
 *
 * Manifest format (two sections, sigil-compact):
 *   [global]
 *   error-handling    C
 *
 *   [project: github.com/you/myapp]
 *   auth-flow         D  →jwt-config[R],error-handling[C:g]  ←api-gateway[R]
 *
 * Type sigils: D=decision R=reference C=convention P=procedure S=summary H=hypothesis
 * Provenance suffix: [R:g] = global node, [R:p] = project node (only shown in cross-store refs)
 */

import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { Database } from "bun:sqlite";
import { join } from "path";
import { homedir } from "os";
import { mkdirSync, appendFileSync } from "fs";
import { createHash } from "crypto";

// ─── Paths ────────────────────────────────────────────────────────────────────

const ENGRAM_ROOT = join(homedir(), ".config", "engram");
const ENGRAM_PROJECTS = join(ENGRAM_ROOT, "projects");
const GLOBAL_DB_PATH = join(ENGRAM_ROOT, "global.db");
const ENGRAM_LOG_PATH = join(ENGRAM_ROOT, "engram.log");

// File logger — written to ~/.config/engram/engram.log
// Rolls over when the file exceeds ~2MB (keeps the last ~1MB).
function fileLog(msg: string): void {
    try {
        const line = `${new Date().toISOString()} ${msg}\n`;
        appendFileSync(ENGRAM_LOG_PATH, line);
    } catch {}
}

// Single shared connection to global.db — multiple EngramStore instances (one per project slug)
// must not each open their own Database handle to the same file or concurrent writes cause SQLITE_BUSY.
let _globalDB: Database | null = null;
function getGlobalDB(): Database {
    if (!_globalDB) {
        mkdirSync(ENGRAM_PROJECTS, { recursive: true }); // deferred from module top-level
        _globalDB = openDB(GLOBAL_DB_PATH);
    }
    return _globalDB;
}

// Returns a human-readable project label used for display and store identification.
// The DB filename is derived separately via slugDbKey() — no filesystem constraints here.
async function projectSlug(cwd: string, $: Function): Promise<string> {
    try {
        const remote = (
            await $`git -C ${cwd} remote get-url origin`.text()
        ).trim();
        if (remote)
            return remote
                .replace(/^https?:\/\//, "")
                .replace(/^git@/, "")
                .replace(/\.git$/, "");
    } catch {}
    try {
        const root = (
            await $`git -C ${cwd} rev-parse --show-toplevel`.text()
        ).trim();
        if (root) return root;
    } catch {}
    return cwd;
}

// Stable, fixed-length DB key derived from the human-readable slug.
// SHA-1 of the full label → 20 hex chars — no length limit, no sanitization needed.
function slugDbKey(label: string): string {
    return createHash("sha1").update(label).digest("hex").slice(0, 20);
}

// ─── Types ────────────────────────────────────────────────────────────────────

type NodeType =
    | "decision"
    | "reference"
    | "convention"
    | "procedure"
    | "summary"
    | "hypothesis";
type NodeStatus = "current" | "deprecated" | "draft" | "archived";
type NodeAuthority = "follow" | "consult" | "historical";
type EdgeType =
    | "depends-on"
    | "implements"
    | "supersedes"
    | "constrains"
    | "related-to"
    | "contradicts";
type StoreKey = "global" | "project";

const TYPE_SIGIL: Record<NodeType, string> = {
    decision: "D",
    reference: "R",
    convention: "C",
    procedure: "P",
    summary: "S",
    hypothesis: "H",
};
const DEPTH_LIMITS: Record<EdgeType, number> = {
    "depends-on": 3,
    implements: 2,
    supersedes: 1,
    constrains: 2,
    "related-to": 1,
    contradicts: 1,
};

const VALID_TYPES: NodeType[] = [
    "decision",
    "reference",
    "convention",
    "procedure",
    "summary",
    "hypothesis",
];
const VALID_STATUSES: NodeStatus[] = [
    "current",
    "deprecated",
    "draft",
    "archived",
];
const VALID_AUTHORITIES: NodeAuthority[] = ["follow", "consult", "historical"];
const VALID_EDGES: EdgeType[] = [
    "depends-on",
    "implements",
    "supersedes",
    "constrains",
    "related-to",
    "contradicts",
];

// Derived display strings — single source of truth for descriptions and validation messages
const DESC_TYPES =
    "decision (a choice made) | convention (always/never rule) | reference (external fact or API) | procedure (how-to steps) | summary (work completed) | hypothesis (unverified risk or assumption)";
const DESC_STATUSES =
    "current (active) | archived (resolved/done) | deprecated (superseded) | draft (unverified)";
const DESC_AUTHORITIES =
    "follow (active constraint — must be respected) | consult (advisory — check before acting) | historical (past context — for reference only)";
const DESC_EDGES =
    "depends-on (requires) | implements (realises an interface) | supersedes (replaces) | constrains (limits) | related-to (loosely connected) | contradicts (conflicts with)";
// Manifest legend derived from TYPE_SIGIL — stays current when types are added
const MANIFEST_LEGEND =
    [
        "Types: " +
            Object.entries(TYPE_SIGIL)
                .map(([t, s]) => `${s}=${t}`)
                .join(" "),
        "Format: <id> <type>  →<out>  ←<in>  |  :g=global :p=project  [?]=unresolved",
    ].join("\n") + "\n";

const MANIFEST_CHAR_CAP = 3200; // ~800 tokens hard ceiling for manifest body
const SCORE_INTERVAL = 5; // re-score every N messages
const _rawExtractEvery = Number(process.env.ENGRAM_EXTRACT_EVERY ?? 20);
const MESSAGE_EXTRACT_INTERVAL =
    Number.isFinite(_rawExtractEvery) && _rawExtractEvery > 0
        ? Math.floor(_rawExtractEvery)
        : 20; // default: extract every 20 messages
const EXTRACTION_MSG_LIMIT = 40; // max recent messages fed to extraction call
const QUEUE_POLL_MS = 5_000; // consumer wakes every 5s
const QUEUE_MAX_SIZE = 50; // drop oldest if queue grows beyond this
const ENGRAM_HEADER = `<engram>
Persistent context graph. Nodes below are saved from previous sessions.

When a node looks relevant to the current task, call recall_context(id) to get the full content. If unsure which node, use search_context(query) first.

`;

function validate(
    field: string,
    value: string,
    allowed: readonly string[],
): string | null {
    return allowed.includes(value)
        ? null
        : `Invalid ${field} "${value}". Valid: ${allowed.join(", ")}`;
}
function validateNodeFields(
    type?: string,
    status?: string,
    authority?: string,
    scope?: string,
    storeKey?: StoreKey,
): string | null {
    if (type) {
        const e = validate("type", type, VALID_TYPES);
        if (e) return e;
    }
    if (status) {
        const e = validate("status", status, VALID_STATUSES);
        if (e) return e;
    }
    if (authority) {
        const e = validate("authority", authority, VALID_AUTHORITIES);
        if (e) return e;
    }
    if (scope && storeKey) {
        const e = validateScope(scope, storeKey);
        if (e) return e;
    }
    return null;
}

function validateScope(
    scope: string,
    storeKey: "global" | "project" = "project",
): string | null {
    if (!scope || scope.trim() === "") return `scope cannot be empty`;
    if (scope === "global") {
        if (storeKey !== "global")
            return `scope "global" is only valid for global-store nodes. Use "project", "service:<n>", or "module:<n>" for project nodes.`;
        return null;
    }
    if (scope === "project") return null;
    if (/^service:[a-zA-Z0-9_-]+$/.test(scope)) return null;
    if (/^module:[a-zA-Z0-9_/-]+$/.test(scope)) return null;
    return `Invalid scope "${scope}". Use: project | service:<n> | module:<n>`;
}

interface ItemRow {
    id: string;
    type: string;
    status: string;
    scope: string;
    authority: string;
    description: string;
    content: string;
    saved_at: string;
    recall_count: number;
    last_recalled_at: string | null;
}
interface ItemMeta {
    id: string;
    type: string;
    status: string;
}
interface EdgeRow {
    from_id: string;
    to_id: string;
    edge_type: string;
}
interface VersionRow {
    version: number;
    type: string;
    description: string;
    saved_at: string;
}
interface VersionSnap {
    content: string;
    description: string;
    saved_at: string;
}
interface VersionRecord {
    id: string;
    version: number;
    type: string;
    description: string;
    content: string;
    saved_at: string;
}

interface TraversedNode {
    id: string;
    type: string;
    status: string;
    store: StoreKey;
    exists: boolean;
    outEdges: {
        etype: EdgeType;
        toId: string;
        toType: string;
        toStore: StoreKey | null;
        toExists: boolean;
    }[];
    inEdges: {
        etype: EdgeType;
        fromId: string;
        fromType: string;
        fromStore: StoreKey;
    }[];
}
interface ScoredItem {
    item: ItemRow;
    store: StoreKey;
    score: number;
}

// ─── Session state ────────────────────────────────────────────────────────────

const RECENT_TERMS_WINDOW = 10; // sliding window: how many messages contribute to scoring terms

interface SessionContext {
    messageCount: number;
    recentTermBuf: Set<string>[]; // ring buffer of per-message term sets (last N messages)
    recentTerms: Set<string>; // union of recentTermBuf — rebuilt when window shifts
    scores: Map<string, number>;
    tokenCache: Map<string, Set<string>>; // id→tokenize(id+description), cleared on write
    lastScoredAt: number;
    scoresDirty: boolean; // set true on any store write during session
    lastExtractAt: number; // messageCount at last autonomous extraction
    lastIdleExtractAt: number; // wall-clock ms of last idle extraction (cooldown)
    providerID: string; // from last user message
    modelID: string; // from last user message
}

// sessions and getSession are instantiated per plugin (see plugin body)

// Application-layer tokenizer for in-memory Jaccard overlap scoring.
// Keeps '-' so hyphenated terms like `jwt-token` stay compound; we control this set entirely.
// Intentionally diverges from ftsQuery — these operate at different layers (see ftsQuery comment).
function tokenize(text: string): Set<string> {
    return new Set(
        text
            .toLowerCase()
            .replace(/[^a-z0-9\s_-]/g, " ")
            .split(/\s+/)
            .filter((t) => t.length > 2),
    );
}

// Builds a safe FTS5 query expression from free text.
// Strips '-' and punctuation per token because SQLite's unicode61 tokenizer splits on hyphens
// at index time — querying '"jwt-token"' finds nothing since the index stores 'jwt' and 'token'
// as separate terms. Quoting each token prevents FTS5 from treating AND/OR/NOT/+/: as operators.
// Last token gets '*' for prefix matching; earlier tokens require exact term presence.
function ftsQuery(raw: string): string {
    const tokens = raw
        .split(/\s+/)
        .map((t) => t.replace(/[^a-zA-Z0-9_]/g, ""))
        .filter((t) => t.length > 0);
    if (!tokens.length) return "";
    return tokens
        .map((t, i) =>
            i === tokens.length - 1 ? '"' + t + '"*' : '"' + t + '"',
        )
        .join(" ");
}

// XML-escapes a string for safe embedding in element content or attribute values.
function xmlEscape(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

// Extract session ID from an opencode event.
// The canonical location is event.properties.sessionID (capital D) per the opencode SDK.
// Fall back to snake_case / camelCase variants for forward-compat.
function getSessionId(event: any): string | undefined {
    return (
        event?.properties?.sessionID ??
        event?.properties?.sessionId ??
        event?.session_id ??
        event?.sessionId
    );
}

// Cap-limited manifest line builder.
// Shared by the compaction hook and system.transform — pass a pre-built edgeIndex to avoid rebuilding.
function buildManifestLines(
    sorted: { item: ItemRow; store: StoreKey }[],
    engramStore: EngramStore,
    edgeIndex: ReturnType<EngramStore["buildEdgeIndex"]>,
): { lines: string[]; dropped: number } {
    const result: string[] = [];
    let charCount = MANIFEST_LEGEND.length;
    let dropped = 0;
    for (const { item, store: storeKey } of sorted) {
        const line = "  " + engramStore.manifestLine(item, storeKey, edgeIndex);
        if (charCount + line.length > MANIFEST_CHAR_CAP) {
            dropped++;
            continue;
        }
        result.push(line);
        charCount += line.length + 1;
    }
    return { lines: result, dropped };
}

function jaccardOverlap(a: Set<string>, b: Set<string>): number {
    if (!a.size || !b.size) return 0;
    // Iterate the smaller set — minimises b.has() calls
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    let intersection = 0;
    for (const t of small) if (large.has(t)) intersection++;
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
}

// ─── Formatting (pure, no DB) ─────────────────────────────────────────────────

function sigil(type: string): string {
    return TYPE_SIGIL[type as NodeType] ?? "?";
}

function ref(
    id: string,
    type: string,
    exists: boolean,
    nodeStore: StoreKey | null,
    fromStore: StoreKey,
): string {
    if (!exists) return `${id}[?]`;
    const cross =
        nodeStore && nodeStore !== fromStore ? `:${nodeStore[0]}` : "";
    return `${id}[${sigil(type)}${cross}]`;
}

function fmtSubgraph(nodes: TraversedNode[], rootId: string): string {
    const root = nodes.find((n) => n.id === rootId);
    if (!root || (!root.outEdges.length && !root.inEdges.length))
        return "(no edges)";

    const lines: string[] = [];
    const byOut = new Map<string, string[]>();
    for (const e of root.outEdges) {
        const refs = byOut.get(e.etype) ?? [];
        refs.push(ref(e.toId, e.toType, e.toExists, e.toStore, root.store));
        byOut.set(e.etype, refs);
    }
    for (const [etype, refs] of byOut)
        lines.push(`  ${etype}: ${refs.join(", ")}`);

    const byIn = new Map<string, string[]>();
    for (const e of root.inEdges) {
        const refs = byIn.get(e.etype) ?? [];
        refs.push(ref(e.fromId, e.fromType, true, e.fromStore, root.store));
        byIn.set(e.etype, refs);
    }
    for (const [etype, refs] of byIn)
        lines.push(`  ← ${etype}: ${refs.join(", ")}`);

    const deeper = nodes.filter((n) => n.id !== rootId && n.exists);
    if (deeper.length)
        lines.push(
            `  transitive (${deeper.length}): ${deeper.map((n) => ref(n.id, n.type, true, n.store, root.store)).join(", ")}`,
        );

    return lines.join("\n");
}

// ─── DB bootstrap ─────────────────────────────────────────────────────────────

// Versioned migrations — add new entries at the end only, never re-number.
const MIGRATIONS: { version: number; sql: string }[] = [
    {
        version: 1,
        sql: `
    CREATE TABLE IF NOT EXISTS items (
      id               TEXT PRIMARY KEY,
      type             TEXT NOT NULL DEFAULT 'reference',
      status           TEXT NOT NULL DEFAULT 'current',
      scope            TEXT NOT NULL DEFAULT 'project',
      authority        TEXT NOT NULL DEFAULT 'follow',
      description      TEXT NOT NULL,
      content          TEXT NOT NULL,
      saved_at         TEXT NOT NULL
    )`,
    },
    {
        version: 2,
        sql: `ALTER TABLE items ADD COLUMN recall_count INTEGER NOT NULL DEFAULT 0`,
    },
    { version: 3, sql: `ALTER TABLE items ADD COLUMN last_recalled_at TEXT` },
    {
        version: 4,
        sql: `
    CREATE TABLE IF NOT EXISTS edges (
      from_id   TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      to_id     TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      PRIMARY KEY (from_id, to_id, edge_type)
    )`,
    },
    {
        version: 5,
        sql: `CREATE INDEX IF NOT EXISTS idx_edges_to_id ON edges(to_id)`,
    },
    {
        version: 6,
        sql: `
    CREATE TABLE IF NOT EXISTS versions (
      id          TEXT NOT NULL,
      version     INTEGER NOT NULL,
      type        TEXT NOT NULL,
      description TEXT NOT NULL,
      content     TEXT NOT NULL,
      saved_at    TEXT NOT NULL,
      PRIMARY KEY (id, version)
    )`,
    },
    {
        version: 7,
        sql: `
    CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
      id, description, content, content=items, content_rowid=rowid
    )`,
    },
    {
        version: 8,
        sql: `
    CREATE TRIGGER IF NOT EXISTS fts_insert AFTER INSERT ON items BEGIN
      INSERT INTO items_fts(rowid,id,description,content) VALUES(new.rowid,new.id,new.description,new.content);
    END`,
    },
    {
        version: 9,
        sql: `
    CREATE TRIGGER IF NOT EXISTS fts_update AFTER UPDATE ON items BEGIN
      INSERT INTO items_fts(items_fts,rowid,id,description,content) VALUES('delete',old.rowid,old.id,old.description,old.content);
      INSERT INTO items_fts(rowid,id,description,content) VALUES(new.rowid,new.id,new.description,new.content);
    END`,
    },
    {
        version: 10,
        sql: `
    CREATE TRIGGER IF NOT EXISTS fts_delete AFTER DELETE ON items BEGIN
      INSERT INTO items_fts(items_fts,rowid,id,description,content) VALUES('delete',old.rowid,old.id,old.description,old.content);
    END`,
    },
    {
        version: 11,
        sql: `CREATE INDEX IF NOT EXISTS idx_versions_id ON versions(id)`,
    },
    {
        version: 12,
        sql: `CREATE INDEX IF NOT EXISTS idx_items_status_saved ON items(status, saved_at DESC)`,
    },
];

function openDB(path: string): Database {
    const db = new Database(path, { create: true });
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = NORMAL");
    db.run("PRAGMA cache_size = -8000");
    db.run("PRAGMA foreign_keys = OFF");

    db.run(
        `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`,
    );
    const row = db.query("SELECT version FROM schema_version").get() as {
        version: number;
    } | null;
    let current = row?.version ?? 0;
    if (!row) db.run("INSERT INTO schema_version VALUES (0)");

    for (const m of MIGRATIONS) {
        if (m.version <= current) continue;
        // Wrap each migration + version bump in a transaction so a crash cannot
        // leave the schema mutated but the version counter un-incremented.
        db.transaction(() => {
            try {
                db.run(m.sql.trim());
            } catch (e: any) {
                // Tolerate "already exists" for idempotent DDL; surface everything else
                if (
                    !e?.message?.includes("already exists") &&
                    !e?.message?.includes("duplicate column")
                ) {
                    throw new Error(
                        `Migration v${m.version} failed: ${e.message}`,
                    );
                }
            }
            db.run("UPDATE schema_version SET version = ?", [m.version]);
        })();
        current = m.version;
    }

    return db;
}

// ─── Extraction node (declared early — referenced by EngramStore.commitBatch) ─

interface ExtractionNode {
    id: string;
    type: NodeType;
    scope: "global" | "project";
    description: string;
    content: string;
    status?: NodeStatus;
    authority?: NodeAuthority;
}

// ─── StoreDB — wraps a single SQLite database with all prepared statements ─────

class StoreDB {
    readonly db: Database;
    readonly s: {
        getItem: ReturnType<Database["prepare"]>;
        getMeta: ReturnType<Database["prepare"]>;
        edgesOut: ReturnType<Database["prepare"]>;
        edgesIn: ReturnType<Database["prepare"]>;
        currentItems: ReturnType<Database["prepare"]>;
        allItems: ReturnType<Database["prepare"]>;
        maxVersion: ReturnType<Database["prepare"]>;
        insertVersion: ReturnType<Database["prepare"]>;
        allVersions: ReturnType<Database["prepare"]>;
        deleteVersions: ReturnType<Database["prepare"]>;
        deleteEdgesFrom: ReturnType<Database["prepare"]>;
        upsertItem: ReturnType<Database["prepare"]>;
        updateRecall: ReturnType<Database["prepare"]>;
        deleteItem: ReturnType<Database["prepare"]>;
        insertEdge: ReturnType<Database["prepare"]>;
        deleteEdge: ReturnType<Database["prepare"]>;
        countEdgesTo: ReturnType<Database["prepare"]>;
        renameItem: ReturnType<Database["prepare"]>;
        renameEdgeFrom: ReturnType<Database["prepare"]>;
        renameEdgeTo: ReturnType<Database["prepare"]>;
        renameVersion: ReturnType<Database["prepare"]>;
        listVersions: ReturnType<Database["prepare"]>;
        getVersion: ReturnType<Database["prepare"]>;
        searchFts: ReturnType<Database["prepare"]>;
        allIds: ReturnType<Database["prepare"]>;
        allEdgesOut: ReturnType<Database["prepare"]>;
        allDegreesOut: ReturnType<Database["prepare"]>;
        allDegreesIn: ReturnType<Database["prepare"]>;
        rebuildFts: ReturnType<Database["prepare"]>;
    };

    // Cache of "SELECT * FROM items WHERE id IN (?,…)" statements by arity
    readonly inCache = new Map<number, ReturnType<Database["prepare"]>>();

    constructor(db: Database) {
        this.db = db;
        this.s = {
            getItem: db.prepare("SELECT * FROM items WHERE id=?"),
            getMeta: db.prepare(
                "SELECT id, type, status FROM items WHERE id=?",
            ),
            edgesOut: db.prepare("SELECT * FROM edges WHERE from_id=?"),
            edgesIn: db.prepare("SELECT * FROM edges WHERE to_id=?"),
            currentItems: db.prepare(
                "SELECT * FROM items WHERE status='current' ORDER BY saved_at DESC",
            ),
            allItems: db.prepare("SELECT * FROM items ORDER BY saved_at DESC"),
            maxVersion: db.prepare(
                "SELECT COALESCE(MAX(version),0) AS v FROM versions WHERE id=?",
            ),
            insertVersion: db.prepare(
                "INSERT INTO versions (id,version,type,description,content,saved_at) VALUES (?,?,?,?,?,?)",
            ),
            allVersions: db.prepare("SELECT * FROM versions WHERE id=?"),
            deleteVersions: db.prepare("DELETE FROM versions WHERE id=?"),
            deleteEdgesFrom: db.prepare("DELETE FROM edges WHERE from_id=?"),
            upsertItem: db.prepare(
                "INSERT INTO items (id,type,status,scope,authority,description,content,saved_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET type=excluded.type, status=excluded.status, scope=excluded.scope, authority=excluded.authority, description=excluded.description, content=excluded.content, saved_at=excluded.saved_at",
            ),
            updateRecall: db.prepare(
                "UPDATE items SET recall_count = recall_count + 1, last_recalled_at = ? WHERE id = ?",
            ),
            deleteItem: db.prepare("DELETE FROM items WHERE id=?"),
            insertEdge: db.prepare(
                "INSERT OR IGNORE INTO edges (from_id,to_id,edge_type) VALUES (?,?,?)",
            ),
            deleteEdge: db.prepare(
                "DELETE FROM edges WHERE from_id=? AND to_id=? AND edge_type=?",
            ),
            countEdgesTo: db.prepare(
                "SELECT COUNT(*) as n FROM edges WHERE to_id=?",
            ),
            renameItem: db.prepare("UPDATE items SET id=? WHERE id=?"),
            renameEdgeFrom: db.prepare(
                "UPDATE edges SET from_id=? WHERE from_id=?",
            ),
            renameEdgeTo: db.prepare("UPDATE edges SET to_id=? WHERE to_id=?"),
            renameVersion: db.prepare("UPDATE versions SET id=? WHERE id=?"),
            listVersions: db.prepare(
                "SELECT version, type, description, saved_at FROM versions WHERE id=? ORDER BY version DESC",
            ),
            getVersion: db.prepare(
                "SELECT * FROM versions WHERE id=? AND version=?",
            ),
            searchFts: db.prepare(
                "SELECT id, rank FROM items_fts WHERE items_fts MATCH ? ORDER BY rank LIMIT ?",
            ),
            allIds: db.prepare("SELECT id FROM items"),
            allEdgesOut: db.prepare("SELECT * FROM edges"),
            allDegreesOut: db.prepare(
                "SELECT from_id AS id, COUNT(*) AS n FROM edges GROUP BY from_id",
            ),
            allDegreesIn: db.prepare(
                "SELECT to_id   AS id, COUNT(*) AS n FROM edges GROUP BY to_id",
            ),
            rebuildFts: db.prepare(
                "INSERT INTO items_fts(items_fts) VALUES('rebuild')",
            ),
        };
    }
}

// ─── EngramStore ──────────────────────────────────────────────────────────────

class EngramStore {
    readonly slug: string;

    #edgeDirty = true;
    #edgeIndex: ReturnType<EngramStore["buildEdgeIndex"]> | null = null;

    readonly #g: StoreDB; // global store
    readonly #p: StoreDB; // project store

    static readonly #instances = new Map<string, EngramStore>();

    static getInstance(slug: string): EngramStore {
        let inst = EngramStore.#instances.get(slug);
        if (!inst) {
            inst = new EngramStore(
                getGlobalDB(),
                openDB(join(ENGRAM_PROJECTS, `${slugDbKey(slug)}.db`)),
                slug,
            );
            EngramStore.#instances.set(slug, inst);
        }
        return inst;
    }

    private constructor(globalDB: Database, projectDB: Database, slug: string) {
        this.slug = slug;
        this.#g = new StoreDB(globalDB);
        this.#p = new StoreDB(projectDB);
    }

    #sdb(key: StoreKey): StoreDB {
        return key === "global" ? this.#g : this.#p;
    }

    // ── Accessors ───────────────────────────────────────────────────────────────

    resolve(id: string): [ItemRow, StoreKey] | null {
        const rowP = this.#p.s.getItem.get(id) as ItemRow | null;
        if (rowP) return [rowP, "project"];
        const rowG = this.#g.s.getItem.get(id) as ItemRow | null;
        if (rowG) return [rowG, "global"];
        return null;
    }

    resolveMeta(id: string): [ItemMeta, StoreKey] | null {
        const rowP = this.#p.s.getMeta.get(id) as ItemMeta | null;
        if (rowP) return [rowP, "project"];
        const rowG = this.#g.s.getMeta.get(id) as ItemMeta | null;
        if (rowG) return [rowG, "global"];
        return null;
    }

    edgesOut(id: string, key: StoreKey): EdgeRow[] {
        return this.#sdb(key).s.edgesOut.all(id) as EdgeRow[];
    }

    edgesIn(id: string): EdgeRow[] {
        return [
            ...(this.#p.s.edgesIn.all(id) as EdgeRow[]),
            ...(this.#g.s.edgesIn.all(id) as EdgeRow[]),
        ];
    }

    // Returns all current-status nodes from both stores.
    // Note: service:/module: subscoping was removed — it never matched for URL-based slugs.
    // All project-scoped nodes (scope='project', 'service:*', 'module:*') are returned.
    currentItems(): { global: ItemRow[]; project: ItemRow[] } {
        return {
            global: this.#g.s.currentItems.all() as ItemRow[],
            project: this.#p.s.currentItems.all() as ItemRow[],
        };
    }

    allItems(key: StoreKey): ItemRow[] {
        return this.#sdb(key).s.allItems.all() as ItemRow[];
    }

    // ── Bulk write — one transaction for all nodes (used by commitNodes) ────────

    commitBatch(key: StoreKey, nodes: ExtractionNode[]): void {
        const sdb = this.#sdb(key);
        sdb.db.transaction(() => {
            for (const n of nodes) {
                const desc = n.description || n.id;
                const scopeCol =
                    key === "global" ? "global" : n.scope || "project";
                const status = VALID_STATUSES.includes(n.status as any)
                    ? n.status!
                    : "current";
                const authority = VALID_AUTHORITIES.includes(n.authority as any)
                    ? n.authority!
                    : "follow";
                const prior = sdb.s.getItem.get(n.id) as ItemRow | null;
                const savedAt = this.#versionIfChanged(
                    sdb,
                    n.id,
                    prior,
                    desc,
                    n.content,
                );
                sdb.s.upsertItem.run(
                    n.id,
                    n.type,
                    status,
                    scopeCol,
                    authority,
                    desc,
                    n.content,
                    savedAt,
                );
            }
        })();
    }

    // ── Writes ───────────────────────────────────────────────────────────────────

    upsert(
        key: StoreKey,
        id: string,
        type: string,
        status: string,
        scope: string,
        authority: string,
        description: string,
        content: string,
        existing?: ItemRow | null, // pass if already fetched to avoid re-SELECT
    ): void {
        const sdb = this.#sdb(key);
        sdb.db.transaction(() => {
            const prior =
                existing !== undefined
                    ? existing
                    : (sdb.s.getItem.get(id) as ItemRow | null);
            const savedAt = this.#versionIfChanged(
                sdb,
                id,
                prior,
                description,
                content,
            );
            sdb.s.upsertItem.run(
                id,
                type,
                status,
                scope,
                authority,
                description,
                content,
                savedAt,
            );
        })();
        // edges not touched — no need to dirty the edge index
    }

    #markEdgeDirty(): void {
        this.#edgeDirty = true;
        this.#edgeIndex = null;
    }

    // Shared snapshot logic — called by both upsert and commitBatch
    #versionIfChanged(
        sdb: StoreDB,
        id: string,
        prior: ItemRow | null,
        description: string,
        content: string,
    ): string {
        if (prior) {
            const changed =
                prior.content !== content || prior.description !== description;
            if (changed) {
                const lastVer = (sdb.s.maxVersion.get(id) as { v: number }).v;
                sdb.s.insertVersion.run(
                    id,
                    lastVer + 1,
                    prior.type,
                    prior.description,
                    prior.content,
                    prior.saved_at,
                );
            }
            // Preserve saved_at when only metadata (not content or description) changed
            if (!changed) return prior.saved_at;
        }
        return new Date().toISOString(); // new node, or content/description changed
    }

    touchRecall(key: StoreKey, id: string): void {
        this.#sdb(key).s.updateRecall.run(new Date().toISOString(), id);
    }

    insertEdge(
        key: StoreKey,
        fromId: string,
        toId: string,
        edgeType: string,
    ): void {
        this.#sdb(key).s.insertEdge.run(fromId, toId, edgeType);
        this.#markEdgeDirty();
    }

    deleteEdge(
        key: StoreKey,
        fromId: string,
        toId: string,
        edgeType: string,
    ): void {
        this.#sdb(key).s.deleteEdge.run(fromId, toId, edgeType);
        this.#markEdgeDirty();
    }

    deleteItem(key: StoreKey, id: string): void {
        const sdb = this.#sdb(key);
        sdb.db.transaction(() => {
            sdb.s.deleteVersions.run(id);
            sdb.s.deleteEdgesFrom.run(id); // FK cascade is OFF; must delete manually
            sdb.s.deleteItem.run(id);
        })();
        this.#markEdgeDirty();
    }

    countEdgesTo(key: StoreKey, id: string): number {
        return (this.#sdb(key).s.countEdgesTo.get(id) as { n: number }).n;
    }

    rename(
        oldId: string,
        newId: string,
    ): { storeKey: StoreKey; crossUpdated: number } {
        const resolved = this.resolve(oldId);
        if (!resolved) throw new Error(`No node: "${oldId}"`);
        const [, key] = resolved;
        const other = key === "global" ? "project" : "global";
        const s = this.#sdb(key).s;

        this.#sdb(key).db.transaction(() => {
            s.renameItem.run(newId, oldId);
            s.renameEdgeFrom.run(newId, oldId);
            s.renameEdgeTo.run(newId, oldId);
            s.renameVersion.run(newId, oldId);
        })();

        // Cross-store edge update is best-effort (two separate DBs, not one transaction).
        // If the process crashes between the two writes, the other DB retains the old ID.
        // Safe to repair by calling rename again — the in-store rename is idempotent.
        const crossN = this.countEdgesTo(other, oldId);
        if (crossN > 0) {
            try {
                this.#sdb(other).s.renameEdgeTo.run(newId, oldId);
            } catch (e: any) {
                throw new Error(
                    `Renamed "${oldId}" in ${key} but cross-store edge update failed: ${e?.message}. Run rename again to retry.`,
                );
            }
        }

        this.#markEdgeDirty();
        return { storeKey: key, crossUpdated: crossN };
    }

    move(
        id: string,
        destKey: StoreKey,
    ): {
        outEdgesMigrated: number;
        totalIncoming: number;
    } {
        const resolved = this.resolve(id);
        if (!resolved) throw new Error(`No node: "${id}"`);
        const [item, srcKey] = resolved;
        if (srcKey === destKey) throw new Error(`Already in ${destKey}`);

        const outEdges = this.edgesOut(id, srcKey);
        const totalIncoming = (["global", "project"] as StoreKey[]).reduce(
            (n, k) => n + this.countEdgesTo(k, id),
            0,
        );

        const srcDB = this.#sdb(srcKey).db;
        const srcS = this.#sdb(srcKey).s;
        const destDB = this.#sdb(destKey).db;
        const ds = this.#sdb(destKey).s;

        const versionRows = srcS.allVersions.all(id) as VersionRecord[];

        // Write destination first — a crash here leaves a duplicate, which is recoverable.
        // Writing source-delete first would risk permanent data loss on crash.
        destDB.transaction(() => {
            ds.upsertItem.run(
                item.id,
                item.type,
                item.status,
                item.scope,
                item.authority,
                item.description,
                item.content,
                item.saved_at,
            );
            for (const e of outEdges)
                ds.insertEdge.run(id, e.to_id, e.edge_type);
            for (const v of versionRows)
                ds.insertVersion.run(
                    v.id,
                    v.version,
                    v.type,
                    v.description,
                    v.content,
                    v.saved_at,
                );
        })();
        srcDB.transaction(() => {
            srcS.deleteVersions.run(id);
            srcS.deleteEdgesFrom.run(id); // FK cascade OFF — must delete manually (same as deleteItem method)
            srcS.deleteItem.run(id);
        })();

        this.#markEdgeDirty();
        return { outEdgesMigrated: outEdges.length, totalIncoming };
    }

    // ── Read ops ────────────────────────────────────────────────────────────────

    listVersions(key: StoreKey, id: string): VersionRow[] {
        return this.#sdb(key).s.listVersions.all(id) as VersionRow[];
    }

    getVersion(key: StoreKey, id: string, version: number): VersionSnap | null {
        return this.#sdb(key).s.getVersion.get(
            id,
            version,
        ) as VersionSnap | null;
    }

    search(query: string, limit: number): { item: ItemRow; store: StoreKey }[] {
        // Sanitize here so all callers are protected, not just search_context tool
        const safe = ftsQuery(query);
        if (!safe) return [];
        const results: { item: ItemRow; store: StoreKey }[] = [];
        for (const key of ["global", "project"] as StoreKey[]) {
            const hits = this.#sdb(key).s.searchFts.all(safe, limit) as {
                id: string;
                rank: number;
            }[];
            if (!hits.length) continue;
            // Batch-fetch via a cached prepared statement keyed by hit count
            const ids = hits.map((h) => h.id);
            const sdb = this.#sdb(key);
            let stmt = sdb.inCache.get(ids.length);
            if (!stmt) {
                stmt = sdb.db.prepare(
                    `SELECT * FROM items WHERE id IN (${ids.map(() => "?").join(",")})`,
                );
                sdb.inCache.set(ids.length, stmt);
            }
            const rows = stmt.all(...ids) as ItemRow[];
            // Preserve FTS rank order
            const byId = new Map(rows.map((r) => [r.id, r]));
            for (const hit of hits) {
                const item = byId.get(hit.id);
                if (item) results.push({ item, store: key });
            }
        }
        return results;
    }

    rebuildFts(): void {
        for (const key of ["global", "project"] as StoreKey[]) {
            this.#sdb(key).s.rebuildFts.run();
        }
    }

    // ── Graph traversal ─────────────────────────────────────────────────────────

    traverse(rootId: string): TraversedNode[] {
        const visited = new Map<string, number>();
        const resultSeen = new Set<string>(); // guards against duplicate result entries
        const result: TraversedNode[] = [];
        const queue: {
            id: string;
            depth: number;
            via: EdgeType | null;
            inStore: StoreKey;
        }[] = [];
        let head = 0; // index pointer — avoids O(n) Array.shift()

        // Local caches — eliminate repeated resolve/resolveMeta DB calls for the same ID
        const resolveCache: Map<string, [ItemRow, StoreKey] | null> = new Map();
        const resolveMetaCache: Map<string, [ItemMeta, StoreKey] | null> =
            new Map();
        const cachedResolve = (id: string) => {
            if (!resolveCache.has(id)) resolveCache.set(id, this.resolve(id));
            return resolveCache.get(id)!;
        };
        const cachedResolveMeta = (id: string) => {
            if (!resolveMetaCache.has(id))
                resolveMetaCache.set(id, this.resolveMeta(id));
            return resolveMetaCache.get(id)!;
        };

        const rootResolved = cachedResolve(rootId);
        queue.push({
            id: rootId,
            depth: 0,
            via: null,
            inStore: rootResolved?.[1] ?? "project",
        });

        while (head < queue.length) {
            const { id, depth, via, inStore } = queue[head++];
            if (via !== null && depth > (DEPTH_LIMITS[via] ?? 1)) continue;
            const prev = visited.get(id);
            if (prev !== undefined && prev <= depth) continue;
            visited.set(id, depth);
            if (resultSeen.has(id)) continue; // already in result at a shallower depth — skip duplicate push
            resultSeen.add(id);

            const resolved = cachedResolve(id);
            const item = resolved?.[0] ?? null;
            const itemStore = resolved?.[1] ?? inStore;
            const outRows = item ? this.edgesOut(id, itemStore) : [];
            const inRows = this.edgesIn(id);

            const outEdges = outRows.map((e) => {
                const target = cachedResolveMeta(e.to_id);
                queue.push({
                    id: e.to_id,
                    depth: depth + 1,
                    via: e.edge_type as EdgeType,
                    inStore: target?.[1] ?? "project",
                });
                return {
                    etype: e.edge_type as EdgeType,
                    toId: e.to_id,
                    toType: target?.[0].type ?? "?",
                    toStore: target?.[1] ?? null,
                    toExists: !!target,
                };
            });

            const inEdges = inRows.map((e) => {
                const source = cachedResolveMeta(e.from_id);
                return {
                    etype: e.edge_type as EdgeType,
                    fromId: e.from_id,
                    fromType: source?.[0].type ?? "?",
                    fromStore: source?.[1] ?? "project",
                };
            });

            result.push({
                id,
                type: item?.type ?? "?",
                status: item?.status ?? "unresolved",
                store: itemStore,
                exists: !!item,
                outEdges,
                inEdges,
            });
        }

        return result;
    }

    // ── Edge index for manifest (batch, avoids N+1) ────────────────────────────

    buildEdgeIndex(): {
        outByKey: Record<StoreKey, Map<string, EdgeRow[]>>;
        inByKey: Record<StoreKey, Map<string, EdgeRow[]>>;
        metaCache: Map<string, [ItemMeta, StoreKey] | null>;
    } {
        if (!this.#edgeDirty && this.#edgeIndex) return this.#edgeIndex; // metaCache populated in-place; cleared by #markEdgeDirty
        const outByKey = {
            global: new Map<string, EdgeRow[]>(),
            project: new Map<string, EdgeRow[]>(),
        };
        // inByKey is keyed by the target node id — captures cross-store edges correctly
        // by indexing every edge (regardless of source store) under the to_id
        const inByKey = {
            global: new Map<string, EdgeRow[]>(),
            project: new Map<string, EdgeRow[]>(),
        };
        const metaCache = new Map<string, [ItemMeta, StoreKey] | null>();

        // Pre-build a set of all node IDs per store for O(1) lookup during indexing
        // Use allIds (SELECT id only) not allItems (SELECT *) — avoids loading content column
        const idSet = {
            global: new Set(
                (this.#g.s.allIds.all() as { id: string }[]).map((r) => r.id),
            ),
            project: new Set(
                (this.#p.s.allIds.all() as { id: string }[]).map((r) => r.id),
            ),
        };

        for (const srcKey of ["global", "project"] as StoreKey[]) {
            for (const e of this.#sdb(
                srcKey,
            ).s.allEdgesOut.all() as EdgeRow[]) {
                // out-index: keyed by source store and from_id
                const outs = outByKey[srcKey].get(e.from_id) ?? [];
                outs.push(e);
                outByKey[srcKey].set(e.from_id, outs);
                // in-index: index under the store where to_id actually lives.
                // A node lives in exactly one store — break after the first match.
                let placed = false;
                for (const destKey of ["global", "project"] as StoreKey[]) {
                    if (!idSet[destKey].has(e.to_id)) continue;
                    const ins = inByKey[destKey].get(e.to_id) ?? [];
                    ins.push(e);
                    inByKey[destKey].set(e.to_id, ins);
                    placed = true;
                    break; // found — no need to check the other store
                }
                // Dangling to_id: node doesn't exist in either store.
                // Still index under "project" so neighborLine can display the [?] indicator.
                if (!placed) {
                    const ins = inByKey["project"].get(e.to_id) ?? [];
                    ins.push(e);
                    inByKey["project"].set(e.to_id, ins);
                }
            }
        }
        this.#edgeDirty = false;
        this.#edgeIndex = { outByKey, inByKey, metaCache }; // metaCache populated by manifestLine calls; survives until next write
        return this.#edgeIndex;
    }

    // ── Manifest line — uses pre-built edge index to avoid per-node DB calls ───

    manifestLine(
        item: ItemRow,
        key: StoreKey,
        edgeIndex?: ReturnType<EngramStore["buildEdgeIndex"]>,
    ): string {
        const idx = edgeIndex ?? this.buildEdgeIndex();
        const edges = this.neighborLine(item, key, idx);
        const parts = [`${item.id.padEnd(24)} ${sigil(item.type)}`];
        if (edges) parts.push(edges);
        return parts.join("  ");
    }
    // ── Neighbor line — shared edge formatter used by manifestLine and search_context ─

    neighborLine(
        item: ItemRow,
        key: StoreKey,
        edgeIndex: ReturnType<EngramStore["buildEdgeIndex"]>,
    ): string {
        const { outByKey, inByKey, metaCache } = edgeIndex;

        const cachedMeta = (id: string): [ItemMeta, StoreKey] | null => {
            if (!metaCache.has(id)) metaCache.set(id, this.resolveMeta(id));
            return metaCache.get(id)!;
        };

        const outEdges = outByKey[key].get(item.id) ?? [];
        const inEdges = inByKey[key].get(item.id) ?? [];

        const outRefs = outEdges.map((e) => {
            const target = cachedMeta(e.to_id);
            return ref(
                e.to_id,
                target?.[0].type ?? "?",
                !!target,
                target?.[1] ?? null,
                key,
            );
        });
        const inRefs = inEdges.map((e) => {
            const source = cachedMeta(e.from_id);
            return ref(
                e.from_id,
                source?.[0].type ?? "?",
                !!source,
                source?.[1] ?? key,
                key,
            );
        });

        const parts: string[] = [];
        if (outRefs.length) parts.push("→" + outRefs.join(","));
        if (inRefs.length) parts.push("←" + inRefs.join(","));
        return parts.join("  ");
    }
    // ── Scoring ──────────────────────────────────────────────────────────────────

    score(
        globalItems: ItemRow[],
        projectItems: ItemRow[],
        recentTerms: Set<string>,
        tokenCache?: Map<string, Set<string>>,
    ): ScoredItem[] {
        const all: [ItemRow, StoreKey][] = [
            ...globalItems.map((i) => [i, "global"] as [ItemRow, StoreKey]),
            ...projectItems.map((i) => [i, "project"] as [ItemRow, StoreKey]),
        ];
        if (!all.length) return [];

        // Batch-fetch all degree counts in 4 queries (2 per store) instead of 3 per node
        const degOut: Map<string, number> = new Map();
        const degIn: Map<string, number> = new Map();
        for (const key of ["global", "project"] as StoreKey[]) {
            for (const r of this.#sdb(key).s.allDegreesOut.all() as {
                id: string;
                n: number;
            }[])
                degOut.set(r.id, (degOut.get(r.id) ?? 0) + r.n);
            for (const r of this.#sdb(key).s.allDegreesIn.all() as {
                id: string;
                n: number;
            }[])
                degIn.set(r.id, (degIn.get(r.id) ?? 0) + r.n);
        }

        const maxRecall = Math.max(1, ...all.map(([i]) => i.recall_count));
        const degrees = all.map(
            ([i]) => (degOut.get(i.id) ?? 0) + (degIn.get(i.id) ?? 0),
        );
        const maxDegree = Math.max(1, ...degrees);

        return all
            .map(([item, storeKey], idx) => {
                const cacheKey = item.id;
                let itemTerms = tokenCache?.get(cacheKey);
                if (!itemTerms) {
                    itemTerms = tokenize(`${item.id} ${item.description}`);
                    tokenCache?.set(cacheKey, itemTerms);
                }
                const overlap = jaccardOverlap(itemTerms, recentTerms);
                const normRecall = item.recall_count / maxRecall;
                const normDegree = degrees[idx] / maxDegree;
                return {
                    item,
                    store: storeKey,
                    score: overlap + 0.2 * normRecall + 0.1 * normDegree,
                };
            })
            .sort((a, b) => b.score - a.score);
    }
}

// ─── Autonomous extraction ────────────────────────────────────────────────────
// Reads the conversation directly and writes nodes without any model cooperation.
// Called from session.idle, session.compacted, and chat.message — never relies on the session
// model choosing to call save_context.

const EXTRACTION_SYSTEM = `You extract persistent knowledge from a coding session transcript.
You are a JSON extraction tool. You MUST respond with ONLY a JSON object — no prose, no explanation, no markdown.

Return exactly this structure:
{"nodes": [...]}

Each node:
  { "id": "<slug>", "type": "<type>", "scope": "<scope>",
    "description": "<one line>", "content": "<full detail>",
    "status": "current", "authority": "follow" }

Types: decision (choices made), convention (always/never rules), reference (external facts),
       procedure (how-to steps), summary (work completed), hypothesis (things to verify).
Scope: "global" (cross-project patterns) or "project" (specific to this codebase).

Rules:
- Only extract things worth remembering in future sessions.
- Skip transient debugging, failed attempts, and obvious facts.
- Ignore any tool calls in the transcript — extract knowledge from the content, not the actions.
- id must be a lowercase-hyphenated slug, max 40 chars.
- Merge related items into one node rather than splitting.
- Return {"nodes":[]} if nothing is worth saving.
- Your ENTIRE response must be valid JSON. Not a single word outside the JSON object.`;

// ─── Provider routing ─────────────────────────────────────────────────────────
// Maps the session's active provider to the cheapest capable model + endpoint.
// anthropic / openrouter → Haiku 4.5
// openai                 → gpt-4o-mini
// anything else          → use the session's own model via the same provider

interface ExtractionTarget {
    url: string;
    headers: Record<string, string>;
    model: string;
    // parse the raw response text out of the provider-specific envelope
    parseText: (body: any) => string;
    // build the provider-specific request body
    buildBody: (model: string, system: string, userMsg: string) => object;
}

// Shared OpenAI-compatible request body builder (used by OpenRouter and OpenAI)
function openAICompatBody(
    model: string,
    system: string,
    userMsg: string,
): object {
    return {
        model,
        max_tokens: 1024,
        messages: [
            { role: "system", content: system },
            { role: "user", content: userMsg },
        ],
    };
}

function anthropicTarget(key: string): ExtractionTarget {
    return {
        url: "https://api.anthropic.com/v1/messages",
        headers: {
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        model: "claude-haiku-4-5-20251001",
        parseText: (b) => b?.content?.[0]?.text?.trim() ?? "",
        buildBody: (model, system, userMsg) => ({
            model,
            max_tokens: 1024,
            system,
            messages: [{ role: "user", content: userMsg }],
        }),
    };
}

function resolveExtractionTarget(
    providerID: string,
    log: (msg: string) => void,
): ExtractionTarget | null {
    const pid = providerID.toLowerCase();

    // ── Anthropic ──────────────────────────────────────────────────────────────
    if (pid === "anthropic") {
        const key = process.env.ANTHROPIC_API_KEY;
        if (!key) {
            log("extraction: no ANTHROPIC_API_KEY — falling back to session");
            return null;
        }
        return anthropicTarget(key);
    }

    // ── OpenRouter (OpenAI-compatible, Anthropic model via their proxy) ────────
    if (pid === "openrouter") {
        const key = process.env.OPENROUTER_API_KEY;
        if (!key) {
            log("extraction: no OPENROUTER_API_KEY — falling back to session");
            return null;
        }
        return {
            url: "https://openrouter.ai/api/v1/chat/completions",
            headers: {
                Authorization: `Bearer ${key}`,
                "content-type": "application/json",
            },
            model: "anthropic/claude-haiku-4-5",
            parseText: (b) => b?.choices?.[0]?.message?.content?.trim() ?? "",
            buildBody: openAICompatBody,
        };
    }

    // ── OpenAI ─────────────────────────────────────────────────────────────────
    if (pid === "openai") {
        const key = process.env.OPENAI_API_KEY;
        if (!key) {
            log("extraction: no OPENAI_API_KEY — falling back to session");
            return null;
        }
        return {
            url: "https://api.openai.com/v1/chat/completions",
            headers: {
                Authorization: `Bearer ${key}`,
                "content-type": "application/json",
            },
            model: "gpt-4o-mini",
            parseText: (b) => b?.choices?.[0]?.message?.content?.trim() ?? "",
            buildBody: openAICompatBody,
        };
    }

    // ── Fallback: try Anthropic key for unknown providers; give up if unavailable ─
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (anthropicKey) {
        log(
            `extraction: unknown provider "${providerID}", falling back to Anthropic haiku`,
        );
        return anthropicTarget(anthropicKey);
    }
    log(
        `extraction: unknown provider "${providerID}" — will use user's model via opencode session`,
    );
    return null; // signals extractBatch to use the opencode-session path
}

// JSON schema for structured extraction output — used with opencode session fallback
// Enums derived from VALID_* constants — single source of truth
const EXTRACTION_SCHEMA = {
    type: "object",
    properties: {
        nodes: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    id: { type: "string" },
                    type: { type: "string", enum: VALID_TYPES },
                    scope: { type: "string", enum: ["global", "project"] },
                    description: { type: "string" },
                    content: { type: "string" },
                    status: { type: "string", enum: VALID_STATUSES },
                    authority: { type: "string", enum: VALID_AUTHORITIES },
                },
                required: ["id", "type", "scope", "description", "content"],
            },
        },
    },
    required: ["nodes"],
};

// Fetch and format a transcript for one session
async function fetchTranscript(
    sessionId: string,
    client: any,
    log: (msg: string) => void,
): Promise<string | null> {
    let messages: any[] = [];
    try {
        const resp = await client.session.messages({ path: { id: sessionId } });
        messages = Array.isArray(resp?.data)
            ? resp.data
            : Array.isArray(resp)
              ? resp
              : [];
    } catch (e: any) {
        log(
            `extraction: session.messages failed [${sessionId}] — ${e?.message ?? e}`,
        );
        return null;
    }
    if (!messages.length) return null;
    const recent = messages.slice(-EXTRACTION_MSG_LIMIT);
    const text = recent
        .map((m: any) => {
            const role = m.role ?? m.metadata?.role ?? "unknown";
            const parts: any[] = m.parts ?? m.content ?? [];
            const segments: string[] = [];
            for (const p of parts) {
                if (p.type === "text" && p.text?.trim())
                    segments.push(p.text.trim());
                else if (p.type === "tool_call" || p.type === "tool_use")
                    segments.push(
                        `[tool: ${p.name ?? p.tool_name ?? "?"}(${JSON.stringify(p.input ?? p.arguments ?? {}).slice(0, 120)})]`,
                    );
                else if (p.type === "tool_result")
                    segments.push(
                        `[tool_result: ${String(p.content ?? p.output ?? "").slice(0, 120)}]`,
                    );
            }
            const body = segments.join(" ").trim();
            return body ? `[${role}] ${body}` : null;
        })
        .filter(Boolean)
        .join("\n\n");
    return text || null;
}

// Write extracted nodes into the store; returns count saved
function commitNodes(
    nodes: ExtractionNode[],
    store: EngramStore,
    label: string,
    log: (msg: string) => void,
): number {
    // Group by target store key so we open at most two outer transactions
    const byKey = new Map<StoreKey, ExtractionNode[]>();
    for (const n of nodes) {
        if (!n.id || !n.type || !n.content) continue;
        if (!VALID_TYPES.includes(n.type)) continue;
        // Enforce slug format — a bad ID would be stored verbatim and never match dedup or manifest padding
        if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(n.id)) continue;
        const key = n.scope === "global" ? "global" : ("project" as StoreKey);
        const bucket = byKey.get(key) ?? [];
        bucket.push(n);
        byKey.set(key, bucket);
    }
    let saved = 0;
    for (const [storeKey, bucket] of byKey) {
        // One transaction per store — N node writes = 1 WAL flush instead of N
        store.commitBatch(storeKey, bucket);
        saved += bucket.length;
    }
    log(`extraction: saved ${saved} node(s) via ${label}`);
    return saved;
}

// Single-job fallback (ephemeral opencode session, unknown providers only)
// transcript is pre-fetched by extractBatch — pass it directly to avoid a second message.list call
async function extractViaSession(
    providerID: string,
    modelID: string,
    store: EngramStore,
    client: any,
    log: (msg: string) => void,
    transcript: string,
): Promise<void> {
    if (!transcript) return;

    const { global: gi, project: pi } = store.currentItems();
    const existingItems =
        [...gi, ...pi].map((i) => `${i.id}: ${i.description}`).join("\n") ||
        "none";
    // System prompt goes in body.system (same field used by direct API path in extractBatch).
    // User turn carries only the context-specific content: existing nodes + transcript.
    const systemMsg = EXTRACTION_SYSTEM;
    const userMsg = `Existing nodes (do not duplicate — check semantic similarity, not just ID):\n${existingItems}\n\n---\n\n${transcript}`;

    let ephemeralSessionId: string | null = null;
    let nodes: ExtractionNode[];
    try {
        const created = await client.session.create({
            body: { title: "engram-extraction" },
        });
        ephemeralSessionId = created?.data?.id ?? created?.id;
        if (!ephemeralSessionId) throw new Error("no session ID returned");
        const result = await client.session.prompt({
            path: { id: ephemeralSessionId },
            body: {
                system: systemMsg,
                parts: [{ type: "text", text: userMsg }],
            },
        });
        // Extract text from response parts
        const info = result?.data?.info ?? result?.data;
        const parts: any[] = info?.parts ?? result?.data?.parts ?? [];
        const raw = parts
            .filter((p: any) => p.type === "text")
            .map((p: any) => p.text ?? "")
            .join("")
            .trim();
        if (!raw) throw new Error("empty response from model");
        // Strip markdown code fences if present
        const stripped = raw
            .replace(/^```(?:json)?\s*/i, "")
            .replace(/\s*```$/, "")
            .trim();
        let parsed: any;
        try {
            parsed = JSON.parse(stripped);
        } catch {
            // Model returned prose instead of JSON.
            // If it looks like "nothing to save", treat as empty — otherwise log and skip.
            const lower = raw.toLowerCase();
            const looksEmpty =
                lower.includes("nothing") ||
                lower.includes("no node") ||
                lower.includes("nothing worth") ||
                lower.includes("no persistent") ||
                lower.includes("nothing to persist") ||
                lower.includes("nothing to save");
            if (looksEmpty) {
                nodes = [];
            } else {
                log(`extraction via session: model returned prose — skipping`);
                nodes = [];
            }
        }
        if (!nodes) {
            nodes = Array.isArray(parsed)
                ? parsed
                : Array.isArray(parsed?.nodes)
                  ? parsed.nodes
                  : null!;
            if (!Array.isArray(nodes))
                throw new Error(`unexpected shape: ${raw.slice(0, 120)}`);
        }
    } catch (e: any) {
        log(`extraction via session failed — ${e?.message ?? e}`);
        return;
    } finally {
        if (ephemeralSessionId)
            client.session
                .delete({ path: { id: ephemeralSessionId } })
                .catch(() => {});
    }
    commitNodes(nodes, store, `${providerID}/${modelID} (session)`, log);
}

// Batch extraction: group jobs by resolved target, one API call per group.
// Retry with exponential backoff for transient network errors (429, 503, etc.)
async function fetchWithRetry(
    url: string,
    init: RequestInit,
    log: (msg: string) => void,
    maxTries = 3,
): Promise<Response> {
    let lastErr: any;
    for (let attempt = 1; attempt <= maxTries; attempt++) {
        try {
            const res = await fetch(url, init);
            if (res.status === 429 || res.status >= 500) {
                // Respect Retry-After header if present (value is seconds)
                const retryAfter = res.headers.get("retry-after");
                const delay = retryAfter
                    ? Math.min(
                          Math.max(parseFloat(retryAfter) * 1000, 500),
                          60_000,
                      )
                    : 1000 * Math.pow(2, attempt - 1); // fallback: 1s, 2s, 4s
                log(
                    `extraction: HTTP ${res.status} (attempt ${attempt}/${maxTries}) — retrying in ${(delay / 1000).toFixed(1)}s`,
                );
                if (attempt < maxTries) {
                    await new Promise((r) => setTimeout(r, delay));
                    continue;
                }
                return res; // surface final error to caller
            }
            return res;
        } catch (e: any) {
            lastErr = e;
            const delay = 1000 * Math.pow(2, attempt - 1);
            log(
                `extraction: fetch error "${e?.message}" (attempt ${attempt}/${maxTries}) — retrying in ${delay}ms`,
            );
            if (attempt < maxTries)
                await new Promise((r) => setTimeout(r, delay));
        }
    }
    throw lastErr ?? new Error("fetch failed after retries");
}

async function extractBatch(
    jobs: ExtractionJob[],
    log: (msg: string) => void,
): Promise<void> {
    if (!jobs.length) return;

    // ── Step 1: fetch all transcripts in parallel — each job uses its own client ──
    const transcripts = await Promise.all(
        jobs.map((job) => fetchTranscript(job.sessionId, job.client, job.log)),
    );

    // ── Step 2: group by (targetKey, storeSlug) ──────────────────────────────
    // Cache target resolution — all jobs with the same providerID get the same target
    const targetCache = new Map<
        string,
        ReturnType<typeof resolveExtractionTarget>
    >();
    const getTarget = (providerID: string, grpLog: (msg: string) => void) => {
        if (!targetCache.has(providerID))
            targetCache.set(
                providerID,
                resolveExtractionTarget(providerID, grpLog),
            );
        return targetCache.get(providerID)!;
    };
    type Group = {
        target: ReturnType<typeof resolveExtractionTarget>;
        store: EngramStore;
        providerID: string;
        modelID: string;
        client: any;
        log: (msg: string) => void; // per-group (per-project) logger
        entries: { sessionId: string; transcript: string }[];
    };
    const groups = new Map<string, Group>();

    for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        const t = transcripts[i];
        if (!t) continue; // message.list failed or empty

        const jobStore = EngramStore.getInstance(job.storeSlug);
        const target = getTarget(job.providerID, job.log);
        const targetKey = target
            ? `${target.url}::${target.model}`
            : `session::${job.providerID}::${job.modelID}`;
        const groupKey = `${targetKey}||${job.storeSlug}`;

        if (!groups.has(groupKey)) {
            groups.set(groupKey, {
                target,
                store: jobStore,
                providerID: job.providerID,
                modelID: job.modelID,
                client: job.client,
                log: job.log,
                entries: [],
            });
        }
        groups
            .get(groupKey)!
            .entries.push({ sessionId: job.sessionId, transcript: t });
    }

    log(`queue consumer: ${jobs.length} job(s) → ${groups.size} request(s)`); // `log` here is batchLog from consumer

    // ── Step 3: one request per group ────────────────────────────────────────
    await Promise.all(
        [...groups.values()].map(async (grp) => {
            const {
                target,
                store,
                providerID,
                modelID,
                client: grpClient,
                log: grpLog,
                entries,
            } = grp;

            // Combine multiple transcripts with clear session separators
            const combined =
                entries.length === 1
                    ? entries[0].transcript
                    : entries
                          .map(
                              (e, idx) =>
                                  `=== SESSION ${idx + 1} (${e.sessionId}) ===\n${e.transcript}`,
                          )
                          .join("\n\n");

            const { global: gi, project: pi } = store.currentItems();
            const existingItems =
                [...gi, ...pi]
                    .map((i) => `${i.id}: ${i.description}`)
                    .join("\n") || "none";
            const userContent = `Existing nodes (do not duplicate — check semantic similarity, not just ID):\n${existingItems}\n\n---\n\n${combined}`;

            if (target) {
                // ── Known provider: single direct API call ──────────────────────────
                let body: any;
                try {
                    const res = await fetchWithRetry(
                        target.url,
                        {
                            method: "POST",
                            headers: target.headers,
                            body: JSON.stringify(
                                target.buildBody(
                                    target.model,
                                    EXTRACTION_SYSTEM,
                                    userContent,
                                ),
                            ),
                        },
                        grpLog,
                    );
                    if (!res.ok) {
                        grpLog(
                            `extraction API error ${res.status} from ${providerID}`,
                        );
                        return;
                    }
                    body = await res.json();
                } catch (e: any) {
                    grpLog(
                        `extraction fetch failed after retries — ${e?.message ?? e}`,
                    );
                    return;
                }
                const raw = target.parseText(body);
                let nodes: ExtractionNode[];
                try {
                    const parsed = JSON.parse(raw);
                    // Accept either {nodes:[...]} envelope (structured schema) or bare array (legacy)
                    nodes = Array.isArray(parsed)
                        ? parsed
                        : Array.isArray(parsed?.nodes)
                          ? parsed.nodes
                          : null!;
                    if (!Array.isArray(nodes))
                        throw new Error("expected array or {nodes:[...]}");
                } catch {
                    grpLog(
                        `extraction: bad JSON from model — ${raw.slice(0, 120)}`,
                    );
                    return;
                }
                commitNodes(
                    nodes,
                    store,
                    `${providerID}/${target.model}`,
                    grpLog,
                );
            } else {
                // ── Unknown provider: one ephemeral session per job (can't batch) ───
                await Promise.all(
                    entries.map((e) =>
                        extractViaSession(
                            providerID,
                            modelID,
                            store,
                            grpClient,
                            grpLog,
                            e.transcript,
                        ).catch((err: any) =>
                            grpLog(
                                `session extract error [${e.sessionId}]: ${err?.message ?? err}`,
                            ),
                        ),
                    ),
                ); // store is the per-group store resolved from job.storeSlug
            }
        }),
    );
}

// ─── Extraction queue ─────────────────────────────────────────────────────────
// Callers enqueue a job and return immediately. The consumer loop runs in the
// background, processing one job per tick so extraction never blocks the user.

interface ExtractionJob {
    sessionId: string;
    providerID: string;
    modelID: string;
    storeSlug: string; // which EngramStore to write into
    log: (msg: string) => void; // per-project client logger
    client: any; // per-project opencode client (for message.list)
    enqueuedAt: number;
}

// extractionQueue and extractionConsumerStarted are instantiated per plugin (see plugin body)

// enqueueExtraction and startExtractionConsumer are created per plugin instance (see plugin body)
// ─── Plugin ───────────────────────────────────────────────────────────────────

export const EngramPlugin: Plugin = async ({ directory, $, client }) => {
    const slug = await projectSlug(directory, $);
    const store = EngramStore.getInstance(slug);

    function log(msg: string) {
        fileLog(`[${slug}] ${msg}`);
    }

    // ── Instance-scoped state — each plugin instance (project) has its own ──────
    const sessions = new Map<string, SessionContext>();
    const extractionQueue: ExtractionJob[] = [];
    const enqueuedSessions = new Set<string>(); // O(1) dedup — mirrors queued sessionIds
    let extractionConsumerStarted = false;

    function getSession(id: string): SessionContext {
        let s = sessions.get(id);
        if (!s) {
            s = {
                messageCount: 0,
                recentTermBuf: [],
                recentTerms: new Set(),
                scores: new Map(),
                tokenCache: new Map(),
                lastScoredAt: -1,
                scoresDirty: false,
                lastExtractAt: 0,
                lastIdleExtractAt: 0,
                providerID: "",
                modelID: "",
            };
            sessions.set(id, s);
        }
        return s;
    }

    function markScoresDirty(): void {
        for (const sess of sessions.values()) {
            sess.scoresDirty = true;
            sess.tokenCache.clear();
        }
    }

    const enqueueExtraction = (job: ExtractionJob) => {
        // Per-instance queue: storeSlug is always `slug` here, so dedup on sessionId alone
        if (enqueuedSessions.has(job.sessionId)) return;
        // Drop the oldest entry rather than silently discarding the new one
        if (extractionQueue.length >= QUEUE_MAX_SIZE) {
            const dropped = extractionQueue.splice(0, 1);
            enqueuedSessions.delete(dropped[0].sessionId);
        }
        enqueuedSessions.add(job.sessionId);
        extractionQueue.push(job);
    };

    function startExtractionConsumer(): void {
        if (extractionConsumerStarted) return;
        extractionConsumerStarted = true;
        let qHead = 0; // pointer into extractionQueue — O(1) dequeue without Array.shift()
        const tick = async () => {
            const batch: ExtractionJob[] = [];
            while (batch.length < 10 && qHead < extractionQueue.length) {
                const job = extractionQueue[qHead++];
                enqueuedSessions.delete(job.sessionId);
                batch.push(job);
            }
            // Compact the array periodically to avoid unbounded growth of consumed entries
            if (qHead > 20) {
                extractionQueue.splice(0, qHead);
                qHead = 0;
            }
            if (batch.length > 0) {
                const batchLog = batch[0].log;
                for (const job of batch) {
                    const age = ((Date.now() - job.enqueuedAt) / 1000).toFixed(
                        1,
                    );
                    job.log(
                        `  → ${job.sessionId} [${job.storeSlug}] (queued ${age}s ago)`,
                    );
                }
                extractBatch(batch, batchLog).catch((e: any) =>
                    batchLog(`queue batch error: ${e?.message ?? e}`),
                );
            }
            setTimeout(tick, QUEUE_POLL_MS);
        };
        setTimeout(tick, QUEUE_POLL_MS);
    }

    startExtractionConsumer();
    log(`initialized — project: ${slug}`);

    function scheduleExtraction(sessionId: string, sess: SessionContext): void {
        enqueueExtraction({
            sessionId,
            providerID: sess.providerID || "anthropic",
            modelID: sess.modelID,
            storeSlug: slug,
            log,
            client,
            enqueuedAt: Date.now(),
        });
    }

    function rescore(sess: SessionContext): void {
        const { global: gi, project: pi } = store.currentItems();
        const scored = store.score(gi, pi, sess.recentTerms, sess.tokenCache);
        sess.scores.clear();
        for (const s of scored) sess.scores.set(s.item.id, s.score);
        sess.lastScoredAt = sess.messageCount;
        const hot = scored.filter((s) => s.score > 0).length;
        log(
            `scored ${scored.length} nodes — ${hot} hot, ${scored.length - hot} cold`,
        );
    }

    return {
        // ── session.created — prime context awareness on startup ─────────────────
        event: async ({ event }: any) => {
            const type = event?.type;

            if (type === "session.created") {
                const sessionId = getSessionId(event);
                if (!sessionId) return;
                const { global: gi, project: pi } = store.currentItems();
                if (!gi.length && !pi.length) return;
                // Silent primer — no reply generated, just injects awareness
                client.session
                    .prompt({
                        path: { id: sessionId },
                        body: {
                            noReply: true,
                            parts: [
                                {
                                    type: "text",
                                    text: `You have ${gi.length + pi.length} node(s) in engram for this project. Check the <engram> block in your system prompt and recall any nodes relevant to the current task.`,
                                },
                            ],
                        },
                    })
                    .catch(() => {});
                return;
            }

            // ── session.idle + session.compacted — autonomous extraction ─────────────
            if (type !== "session.idle" && type !== "session.compacted") return;
            const sessionId = getSessionId(event);
            if (!sessionId) return;

            // Use existing session state if available, or create a minimal one for
            // sub-agent sessions that were never tracked via chat.message.
            const sess = sessions.get(sessionId) ?? getSession(sessionId);

            const now = Date.now();
            const cooldownMs = 30_000;
            // session.idle fires after EVERY model turn (not after user inactivity).
            // Cooldown prevents extraction on every single turn — throttles to at most once per 30s.
            // Compaction is a distinct trigger and always extracts regardless of recent idle.
            if (type === "session.idle") {
                if (
                    sess.lastIdleExtractAt &&
                    now - sess.lastIdleExtractAt < cooldownMs
                )
                    return;
                sess.lastIdleExtractAt = now;
            }

            log(`${type} — queuing extraction`);
            scheduleExtraction(sessionId, sess);

            // Evict session state on idle — prevents unbounded Map growth.
            // getSession() will re-create a fresh entry if the session resumes.
            if (type === "session.idle") {
                sessions.delete(sessionId);
                log(`session evicted from memory: ${sessionId}`);
            }
        },

        // ── Compaction — reinject graph + hard save directive into continuation ──
        "experimental.session.compacting": async (input: any, output: any) => {
            const { global: gi, project: pi } = store.currentItems();
            if (!gi.length && !pi.length) return;

            const sessionId = getSessionId(input?.event) ?? "default";
            const sess = getSession(sessionId);
            if (sess.scores.size === 0) rescore(sess);

            const all = [
                ...gi.map((item) => ({ item, store: "global" as StoreKey })),
                ...pi.map((item) => ({ item, store: "project" as StoreKey })),
            ];
            const sorted = [...all].sort(
                (a, b) =>
                    (sess.scores.get(b.item.id) ?? 0) -
                    (sess.scores.get(a.item.id) ?? 0),
            );
            const { lines: hotLines } = buildManifestLines(
                sorted,
                store,
                store.buildEdgeIndex(),
            );
            const body =
                hotLines.length > 0
                    ? MANIFEST_LEGEND + "\n" + hotLines.join("\n")
                    : `${all.length} nodes in graph — use search_context(query) to find relevant nodes.`;

            output.context.push(`${ENGRAM_HEADER}${body}\n</engram>`);
            log(`compaction — engram graph reinjected (${all.length} nodes)`);
        },

        // ── Session tracking + inline save nudge appended to user messages ────────
        "chat.message": async ({ event, message }: any) => {
            const sessionId = getSessionId(event) ?? "default";
            const sess = getSession(sessionId);
            sess.messageCount++;

            if (message?.role === "user" && message?.content) {
                // Track provider/model from user message (carries model: { providerID, modelID })
                if (message.model?.providerID)
                    sess.providerID = message.model.providerID;
                if (message.model?.modelID)
                    sess.modelID = message.model.modelID;

                const text =
                    typeof message.content === "string"
                        ? message.content
                        : message.content
                              .map((p: any) => p.text ?? "")
                              .join(" ");
                // Sliding window: keep only last RECENT_TERMS_WINDOW message term sets
                const msgTerms = tokenize(text);
                if (sess.recentTermBuf.length >= RECENT_TERMS_WINDOW)
                    sess.recentTermBuf.splice(0, 1);
                sess.recentTermBuf.push(msgTerms);
                // Rebuild union from window (cheap for small N=10)
                sess.recentTerms = new Set(
                    sess.recentTermBuf.flatMap((s) => [...s]),
                );

                // Autonomous extraction every MESSAGE_EXTRACT_INTERVAL messages
                const extractDue =
                    sess.messageCount - sess.lastExtractAt >=
                    MESSAGE_EXTRACT_INTERVAL;
                if (extractDue && sessionId !== "default") {
                    sess.lastExtractAt = sess.messageCount;
                    log(
                        `chat.message — queuing extraction at message ${sess.messageCount}`,
                    );
                    scheduleExtraction(sessionId, sess);
                }
            }

            const isDue =
                sess.scoresDirty ||
                sess.lastScoredAt === -1 ||
                sess.messageCount - sess.lastScoredAt >= SCORE_INTERVAL;
            if (isDue) {
                sess.scoresDirty = false;
                rescore(sess);
            }
        },

        // ── Manifest ─────────────────────────────────────────────────────────────
        "experimental.chat.system.transform": async (input: any, output) => {
            const { global: gi, project: pi } = store.currentItems();
            if (!gi.length && !pi.length) return;

            const sess = getSession(getSessionId(input?.event) ?? "default");
            if (sess.scores.size === 0) rescore(sess);

            const all = [
                ...gi.map((item) => ({ item, store: "global" as StoreKey })),
                ...pi.map((item) => ({ item, store: "project" as StoreKey })),
            ];

            const hot: typeof all = [];
            const cold: typeof all = [];
            for (const entry of all) {
                ((sess.scores.get(entry.item.id) ?? 0) > 0 ? hot : cold).push(
                    entry,
                );
            }
            hot.sort(
                (a, b) =>
                    (sess.scores.get(b.item.id) ?? 0) -
                    (sess.scores.get(a.item.id) ?? 0),
            );
            cold.sort((a, b) => b.item.recall_count - a.item.recall_count);

            const edgeIndex = store.buildEdgeIndex();
            const { lines: hotLines, dropped } = buildManifestLines(
                hot,
                store,
                edgeIndex,
            );
            if (dropped > 0)
                log("manifest cap hit — dropping lowest-scored nodes");

            const coldCount = cold.length + dropped;
            const coldNote =
                coldCount > 0
                    ? `\n+${coldCount} lower-relevance node(s) — use search_context(query) or list_context() to access.`
                    : "";
            const body =
                hotLines.length > 0
                    ? MANIFEST_LEGEND + "\n" + hotLines.join("\n") + coldNote
                    : `${all.length} nodes available. Use search_context(query) to find relevant nodes.`;

            output.system.push(`${ENGRAM_HEADER}${body}\n</engram>`);
        },

        tool: {
            // ── recall_context ─────────────────────────────────────────────────────
            recall_context: tool({
                description:
                    "Retrieve a context node by ID from either the global or project store. " +
                    "Returns full Markdown content plus graph neighborhood up to per-edge-type " +
                    "depth limits. Cross-store references shown with :g/:p provenance suffix. " +
                    "Use the graph block to decide whether to recall dependencies.",
                args: { id: tool.schema.string().describe("Node ID") },
                async execute({ id }) {
                    const resolved = store.resolve(id);
                    if (!resolved) {
                        const inRows = store.edgesIn(id);
                        if (inRows.length)
                            return `"${id}" is referenced but not yet defined ([?]).\nReferenced by: ${inRows.map((e) => `${e.from_id} via ${e.edge_type}`).join(", ")}\nUse save_context to define it.`;
                        return `No node: "${id}". Use list_context or search_context to find available nodes.`;
                    }

                    const [item, key] = resolved;
                    store.touchRecall(key, id);
                    log(`recalled ${id} [${item.type}] from ${key}`);

                    const nodes = store.traverse(id);
                    const graph = fmtSubgraph(nodes, id);
                    return `<context id="${item.id}" type="${item.type}" store="${key}" authority="${item.authority}" scope="${item.scope}" status="${item.status}">\n<content>\n${xmlEscape(item.content)}\n</content>\n<graph>\n${graph}\n</graph>\n</context>`;
                },
            }),

            // ── search_context ──────────────────────────────────────────────────────
            search_context: tool({
                description:
                    "Graph-aware full-text search across both global and project stores. " +
                    "Use when you cannot identify the right node from the manifest. " +
                    "Each hit includes immediate graph neighborhood. " +
                    "Follow up with recall_context(id) on the best match.",
                args: {
                    query: tool.schema.string().describe("Search query"),
                    max_results: tool.schema
                        .number()
                        .optional()
                        .describe("Max hits per store (default 4)"),
                },
                async execute({ query, max_results = 4 }) {
                    if (!query.trim()) return "Empty query.";
                    // store.search() sanitizes internally — no need to pre-sanitize here
                    const hits = store.search(query, max_results);
                    log(`search "${query}" → ${hits.length} hit(s)`);
                    if (!hits.length) return `No results for "${query}".`;

                    const edgeIndex = store.buildEdgeIndex();
                    const xmlHits = hits.map(({ item, store: storeKey }) => {
                        const neighbors =
                            store.neighborLine(item, storeKey, edgeIndex) ||
                            "no edges";
                        return `<hit id="${item.id}" type="${item.type}" store="${storeKey}" status="${item.status}">\n  <description>${xmlEscape(item.description)}</description>\n  <neighbors>${xmlEscape(neighbors)}</neighbors>\n</hit>`;
                    });

                    // safe already stripped " — only & needs XML-escaping for the attribute
                    const safeAttr = xmlEscape(query);
                    return `<search-results query="${safeAttr}">\n${xmlHits.join("\n")}\n</search-results>\n<next-step>Call recall_context(id) on the most relevant hit.</next-step>`;
                },
            }),

            // ── save_context ────────────────────────────────────────────────────────
            save_context: tool({
                description:
                    "Create a new context node. Fails if the ID already exists — use update_context to modify. " +
                    "Defaults to project store; use store='global' for conventions that apply across all projects. " +
                    "Pick the most specific type: hypothesis for unverified risks, convention for always/never rules, " +
                    "decision for choices made, procedure for how-to steps, summary for completed work. " +
                    "Set authority=follow for active constraints, consult for advisories, historical for past context. " +
                    "When work is done on a hypothesis, use update_context to change it to a decision or convention.",
                args: {
                    id: tool.schema
                        .string()
                        .describe("Unique kebab-case ID, e.g. 'auth-flow'"),
                    type: tool.schema.string().describe(DESC_TYPES),
                    description: tool.schema
                        .string()
                        .describe("One-line manifest summary, under 80 chars"),
                    content: tool.schema
                        .string()
                        .describe("Full content in Markdown"),
                    store: tool.schema
                        .string()
                        .optional()
                        .describe("project (default) | global"),
                    status: tool.schema
                        .string()
                        .optional()
                        .describe(`${DESC_STATUSES} (default: current)`),
                    scope: tool.schema
                        .string()
                        .optional()
                        .describe(
                            "project (default) | service:name | module:name",
                        ),
                    authority: tool.schema
                        .string()
                        .optional()
                        .describe(`${DESC_AUTHORITIES} (default: follow)`),
                },
                async execute({
                    id,
                    type,
                    description,
                    content,
                    store: storeArg,
                    status,
                    scope,
                    authority,
                }) {
                    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id))
                        return `Invalid id "${id}". Must be a lowercase-hyphenated slug (a-z0-9-), 1–40 chars, starting with a letter or digit.`;
                    const key = (
                        storeArg === "global" ? "global" : "project"
                    ) as StoreKey;
                    const fieldErr = validateNodeFields(
                        type,
                        status,
                        authority,
                        scope,
                        key,
                    );
                    if (fieldErr) return fieldErr;
                    const existing = store.resolve(id);
                    if (existing)
                        return `"${id}" already exists in the ${existing[1]} store. Use update_context to modify it.`;

                    store.upsert(
                        key,
                        id,
                        type,
                        status ?? "current",
                        scope ?? (key === "global" ? "global" : "project"),
                        authority ?? "follow",
                        description,
                        content,
                    );
                    markScoresDirty();
                    log(`saved "${id}" [${type}] → ${key}`);

                    const inRows = store.edgesIn(id);
                    const resolvedNote = inRows.length
                        ? `\nResolves ${inRows.length} dangling edge(s) from: ${inRows.map((e) => e.from_id).join(", ")}`
                        : "";
                    return `Saved "${id}" [${type}] in ${key} store.${resolvedNote}`;
                },
            }),

            // ── update_context ───────────────────────────────────────────────────
            update_context: tool({
                description:
                    "Update fields on an existing node. Only provided fields are changed — " +
                    "omitted fields retain their current values. Previous content is versioned automatically. " +
                    "Common patterns: hypothesis→decision/convention when verified; status→archived when resolved; " +
                    "authority→historical when superseded. Cannot change store — use move_context for that.",
                args: {
                    id: tool.schema.string().describe("Node ID to update"),
                    type: tool.schema.string().optional().describe(DESC_TYPES),
                    description: tool.schema
                        .string()
                        .optional()
                        .describe("New one-line manifest summary"),
                    content: tool.schema
                        .string()
                        .optional()
                        .describe("New full content in Markdown"),
                    status: tool.schema
                        .string()
                        .optional()
                        .describe(DESC_STATUSES),
                    scope: tool.schema
                        .string()
                        .optional()
                        .describe("project|service:name|module:name"),
                    authority: tool.schema
                        .string()
                        .optional()
                        .describe(DESC_AUTHORITIES),
                },
                async execute({
                    id,
                    type,
                    description,
                    content,
                    status,
                    scope,
                    authority,
                }) {
                    const resolved = store.resolve(id);
                    if (!resolved)
                        return `No node: "${id}". Use save_context to create it.`;

                    const [existing, key] = resolved;
                    const fieldErr = validateNodeFields(
                        type,
                        status,
                        authority,
                        scope,
                        key,
                    );
                    if (fieldErr) return fieldErr;

                    store.upsert(
                        key,
                        id,
                        type ?? existing.type,
                        status ?? existing.status,
                        scope ?? existing.scope,
                        authority ?? existing.authority,
                        description ?? existing.description,
                        content ?? existing.content,
                        existing, // already fetched — skip re-SELECT inside upsert
                    );
                    markScoresDirty();

                    const changed = (
                        [
                            "type",
                            "description",
                            "content",
                            "status",
                            "scope",
                            "authority",
                        ] as const
                    )
                        .filter(
                            (f) =>
                                ({
                                    type,
                                    description,
                                    content,
                                    status,
                                    scope,
                                    authority,
                                })[f] != null,
                        )
                        .join(", ");
                    log(`updated "${id}" [${key}] — ${changed}`);
                    return `Updated "${id}" in ${key} store. Changed: ${changed}.`;
                },
            }),

            // ── link_context ────────────────────────────────────────────────────────
            link_context: tool({
                description:
                    "Add or remove a directed edge between nodes. " +
                    "Use to capture relationships: a fix that supersedes a hypothesis, a convention that constrains a decision, " +
                    "a procedure that implements a reference. to_id may not exist yet — dangling edges are allowed. " +
                    `edge_type: ${DESC_EDGES}.`,
                args: {
                    from_id: tool.schema
                        .string()
                        .describe("Source node ID (must exist)"),
                    to_id: tool.schema
                        .string()
                        .describe("Target node ID (may not exist yet)"),
                    edge_type: tool.schema.string().describe(DESC_EDGES),
                    remove: tool.schema
                        .boolean()
                        .optional()
                        .describe("true = remove this edge"),
                },
                async execute({ from_id, to_id, edge_type, remove }) {
                    const edgeErr = validate(
                        "edge_type",
                        edge_type,
                        VALID_EDGES,
                    );
                    if (edgeErr) return edgeErr;

                    const fromResolved = store.resolve(from_id);
                    if (!fromResolved)
                        return `Source "${from_id}" does not exist. Create it with save_context first.`;

                    // Resolve to_id once — reused for both the global→project guard and the success message
                    const toResolved = remove ? null : store.resolve(to_id);

                    if (!remove && fromResolved[1] === "global") {
                        if (toResolved?.[1] === "project")
                            return `Cannot link global→project: "${from_id}" (global) → "${to_id}" (project).\nGlobal nodes must only reference other global nodes — they are shared across all projects and a project-scoped target would be unresolvable elsewhere.\nEither move "${to_id}" to the global store, or reverse the edge direction.`;
                    }

                    if (remove) {
                        store.deleteEdge(
                            fromResolved[1],
                            from_id,
                            to_id,
                            edge_type,
                        );
                        markScoresDirty(); // degree counts change on edge removal
                        log(`unlinked ${from_id} -[${edge_type}]→ ${to_id}`);
                        return `Removed: ${from_id} -[${edge_type}]→ ${to_id}`;
                    }

                    store.insertEdge(
                        fromResolved[1],
                        from_id,
                        to_id,
                        edge_type,
                    );
                    markScoresDirty();
                    log(`linked ${from_id} -[${edge_type}]→ ${to_id}`);

                    const crossNote =
                        toResolved?.[1] !== fromResolved[1]
                            ? ` (cross-store: ${fromResolved[1]}→${toResolved?.[1]})`
                            : "";
                    const dangNote = !toResolved
                        ? ` (${to_id} is [?] — define with save_context)`
                        : "";
                    return `Linked: ${from_id} -[${edge_type}]→ ${to_id}${crossNote}${dangNote}`;
                },
            }),

            // ── delete_context ──────────────────────────────────────────────────────
            delete_context: tool({
                description:
                    "Delete a node and its outgoing edges from whichever store it lives in. " +
                    "Nodes pointing to it become dangling [?] references.",
                args: {
                    id: tool.schema.string().describe("Node ID to delete"),
                },
                async execute({ id }) {
                    const resolved = store.resolve(id);
                    if (!resolved) return `No node: "${id}".`;
                    const [, key] = resolved;
                    const inRows = store.edgesIn(id);
                    store.deleteItem(key, id);
                    markScoresDirty();
                    log(`deleted "${id}" from ${key}`);
                    return `Deleted "${id}" from ${key} store.${inRows.length ? ` ${inRows.length} edge(s) from [${inRows.map((e) => e.from_id).join(", ")}] now dangling.` : ""}`;
                },
            }),

            // ── move_context ──────────────────────────────────────────────────────
            move_context: tool({
                description:
                    "Atomically move a node between global and project stores. " +
                    "Rewrites outgoing edges into the destination DB. Incoming edge references " +
                    "remain valid since traversal checks both stores. " +
                    "Blocked if a global node references the node being moved to project " +
                    "(would create a forbidden global→project edge).",
                args: {
                    id: tool.schema.string().describe("Node ID to move"),
                    store: tool.schema
                        .string()
                        .describe("Destination store: global | project"),
                },
                async execute({ id, store: storeArg }) {
                    const destKey = (
                        storeArg === "global" ? "global" : "project"
                    ) as StoreKey;
                    const resolved = store.resolve(id);
                    if (!resolved) return `No node: "${id}".`;

                    const [, srcKey] = resolved;
                    if (srcKey === destKey)
                        return `"${id}" is already in the ${destKey} store.`;

                    if (destKey === "project") {
                        const inRows = store.edgesIn(id) as EdgeRow[];
                        // Batch resolve: one resolveMeta call per unique from_id, not per edge
                        const sourceStores = new Map<string, StoreKey | null>();
                        for (const e of inRows)
                            if (!sourceStores.has(e.from_id))
                                sourceStores.set(
                                    e.from_id,
                                    store.resolveMeta(e.from_id)?.[1] ?? null,
                                );
                        const globalIncoming = inRows.filter(
                            (e) => sourceStores.get(e.from_id) === "global",
                        );
                        if (globalIncoming.length)
                            return `Cannot move "${id}" to project — referenced by global node(s): ${globalIncoming.map((e) => e.from_id).join(", ")}.\nRemove those edges first, or move the referencing nodes to project too.`;
                    }

                    try {
                        const { outEdgesMigrated, totalIncoming } = store.move(
                            id,
                            destKey,
                        );
                        markScoresDirty(); // degree counts change when node moves store
                        log(`moved "${id}" ${srcKey} → ${destKey}`);
                        return `Moved "${id}" ${srcKey} → ${destKey}.${outEdgesMigrated ? ` ${outEdgesMigrated} outgoing edge(s) migrated.` : ""}${totalIncoming ? ` ${totalIncoming} incoming edge(s) resolve via ${destKey} store.` : ""}`;
                    } catch (e: any) {
                        return `Move failed: ${e.message}`;
                    }
                },
            }),

            // ── rename_context ───────────────────────────────────────────────────
            rename_context: tool({
                description:
                    "Atomically rename a node ID. Rewrites all edge from_id/to_id references " +
                    "across both stores so graph integrity is fully preserved. " +
                    "Also rewrites version history entries for the node.",
                args: {
                    old_id: tool.schema.string().describe("Current node ID"),
                    new_id: tool.schema.string().describe("New node ID"),
                },
                async execute({ old_id, new_id }) {
                    if (old_id === new_id)
                        return "IDs are identical — nothing to do.";
                    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(new_id))
                        return `Invalid new_id "${new_id}". Must be a lowercase-hyphenated slug (a-z0-9-), 1–40 chars.`;
                    if (!store.resolve(old_id)) return `No node: "${old_id}".`;
                    if (store.resolve(new_id))
                        return `"${new_id}" already exists. Delete it first or choose a different name.`;

                    try {
                        const { storeKey, crossUpdated } = store.rename(
                            old_id,
                            new_id,
                        );
                        markScoresDirty(); // old_id tokenCache entry is now a stale orphan
                        log(`renamed "${old_id}" → "${new_id}" [${storeKey}]`);
                        return `Renamed "${old_id}" → "${new_id}" in ${storeKey} store.${crossUpdated > 0 ? ` Updated ${crossUpdated} cross-store edge(s).` : ""}`;
                    } catch (e: any) {
                        return `Rename failed: ${e.message}`;
                    }
                },
            }),

            // ── history_context ──────────────────────────────────────────────────
            history_context: tool({
                description:
                    "Show the version history of a node — previous descriptions and content snapshots. " +
                    "Useful for understanding how an architectural decision evolved over time.",
                args: {
                    id: tool.schema.string().describe("Node ID"),
                    version: tool.schema
                        .number()
                        .optional()
                        .describe("Retrieve a specific version's full content"),
                },
                async execute({ id, version }) {
                    const resolved = store.resolve(id);
                    if (!resolved) return `No node: "${id}".`;
                    const [, key] = resolved;
                    const versions = store.listVersions(key, id);
                    if (!versions.length)
                        return `No history for "${id}" — it has never been overwritten.`;

                    if (version !== undefined) {
                        const snap = store.getVersion(key, id, version);
                        if (!snap)
                            return `Version ${version} not found for "${id}".`;
                        log(`history "${id}" v${version} retrieved`);
                        return `<version id="${id}" v="${version}" saved="${snap.saved_at}">\n<description>${xmlEscape(snap.description)}</description>\n<content>\n${xmlEscape(snap.content)}\n</content>\n</version>`;
                    }

                    const lines = versions.map(
                        (v) =>
                            `  v${v.version}  ${v.saved_at}  [${v.type}] ${v.description}`,
                    );
                    log(`history "${id}" — ${versions.length} snapshot(s)`);
                    return `History for "${id}" (${versions.length} snapshot(s)):\n${lines.join("\n")}\n\nCall history_context(id, version=N) to retrieve a specific snapshot.`;
                },
            }),

            // ── rebuild_fts ──────────────────────────────────────────────────────
            rebuild_fts: tool({
                description:
                    "Rebuild FTS5 search indexes from scratch in both stores. " +
                    "Use if search_context returns unexpected results — indexes can drift " +
                    "if the database was modified externally.",
                args: {},
                async execute() {
                    store.rebuildFts();
                    log("FTS indexes rebuilt");
                    return "FTS5 indexes rebuilt for both stores.";
                },
            }),

            // ── list_context ────────────────────────────────────────────────────────
            list_context: tool({
                description:
                    "List all nodes across both stores including hidden statuses. Useful for auditing the full graph.",
                args: {
                    store: tool.schema
                        .string()
                        .optional()
                        .describe("global | project | all (default)"),
                    status: tool.schema
                        .string()
                        .optional()
                        .describe(`${DESC_STATUSES} | all (default)`),
                },
                async execute({ store: storeArg, status }) {
                    const filter = (items: ItemRow[]) =>
                        items.filter(
                            (i) =>
                                !status ||
                                status === "all" ||
                                i.status === status,
                        );

                    const sections: string[] = [];
                    const idx = store.buildEdgeIndex(); // build once for both sections
                    let total = 0;

                    if (
                        !storeArg ||
                        storeArg === "all" ||
                        storeArg === "global"
                    ) {
                        const items = filter(store.allItems("global"));
                        total += items.length;
                        if (items.length)
                            sections.push(
                                "[global]\n" +
                                    items
                                        .map(
                                            (i) =>
                                                `  ${store.manifestLine(i, "global", idx)}  [${i.authority}] ${i.description}`,
                                        )
                                        .join("\n"),
                            );
                    }

                    if (
                        !storeArg ||
                        storeArg === "all" ||
                        storeArg === "project"
                    ) {
                        const items = filter(store.allItems("project"));
                        total += items.length;
                        if (items.length)
                            sections.push(
                                `[project: ${store.slug}]\n` +
                                    items
                                        .map(
                                            (i) =>
                                                `  ${store.manifestLine(i, "project", idx)}  [${i.authority}] ${i.description}`,
                                        )
                                        .join("\n"),
                            );
                    }

                    log(`list — ${total} node(s) across both stores`);
                    return sections.length
                        ? sections.join("\n\n")
                        : "Engram is empty.";
                },
            }),
        },
    };
};

export default EngramPlugin;
