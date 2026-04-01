import { tool } from "@opencode-ai/plugin"

export const search = tool({
    description:
        "Structural code search using AST patterns. Finds code by syntax structure, not text. " +
        "Example patterns: '$F($$$ARGS)' matches any function call (zero or more args), 'if ($COND) { $$$BODY }' matches if blocks. " +
        "Use $NAME for named single-node wildcards, $$$NAME for variadic matches. " +
        "Metavar names must be UPPERCASE (A-Z, underscore, digits). Patterns must be valid parseable code for the target language.",
    args: {
        pattern: tool.schema
            .string()
            .describe("AST pattern to search for. Use $VAR for wildcards."),
        lang: tool.schema
            .string()
            .optional()
            .describe("Language: c, js, ts, py, go, rust, etc. Auto-detected if omitted."),
        path: tool.schema
            .string()
            .optional()
            .describe("Directory or file to search. Defaults to project root."),
    },
    async execute(args, context) {
        const searchPath = args.path ?? context.worktree
        const cmdArgs = ["run", "-p", args.pattern, searchPath, "--color", "never"]
        if (args.lang) cmdArgs.splice(3, 0, "-l", args.lang)
        try {
            const proc = Bun.spawn(["ast-grep", ...cmdArgs], {
                cwd: context.worktree,
                stdout: "pipe",
                stderr: "pipe",
            })
            const stdout = await new Response(proc.stdout).text()
            const stderr = await new Response(proc.stderr).text()
            await proc.exited
            if (!stdout.trim() && proc.exitCode === 0) return "No matches found."
            if (proc.exitCode !== 0 && stderr.trim()) return `Error: ${stderr.trim()}`
            return stdout.trim()
        } catch (e: any) {
            if (e?.code === "ENOENT") {
                return "ast-grep not installed. Install with: cargo install ast-grep"
            }
            return `Error: ${e?.message ?? e}`
        }
    },
})

export const rewrite = tool({
    description:
        "Structural find-and-replace using AST patterns. Dry-run only — shows what would change without modifying files. " +
        'Example: pattern="strncpy($D,$S,$N)" rewrite="memcpy($D,$S,strlen($S));$D[strlen($S)]=0;" ' +
        "Metavar names must be UPPERCASE (A-Z, underscore, digits). Patterns must be valid parseable code for the target language. " +
        "Use $$$NAME for variadic matches (zero or more nodes).",
    args: {
        pattern: tool.schema.string().describe("AST pattern to find."),
        rewrite: tool.schema
            .string()
            .describe("Rewrite pattern (matches CLI --rewrite flag). Use same $VAR names from the search pattern."),
        lang: tool.schema
            .string()
            .optional()
            .describe("Language: c, js, ts, py, go, rust, etc."),
        path: tool.schema
            .string()
            .optional()
            .describe("Directory or file to search. Defaults to project root."),
    },
    async execute(args, context) {
        const searchPath = args.path ?? context.worktree
        const cmdArgs = ["run", "-p", args.pattern, "-r", args.rewrite, searchPath, "--color", "never"]
        if (args.lang) cmdArgs.splice(5, 0, "-l", args.lang)
        try {
            const proc = Bun.spawn(["ast-grep", ...cmdArgs], {
                cwd: context.worktree,
                stdout: "pipe",
                stderr: "pipe",
            })
            const stdout = await new Response(proc.stdout).text()
            const stderr = await new Response(proc.stderr).text()
            await proc.exited
            if (!stdout.trim() && proc.exitCode === 0) return "No matches found."
            if (proc.exitCode !== 0 && stderr.trim()) return `Error: ${stderr.trim()}`
            return `DRY RUN — these changes would be applied:\n\n${stdout.trim()}`
        } catch (e: any) {
            if (e?.code === "ENOENT") {
                return "ast-grep not installed. Install with: cargo install ast-grep"
            }
            return `Error: ${e?.message ?? e}`
        }
    },
})
