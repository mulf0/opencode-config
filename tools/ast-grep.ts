import { tool } from "@opencode-ai/plugin"

export const search = tool({
    description:
        "Structural code search using AST patterns. Finds code by syntax structure, not text. " +
        "Example patterns: '$F($ARGS)' matches any function call, 'if ($COND) { $BODY }' matches if blocks. " +
        "Use $NAME for named wildcards, $$$REST for variadic matches.",
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
        const cmdArgs = ["scan", "-p", args.pattern, searchPath, "--color", "never"]
        if (args.lang) cmdArgs.splice(3, 0, "-l", args.lang)
        try {
            const proc = Bun.spawn(["sg", ...cmdArgs], {
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
                return "ast-grep (sg) not installed. Install with: cargo install ast-grep"
            }
            return `Error: ${e?.message ?? e}`
        }
    },
})

export const rewrite = tool({
    description:
        "Structural find-and-replace using AST patterns. Dry-run only — shows what would change without modifying files. " +
        'Example: pattern="strncpy($D,$S,$N)" rewrite="memcpy($D,$S,strlen($S));$D[strlen($S)]=0;"',
    args: {
        pattern: tool.schema.string().describe("AST pattern to find."),
        replacement: tool.schema
            .string()
            .describe("Replacement pattern. Use same $VAR names from the search pattern."),
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
        const cmdArgs = ["scan", "-p", args.pattern, "-r", args.replacement, searchPath, "--color", "never"]
        if (args.lang) cmdArgs.splice(5, 0, "-l", args.lang)
        try {
            const proc = Bun.spawn(["sg", ...cmdArgs], {
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
                return "ast-grep (sg) not installed. Install with: cargo install ast-grep"
            }
            return `Error: ${e?.message ?? e}`
        }
    },
})
