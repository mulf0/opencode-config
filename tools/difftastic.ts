import { tool } from "@opencode-ai/plugin"

export default tool({
    description:
        "Structural diff of uncommitted changes. Shows what changed semantically (moved functions, type changes, renamed variables) without whitespace noise. Use before reviewing code changes.",
    args: {
        path: tool.schema
            .string()
            .optional()
            .describe("Specific file path to diff. Omit for all uncommitted changes."),
    },
    async execute(args, context) {
        const gitArgs = [
            "difftool", "--no-prompt",
            "--extcmd", "difft --display inline --context 3 --color never",
        ]
        if (args.path) gitArgs.push("--", args.path)
        try {
            const proc = Bun.spawn(["git", ...gitArgs], {
                cwd: context.worktree,
                stdout: "pipe",
                stderr: "pipe",
            })
            const stdout = await new Response(proc.stdout).text()
            const stderr = await new Response(proc.stderr).text()
            await proc.exited
            if (!stdout.trim() && proc.exitCode === 0) return "No uncommitted changes."
            if (proc.exitCode !== 0 && stderr.trim()) return `Error: ${stderr.trim()}`
            return stdout.trim()
        } catch (e: any) {
            if (e?.code === "ENOENT") {
                return "difftastic not installed. Install with: cargo install difftastic"
            }
            return `Error: ${e?.message ?? e}`
        }
    },
})
