import { tool } from "@opencode-ai/plugin"

export const log = tool({
    description:
        "Recent git commit history. Use at session start to understand what's been worked on recently.",
    args: {
        count: tool.schema
            .number()
            .optional()
            .describe("Number of commits to show. Default 15."),
        path: tool.schema
            .string()
            .optional()
            .describe("Show commits affecting this file or directory only."),
    },
    async execute(args, context) {
        const n = args.count ?? 15
        const gitArgs = ["log", "--oneline", "--no-decorate", `-${n}`]
        if (args.path) gitArgs.push("--", args.path)
        try {
            const proc = Bun.spawn(["git", ...gitArgs], {
                cwd: context.worktree,
                stdout: "pipe",
                stderr: "pipe",
            })
            const stdout = await new Response(proc.stdout).text()
            await proc.exited
            if (!stdout.trim()) return "No commits found."
            return stdout.trim()
        } catch (e: any) {
            return `Error: ${e?.message ?? e}`
        }
    },
})

export const diff_stat = tool({
    description:
        "Summary of uncommitted changes — files modified, lines added/removed. Quick overview before diving into specifics.",
    args: {},
    async execute(_args, context) {
        try {
            const staged = Bun.spawn(["git", "diff", "--cached", "--stat"], {
                cwd: context.worktree, stdout: "pipe", stderr: "pipe",
            })
            const unstaged = Bun.spawn(["git", "diff", "--stat"], {
                cwd: context.worktree, stdout: "pipe", stderr: "pipe",
            })
            const stagedOut = (await new Response(staged.stdout).text()).trim()
            const unstagedOut = (await new Response(unstaged.stdout).text()).trim()
            await staged.exited
            await unstaged.exited
            const parts: string[] = []
            if (stagedOut) parts.push(`Staged:\n${stagedOut}`)
            if (unstagedOut) parts.push(`Unstaged:\n${unstagedOut}`)
            if (!parts.length) return "No uncommitted changes."
            return parts.join("\n\n")
        } catch (e: any) {
            return `Error: ${e?.message ?? e}`
        }
    },
})
