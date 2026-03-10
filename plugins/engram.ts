/**
 * engram.ts — persistent context graph for opencode sessions
 * Drop in ~/.config/opencode/plugins/ (global) or .opencode/plugins/ (project).
 *
 * Two stores, always separate:
 *
 *   ~/.config/engram/global.db
 *     Cross-project conventions, personal patterns, long-form preferences.
 *
 *   ~/.config/engram/projects/<sha1>.db
 *     Scoped to the current git repo, identified by remote URL.
 *     DB filename = slugDbKey(label) — SHA-1 hash, 20 hex chars.
 *
 * Node kinds:    constraint decision interface reference procedure finding plan risk
 * Certainty:     confirmed (uppercase sigil) | working (SIGIL?) | speculative (lowercase sigil)
 * Authority:     binding (constraint/decision) | advisory (all others)
 * Importance:    1 (ephemeral) … 5 (irreversible architectural constraint); shown as i4/i5 in manifest
 * Edge types:    requires implements supersedes constrains validates causes contradicts informs
 * Edge attrs:    strength (0–1), rationale (why it exists), created_at
 *
 * Scoring (3-phase):
 *   Phase 1: Jaccard overlap + 0.20×recall-recency + 0.10×in-degree + 0.15×importance + 0.05×saved-recency
 *            × certainty multiplier (speculative=0.5, working=0.75, confirmed=1.0)
 *   Phase 2: one-hop propagation via edge type damping × strength
 *   Phase 3: min-max normalization to [0,1]
 *   Manifest: lowest-scored hot first, highest last (recency attention effect — most relevant nearest user turn)
 *
 * Manifest format (scored, compact):
 *   auth-flow         D  →jwt-config[R],error-handling[C:g]  ←api-gateway[r?]
 *   ssl-pinning       C i5                                    (i5 = importance 5, shown when ≠ default 3)
 *   ~weak-dep         x                                        (lowercase=speculative, ~=weak edge)
 */

import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { Database } from "bun:sqlite";
import { join } from "path";
import { homedir } from "os";
import { mkdirSync, appendFileSync, existsSync, renameSync } from "fs";
import { createHash } from "crypto";

// ─── Paths ────────────────────────────────────────────────────────────────────

const ENGRAM_ROOT = join(homedir(), ".config", "engram");
const ENGRAM_PROJECTS = join(ENGRAM_ROOT, "projects");
const GLOBAL_DB_PATH = join(ENGRAM_ROOT, "global.db");
const ENGRAM_LOG_PATH = join(ENGRAM_ROOT, "engram.log");

// ─── Logger ───────────────────────────────────────────────────────────────────
//
// Structured logger with levels and domain tags. Each line:
//   <ISO timestamp> [LEVEL] [TAG] [slug?] message
//
// Levels:  ERROR > WARN > INFO > DEBUG
// Tags:    DB  GRAPH  SCORE  EXTRACT  QUEUE  EVENT  TOOL
//
// Set ENGRAM_LOG_LEVEL=debug to see all lines (default: info).
// Set ENGRAM_LOG_LEVEL=warn to suppress info and debug.

type LogLevel = "debug" | "info" | "warn" | "error";
type LogTag =
    | "DB"
    | "GRAPH"
    | "SCORE"
    | "EXTRACT"
    | "QUEUE"
    | "EVENT"
    | "TOOL"
    | "INIT";

const LOG_LEVEL_RANK: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};
const _rawLogLevel = (
    process.env.ENGRAM_LOG_LEVEL ?? "info"
).toLowerCase() as LogLevel;
const ACTIVE_LOG_LEVEL: number =
    LOG_LEVEL_RANK[_rawLogLevel] ?? LOG_LEVEL_RANK.info;

// fileLog is the primitive writer — all other log calls go through it.
// Falls back to stderr if the file is unwritable, so no log line is ever silently lost.
function fileLog(
    level: LogLevel,
    tag: LogTag,
    slug: string | null,
    msg: string,
): void {
    if ((LOG_LEVEL_RANK[level] ?? 0) < ACTIVE_LOG_LEVEL) return;
    const prefix = slug
        ? `[${level.toUpperCase()}] [${tag}] [${slug}]`
        : `[${level.toUpperCase()}] [${tag}]`;
    const line = `${new Date().toISOString()} ${prefix} ${msg}\n`;
    try {
        appendFileSync(ENGRAM_LOG_PATH, line);
    } catch (writeErr) {
        // Log file unwritable — surface to stderr so it's never silently lost
        try {
            process.stderr.write(
                `engram log write failed: ${writeErr}\n${line}`,
            );
        } catch {}
    }
}

// Module-level logger (for DB open, global store init — no slug yet)
function glog(level: LogLevel, tag: LogTag, msg: string): void {
    fileLog(level, tag, null, msg);
}

let _globalDB: Database | null = null;
function getGlobalDB(): Database {
    if (!_globalDB) {
        mkdirSync(ENGRAM_PROJECTS, { recursive: true });
        glog("info", "DB", `opening global DB: ${GLOBAL_DB_PATH}`);
        _globalDB = openDB(GLOBAL_DB_PATH);
    }
    return _globalDB;
}

function slugDbKey(label: string): string {
    return createHash("sha1").update(label).digest("hex").slice(0, 20);
}

// ─── Project slug resolution + DB migration ───────────────────────────────────
//
// On every startup we compute the best slug we can for this cwd, then compare
// it against what we stored last time.  If we now have a more stable slug kind
// (remote > hash > cwd), we rename the on-disk project DB so no history is lost.

type SlugKind = "cwd" | "hash" | "remote";
const SLUG_KIND_RANK: Record<SlugKind, number> = { cwd: 0, hash: 1, remote: 2 };

interface ProjectRecord {
    cwd: string;
    slug: string;
    slug_kind: SlugKind;
}

// Computes slug + kind together so the caller can store the kind.
async function resolveProjectSlug(
    cwd: string,
    $: Function,
): Promise<{ slug: string; kind: SlugKind }> {
    try {
        const remote = (
            await $`git -C ${cwd} remote get-url origin`.text()
        ).trim();
        if (remote) {
            const slug = remote
                .replace(/^https?:\/\//, "")
                .replace(/^git@/, "")
                .replace(/\.git$/, "");
            glog("debug", "INIT", `resolveProjectSlug: git remote → ${slug}`);
            return { slug, kind: "remote" };
        }
    } catch {}

    try {
        const hash = (
            await $`git -C ${cwd} rev-list --max-parents=0 HEAD`.text()
        ).trim();
        if (hash) {
            glog(
                "debug",
                "INIT",
                `resolveProjectSlug: initial commit hash → ${hash}`,
            );
            return { slug: hash, kind: "hash" };
        }
    } catch {}

    glog(
        "warn",
        "INIT",
        `resolveProjectSlug: no git remote or commits found — falling back to cwd "${cwd}". ` +
            `This slug will break if the directory is renamed or moved. ` +
            `Run "git init && git commit" to get a stable identity.`,
    );
    return { slug: cwd, kind: "cwd" };
}

// Looks up the stored record for cwd.  If the freshly computed slug is better,
// renames the old project DB file (if it exists) and updates the record.
// Returns the slug that should be used for this session.
function reconcileProjectSlug(
    cwd: string,
    fresh: { slug: string; kind: SlugKind },
): string {
    const globalDB = getGlobalDB();

    const stored = globalDB
        .query("SELECT cwd, slug, slug_kind FROM known_projects WHERE cwd = ?")
        .get(cwd) as ProjectRecord | null;

    if (!stored) {
        // First time we've seen this cwd — just record it.
        globalDB.run(
            "INSERT INTO known_projects (cwd, slug, slug_kind) VALUES (?, ?, ?)",
            [cwd, fresh.slug, fresh.kind],
        );
        glog(
            "info",
            "INIT",
            `known_projects: registered cwd="${cwd}" slug="${fresh.slug}" kind=${fresh.kind}`,
        );
        return fresh.slug;
    }

    const storedRank = SLUG_KIND_RANK[stored.slug_kind as SlugKind] ?? 0;
    const freshRank = SLUG_KIND_RANK[fresh.kind];

    if (freshRank <= storedRank) {
        // Stored slug is at least as stable — keep it (avoids downgrading remote→hash
        // if git remote is temporarily unavailable).
        if (stored.slug !== fresh.slug) {
            glog(
                "debug",
                "INIT",
                `known_projects: keeping stored slug "${stored.slug}" (${stored.slug_kind}) over "${fresh.slug}" (${fresh.kind})`,
            );
        }
        return stored.slug;
    }

    // We have a better slug — rename the DB file if it exists.
    const oldDbPath = join(ENGRAM_PROJECTS, `${slugDbKey(stored.slug)}.db`);
    const newDbPath = join(ENGRAM_PROJECTS, `${slugDbKey(fresh.slug)}.db`);

    try {
        // Rename WAL companion first (if present), then the main DB file.
        // SHM is recreated automatically by SQLite on next open — no rename needed.
        // existsSync + renameSync are already imported from "fs" at the top of the file.
        const walPath = oldDbPath + "-wal";
        if (existsSync(walPath)) renameSync(walPath, newDbPath + "-wal");
        if (existsSync(oldDbPath)) {
            renameSync(oldDbPath, newDbPath);
            glog(
                "info",
                "INIT",
                `known_projects: upgraded slug "${stored.slug}" (${stored.slug_kind}) → "${fresh.slug}" (${fresh.kind}), DB renamed`,
            );
        } else {
            glog(
                "info",
                "INIT",
                `known_projects: upgraded slug "${stored.slug}" (${stored.slug_kind}) → "${fresh.slug}" (${fresh.kind}), no existing DB to rename`,
            );
        }
    } catch (e: any) {
        glog(
            "error",
            "INIT",
            `known_projects: DB rename failed (${e?.message ?? e}) — continuing with new slug; old DB at ${oldDbPath} may be orphaned`,
        );
    }

    globalDB.run(
        "UPDATE known_projects SET slug = ?, slug_kind = ? WHERE cwd = ?",
        [fresh.slug, fresh.kind, cwd],
    );
    return fresh.slug;
}

// ─── Types ────────────────────────────────────────────────────────────────────

type NodeKind =
    | "constraint" // always/never rule — architectural or code-level
    | "decision" // choice made, rationale recorded
    | "interface" // internal API/schema boundary you own and enforce
    | "reference" // external fact: library API, spec, third-party behavior
    | "procedure" // how-to steps
    | "finding" // result of investigation or completed work
    | "plan" // intended future work
    | "risk"; // unverified concern or assumption

type NodeStatus = "active" | "deprecated" | "draft" | "archived";
type NodeAuthority = "binding" | "advisory";
type NodeCertainty = "confirmed" | "working" | "speculative";

type EdgeType =
    | "requires" // A needs B to function
    | "implements" // A is a concrete realization of interface B
    | "supersedes" // A replaces B (B should become archived)
    | "constrains" // B limits what A can do
    | "validates" // A is evidence that B is true or false
    | "causes" // A's existence made B necessary
    | "contradicts" // A and B are in conflict
    | "informs"; // A is context that shaped B (directional)

type StoreKey = "global" | "project";

// ─── Constants ────────────────────────────────────────────────────────────────

const KIND_SIGIL: Record<NodeKind, string> = {
    constraint: "C",
    decision: "D",
    interface: "I",
    reference: "R",
    procedure: "P",
    finding: "F",
    plan: "N", // plaN
    risk: "X", // risK — X to avoid collision
};

// Traversal depth limits per edge type
const DEPTH_LIMITS: Record<EdgeType, number> = {
    requires: 3, // dependency chains are deep and matter
    constrains: 3, // constraint trees too
    implements: 2,
    validates: 2,
    causes: 2,
    supersedes: 1, // just the immediate replacement
    contradicts: 1,
    informs: 1,
};

// Score propagation damping: fwd = A→B boost when A is hot, bwd = B←A boost
const PROPAGATION: Record<EdgeType, { fwd: number; bwd: number }> = {
    requires: { fwd: 0.55, bwd: 0.35 }, // if A is hot, its deps matter; vice versa
    constrains: { fwd: 0.45, bwd: 0.45 }, // symmetric — constraints matter both ways
    implements: { fwd: 0.3, bwd: 0.2 },
    validates: { fwd: 0.3, bwd: 0.25 },
    causes: { fwd: 0.2, bwd: 0.15 },
    supersedes: { fwd: 0.15, bwd: 0.1 },
    contradicts: { fwd: 0.25, bwd: 0.25 }, // conflicts matter symmetrically
    informs: { fwd: 0.1, bwd: 0.05 },
};

const VALID_KINDS: NodeKind[] = [
    "constraint",
    "decision",
    "interface",
    "reference",
    "procedure",
    "finding",
    "plan",
    "risk",
];
const VALID_STATUSES: NodeStatus[] = [
    "active",
    "deprecated",
    "draft",
    "archived",
];
const VALID_AUTHORITIES: NodeAuthority[] = ["binding", "advisory"];
const VALID_CERTAINTIES: NodeCertainty[] = [
    "confirmed",
    "working",
    "speculative",
];
const VALID_EDGES: EdgeType[] = [
    "requires",
    "implements",
    "supersedes",
    "constrains",
    "validates",
    "causes",
    "contradicts",
    "informs",
];

const DESC_KINDS =
    "constraint (always/never rule) | decision (choice made) | interface (internal API/schema you own) | " +
    "reference (external fact) | procedure (how-to steps) | finding (investigation result) | " +
    "plan (future work) | risk (unverified concern)";
const DESC_STATUSES =
    "active (live) | deprecated (superseded) | draft (unverified) | archived (resolved/done)";
const DESC_AUTHORITIES =
    "binding (must be respected) | advisory (check before acting)";
const DESC_CERTAINTIES =
    "confirmed (verified) | working (assumed true) | speculative (uncertain)";
const DESC_EDGES =
    "requires (A needs B) | implements (A realizes interface B) | supersedes (A replaces B) | " +
    "constrains (B limits A) | validates (A is evidence for/against B) | causes (A made B necessary) | " +
    "contradicts (A and B conflict) | informs (A is context that shaped B)";

const MANIFEST_LEGEND =
    [
        "Kinds: " +
            Object.entries(KIND_SIGIL)
                .map(([k, s]) => `${s}=${k}`)
                .join(" "),
        "Certainty: UPPER=confirmed  UPPER?=working  lower=speculative",
        "Edges: ~prefix=weak(<0.5)  :g=global  :p=project  [?]=unresolved",
    ].join("\n") + "\n";

const MANIFEST_CHAR_CAP = 3200; // ~800 token ceiling for manifest body
const SCORE_INTERVAL = 5; // rescore every N messages
const RECENT_TERMS_WINDOW = 10; // sliding window size for Jaccard terms
const RECALL_HALF_LIFE_DAYS = 10; // exponential decay λ = ln(2) / 10 ≈ 0.069
const QUEUE_POLL_MS = 5_000;
const QUEUE_MAX_SIZE = 50;
const EXTRACTION_MSG_LIMIT = 40;
const EXTRACTION_MIN_MESSAGES = 5; // skip extraction if session has fewer messages than this

const _rawExtractEvery = Number(process.env.ENGRAM_EXTRACT_EVERY ?? 20);
const MESSAGE_EXTRACT_INTERVAL =
    Number.isFinite(_rawExtractEvery) && _rawExtractEvery > 0
        ? Math.floor(_rawExtractEvery)
        : 20;

const ENGRAM_HEADER = `<engram>
Persistent context graph. Nodes below are saved from previous sessions.

At session start: scan these nodes and recall any that look relevant to the current task before asking clarifying questions. When a node ID looks relevant, call recall_context(id) to get full content and graph neighborhood. If unsure which node, use search_context(query) first.

During work, write to context when:
- You choose between two or more approaches → save_context (decision)
- A bug or unexpected behavior is confirmed → save_context (finding)
- You learn how an external API, library, or system actually behaves → save_context (reference)
- An assumption in the manifest turns out to be wrong → update_context (correct content/certainty)
- A risk or plan node in the manifest reaches a conclusion → resolve_context
- You establish a rule that must hold across the codebase → save_context (constraint)

Do not write for: steps you are about to take, routine tool calls, speculative ideas not yet tested, or anything already captured in the manifest.

`;

// ─── Validation ───────────────────────────────────────────────────────────────

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
    kind?: string,
    status?: string,
    authority?: string,
    certainty?: string,
): string | null {
    if (kind) {
        const e = validate("kind", kind, VALID_KINDS);
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
    if (certainty) {
        const e = validate("certainty", certainty, VALID_CERTAINTIES);
        if (e) return e;
    }
    return null;
}

// ─── Interfaces ───────────────────────────────────────────────────────────────

interface ItemRow {
    id: string;
    kind: string;
    status: string;
    authority: string;
    certainty: string;
    importance: number; // 1–5, default 3; used as independent scoring dimension
    description: string;
    content: string;
    saved_at: string;
    recall_count: number;
    last_recalled_at: string | null;
}

interface ItemMeta {
    id: string;
    kind: string;
    status: string;
    certainty: string;
}

interface EdgeRow {
    from_id: string;
    to_id: string;
    edge_type: string;
    strength: number;
    rationale: string | null;
    created_at: string;
}

interface VersionRow {
    version: number;
    kind: string;
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
    kind: string;
    description: string;
    content: string;
    saved_at: string;
}

interface TraversedNode {
    id: string;
    kind: string;
    status: string;
    certainty: string;
    store: StoreKey;
    exists: boolean;
    outEdges: {
        etype: EdgeType;
        toId: string;
        toKind: string;
        toStore: StoreKey | null;
        toExists: boolean;
        strength: number;
        rationale: string | null;
    }[];
    inEdges: {
        etype: EdgeType;
        fromId: string;
        fromKind: string;
        fromStore: StoreKey;
        strength: number;
        rationale: string | null;
    }[];
}

interface ScoredItem {
    item: ItemRow;
    store: StoreKey;
    score: number;
}

// ─── Session state ─────────────────────────────────────────────────────────────

interface SessionContext {
    messageCount: number;
    recentTermBuf: Set<string>[]; // user message terms (full weight)
    recentTerms: Set<string>; // union of user term window
    assistantTermBuf: Set<string>[]; // assistant message terms (half weight)
    assistantTerms: Set<string>; // union of assistant term window
    scores: Map<string, number>;
    tokenCache: Map<string, Set<string>>; // id → tokenize(id+description)
    contentTokenCache: Map<string, Set<string>>; // id → tokenize(content excerpt)
    lastScoredAt: number;
    scoresDirty: boolean;
    lastExtractAt: number;
    lastIdleExtractAt: number;
    providerID: string;
    modelID: string;
}

// ─── Text utilities ────────────────────────────────────────────────────────────

// Application-layer tokenizer for Jaccard overlap.
// camelCase/PascalCase is split before lowercasing so "authFlow" → {"auth","flow"} and
// hyphenated terms like "jwt-token" stay compound after lowercasing.
function tokenize(text: string): Set<string> {
    const decameled = text
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2") // "JWTConfig" → "JWT Config"
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2"); // "authFlow"  → "auth Flow"
    return new Set(
        decameled
            .toLowerCase()
            .replace(/[^a-z0-9\s_-]/g, " ")
            .split(/\s+/)
            .filter((t) => t.length > 2),
    );
}

// FTS5-safe query builder. Strips hyphens because SQLite's unicode61 tokenizer splits on them.
// Last token gets '*' for prefix matching.
function ftsQuery(raw: string): string {
    const tokens = raw
        .split(/\s+/)
        .map((t) => t.replace(/[^a-zA-Z0-9_]/g, ""))
        .filter((t) => t.length > 0);
    if (!tokens.length) return "";
    return tokens
        .map((t, i) => (i === tokens.length - 1 ? `"${t}"*` : `"${t}"`))
        .join(" ");
}

function xmlEscape(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function getSessionId(event: any): string | undefined {
    return (
        event?.properties?.sessionID ??
        event?.properties?.sessionId ??
        event?.session_id ??
        event?.sessionId
    );
}

function jaccardOverlap(a: Set<string>, b: Set<string>): number {
    if (!a.size || !b.size) return 0;
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    let intersection = 0;
    for (const t of small) if (large.has(t)) intersection++;
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
}

// ─── Formatting ───────────────────────────────────────────────────────────────

// Encodes both kind and certainty in a single character:
//   confirmed  → uppercase (C, D, I …)
//   working    → uppercase + ? (C?, D? …)
//   speculative→ lowercase (c, d, i …)
function sigil(kind: string, certainty: string): string {
    const base = KIND_SIGIL[kind as NodeKind] ?? "?";
    if (certainty === "speculative") return base.toLowerCase();
    if (certainty === "working") return base + "?";
    return base;
}

// Renders a node reference in neighbor/manifest context.
// ~ prefix = weak edge (strength < 0.5); :g/:p = cross-store provenance.
function ref(
    id: string,
    kind: string,
    certainty: string,
    exists: boolean,
    nodeStore: StoreKey | null,
    fromStore: StoreKey,
    strength: number,
): string {
    if (!exists) return `${id}[?]`;
    const cross =
        nodeStore && nodeStore !== fromStore ? `:${nodeStore[0]}` : "";
    const weak = strength < 0.5 ? "~" : "";
    return `${weak}${id}[${sigil(kind, certainty)}${cross}]`;
}

function fmtSubgraph(nodes: TraversedNode[], rootId: string): string {
    const root = nodes.find((n) => n.id === rootId);
    if (!root || (!root.outEdges.length && !root.inEdges.length))
        return "(no edges)";

    const lines: string[] = [];

    const byOut = new Map<string, string[]>();
    for (const e of root.outEdges) {
        const r = ref(
            e.toId,
            e.toKind,
            "confirmed",
            e.toExists,
            e.toStore,
            root.store,
            e.strength,
        );
        const entry = e.rationale ? `${r} "${e.rationale}"` : r;
        const arr = byOut.get(e.etype) ?? [];
        arr.push(entry);
        byOut.set(e.etype, arr);
    }
    for (const [etype, refs] of byOut)
        lines.push(`  ${etype}: ${refs.join(", ")}`);

    const byIn = new Map<string, string[]>();
    for (const e of root.inEdges) {
        const r = ref(
            e.fromId,
            e.fromKind,
            "confirmed",
            true,
            e.fromStore,
            root.store,
            e.strength,
        );
        const entry = e.rationale ? `${r} "${e.rationale}"` : r;
        const arr = byIn.get(e.etype) ?? [];
        arr.push(entry);
        byIn.set(e.etype, arr);
    }
    for (const [etype, refs] of byIn)
        lines.push(`  ← ${etype}: ${refs.join(", ")}`);

    const deeper = nodes.filter((n) => n.id !== rootId && n.exists);
    if (deeper.length)
        lines.push(
            `  transitive (${deeper.length}): ${deeper
                .map((n) =>
                    ref(
                        n.id,
                        n.kind,
                        n.certainty,
                        true,
                        n.store,
                        root.store,
                        1.0,
                    ),
                )
                .join(", ")}`,
        );

    return lines.join("\n");
}

// ─── DB bootstrap ─────────────────────────────────────────────────────────────

function openDB(dbPath: string): Database {
    glog("debug", "DB", `openDB: ${dbPath}`);
    const db = new Database(dbPath, { create: true });
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = NORMAL");
    db.run("PRAGMA cache_size = -8000");
    db.run("PRAGMA foreign_keys = OFF");

    db.transaction(() => {
        db.run(`CREATE TABLE IF NOT EXISTS items (
            id               TEXT PRIMARY KEY,
            kind             TEXT NOT NULL DEFAULT 'reference',
            status           TEXT NOT NULL DEFAULT 'active',
            authority        TEXT NOT NULL DEFAULT 'advisory',
            certainty        TEXT NOT NULL DEFAULT 'confirmed',
            importance       INTEGER NOT NULL DEFAULT 3,
            description      TEXT NOT NULL,
            content          TEXT NOT NULL,
            saved_at         TEXT NOT NULL,
            recall_count     INTEGER NOT NULL DEFAULT 0,
            last_recalled_at TEXT
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS edges (
            from_id    TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
            to_id      TEXT NOT NULL,
            edge_type  TEXT NOT NULL,
            strength   REAL NOT NULL DEFAULT 1.0,
            rationale  TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (from_id, to_id, edge_type),
            CHECK (strength >= 0.0 AND strength <= 1.0)
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS versions (
            id          TEXT NOT NULL,
            version     INTEGER NOT NULL,
            kind        TEXT NOT NULL,
            description TEXT NOT NULL,
            content     TEXT NOT NULL,
            saved_at    TEXT NOT NULL,
            PRIMARY KEY (id, version)
        )`);

        // known_projects lives in the global DB only — harmless no-op on project DBs.
        db.run(`CREATE TABLE IF NOT EXISTS known_projects (
            cwd       TEXT PRIMARY KEY,
            slug      TEXT NOT NULL,
            slug_kind TEXT NOT NULL CHECK(slug_kind IN ('cwd','hash','remote'))
        )`);

        db.run(`CREATE INDEX IF NOT EXISTS idx_edges_to_id   ON edges(to_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_versions_id   ON versions(id)`);
        db.run(
            `CREATE INDEX IF NOT EXISTS idx_items_status_saved ON items(status, saved_at DESC)`,
        );

        db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
            id, description, content, content=items, content_rowid=rowid
        )`);

        db.run(`CREATE TRIGGER IF NOT EXISTS fts_insert AFTER INSERT ON items BEGIN
            INSERT INTO items_fts(rowid,id,description,content)
            VALUES(new.rowid,new.id,new.description,new.content);
        END`);

        db.run(`CREATE TRIGGER IF NOT EXISTS fts_update AFTER UPDATE ON items BEGIN
            INSERT INTO items_fts(items_fts,rowid,id,description,content)
            VALUES('delete',old.rowid,old.id,old.description,old.content);
            INSERT INTO items_fts(rowid,id,description,content)
            VALUES(new.rowid,new.id,new.description,new.content);
        END`);

        db.run(`CREATE TRIGGER IF NOT EXISTS fts_delete AFTER DELETE ON items BEGIN
            INSERT INTO items_fts(items_fts,rowid,id,description,content)
            VALUES('delete',old.rowid,old.id,old.description,old.content);
        END`);
    })();

    return db;
}

// ─── Extraction types ─────────────────────────────────────────────────────────

interface ExtractionNode {
    id: string;
    kind: NodeKind;
    scope: "global" | "project"; // determines target store
    description: string;
    content: string;
    status?: NodeStatus;
    authority?: NodeAuthority;
    certainty?: NodeCertainty;
    importance?: number; // 1–5; extraction model assigns this
}

interface ExtractionEdge {
    from_id: string;
    to_id: string;
    edge_type: EdgeType;
    strength: number;
    rationale?: string;
}

// ─── StoreDB ──────────────────────────────────────────────────────────────────

class StoreDB {
    readonly db: Database;
    readonly s: {
        getItem: ReturnType<Database["prepare"]>;
        getMeta: ReturnType<Database["prepare"]>;
        edgesOut: ReturnType<Database["prepare"]>;
        edgesIn: ReturnType<Database["prepare"]>;
        activeItems: ReturnType<Database["prepare"]>;
        allItems: ReturnType<Database["prepare"]>;
        maxVersion: ReturnType<Database["prepare"]>;
        insertVersion: ReturnType<Database["prepare"]>;
        allVersions: ReturnType<Database["prepare"]>;
        deleteVersions: ReturnType<Database["prepare"]>;
        deleteEdgesFrom: ReturnType<Database["prepare"]>;
        upsertItem: ReturnType<Database["prepare"]>;
        updateRecall: ReturnType<Database["prepare"]>;
        deleteItem: ReturnType<Database["prepare"]>;
        upsertEdge: ReturnType<Database["prepare"]>;
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
                "SELECT id, kind, status, certainty FROM items WHERE id=?",
            ),
            edgesOut: db.prepare("SELECT * FROM edges WHERE from_id=?"),
            edgesIn: db.prepare("SELECT * FROM edges WHERE to_id=?"),
            activeItems: db.prepare(
                "SELECT * FROM items WHERE status='active' ORDER BY saved_at DESC",
            ),
            allItems: db.prepare("SELECT * FROM items ORDER BY saved_at DESC"),
            maxVersion: db.prepare(
                "SELECT COALESCE(MAX(version),0) AS v FROM versions WHERE id=?",
            ),
            insertVersion: db.prepare(
                "INSERT INTO versions (id,version,kind,description,content,saved_at) VALUES (?,?,?,?,?,?)",
            ),
            allVersions: db.prepare("SELECT * FROM versions WHERE id=?"),
            deleteVersions: db.prepare("DELETE FROM versions WHERE id=?"),
            deleteEdgesFrom: db.prepare("DELETE FROM edges WHERE from_id=?"),
            upsertItem: db.prepare(
                "INSERT INTO items (id,kind,status,authority,certainty,importance,description,content,saved_at) " +
                    "VALUES (?,?,?,?,?,?,?,?,?) " +
                    "ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, status=excluded.status, " +
                    "authority=excluded.authority, certainty=excluded.certainty, importance=excluded.importance, " +
                    "description=excluded.description, content=excluded.content, saved_at=excluded.saved_at",
            ),
            updateRecall: db.prepare(
                "UPDATE items SET recall_count = recall_count + 1, last_recalled_at = ? WHERE id = ?",
            ),
            deleteItem: db.prepare("DELETE FROM items WHERE id=?"),
            // ON CONFLICT … DO UPDATE allows re-linking with new strength/rationale
            upsertEdge: db.prepare(
                "INSERT INTO edges (from_id,to_id,edge_type,strength,rationale,created_at) VALUES (?,?,?,?,?,?) " +
                    "ON CONFLICT(from_id,to_id,edge_type) DO UPDATE SET strength=excluded.strength, rationale=excluded.rationale",
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
                "SELECT version, kind, description, saved_at FROM versions WHERE id=? ORDER BY version DESC",
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

    readonly #g: StoreDB;
    readonly #p: StoreDB;

    static readonly #instances = new Map<string, EngramStore>();

    static getInstance(slug: string): EngramStore {
        let inst = EngramStore.#instances.get(slug);
        if (!inst) {
            const dbKey = slugDbKey(slug);
            const dbPath = join(ENGRAM_PROJECTS, `${dbKey}.db`);
            glog(
                "info",
                "DB",
                `EngramStore: new instance for slug="${slug}" dbKey=${dbKey} path=${dbPath}`,
            );
            inst = new EngramStore(getGlobalDB(), openDB(dbPath), slug);
            EngramStore.#instances.set(slug, inst);
        } else {
            glog("debug", "DB", `EngramStore: cache hit for slug="${slug}"`);
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
        const p = this.#p.s.getItem.get(id) as ItemRow | null;
        if (p) return [p, "project"];
        const g = this.#g.s.getItem.get(id) as ItemRow | null;
        if (g) return [g, "global"];
        return null;
    }

    resolveMeta(id: string): [ItemMeta, StoreKey] | null {
        const p = this.#p.s.getMeta.get(id) as ItemMeta | null;
        if (p) return [p, "project"];
        const g = this.#g.s.getMeta.get(id) as ItemMeta | null;
        if (g) return [g, "global"];
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

    activeItems(): { global: ItemRow[]; project: ItemRow[] } {
        return {
            global: this.#g.s.activeItems.all() as ItemRow[],
            project: this.#p.s.activeItems.all() as ItemRow[],
        };
    }

    allItems(key: StoreKey): ItemRow[] {
        return this.#sdb(key).s.allItems.all() as ItemRow[];
    }

    // ── Bulk write — extraction batch ───────────────────────────────────────────

    commitBatch(key: StoreKey, nodes: ExtractionNode[]): void {
        const sdb = this.#sdb(key);
        glog(
            "debug",
            "DB",
            `[${this.slug}] commitBatch: writing ${nodes.length} node(s) to ${key} store`,
        );
        sdb.db.transaction(() => {
            for (const n of nodes) {
                const desc = n.description || n.id;
                const status = VALID_STATUSES.includes(n.status as any)
                    ? n.status!
                    : "active";
                // Per-kind authority defaults: constraints/decisions are binding; everything else is advisory
                const defaultAuthority: NodeAuthority =
                    n.kind === "constraint" || n.kind === "decision"
                        ? "binding"
                        : "advisory";
                const authority = VALID_AUTHORITIES.includes(n.authority as any)
                    ? n.authority!
                    : defaultAuthority;
                const certainty = VALID_CERTAINTIES.includes(n.certainty as any)
                    ? n.certainty!
                    : "confirmed";
                const importance =
                    typeof n.importance === "number" &&
                    n.importance >= 1 &&
                    n.importance <= 5
                        ? Math.round(n.importance)
                        : 3;
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
                    n.kind,
                    status,
                    authority,
                    certainty,
                    importance,
                    desc,
                    n.content,
                    savedAt,
                );
                glog(
                    "debug",
                    "DB",
                    `[${this.slug}]   ${prior ? "updated" : "created"} node "${n.id}" [${n.kind}] certainty=${certainty} importance=${importance} in ${key}`,
                );
            }
        })();
    }

    commitEdgeBatch(key: StoreKey, edges: ExtractionEdge[]): void {
        const sdb = this.#sdb(key);
        glog(
            "debug",
            "DB",
            `[${this.slug}] commitEdgeBatch: writing ${edges.length} edge(s) to ${key} store`,
        );
        sdb.db.transaction(() => {
            for (const e of edges) {
                const s = Math.max(0, Math.min(1, e.strength ?? 1.0));
                sdb.s.upsertEdge.run(
                    e.from_id,
                    e.to_id,
                    e.edge_type,
                    s,
                    e.rationale ?? null,
                    new Date().toISOString(),
                );
                glog(
                    "debug",
                    "DB",
                    `[${this.slug}]   edge ${e.from_id} -[${e.edge_type}]→ ${e.to_id} strength=${s.toFixed(2)}`,
                );
            }
        })();
        this.#markEdgeDirty();
    }

    // ── Writes ───────────────────────────────────────────────────────────────────

    upsert(
        key: StoreKey,
        id: string,
        kind: string,
        status: string,
        authority: string,
        certainty: string,
        importance: number,
        description: string,
        content: string,
        existing?: ItemRow | null,
    ): void {
        const sdb = this.#sdb(key);
        const imp =
            typeof importance === "number" && importance >= 1 && importance <= 5
                ? Math.round(importance)
                : 3;
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
                kind,
                status,
                authority,
                certainty,
                imp,
                description,
                content,
                savedAt,
            );
        })();
    }

    #markEdgeDirty(): void {
        this.#edgeDirty = true;
        this.#edgeIndex = null;
    }

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
                    prior.kind,
                    prior.description,
                    prior.content,
                    prior.saved_at,
                );
                glog(
                    "debug",
                    "DB",
                    `[${this.slug}] versioned "${id}" → snapshot v${lastVer + 1} (content/description changed)`,
                );
            } else {
                glog(
                    "debug",
                    "DB",
                    `[${this.slug}] "${id}" metadata-only change — saved_at preserved, no version snapshot`,
                );
            }
            if (!changed) return prior.saved_at;
        }
        return new Date().toISOString();
    }

    touchRecall(key: StoreKey, id: string): void {
        this.#sdb(key).s.updateRecall.run(new Date().toISOString(), id);
    }

    insertEdge(
        key: StoreKey,
        fromId: string,
        toId: string,
        edgeType: string,
        strength = 1.0,
        rationale?: string,
    ): void {
        this.#sdb(key).s.upsertEdge.run(
            fromId,
            toId,
            edgeType,
            Math.max(0, Math.min(1, strength)),
            rationale ?? null,
            new Date().toISOString(),
        );
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
            sdb.s.deleteEdgesFrom.run(id); // FK cascade OFF — manual delete required
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

        // Cross-store edge update is best-effort across two separate DBs.
        // If it fails, call rename again — the in-store rename is idempotent.
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
    ): { outEdgesMigrated: number; totalIncoming: number } {
        const resolved = this.resolve(id);
        if (!resolved) throw new Error(`No node: "${id}"`);
        const [item, srcKey] = resolved;
        if (srcKey === destKey) throw new Error(`Already in ${destKey}`);

        const outEdges = this.edgesOut(id, srcKey);
        const totalIncoming = (["global", "project"] as StoreKey[]).reduce(
            (n, k) => n + this.countEdgesTo(k, id),
            0,
        );
        const srcS = this.#sdb(srcKey).s;
        const ds = this.#sdb(destKey).s;
        const versionRows = srcS.allVersions.all(id) as VersionRecord[];

        // Write destination first — crash here leaves a recoverable duplicate, not data loss.
        this.#sdb(destKey).db.transaction(() => {
            ds.upsertItem.run(
                item.id,
                item.kind,
                item.status,
                item.authority,
                item.certainty,
                item.importance ?? 3,
                item.description,
                item.content,
                item.saved_at,
            );
            for (const e of outEdges)
                ds.upsertEdge.run(
                    id,
                    e.to_id,
                    e.edge_type,
                    e.strength,
                    e.rationale,
                    e.created_at,
                );
            for (const v of versionRows)
                ds.insertVersion.run(
                    v.id,
                    v.version,
                    v.kind,
                    v.description,
                    v.content,
                    v.saved_at,
                );
        })();
        this.#sdb(srcKey).db.transaction(() => {
            srcS.deleteVersions.run(id);
            srcS.deleteEdgesFrom.run(id);
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

    search(
        query: string,
        limit: number,
        includeArchived = false,
    ): { item: ItemRow; store: StoreKey }[] {
        const safe = ftsQuery(query);
        if (!safe) return [];
        const results: { item: ItemRow; store: StoreKey }[] = [];
        for (const key of ["global", "project"] as StoreKey[]) {
            // Fetch more than needed so filtering out archived/deprecated doesn't starve results
            const fetchLimit = includeArchived ? limit : limit * 3;
            const hits = this.#sdb(key).s.searchFts.all(safe, fetchLimit) as {
                id: string;
                rank: number;
            }[];
            if (!hits.length) continue;
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
            const byId = new Map(rows.map((r) => [r.id, r]));
            let added = 0;
            for (const hit of hits) {
                if (added >= limit) break;
                const item = byId.get(hit.id);
                if (!item) continue;
                if (
                    !includeArchived &&
                    (item.status === "archived" || item.status === "deprecated")
                )
                    continue;
                results.push({ item, store: key });
                added++;
            }
        }
        return results;
    }

    rebuildFts(): void {
        for (const key of ["global", "project"] as StoreKey[])
            this.#sdb(key).s.rebuildFts.run();
    }

    // ── Graph traversal ─────────────────────────────────────────────────────────

    traverse(rootId: string): TraversedNode[] {
        glog(
            "debug",
            "GRAPH",
            `[${this.slug}] traverse: starting from root="${rootId}"`,
        );
        const visited = new Map<string, number>();
        const resultSeen = new Set<string>();
        const result: TraversedNode[] = [];
        const queue: {
            id: string;
            depth: number;
            via: EdgeType | null;
            inStore: StoreKey;
        }[] = [];
        let head = 0;
        let depthPruned = 0;
        let danglingVisited = 0;

        const resolveCache = new Map<string, [ItemRow, StoreKey] | null>();
        const resolveMetaCache = new Map<string, [ItemMeta, StoreKey] | null>();
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
        if (!rootResolved)
            glog(
                "warn",
                "GRAPH",
                `[${this.slug}] traverse: root "${rootId}" not found in either store`,
            );
        queue.push({
            id: rootId,
            depth: 0,
            via: null,
            inStore: rootResolved?.[1] ?? "project",
        });

        while (head < queue.length) {
            const { id, depth, via, inStore } = queue[head++];
            if (via !== null && depth > (DEPTH_LIMITS[via] ?? 1)) {
                depthPruned++;
                continue;
            }
            const prev = visited.get(id);
            if (prev !== undefined && prev <= depth) continue;
            visited.set(id, depth);
            if (resultSeen.has(id)) continue;
            resultSeen.add(id);

            const resolved = cachedResolve(id);
            const item = resolved?.[0] ?? null;
            const itemStore = resolved?.[1] ?? inStore;
            if (!item && id !== rootId) {
                danglingVisited++;
                glog(
                    "debug",
                    "GRAPH",
                    `[${this.slug}] traverse:   [?] dangling ref "${id}" at depth=${depth} via=${via ?? "root"}`,
                );
            } else if (item) {
                glog(
                    "debug",
                    "GRAPH",
                    `[${this.slug}] traverse:   visiting "${id}" [${item.kind}/${item.certainty}] depth=${depth} via=${via ?? "root"}`,
                );
            }
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
                    toKind: target?.[0].kind ?? "?",
                    toStore: target?.[1] ?? null,
                    toExists: !!target,
                    strength: e.strength,
                    rationale: e.rationale,
                };
            });

            const inEdges = inRows.map((e) => {
                const source = cachedResolveMeta(e.from_id);
                return {
                    etype: e.edge_type as EdgeType,
                    fromId: e.from_id,
                    fromKind: source?.[0].kind ?? "?",
                    fromStore: source?.[1] ?? "project",
                    strength: e.strength,
                    rationale: e.rationale,
                };
            });

            result.push({
                id,
                kind: item?.kind ?? "?",
                status: item?.status ?? "unresolved",
                certainty: item?.certainty ?? "confirmed",
                store: itemStore,
                exists: !!item,
                outEdges,
                inEdges,
            });
        }

        const dangling = result.filter((n) => !n.exists).length;
        glog(
            "debug",
            "GRAPH",
            `[${this.slug}] traverse: root="${rootId}" visited=${result.length} depthPruned=${depthPruned} dangling=${dangling}`,
        );
        return result;
    }

    // ── Edge index — batch build, no N+1 ───────────────────────────────────────

    buildEdgeIndex(): {
        outByKey: Record<StoreKey, Map<string, EdgeRow[]>>;
        inByKey: Record<StoreKey, Map<string, EdgeRow[]>>;
        metaCache: Map<string, [ItemMeta, StoreKey] | null>;
    } {
        if (!this.#edgeDirty && this.#edgeIndex) {
            glog("debug", "GRAPH", `[${this.slug}] buildEdgeIndex: cache hit`);
            return this.#edgeIndex;
        }
        glog("debug", "GRAPH", `[${this.slug}] buildEdgeIndex: rebuilding`);

        const outByKey: Record<StoreKey, Map<string, EdgeRow[]>> = {
            global: new Map(),
            project: new Map(),
        };
        const inByKey: Record<StoreKey, Map<string, EdgeRow[]>> = {
            global: new Map(),
            project: new Map(),
        };
        const metaCache = new Map<string, [ItemMeta, StoreKey] | null>();

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
                const outs = outByKey[srcKey].get(e.from_id) ?? [];
                outs.push(e);
                outByKey[srcKey].set(e.from_id, outs);

                // in-index: place under the store where to_id actually lives
                let placed = false;
                for (const destKey of ["global", "project"] as StoreKey[]) {
                    if (!idSet[destKey].has(e.to_id)) continue;
                    const ins = inByKey[destKey].get(e.to_id) ?? [];
                    ins.push(e);
                    inByKey[destKey].set(e.to_id, ins);
                    placed = true;
                    break;
                }
                if (!placed) {
                    // Dangling to_id — index under "project" for [?] display
                    const ins = inByKey["project"].get(e.to_id) ?? [];
                    ins.push(e);
                    inByKey["project"].set(e.to_id, ins);
                }
            }
        }

        this.#edgeDirty = false;
        this.#edgeIndex = { outByKey, inByKey, metaCache };
        const totalEdges = (["global", "project"] as StoreKey[]).reduce(
            (n, k) =>
                n +
                [...outByKey[k].values()].reduce((s, arr) => s + arr.length, 0),
            0,
        );
        const danglingTargets = [
            ...outByKey.global.values(),
            ...outByKey.project.values(),
        ]
            .flatMap((arr) => arr)
            .filter(
                (e) =>
                    !idSet.global.has(e.to_id) && !idSet.project.has(e.to_id),
            ).length;
        glog(
            "debug",
            "GRAPH",
            `[${this.slug}] buildEdgeIndex: ${totalEdges} edges indexed, ${danglingTargets} dangling targets`,
        );
        return this.#edgeIndex;
    }

    // ── Manifest / neighbor formatting ─────────────────────────────────────────

    manifestLine(
        item: ItemRow,
        key: StoreKey,
        edgeIndex?: ReturnType<EngramStore["buildEdgeIndex"]>,
    ): string {
        const idx = edgeIndex ?? this.buildEdgeIndex();
        const edges = this.neighborLine(item, key, idx);
        // Show importance only when non-default (≠3) to keep manifest compact
        const imp =
            (item.importance ?? 3) !== 3 ? ` i${item.importance ?? 3}` : "";
        const parts = [
            `${item.id.padEnd(24)} ${sigil(item.kind, item.certainty)}${imp}`,
        ];
        if (edges) parts.push(edges);
        return parts.join("  ");
    }

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
            const t = cachedMeta(e.to_id);
            return ref(
                e.to_id,
                t?.[0].kind ?? "?",
                t?.[0].certainty ?? "confirmed",
                !!t,
                t?.[1] ?? null,
                key,
                e.strength,
            );
        });
        const inRefs = inEdges.map((e) => {
            const s = cachedMeta(e.from_id);
            return ref(
                e.from_id,
                s?.[0].kind ?? "?",
                s?.[0].certainty ?? "confirmed",
                !!s,
                s?.[1] ?? key,
                key,
                e.strength,
            );
        });

        const parts: string[] = [];
        if (outRefs.length) parts.push("→" + outRefs.join(","));
        if (inRefs.length) parts.push("←" + inRefs.join(","));
        return parts.join("  ");
    }

    // ── Scoring ─────────────────────────────────────────────────────────────────
    //
    // Three-phase algorithm:
    //   Phase 1 — per-node base score:
    //     Jaccard overlap with recent conversation terms                  (full weight)
    //     + recency-weighted recall (exponential decay, half-life ~10 days)  (× 0.20)
    //     + in-degree authority weighting (being depended on > depending on)  (× 0.10)
    //     + importance score 1–5 normalized to [0,1]                         (× 0.15)
    //     + saved_at recency (exponential decay, half-life 30 days)           (× 0.05)
    //     × certainty multiplier (speculative=0.5, working=0.75, confirmed=1.0)
    //   Phase 2 — one-hop propagation (O(E), no new DB queries):
    //     Hot nodes boost their neighbors proportional to edge strength and type damping.
    //     This surfaces dependencies automatically without the model manually traversing.
    //   Phase 3 — min-max normalization to [0,1]:
    //     Ensures the hot/cold threshold (score > 0) is meaningful even when all base
    //     scores are saturated (large overlapping vocabulary).
    //
    // Manifest ordering: lowest-scored hot nodes first, highest last.
    //     Exploits the LLM "recency attention" effect (lost-in-the-middle): the most
    //     relevant node sits immediately before the user message, where attention is highest.

    score(
        globalItems: ItemRow[],
        projectItems: ItemRow[],
        recentTerms: Set<string>,
        assistantTerms?: Set<string>,
        tokenCache?: Map<string, Set<string>>,
        contentTokenCache?: Map<string, Set<string>>,
    ): ScoredItem[] {
        const all: [ItemRow, StoreKey][] = [
            ...globalItems.map((i) => [i, "global"] as [ItemRow, StoreKey]),
            ...projectItems.map((i) => [i, "project"] as [ItemRow, StoreKey]),
        ];
        if (!all.length) return [];

        // Degree counts — 4 queries instead of 3 per node
        const degOut = new Map<string, number>();
        const degIn = new Map<string, number>();
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
        const maxDegree = Math.max(
            1,
            ...all.map(
                ([i]) =>
                    (degIn.get(i.id) ?? 0) * 1.5 +
                    (degOut.get(i.id) ?? 0) * 0.5,
            ),
        );
        const now = Date.now();
        const λ = Math.LN2 / RECALL_HALF_LIFE_DAYS;
        // saved_at recency: nodes created recently get a small boost independent of recall
        const λ_saved = Math.LN2 / 30; // half-life 30 days for creation recency

        // ── Phase 1: base scores ───────────────────────────────────────────────
        const baseScores = new Map<string, number>();
        const scored: ScoredItem[] = all.map(([item, storeKey]) => {
            let itemTerms = tokenCache?.get(item.id);
            if (!itemTerms) {
                itemTerms = tokenize(`${item.id} ${item.description}`);
                tokenCache?.set(item.id, itemTerms);
            }
            // Content terms: first 200 chars, weighted 0.4× — carries domain terminology
            // not always present in the short description.
            let contentTerms = contentTokenCache?.get(item.id);
            if (!contentTerms) {
                contentTerms = tokenize(item.content.slice(0, 200));
                contentTokenCache?.set(item.id, contentTerms);
            }
            const userOverlap =
                jaccardOverlap(itemTerms, recentTerms) +
                jaccardOverlap(contentTerms, recentTerms) * 0.4;
            const assistOverlap = assistantTerms?.size
                ? (jaccardOverlap(itemTerms, assistantTerms) +
                      jaccardOverlap(contentTerms, assistantTerms) * 0.4) *
                  0.5
                : 0;
            const overlap = Math.min(1, userOverlap + assistOverlap);

            // Recency-decayed recall — nodes recalled long ago score lower than recently recalled ones
            let recencyScore = 0;
            if (item.recall_count > 0) {
                if (item.last_recalled_at) {
                    const daysSince =
                        (now - new Date(item.last_recalled_at).getTime()) /
                        86_400_000;
                    recencyScore =
                        (item.recall_count * Math.exp(-λ * daysSince)) /
                        maxRecall;
                } else {
                    recencyScore = item.recall_count / maxRecall;
                }
            }

            // In-degree authority: being referenced by many nodes = more important than referencing many
            const authorityScore =
                ((degIn.get(item.id) ?? 0) * 1.5 +
                    (degOut.get(item.id) ?? 0) * 0.5) /
                maxDegree;

            // Node importance score: 1–5 scale normalized to [0,1]; independent of recall or context
            const importanceScore = ((item.importance ?? 3) - 1) / 4; // maps [1..5] → [0..1]

            // Creation recency: small bonus for recently-created nodes (ongoing-work proxy)
            const savedDaysSince =
                (now - new Date(item.saved_at).getTime()) / 86_400_000;
            const savedRecency = Math.exp(-λ_saved * savedDaysSince);

            // Certainty multiplier — speculative nodes score lower even if term-relevant
            const certaintyMult =
                item.certainty === "confirmed"
                    ? 1.0
                    : item.certainty === "working"
                      ? 0.75
                      : 0.5;

            const base =
                (overlap +
                    0.2 * recencyScore +
                    0.1 * authorityScore +
                    0.15 * importanceScore +
                    0.05 * savedRecency) *
                certaintyMult;
            baseScores.set(item.id, base);
            return { item, store: storeKey, score: base };
        });

        // ── Phase 2: one-hop propagation — O(E), no new DB queries ─────────────
        const edgeIdx = this.buildEdgeIndex();
        const propagated = new Map<string, number>(baseScores);

        for (const [item, storeKey] of all) {
            const base = baseScores.get(item.id) ?? 0;
            if (base < 0.01) continue; // cold nodes propagate nothing meaningful

            for (const e of edgeIdx.outByKey[storeKey].get(item.id) ?? []) {
                const factors = PROPAGATION[e.edge_type as EdgeType];
                if (!factors) continue;
                const boost = base * factors.fwd * e.strength;
                propagated.set(
                    e.to_id,
                    Math.min(1.5, (propagated.get(e.to_id) ?? 0) + boost),
                );
            }

            for (const e of edgeIdx.inByKey[storeKey].get(item.id) ?? []) {
                const factors = PROPAGATION[e.edge_type as EdgeType];
                if (!factors) continue;
                const boost = base * factors.bwd * e.strength;
                propagated.set(
                    e.from_id,
                    Math.min(1.5, (propagated.get(e.from_id) ?? 0) + boost),
                );
            }
        }

        // Merge propagated scores back
        for (const s of scored) s.score = propagated.get(s.item.id) ?? s.score;

        // ── Phase 3: post-propagation min-max normalization ────────────────────
        // Normalizing after propagation means the hot/cold threshold (score > 0)
        // is meaningful even when all base scores are saturated near 1.0.
        const minScore = Math.min(...scored.map((s) => s.score));
        const maxScore = Math.max(...scored.map((s) => s.score));
        const scoreRange = maxScore - minScore;
        if (scoreRange > 0.001) {
            for (const s of scored) s.score = (s.score - minScore) / scoreRange;
        }

        scored.sort((a, b) => b.score - a.score);

        // Log top-5 scores and any nodes significantly boosted by propagation
        const top5 = scored
            .slice(0, 5)
            .map((s) => `${s.item.id}(${s.score.toFixed(3)})`)
            .join(", ");
        glog(
            "debug",
            "SCORE",
            `[${this.slug}] score: ${scored.length} nodes — top5: ${top5}`,
        );

        // Nodes whose propagated score meaningfully exceeds base (boosted by graph proximity)
        const boosted = scored.filter((s) => {
            const base = baseScores.get(s.item.id) ?? 0;
            return s.score - base > 0.05;
        });
        if (boosted.length > 0) {
            const boostLog = boosted
                .slice(0, 5)
                .map((s) => {
                    const base = baseScores.get(s.item.id) ?? 0;
                    return `${s.item.id}(+${(s.score - base).toFixed(3)})`;
                })
                .join(", ");
            glog(
                "debug",
                "SCORE",
                `[${this.slug}] propagation boosted: ${boostLog}`,
            );
        }

        return scored;
    }
}

// ─── Extraction ────────────────────────────────────────────────────────────────

const EXTRACTION_SYSTEM = `You extract persistent knowledge from a coding session transcript.
You are a JSON extraction tool. You MUST respond with ONLY a JSON object — no prose, no explanation, no markdown.

Return exactly this structure:
{"nodes": [...], "edges": [...]}

Each node:
  { "id": "<slug>", "kind": "<kind>", "scope": "<scope>",
    "description": "<one line>", "content": "<full detail>",
    "status": "active", "authority": "<authority>", "certainty": "<certainty>",
    "importance": <1-5> }

Kinds:
  constraint  — always/never rules (architectural or code-level)
  decision    — choices made with rationale recorded
  interface   — internal API or schema boundary you own and enforce
  reference   — external facts: library APIs, specs, third-party behavior
  procedure   — how-to steps
  finding     — results of investigation or completed work
  plan        — intended future work not yet done
  risk        — unverified concern or assumption

Scope: "global" (cross-project pattern) or "project" (specific to this codebase)
Certainty: "confirmed" (verified) | "working" (assumed true) | "speculative" (uncertain)
Authority: "binding" for constraint/decision nodes; "advisory" for all others.
Importance (1–5):
  5 = irreversible architectural constraint or critical security/correctness requirement
  4 = significant decision or interface contract
  3 = normal useful context (default)
  2 = supplementary detail or reference
  1 = ephemeral or low-stakes note

Each edge:
  { "from_id": "<id>", "to_id": "<id>", "edge_type": "<type>",
    "strength": 0.0-1.0, "rationale": "<one sentence why>" }

Edge types:
  requires    — A needs B to function correctly
  implements  — A is a concrete realization of interface B
  supersedes  — A replaces B (B should be archived)
  constrains  — B limits what A can do
  validates   — A is evidence that B is true or false
  causes      — A's existence made B necessary
  contradicts — A and B are in conflict
  informs     — A is context that shaped the creation of B

Edge strength: 1.0=certain relationship  0.5=probable  0.3=plausible
Rationale: a single sentence explaining why the relationship exists.

Rules:
- Extract BOTH nodes AND edges. Edges are as important as nodes. A bag of isolated nodes is nearly useless.
- Only extract edges clearly evident from the conversation — do not invent relationships.
- IMPORTANT: Also emit edges between NEW nodes and EXISTING nodes (listed above) when the relationship is clear.
  For example: if a new "auth-token-ttl" constraint directly requires an existing "jwt-config" reference,
  add an edge {"from_id":"auth-token-ttl","to_id":"jwt-config","edge_type":"requires",...}.
- Node id must be a lowercase-hyphenated slug, max 40 chars, starting with a letter or digit.
- Merge related items into one node rather than splitting into many.
- Skip transient debugging, failed attempts, and obvious facts.
- Ignore tool calls in the transcript — extract knowledge from content, not from actions.
- Return {"nodes":[],"edges":[]} if nothing is worth saving.
- Your ENTIRE response must be valid JSON. Not a single word outside the JSON object.`;

// ─── Provider routing ─────────────────────────────────────────────────────────

interface ExtractionTarget {
    url: string;
    headers: Record<string, string>;
    model: string;
    parseText: (body: any) => string;
    buildBody: (model: string, system: string, userMsg: string) => object;
}

function openAICompatBody(
    model: string,
    system: string,
    userMsg: string,
): object {
    return {
        model,
        max_tokens: 2048,
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
            max_tokens: 2048,
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

    if (pid === "anthropic") {
        const key = process.env.ANTHROPIC_API_KEY;
        if (!key) {
            log("extraction: no ANTHROPIC_API_KEY — falling back to session");
            return null;
        }
        return anthropicTarget(key);
    }

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
    return null;
}

// ─── Commit helpers ───────────────────────────────────────────────────────────

function commitExtraction(
    nodes: ExtractionNode[],
    edges: ExtractionEdge[],
    store: EngramStore,
    label: string,
    log: (msg: string) => void,
): void {
    log(
        `[EXTRACT] commitExtraction: ${nodes.length} raw node(s), ${edges.length} raw edge(s) from ${label}`,
    );

    // Group nodes by target store key, logging every rejection
    const byKey = new Map<StoreKey, ExtractionNode[]>();
    let rejectedNodes = 0;
    for (const n of nodes) {
        if (!n.id || !n.kind || !n.content) {
            log(
                `[EXTRACT]   SKIP node: missing required field (id="${n.id}" kind="${n.kind}" content=${!!n.content})`,
            );
            rejectedNodes++;
            continue;
        }
        if (!VALID_KINDS.includes(n.kind)) {
            log(`[EXTRACT]   SKIP node "${n.id}": invalid kind "${n.kind}"`);
            rejectedNodes++;
            continue;
        }
        if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(n.id)) {
            log(`[EXTRACT]   SKIP node: invalid id slug "${n.id}"`);
            rejectedNodes++;
            continue;
        }
        const key: StoreKey = n.scope === "global" ? "global" : "project";
        const bucket = byKey.get(key) ?? [];
        bucket.push(n);
        byKey.set(key, bucket);
    }
    if (rejectedNodes > 0)
        log(
            `[EXTRACT]   rejected ${rejectedNodes} node(s) due to validation errors`,
        );

    let savedNodes = 0;
    for (const [storeKey, bucket] of byKey) {
        store.commitBatch(storeKey, bucket);
        savedNodes += bucket.length;
    }

    // Commit edges — only if from_id exists (to_id may be dangling)
    const validEdges: ExtractionEdge[] = [];
    let rejectedEdges = 0;
    for (const e of edges) {
        if (!e.from_id || !e.to_id || !e.edge_type) {
            log(
                `[EXTRACT]   SKIP edge: missing required field (from="${e.from_id}" to="${e.to_id}" type="${e.edge_type}")`,
            );
            rejectedEdges++;
            continue;
        }
        if (!VALID_EDGES.includes(e.edge_type)) {
            log(
                `[EXTRACT]   SKIP edge ${e.from_id}→${e.to_id}: invalid edge_type "${e.edge_type}"`,
            );
            rejectedEdges++;
            continue;
        }
        if (!store.resolve(e.from_id)) {
            log(
                `[EXTRACT]   SKIP edge: from_id "${e.from_id}" not found in either store`,
            );
            rejectedEdges++;
            continue;
        }
        validEdges.push({
            ...e,
            strength: Math.max(0, Math.min(1, e.strength ?? 0.8)),
        });
    }
    if (rejectedEdges > 0)
        log(
            `[EXTRACT]   rejected ${rejectedEdges} edge(s) due to validation errors`,
        );

    if (validEdges.length) {
        const edgesByKey = new Map<StoreKey, ExtractionEdge[]>();
        for (const e of validEdges) {
            const [, key] = store.resolve(e.from_id)!;
            const bucket = edgesByKey.get(key) ?? [];
            bucket.push(e);
            edgesByKey.set(key, bucket);
        }
        for (const [storeKey, bucket] of edgesByKey) {
            store.commitEdgeBatch(storeKey, bucket);
        }
    }

    log(
        `[EXTRACT] committed: ${savedNodes} node(s), ${validEdges.length} edge(s) via ${label}`,
    );
}

// ─── Transcript fetcher ───────────────────────────────────────────────────────

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
    if (!messages.length) {
        log(
            `[EXTRACT] fetchTranscript [${sessionId}]: session has no messages`,
        );
        return null;
    }
    log(
        `[EXTRACT] fetchTranscript [${sessionId}]: fetched ${messages.length} message(s), using last ${Math.min(messages.length, EXTRACTION_MSG_LIMIT)}`,
    );

    const text = messages
        .slice(-EXTRACTION_MSG_LIMIT)
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

// ─── Ephemeral-session extraction (unknown providers) ─────────────────────────

async function extractViaSession(
    providerID: string,
    modelID: string,
    store: EngramStore,
    client: any,
    log: (msg: string) => void,
    transcript: string,
): Promise<void> {
    if (!transcript) return;

    const { global: gi, project: pi } = store.activeItems();
    const existingItems =
        [...gi, ...pi]
            .map(
                (i) =>
                    `${i.id} [${i.kind}]: ${i.description} | ${i.content.slice(0, 100).replace(/\n/g, " ")}`,
            )
            .join("\n") || "none";
    const userMsg = `Existing nodes (check id, description AND content excerpt for semantic overlap — do not re-extract semantically similar nodes):\n${existingItems}\n\n---\n\n${transcript}`;

    let ephemeralSessionId: string | null = null;
    let parsed: any;
    try {
        log(
            `[EXTRACT] extractViaSession: creating ephemeral session (provider=${providerID} model=${modelID})`,
        );
        const created = await client.session.create({
            body: { title: "engram-extraction" },
        });
        ephemeralSessionId = created?.data?.id ?? created?.id;
        if (!ephemeralSessionId) throw new Error("no session ID returned");
        log(
            `[EXTRACT] extractViaSession: ephemeral session created id=${ephemeralSessionId}`,
        );

        const result = await client.session.prompt({
            path: { id: ephemeralSessionId },
            body: {
                system: EXTRACTION_SYSTEM,
                parts: [{ type: "text", text: userMsg }],
            },
        });
        const info = result?.data?.info ?? result?.data;
        const parts: any[] = info?.parts ?? result?.data?.parts ?? [];
        const raw = parts
            .filter((p: any) => p.type === "text")
            .map((p: any) => p.text ?? "")
            .join("")
            .trim();
        if (!raw) throw new Error("empty response from model");
        log(
            `[EXTRACT] extractViaSession: model responded (${raw.length} chars)`,
        );

        const stripped = raw
            .replace(/^```(?:json)?\s*/i, "")
            .replace(/\s*```$/, "")
            .trim();
        parsed = JSON.parse(stripped);
    } catch (e: any) {
        log(`[EXTRACT] extractViaSession FAILED — ${e?.message ?? e}`);
        return;
    } finally {
        if (ephemeralSessionId) {
            client.session
                .delete({ path: { id: ephemeralSessionId } })
                .catch((e: any) =>
                    log(
                        `[EXTRACT] extractViaSession: ephemeral session delete failed (${ephemeralSessionId}): ${e?.message ?? e}`,
                    ),
                );
        }
    }

    const nodes: ExtractionNode[] = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.nodes)
          ? parsed.nodes
          : [];
    const edges: ExtractionEdge[] = Array.isArray(parsed?.edges)
        ? parsed.edges
        : [];
    commitExtraction(
        nodes,
        edges,
        store,
        `${providerID}/${modelID} (session)`,
        log,
    );
}

// ─── Fetch with retry ─────────────────────────────────────────────────────────

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
                const retryAfter = res.headers.get("retry-after");
                const delay = retryAfter
                    ? Math.min(
                          Math.max(parseFloat(retryAfter) * 1000, 500),
                          60_000,
                      )
                    : 1000 * Math.pow(2, attempt - 1);
                log(
                    `extraction: HTTP ${res.status} (attempt ${attempt}/${maxTries}) — retrying in ${(delay / 1000).toFixed(1)}s`,
                );
                if (attempt < maxTries) {
                    await new Promise((r) => setTimeout(r, delay));
                    continue;
                }
                return res;
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

// ─── Extraction queue ─────────────────────────────────────────────────────────

interface ExtractionJob {
    sessionId: string;
    providerID: string;
    modelID: string;
    storeSlug: string;
    log: (msg: string) => void;
    client: any;
    enqueuedAt: number;
}

async function extractBatch(
    jobs: ExtractionJob[],
    log: (msg: string) => void,
): Promise<void> {
    if (!jobs.length) return;

    const transcripts = await Promise.all(
        jobs.map((job) => fetchTranscript(job.sessionId, job.client, job.log)),
    );

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
        log: (msg: string) => void;
        entries: { sessionId: string; transcript: string }[];
    };
    const groups = new Map<string, Group>();

    for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        const t = transcripts[i];
        if (!t) {
            job.log(
                `[EXTRACT] extractBatch: skipping job sessionId=${job.sessionId} — no transcript`,
            );
            continue;
        }
        job.log(
            `[EXTRACT] extractBatch: transcript for sessionId=${job.sessionId} — ${t.length} chars`,
        );
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

    log(`queue consumer: ${jobs.length} job(s) → ${groups.size} request(s)`);

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

            const combined =
                entries.length === 1
                    ? entries[0].transcript
                    : entries
                          .map(
                              (e, idx) =>
                                  `=== SESSION ${idx + 1} (${e.sessionId}) ===\n${e.transcript}`,
                          )
                          .join("\n\n");

            const { global: gi, project: pi } = store.activeItems();
            const existingItems =
                [...gi, ...pi]
                    .map(
                        (i) =>
                            `${i.id} [${i.kind}]: ${i.description} | ${i.content.slice(0, 100).replace(/\n/g, " ")}`,
                    )
                    .join("\n") || "none";
            const userContent = `Existing nodes (check id, description AND content excerpt for semantic overlap — do not re-extract semantically similar nodes):\n${existingItems}\n\n---\n\n${combined}`;

            if (target) {
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
                let parsed: any;
                try {
                    parsed = JSON.parse(raw);
                } catch {
                    grpLog(
                        `extraction: bad JSON from model — ${raw.slice(0, 120)}`,
                    );
                    return;
                }
                const nodes: ExtractionNode[] = Array.isArray(parsed)
                    ? parsed
                    : Array.isArray(parsed?.nodes)
                      ? parsed.nodes
                      : [];
                const edges: ExtractionEdge[] = Array.isArray(parsed?.edges)
                    ? parsed.edges
                    : [];
                commitExtraction(
                    nodes,
                    edges,
                    store,
                    `${providerID}/${target.model}`,
                    grpLog,
                );
            } else {
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
                );
            }
        }),
    );
}

// ─── Manifest builder ─────────────────────────────────────────────────────────

function buildManifestLines(
    sorted: { item: ItemRow; store: StoreKey }[],
    engramStore: EngramStore,
    edgeIndex: ReturnType<EngramStore["buildEdgeIndex"]>,
): { lines: string[]; dropped: number; showLegend: boolean } {
    // Legend is only worth the space when there are enough distinct sigils to be confusing
    const showLegend = sorted.length > 5;
    const result: string[] = [];
    let charCount = showLegend ? MANIFEST_LEGEND.length : 0;
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
    return { lines: result, dropped, showLegend };
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export const EngramPlugin: Plugin = async ({ directory, $, client }) => {
    const freshSlug = await resolveProjectSlug(directory, $);
    const slug = reconcileProjectSlug(directory, freshSlug);
    const store = EngramStore.getInstance(slug);

    function log(msg: string): void {
        // Parse out optional [LEVEL] and [TAG] prefixes inserted by helpers like commitExtraction.
        // Format: "[LEVEL] [TAG] message" or plain message → default INFO / TOOL
        const levelMatch = msg.match(/^\[(ERROR|WARN|INFO|DEBUG)\]\s*/i);
        const level: LogLevel = levelMatch
            ? (levelMatch[1].toLowerCase() as LogLevel)
            : "info";
        const rest = levelMatch ? msg.slice(levelMatch[0].length) : msg;

        const tagMatch = rest.match(
            /^\[(DB|GRAPH|SCORE|EXTRACT|QUEUE|EVENT|TOOL|INIT)\]\s*/i,
        );
        const tag: LogTag = tagMatch
            ? (tagMatch[1].toUpperCase() as LogTag)
            : "TOOL";
        const body = tagMatch ? rest.slice(tagMatch[0].length) : rest;

        fileLog(level, tag, slug, body);
    }

    // Instance-scoped state — one per project
    const sessions = new Map<string, SessionContext>();
    const extractionQueue: ExtractionJob[] = [];
    const enqueuedSessions = new Set<string>();
    let extractionConsumerStarted = false;

    function getSession(id: string): SessionContext {
        let s = sessions.get(id);
        if (!s) {
            s = {
                messageCount: 0,
                recentTermBuf: [],
                recentTerms: new Set(),
                assistantTermBuf: [],
                assistantTerms: new Set(),
                scores: new Map(),
                tokenCache: new Map(),
                contentTokenCache: new Map(),
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
            sess.contentTokenCache.clear(); // content may have changed on upsert
        }
    }

    const enqueueExtraction = (job: ExtractionJob) => {
        if (enqueuedSessions.has(job.sessionId)) {
            log(
                `[DEBUG] [QUEUE] enqueue skipped: sessionId=${job.sessionId} already queued`,
            );
            return;
        }
        if (extractionQueue.length >= QUEUE_MAX_SIZE) {
            const dropped = extractionQueue.splice(0, 1);
            enqueuedSessions.delete(dropped[0].sessionId);
            log(
                `[WARN] [QUEUE] queue full (max=${QUEUE_MAX_SIZE}) — dropped oldest job sessionId=${dropped[0].sessionId}`,
            );
        }
        enqueuedSessions.add(job.sessionId);
        extractionQueue.push(job);
        log(
            `[DEBUG] [QUEUE] enqueued sessionId=${job.sessionId} (queueDepth=${extractionQueue.length})`,
        );
    };

    function startExtractionConsumer(): void {
        if (extractionConsumerStarted) return;
        extractionConsumerStarted = true;
        log(
            `[INFO] [QUEUE] extraction consumer started (poll=${QUEUE_POLL_MS}ms)`,
        );
        let qHead = 0;
        const tick = async () => {
            const batch: ExtractionJob[] = [];
            while (batch.length < 10 && qHead < extractionQueue.length) {
                const job = extractionQueue[qHead++];
                enqueuedSessions.delete(job.sessionId);
                batch.push(job);
            }
            if (qHead > 20) {
                log(
                    `[DEBUG] [QUEUE] compacting queue array (consumed ${qHead} entries)`,
                );
                extractionQueue.splice(0, qHead);
                qHead = 0;
            }
            if (batch.length > 0) {
                const batchLog = batch[0].log;
                log(`[INFO] [QUEUE] processing ${batch.length} job(s)`);
                for (const job of batch) {
                    const age = ((Date.now() - job.enqueuedAt) / 1000).toFixed(
                        1,
                    );
                    job.log(
                        `[INFO] [QUEUE]   → sessionId=${job.sessionId} slug=${job.storeSlug} provider=${job.providerID} queued ${age}s ago`,
                    );
                }
                extractBatch(batch, batchLog).catch((e: any) =>
                    batchLog(`[ERROR] [QUEUE] batch error: ${e?.message ?? e}`),
                );
            } else {
                glog(
                    "debug",
                    "QUEUE",
                    `consumer tick: queue empty (qHead=${qHead})`,
                );
            }
            setTimeout(tick, QUEUE_POLL_MS);
        };
        setTimeout(tick, QUEUE_POLL_MS);
    }

    startExtractionConsumer();
    const dbKey = slugDbKey(slug);
    log(
        `[INFO] [INIT] initialized — slug="${slug}" dbKey=${dbKey} logLevel=${_rawLogLevel} extractEvery=${MESSAGE_EXTRACT_INTERVAL}msgs`,
    );

    function scheduleExtraction(sessionId: string, sess: SessionContext): void {
        if (sess.messageCount < EXTRACTION_MIN_MESSAGES) {
            log(
                `[DEBUG] [EXTRACT] scheduleExtraction: skipping — only ${sess.messageCount} msg(s) (min=${EXTRACTION_MIN_MESSAGES})`,
            );
            return;
        }
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
        const { global: gi, project: pi } = store.activeItems();
        const recentTermsSnapshot = [...sess.recentTerms]
            .slice(0, 15)
            .join(" ");
        log(
            `[SCORE] rescore: ${gi.length + pi.length} nodes, recentTerms(${sess.recentTerms.size}): ${recentTermsSnapshot || "(none)"}`,
        );
        const scored = store.score(
            gi,
            pi,
            sess.recentTerms,
            sess.assistantTerms,
            sess.tokenCache,
            sess.contentTokenCache,
        );
        sess.scores.clear();
        for (const s of scored) sess.scores.set(s.item.id, s.score);
        sess.lastScoredAt = sess.messageCount;
        const hot = scored.filter((s) => s.score > 0).length;
        const top3 = scored
            .slice(0, 3)
            .map((s) => `${s.item.id}(${s.score.toFixed(3)})`)
            .join(", ");
        log(
            `[SCORE] scored ${scored.length} — ${hot} hot, ${scored.length - hot} cold | top3: ${top3 || "none"}`,
        );
    }

    return {
        // ── session.created — prime context awareness on startup ───────────────
        event: async ({ event }: any) => {
            const type = event?.type;

            if (type !== "session.idle" && type !== "session.compacted") return;
            const sessionId = getSessionId(event);
            if (!sessionId) return;

            const sess = sessions.get(sessionId) ?? getSession(sessionId);
            const now = Date.now();
            const cooldownMs = 30_000;
            if (type === "session.idle") {
                if (
                    sess.lastIdleExtractAt &&
                    now - sess.lastIdleExtractAt < cooldownMs
                ) {
                    const remainingMs =
                        cooldownMs - (now - sess.lastIdleExtractAt);
                    log(
                        `[DEBUG] [EVENT] session.idle cooldown active for ${sessionId} — ${(remainingMs / 1000).toFixed(1)}s remaining, skipping extraction`,
                    );
                    return;
                }
                sess.lastIdleExtractAt = now;
            }

            log(`${type} — queuing extraction`);
            scheduleExtraction(sessionId, sess);

            if (type === "session.idle") {
                sessions.delete(sessionId);
                log(`session evicted from memory: ${sessionId}`);
            }
        },

        // ── Compaction — reinject scored graph into continuation context ────────
        "experimental.session.compacting": async (input: any, output: any) => {
            const { global: gi, project: pi } = store.activeItems();
            if (!gi.length && !pi.length) return;

            const sessionId = getSessionId(input?.event) ?? "default";
            const sess = getSession(sessionId);
            if (sess.scores.size === 0) rescore(sess);

            const all = [
                ...gi.map((item) => ({ item, store: "global" as StoreKey })),
                ...pi.map((item) => ({ item, store: "project" as StoreKey })),
            ];
            const hot: typeof all = [];
            const cold: typeof all = [];
            for (const entry of all)
                ((sess.scores.get(entry.item.id) ?? 0) > 0 ? hot : cold).push(
                    entry,
                );

            hot.sort(
                (a, b) =>
                    (sess.scores.get(a.item.id) ?? 0) -
                    (sess.scores.get(b.item.id) ?? 0),
            ); // lowest first → most relevant last
            cold.sort((a, b) => b.item.saved_at.localeCompare(a.item.saved_at));

            const edgeIdx = store.buildEdgeIndex();
            const { lines: hotLines, showLegend: compactLegend } =
                buildManifestLines(hot, store, edgeIdx);

            let coldNote = "";
            const coldCount = cold.length;
            if (coldCount > 0) {
                const coldIds = cold.map(
                    ({ item, store: sk }) =>
                        `${item.id}[${sigil(item.kind, item.certainty)}${sk === "global" ? ":g" : ""}]`,
                );
                const bodyNow =
                    (compactLegend ? MANIFEST_LEGEND.length : 0) +
                    hotLines.join("\n").length;
                const remaining = Math.max(0, MANIFEST_CHAR_CAP - bodyNow - 60);
                const coldList: string[] = [];
                let used = 0;
                for (const entry of coldIds) {
                    if (used + entry.length + 1 > remaining) break;
                    coldList.push(entry);
                    used += entry.length + 1;
                }
                const overflow = coldCount - coldList.length;
                const overflowNote = overflow > 0 ? ` +${overflow} more` : "";
                coldNote = `\ncold: ${coldList.join(" ")}${overflowNote} — recall_context(id) or search_context(query)`;
            }

            const body =
                hotLines.length > 0
                    ? (compactLegend ? MANIFEST_LEGEND + "\n" : "") +
                      hotLines.join("\n") +
                      coldNote
                    : `${all.length} nodes in graph — use search_context(query) to find relevant nodes.`;

            output.context.push(`${ENGRAM_HEADER}${body}\n</engram>`);
            log(`compaction — engram graph reinjected (${all.length} nodes)`);
        },

        // ── Message tracking — terms, scoring, periodic extraction ─────────────
        "chat.message": async ({ event, message }: any) => {
            const sessionId = getSessionId(event) ?? "default";
            const sess = getSession(sessionId);
            sess.messageCount++;

            const msgContent = message?.content;
            if (
                msgContent &&
                (message.role === "user" || message.role === "assistant")
            ) {
                if (message.role === "user") {
                    if (message.model?.providerID)
                        sess.providerID = message.model.providerID;
                    if (message.model?.modelID)
                        sess.modelID = message.model.modelID;
                }

                const text =
                    typeof msgContent === "string"
                        ? msgContent
                        : Array.isArray(msgContent)
                          ? msgContent.map((p: any) => p.text ?? "").join(" ")
                          : "";

                const msgTerms = tokenize(text);

                if (message.role === "user") {
                    // Topic-shift detection: if the new message shares very few terms with the
                    // existing window, the user has pivoted topics. Clearing the stale window
                    // prevents old terminology from suppressing relevant new nodes.
                    const TOPIC_SHIFT_THRESHOLD = 0.05;
                    if (
                        sess.recentTerms.size > 0 &&
                        msgTerms.size > 0 &&
                        jaccardOverlap(msgTerms, sess.recentTerms) <
                            TOPIC_SHIFT_THRESHOLD
                    ) {
                        sess.recentTermBuf = [];
                        sess.assistantTermBuf = [];
                        sess.assistantTerms = new Set();
                        sess.scoresDirty = true; // force rescore with fresh terms
                        log(
                            `[INFO] [EVENT] chat.message #${sess.messageCount} [user]: topic shift detected (overlap < ${TOPIC_SHIFT_THRESHOLD}) — term window cleared`,
                        );
                    }
                    if (sess.recentTermBuf.length >= RECENT_TERMS_WINDOW)
                        sess.recentTermBuf.splice(0, 1);
                    sess.recentTermBuf.push(msgTerms);
                    sess.recentTerms = new Set(
                        sess.recentTermBuf.flatMap((s) => [...s]),
                    );
                    log(
                        `[DEBUG] [EVENT] chat.message #${sess.messageCount} [user]: ${msgTerms.size} terms, window=${sess.recentTerms.size}`,
                    );

                    const extractDue =
                        sess.messageCount - sess.lastExtractAt >=
                        MESSAGE_EXTRACT_INTERVAL;
                    if (extractDue && sessionId !== "default") {
                        sess.lastExtractAt = sess.messageCount;
                        log(
                            `[INFO] [EVENT] chat.message — queuing extraction at message ${sess.messageCount}`,
                        );
                        scheduleExtraction(sessionId, sess);
                    }
                } else {
                    // Assistant turns: track at half weight — they surface terminology being used
                    // but are more verbose so we don't let them dominate the term window
                    if (sess.assistantTermBuf.length >= RECENT_TERMS_WINDOW)
                        sess.assistantTermBuf.splice(0, 1);
                    sess.assistantTermBuf.push(msgTerms);
                    sess.assistantTerms = new Set(
                        sess.assistantTermBuf.flatMap((s) => [...s]),
                    );
                    log(
                        `[DEBUG] [EVENT] chat.message #${sess.messageCount} [assistant]: ${msgTerms.size} terms, assistant window=${sess.assistantTerms.size}`,
                    );
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

        // ── System transform — inject scored manifest ──────────────────────────
        "experimental.chat.system.transform": async (input: any, output) => {
            const { global: gi, project: pi } = store.activeItems();
            if (!gi.length && !pi.length) return;

            const sess = getSession(getSessionId(input?.event) ?? "default");
            if (sess.scores.size === 0) rescore(sess);

            const all = [
                ...gi.map((item) => ({ item, store: "global" as StoreKey })),
                ...pi.map((item) => ({ item, store: "project" as StoreKey })),
            ];

            const hot: typeof all = [];
            const cold: typeof all = [];
            for (const entry of all)
                ((sess.scores.get(entry.item.id) ?? 0) > 0 ? hot : cold).push(
                    entry,
                );

            hot.sort(
                (a, b) =>
                    (sess.scores.get(a.item.id) ?? 0) -
                    (sess.scores.get(b.item.id) ?? 0),
            ); // lowest first → most relevant is last, nearest the user message (recency attention effect)
            cold.sort((a, b) => b.item.saved_at.localeCompare(a.item.saved_at)); // most recently created first — more likely relevant to ongoing work than historically recalled nodes

            const edgeIndex = store.buildEdgeIndex();
            const {
                lines: hotLines,
                dropped,
                showLegend,
            } = buildManifestLines(hot, store, edgeIndex);
            if (dropped > 0)
                log(
                    `[WARN] [EVENT] manifest cap hit — dropped ${dropped} lowest-scored nodes (cap=${MANIFEST_CHAR_CAP} chars)`,
                );

            const coldCount = cold.length + dropped;
            // Cold nodes: emit a compact ID+sigil line so the model can make an informed search decision.
            // Fitting within the remaining char budget prevents the cold list from blowing the cap.
            let coldNote = "";
            if (coldCount > 0) {
                const coldIds = cold.map(
                    ({ item, store: sk }) =>
                        `${item.id}[${sigil(item.kind, item.certainty)}${sk === "global" ? ":g" : ""}]`,
                );
                const bodyNow =
                    (showLegend ? MANIFEST_LEGEND.length : 0) +
                    hotLines.join("\n").length;
                const remaining = Math.max(0, MANIFEST_CHAR_CAP - bodyNow - 60);
                const coldList: string[] = [];
                let used = 0;
                for (const entry of coldIds) {
                    if (used + entry.length + 1 > remaining) break;
                    coldList.push(entry);
                    used += entry.length + 1;
                }
                const overflow = coldCount - coldList.length;
                const overflowNote = overflow > 0 ? ` +${overflow} more` : "";
                coldNote = `\ncold: ${coldList.join(" ")}${overflowNote} — recall_context(id) or search_context(query)`;
            }
            const body =
                hotLines.length > 0
                    ? (showLegend ? MANIFEST_LEGEND + "\n" : "") +
                      hotLines.join("\n") +
                      coldNote
                    : `${all.length} nodes available. Use search_context(query) to find relevant nodes.`;

            const bodyChars = body.length;
            log(
                `[DEBUG] [EVENT] system.transform: total=${all.length} hot=${hot.length} cold=${cold.length} dropped=${dropped} manifest=${bodyChars}chars`,
            );

            output.system.push(`${ENGRAM_HEADER}${body}\n</engram>`);
        },

        tool: {
            // ── recall_context ─────────────────────────────────────────────────
            recall_context: tool({
                description:
                    "Retrieve a context node by ID. Returns full Markdown content plus graph neighborhood " +
                    "including edge rationale and strength. Traversal follows per-edge-type depth limits. " +
                    "Use edge rationale to understand why relationships exist. " +
                    "Cross-store references shown with :g/:p provenance suffix.",
                args: { id: tool.schema.string().describe("Node ID") },
                async execute({ id }) {
                    const resolved = store.resolve(id);
                    if (!resolved) {
                        const inRows = store.edgesIn(id);
                        if (inRows.length)
                            return `"${id}" is referenced but not yet defined ([?]).\nReferenced by: ${inRows
                                .map((e) => `${e.from_id} via ${e.edge_type}`)
                                .join(", ")}\nUse save_context to define it.`;
                        return `No node: "${id}". Use list_context or search_context to find available nodes.`;
                    }

                    const [item, key] = resolved;
                    store.touchRecall(key, id);
                    log(`recalled ${id} [${item.kind}] from ${key}`);

                    const nodes = store.traverse(id);
                    const graph = fmtSubgraph(nodes, id);
                    return [
                        `<context id="${item.id}" kind="${item.kind}" store="${key}"`,
                        ` authority="${item.authority}" certainty="${item.certainty}" status="${item.status}">`,
                        `\n<content>\n${xmlEscape(item.content)}\n</content>`,
                        `\n<graph>\n${graph}\n</graph>`,
                        `\n</context>`,
                    ].join("");
                },
            }),

            // ── search_context ──────────────────────────────────────────────────
            search_context: tool({
                description:
                    "Full-text search across both global and project stores. " +
                    "Use when you cannot identify the right node from the manifest. " +
                    "Active nodes only by default — set include_archived=true to include deprecated/archived nodes. " +
                    "Each hit includes immediate graph neighborhood with edge strength. " +
                    "Follow up with recall_context(id) on the best match.",
                args: {
                    query: tool.schema.string().describe("Search query"),
                    max_results: tool.schema
                        .number()
                        .optional()
                        .describe("Max hits per store (default 4)"),
                    include_archived: tool.schema
                        .boolean()
                        .optional()
                        .describe(
                            "Include archived/deprecated nodes (default false)",
                        ),
                },
                async execute({
                    query,
                    max_results = 4,
                    include_archived = false,
                }) {
                    if (!query.trim()) return "Empty query.";
                    const hits = store.search(
                        query,
                        max_results,
                        include_archived,
                    );
                    log(
                        `search "${query}" include_archived=${include_archived} → ${hits.length} hit(s)`,
                    );
                    if (!hits.length) return `No results for "${query}".`;

                    const edgeIndex = store.buildEdgeIndex();
                    const xmlHits = hits.map(({ item, store: storeKey }) => {
                        const neighbors =
                            store.neighborLine(item, storeKey, edgeIndex) ||
                            "no edges";
                        return [
                            `<hit id="${item.id}" kind="${item.kind}" store="${storeKey}"`,
                            ` certainty="${item.certainty}" status="${item.status}">`,
                            `\n  <description>${xmlEscape(item.description)}</description>`,
                            `\n  <neighbors>${xmlEscape(neighbors)}</neighbors>`,
                            `\n</hit>`,
                        ].join("");
                    });

                    return (
                        `<search-results query="${xmlEscape(query)}">\n${xmlHits.join("\n")}\n</search-results>\n` +
                        `<next-step>Call recall_context(id) on the most relevant hit.</next-step>`
                    );
                },
            }),

            // ── save_context ────────────────────────────────────────────────────
            save_context: tool({
                description:
                    "Create a new context node. Fails if the ID already exists — use update_context to modify. " +
                    "Defaults to project store; use store='global' for patterns that apply across all projects. " +
                    "Kind guide: risk/plan for things not yet settled, constraint/decision for settled things, " +
                    "interface for internal APIs you own, finding for completed investigation results. " +
                    "Use certainty=speculative for beliefs not yet verified. " +
                    "importance 1–5 (default 3): 5=irreversible architectural constraint, 1=ephemeral detail.",
                args: {
                    id: tool.schema
                        .string()
                        .describe("Unique kebab-case ID, e.g. 'auth-flow'"),
                    kind: tool.schema.string().describe(DESC_KINDS),
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
                        .describe(`${DESC_STATUSES} (default: active)`),
                    authority: tool.schema
                        .string()
                        .optional()
                        .describe(
                            `${DESC_AUTHORITIES} (default: binding for constraint/decision, advisory otherwise)`,
                        ),
                    certainty: tool.schema
                        .string()
                        .optional()
                        .describe(`${DESC_CERTAINTIES} (default: confirmed)`),
                    importance: tool.schema
                        .number()
                        .optional()
                        .describe("1=low … 5=critical (default 3)"),
                },
                async execute({
                    id,
                    kind,
                    description,
                    content,
                    store: storeArg,
                    status,
                    authority,
                    certainty,
                    importance,
                }) {
                    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id))
                        return `Invalid id "${id}". Must be a lowercase-hyphenated slug (a-z0-9-), 1–40 chars, starting with a letter or digit.`;
                    const key = (
                        storeArg === "global" ? "global" : "project"
                    ) as StoreKey;
                    const fieldErr = validateNodeFields(
                        kind,
                        status,
                        authority,
                        certainty,
                    );
                    if (fieldErr) return fieldErr;
                    const existing = store.resolve(id);
                    if (existing)
                        return `"${id}" already exists in the ${existing[1]} store. Use update_context to modify it.`;

                    const defaultAuthority: NodeAuthority =
                        kind === "constraint" || kind === "decision"
                            ? "binding"
                            : "advisory";
                    store.upsert(
                        key,
                        id,
                        kind,
                        status ?? "active",
                        authority ?? defaultAuthority,
                        certainty ?? "confirmed",
                        importance ?? 3,
                        description,
                        content,
                    );
                    markScoresDirty();
                    log(`saved "${id}" [${kind}] → ${key}`);

                    const inRows = store.edgesIn(id);
                    const resolvedNote = inRows.length
                        ? `\nResolves ${inRows.length} dangling edge(s) from: ${inRows.map((e) => e.from_id).join(", ")}`
                        : "";
                    return `Saved "${id}" [${kind}] in ${key} store.${resolvedNote}`;
                },
            }),

            // ── update_context ──────────────────────────────────────────────────
            update_context: tool({
                description:
                    "Update fields on an existing node. Only provided fields are changed; omitted fields retain current values. " +
                    "Previous content is versioned automatically. " +
                    "Common patterns: risk→constraint/decision when investigated; plan→finding when executed; " +
                    "certainty→confirmed when verified; status→archived when resolved. " +
                    "For lifecycle transitions (plan/risk → something resolved), prefer resolve_context. " +
                    "Cannot change store — use move_context for that.",
                args: {
                    id: tool.schema.string().describe("Node ID to update"),
                    kind: tool.schema.string().optional().describe(DESC_KINDS),
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
                    authority: tool.schema
                        .string()
                        .optional()
                        .describe(DESC_AUTHORITIES),
                    certainty: tool.schema
                        .string()
                        .optional()
                        .describe(DESC_CERTAINTIES),
                    importance: tool.schema
                        .number()
                        .optional()
                        .describe("1=low … 5=critical"),
                },
                async execute({
                    id,
                    kind,
                    description,
                    content,
                    status,
                    authority,
                    certainty,
                    importance,
                }) {
                    const resolved = store.resolve(id);
                    if (!resolved)
                        return `No node: "${id}". Use save_context to create it.`;

                    const [existing, key] = resolved;
                    const fieldErr = validateNodeFields(
                        kind,
                        status,
                        authority,
                        certainty,
                    );
                    if (fieldErr) return fieldErr;

                    store.upsert(
                        key,
                        id,
                        kind ?? existing.kind,
                        status ?? existing.status,
                        authority ?? existing.authority,
                        certainty ?? existing.certainty,
                        importance ?? existing.importance,
                        description ?? existing.description,
                        content ?? existing.content,
                        existing,
                    );
                    markScoresDirty();

                    const changed = (
                        [
                            "kind",
                            "description",
                            "content",
                            "status",
                            "authority",
                            "certainty",
                            "importance",
                        ] as const
                    )
                        .filter(
                            (f) =>
                                ({
                                    kind,
                                    description,
                                    content,
                                    status,
                                    authority,
                                    certainty,
                                    importance,
                                })[f] != null,
                        )
                        .join(", ");
                    log(`updated "${id}" [${key}] — ${changed}`);
                    return `Updated "${id}" in ${key} store. Changed: ${changed}.`;
                },
            }),

            // ── resolve_context ─────────────────────────────────────────────────
            resolve_context: tool({
                description:
                    "Atomically resolve a plan or risk node by transitioning it to its outcome kind. " +
                    "Updates kind, certainty, and content in a single versioned operation. " +
                    "Appends a resolution note to the content so the history of the transition is preserved. " +
                    "Use when: a risk is investigated (→ constraint or finding), " +
                    "a plan is executed (→ finding or decision), " +
                    "a speculative assumption is confirmed or refuted. " +
                    "Prefer this over update_context for lifecycle transitions — it enforces proper patterns.",
                args: {
                    id: tool.schema.string().describe("Node ID to resolve"),
                    outcome_kind: tool.schema
                        .string()
                        .describe(
                            "The resolved kind: constraint | decision | finding | reference",
                        ),
                    content: tool.schema
                        .string()
                        .describe("Updated content reflecting the resolution"),
                    resolution: tool.schema
                        .string()
                        .describe(
                            "One sentence: what was found, decided, or confirmed",
                        ),
                    outcome_certainty: tool.schema
                        .string()
                        .optional()
                        .describe("confirmed (default) | working"),
                    description: tool.schema
                        .string()
                        .optional()
                        .describe("Updated description (optional)"),
                },
                async execute({
                    id,
                    outcome_kind,
                    content,
                    resolution,
                    outcome_certainty,
                    description,
                }) {
                    const resolved = store.resolve(id);
                    if (!resolved) return `No node: "${id}".`;
                    const [existing, key] = resolved;

                    const kindErr = validate(
                        "outcome_kind",
                        outcome_kind,
                        VALID_KINDS,
                    );
                    if (kindErr) return kindErr;
                    if (outcome_certainty) {
                        const certErr = validate(
                            "outcome_certainty",
                            outcome_certainty,
                            VALID_CERTAINTIES,
                        );
                        if (certErr) return certErr;
                    }

                    const resolvable: NodeKind[] = [
                        "plan",
                        "risk",
                        "decision",
                        "finding",
                        "constraint",
                    ];
                    if (!resolvable.includes(existing.kind as NodeKind))
                        return (
                            `resolve_context is for plan/risk/decision/finding/constraint nodes. ` +
                            `"${id}" is a ${existing.kind} — use update_context instead.`
                        );

                    const fullContent = `${content}\n\n---\n**Resolution:** ${resolution}\n**Resolved from:** ${existing.kind} (${existing.certainty})`;
                    store.upsert(
                        key,
                        id,
                        outcome_kind,
                        "active",
                        existing.authority,
                        outcome_certainty ?? "confirmed",
                        existing.importance,
                        description ?? existing.description,
                        fullContent,
                        existing,
                    );
                    markScoresDirty();
                    log(`resolved "${id}": ${existing.kind}→${outcome_kind}`);

                    // Suggest edges to complete the graph — resolution alone doesn't create graph links.
                    const edgeHints: string[] = [];
                    if (existing.kind === "risk") {
                        edgeHints.push(
                            `• Evidence/investigation that validated or refuted this: link_context(from_id="<evidence-node>", to_id="${id}", edge_type="validates")`,
                        );
                        if (
                            outcome_kind === "constraint" ||
                            outcome_kind === "decision"
                        ) {
                            edgeHints.push(
                                `• If this risk caused the new constraint/decision to exist: link_context(from_id="${id}", to_id="<constraint-or-decision>", edge_type="causes")`,
                            );
                        }
                    } else if (existing.kind === "plan") {
                        edgeHints.push(
                            `• If this plan supersedes an older approach: link_context(from_id="${id}", to_id="<old-node>", edge_type="supersedes")`,
                        );
                        edgeHints.push(
                            `• If this plan implements a known interface: link_context(from_id="${id}", to_id="<interface-node>", edge_type="implements")`,
                        );
                    }
                    const hintBlock =
                        edgeHints.length > 0
                            ? `\n\nTo complete the graph, consider:\n${edgeHints.join("\n")}`
                            : "";
                    return `Resolved "${id}" from ${existing.kind} → ${outcome_kind} (${outcome_certainty ?? "confirmed"}).${hintBlock}`;
                },
            }),

            // ── link_context ────────────────────────────────────────────────────
            link_context: tool({
                description:
                    "Add or remove a directed edge between nodes. " +
                    "to_id may not exist yet — dangling edges are allowed and will resolve when the node is created. " +
                    `edge_type: ${DESC_EDGES}. ` +
                    "strength reflects confidence in the relationship (0.0–1.0). " +
                    "rationale is a single sentence explaining why the relationship exists — include it for any non-obvious edge.",
                args: {
                    from_id: tool.schema
                        .string()
                        .describe("Source node ID (must exist)"),
                    to_id: tool.schema
                        .string()
                        .describe("Target node ID (may not exist yet)"),
                    edge_type: tool.schema.string().describe(DESC_EDGES),
                    strength: tool.schema
                        .number()
                        .optional()
                        .describe(
                            "0.0–1.0 confidence in this relationship (default 1.0)",
                        ),
                    rationale: tool.schema
                        .string()
                        .optional()
                        .describe(
                            "Why this relationship exists (one sentence)",
                        ),
                    remove: tool.schema
                        .boolean()
                        .optional()
                        .describe("true = remove this edge"),
                },
                async execute({
                    from_id,
                    to_id,
                    edge_type,
                    strength,
                    rationale,
                    remove,
                }) {
                    const edgeErr = validate(
                        "edge_type",
                        edge_type,
                        VALID_EDGES,
                    );
                    if (edgeErr) return edgeErr;

                    const fromResolved = store.resolve(from_id);
                    if (!fromResolved)
                        return `Source "${from_id}" does not exist. Create it with save_context first.`;

                    const toResolved = remove ? null : store.resolve(to_id);

                    if (
                        !remove &&
                        fromResolved[1] === "global" &&
                        toResolved?.[1] === "project"
                    )
                        return (
                            `Cannot link global→project: "${from_id}" (global) → "${to_id}" (project).\n` +
                            `Global nodes must only reference other global nodes — they are shared across all projects.\n` +
                            `Either move "${to_id}" to the global store, or reverse the edge direction.`
                        );

                    if (remove) {
                        store.deleteEdge(
                            fromResolved[1],
                            from_id,
                            to_id,
                            edge_type,
                        );
                        markScoresDirty();
                        log(`unlinked ${from_id} -[${edge_type}]→ ${to_id}`);
                        return `Removed: ${from_id} -[${edge_type}]→ ${to_id}`;
                    }

                    const s = Math.max(0, Math.min(1, strength ?? 1.0));
                    store.insertEdge(
                        fromResolved[1],
                        from_id,
                        to_id,
                        edge_type,
                        s,
                        rationale,
                    );
                    markScoresDirty();
                    log(
                        `[INFO] [TOOL] linked ${from_id} -[${edge_type}]→ ${to_id} strength=${s.toFixed(2)} rationale=${rationale ? `"${rationale.slice(0, 60)}"` : "none"}`,
                    );

                    const crossNote =
                        toResolved?.[1] !== fromResolved[1]
                            ? ` (cross-store: ${fromResolved[1]}→${toResolved?.[1]})`
                            : "";
                    const dangNote = !toResolved
                        ? ` (${to_id} is [?] — define with save_context)`
                        : "";
                    const strengthNote =
                        s < 0.5
                            ? ` [weak edge — ${(s * 100).toFixed(0)}% confidence]`
                            : "";
                    return `Linked: ${from_id} -[${edge_type}]→ ${to_id}${crossNote}${dangNote}${strengthNote}`;
                },
            }),

            // ── delete_context ──────────────────────────────────────────────────
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
                    return `Deleted "${id}" from ${key} store.${
                        inRows.length
                            ? ` ${inRows.length} edge(s) from [${inRows.map((e) => e.from_id).join(", ")}] now dangling.`
                            : ""
                    }`;
                },
            }),

            // ── move_context ────────────────────────────────────────────────────
            move_context: tool({
                description:
                    "Atomically move a node between global and project stores. " +
                    "Rewrites outgoing edges and version history into the destination DB. " +
                    "Incoming edge references remain valid — traversal checks both stores. " +
                    "Blocked if a global node references the node being moved to project.",
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
                        if (globalIncoming.length) {
                            log(
                                `[WARN] [TOOL] move_context: blocked "${id}" global→project — referenced by global nodes: ${globalIncoming.map((e) => e.from_id).join(", ")}`,
                            );
                            return (
                                `Cannot move "${id}" to project — referenced by global node(s): ` +
                                `${globalIncoming.map((e) => e.from_id).join(", ")}.\n` +
                                `Remove those edges first, or move the referencing nodes to project too.`
                            );
                        }
                    }

                    try {
                        const { outEdgesMigrated, totalIncoming } = store.move(
                            id,
                            destKey,
                        );
                        markScoresDirty();
                        log(`moved "${id}" ${srcKey} → ${destKey}`);
                        return (
                            `Moved "${id}" ${srcKey} → ${destKey}.` +
                            (outEdgesMigrated
                                ? ` ${outEdgesMigrated} outgoing edge(s) migrated.`
                                : "") +
                            (totalIncoming
                                ? ` ${totalIncoming} incoming edge(s) resolve via ${destKey} store.`
                                : "")
                        );
                    } catch (e: any) {
                        return `Move failed: ${e.message}`;
                    }
                },
            }),

            // ── rename_context ──────────────────────────────────────────────────
            rename_context: tool({
                description:
                    "Atomically rename a node ID. Rewrites all edge from_id/to_id references " +
                    "across both stores and rewrites version history entries for the node.",
                args: {
                    old_id: tool.schema.string().describe("Current node ID"),
                    new_id: tool.schema.string().describe("New node ID"),
                },
                async execute({ old_id, new_id }) {
                    if (old_id === new_id)
                        return "IDs are identical — nothing to do.";
                    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(new_id))
                        return `Invalid new_id "${new_id}". Must be a lowercase-hyphenated slug, 1–40 chars.`;
                    if (!store.resolve(old_id)) return `No node: "${old_id}".`;
                    if (store.resolve(new_id))
                        return `"${new_id}" already exists. Delete it first or choose a different name.`;

                    try {
                        const { storeKey, crossUpdated } = store.rename(
                            old_id,
                            new_id,
                        );
                        markScoresDirty();
                        log(`renamed "${old_id}" → "${new_id}" [${storeKey}]`);
                        return (
                            `Renamed "${old_id}" → "${new_id}" in ${storeKey} store.` +
                            (crossUpdated > 0
                                ? ` Updated ${crossUpdated} cross-store edge(s).`
                                : "")
                        );
                    } catch (e: any) {
                        return `Rename failed: ${e.message}`;
                    }
                },
            }),

            // ── history_context ─────────────────────────────────────────────────
            history_context: tool({
                description:
                    "Show the version history of a node — previous descriptions and content snapshots. " +
                    "Useful for understanding how a decision or constraint evolved over time.",
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
                        return (
                            `<version id="${id}" v="${version}" saved="${snap.saved_at}">` +
                            `\n<description>${xmlEscape(snap.description)}</description>` +
                            `\n<content>\n${xmlEscape(snap.content)}\n</content>` +
                            `\n</version>`
                        );
                    }

                    const lines = versions.map(
                        (v) =>
                            `  v${v.version}  ${v.saved_at}  [${v.kind}] ${v.description}`,
                    );
                    log(`history "${id}" — ${versions.length} snapshot(s)`);
                    return (
                        `History for "${id}" (${versions.length} snapshot(s)):\n${lines.join("\n")}\n\n` +
                        `Call history_context(id, version=N) to retrieve a specific snapshot.`
                    );
                },
            }),

            // ── rebuild_fts ─────────────────────────────────────────────────────
            rebuild_fts: tool({
                description:
                    "Rebuild FTS5 search indexes from scratch in both stores. " +
                    "Use if search_context returns unexpected results — indexes can drift if the database was modified externally.",
                args: {},
                async execute() {
                    store.rebuildFts();
                    log("FTS indexes rebuilt");
                    return "FTS5 indexes rebuilt for both stores.";
                },
            }),

            // ── list_context ────────────────────────────────────────────────────
            list_context: tool({
                description:
                    "List all nodes across both stores. Includes a structural analysis section " +
                    "flagging orphans, unvalidated risks, unresolved plans, dangling references, " +
                    "and speculative nodes in high-stakes kinds.",
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
                    const idx = store.buildEdgeIndex();
                    let total = 0;

                    let globalItems: ItemRow[] = [];
                    let projectItems: ItemRow[] = [];

                    if (
                        !storeArg ||
                        storeArg === "all" ||
                        storeArg === "global"
                    ) {
                        globalItems = filter(store.allItems("global"));
                        total += globalItems.length;
                        if (globalItems.length)
                            sections.push(
                                "[global]\n" +
                                    globalItems
                                        .map(
                                            (i) =>
                                                `  ${store.manifestLine(i, "global", idx)}  [${i.authority}/${i.certainty}] ${i.description}`,
                                        )
                                        .join("\n"),
                            );
                    }

                    if (
                        !storeArg ||
                        storeArg === "all" ||
                        storeArg === "project"
                    ) {
                        projectItems = filter(store.allItems("project"));
                        total += projectItems.length;
                        if (projectItems.length)
                            sections.push(
                                `[project: ${store.slug}]\n` +
                                    projectItems
                                        .map(
                                            (i) =>
                                                `  ${store.manifestLine(i, "project", idx)}  [${i.authority}/${i.certainty}] ${i.description}`,
                                        )
                                        .join("\n"),
                            );
                    }

                    // ── Structural analysis ──────────────────────────────────────
                    const allItems = [...globalItems, ...projectItems];
                    const allIds = new Set(allItems.map((i) => i.id));

                    if (allIds.size > 0) {
                        const warnings: string[] = [];

                        // Orphans: nodes with no edges in either direction
                        const orphans = [...allIds].filter(
                            (id) =>
                                !(
                                    idx.outByKey.global.has(id) ||
                                    idx.outByKey.project.has(id) ||
                                    idx.inByKey.global.has(id) ||
                                    idx.inByKey.project.has(id)
                                ),
                        );
                        if (orphans.length > 0)
                            warnings.push(
                                `Orphans (no edges — consider linking): ${orphans.join(", ")}`,
                            );

                        // Unvalidated risks: active risk nodes with no incoming "validates" edge
                        const unvalidatedRisks = allItems
                            .filter(
                                (i) =>
                                    i.kind === "risk" && i.status === "active",
                            )
                            .filter((i) => {
                                const incoming = [
                                    ...(idx.inByKey.global.get(i.id) ?? []),
                                    ...(idx.inByKey.project.get(i.id) ?? []),
                                ];
                                return !incoming.some(
                                    (e) => e.edge_type === "validates",
                                );
                            })
                            .map((i) => i.id);
                        if (unvalidatedRisks.length)
                            warnings.push(
                                `Unvalidated risks (no validates edge): ${unvalidatedRisks.join(", ")}`,
                            );

                        // Unresolved plans: active plan nodes with no supersedes incoming
                        const unresolvedPlans = allItems
                            .filter(
                                (i) =>
                                    i.kind === "plan" && i.status === "active",
                            )
                            .filter((i) => {
                                const incoming = [
                                    ...(idx.inByKey.global.get(i.id) ?? []),
                                    ...(idx.inByKey.project.get(i.id) ?? []),
                                ];
                                return !incoming.some(
                                    (e) => e.edge_type === "supersedes",
                                );
                            })
                            .map((i) => i.id);
                        if (unresolvedPlans.length)
                            warnings.push(
                                `Unresolved plans (no supersedes edge — use resolve_context when done): ${unresolvedPlans.join(", ")}`,
                            );

                        // Dangling targets: to_ids that don't exist in either store
                        const dangling = new Set<string>();
                        for (const key of ["global", "project"] as StoreKey[])
                            for (const edges of idx.outByKey[key].values())
                                for (const e of edges)
                                    if (!allIds.has(e.to_id))
                                        dangling.add(e.to_id);
                        if (dangling.size)
                            warnings.push(
                                `Dangling targets (referenced but undefined — use save_context): ${[...dangling].join(", ")}`,
                            );

                        // Speculative high-stakes nodes: constraint/decision/interface marked speculative
                        const speculativeHighStakes = allItems
                            .filter(
                                (i) =>
                                    [
                                        "constraint",
                                        "decision",
                                        "interface",
                                    ].includes(i.kind) &&
                                    i.certainty === "speculative",
                            )
                            .map((i) => i.id);
                        if (speculativeHighStakes.length)
                            warnings.push(
                                `Speculative constraint/decision/interface nodes (verify and update certainty): ${speculativeHighStakes.join(", ")}`,
                            );

                        if (warnings.length)
                            sections.push(
                                `[analysis]\n${warnings.map((w) => "  ! " + w).join("\n")}`,
                            );
                    }

                    log(`list — ${total} node(s) across both stores`);
                    return sections.length
                        ? sections.join("\n\n")
                        : "Engram is empty.";
                },
            }),

            // ── stale_context ───────────────────────────────────────────────────
            stale_context: tool({
                description:
                    "List candidate nodes for pruning: created more than N days ago, never recalled, " +
                    "and having no outgoing or incoming edges (truly isolated dead weight). " +
                    "Use to identify and delete nodes that waste manifest budget. " +
                    "Does not delete anything — call delete_context to act on candidates.",
                args: {
                    min_age_days: tool.schema
                        .number()
                        .optional()
                        .describe(
                            "Minimum age in days since saved_at (default 30)",
                        ),
                    store: tool.schema
                        .string()
                        .optional()
                        .describe("global | project | all (default)"),
                },
                async execute({ min_age_days = 30, store: storeArg }) {
                    const cutoff = new Date(
                        Date.now() - min_age_days * 86_400_000,
                    ).toISOString();
                    const keys: StoreKey[] =
                        !storeArg || storeArg === "all"
                            ? ["global", "project"]
                            : [
                                  (storeArg === "global"
                                      ? "global"
                                      : "project") as StoreKey,
                              ];

                    const idx = store.buildEdgeIndex();
                    const candidates: string[] = [];

                    for (const key of keys) {
                        const items = store.allItems(key);
                        for (const item of items) {
                            if (item.recall_count > 0) continue; // ever recalled — keep
                            if (item.saved_at > cutoff) continue; // too recent — keep
                            // Keep if it has any edges (it's part of the graph structure)
                            const hasEdges =
                                (idx.outByKey[key].get(item.id)?.length ?? 0) >
                                    0 ||
                                (idx.inByKey[key].get(item.id)?.length ?? 0) >
                                    0;
                            if (hasEdges) continue;
                            candidates.push(
                                `  ${item.id.padEnd(28)} [${item.kind}]  saved=${item.saved_at.slice(0, 10)}  recalled=0  no-edges  store=${key}`,
                            );
                        }
                    }

                    log(
                        `stale_context: ${candidates.length} candidate(s) (age>${min_age_days}d, never recalled, no edges)`,
                    );
                    if (!candidates.length)
                        return `No stale nodes found (criteria: age > ${min_age_days}d, never recalled, no graph edges).`;
                    return `Stale candidates (${candidates.length}) — review and call delete_context(id) to remove:\n${candidates.join("\n")}`;
                },
            }),
        },
    };
};

export default EngramPlugin;
