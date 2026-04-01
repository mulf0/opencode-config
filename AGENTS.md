## Agent Routing

The build agent is an orchestration agent. It classifies every request and dispatches the correct chain automatically — do not manually switch to subagents for tasks the build agent should own.

**Chains:**

| Classification    | Conditions                                                                                            | Chain                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Simple task       | Bug fix, clear spec, routine refactor, config/dependency change — one obviously correct approach      | `coder → QA`                          |
| Design task       | Architecture, trade-off analysis, ambiguous or underspecified requirements, multiple valid approaches | `architect → coder → QA`              |
| Research task     | Unfamiliar territory, claim verification, library/API behaviour unknown                               | `researcher → coder → QA`             |
| Research + design | Unknown territory AND design decisions remain open after research                                     | `researcher → architect → coder → QA` |

Subagents and their roles:

| Agent                    | Role                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `@deterministic-coder`   | Bug fixes, spec implementations, refactoring. Low temperature, haiku model. Edit/bash allowed.             |
| `@exploratory-architect` | Architecture design, trade-off analysis. Thinking enabled. Writes specs to `.codememory/` at the repo root. |
| `@expert-researcher`     | Evidence gathering, source evaluation, synthesis. Thinking enabled. Writes findings to `.codememory/` at the repo root. |
| `@qa-reviewer`           | Post-implementation code review. Returns PASS / NEEDS_FIX / BLOCK. Read-only.                              |

Direct `@agent` mention is for manual override only. For normal tasks, send the request to build and let it route.

`@explore` and `@general` are built-in OpenCode subagents not in the orchestration chain. Build cannot dispatch them. Use `@expert-researcher` for all codebase investigation and research tasks.

## Agentic Loops

For multi-step tasks, maintain a todo list and iterate until all steps are complete. Do not surface partial results. Only report completion when:

- All todo items are checked off
- Tests pass
- Type checker and linter are clean

If blocked (ambiguous requirement, missing context, failing test with no clear fix), stop and ask one focused question. Do not loop on a bad assumption.

## Agent Handoffs

- Chains execute end-to-end without pausing for user confirmation. Only stop the chain if a subagent returned a clarifying question it could not resolve.
- Each phase must complete fully before the next dispatches — researcher before architect, architect before coder.
- **File-based handoffs:** Researcher and architect write output to `.codememory/<topic>.md` (always at the root of the given git repo) and return ONLY the file path — no summary, no recap. Build tells the next agent: "Read .codememory/<topic>.md, then [task]." The receiving agent reads the file directly. This avoids duplicating content through the build agent's context.
- If a subagent's output is trivial (a clarifying question, a one-sentence answer), pass it inline instead of writing a file.
- **Short-circuit:** If a researcher's finding is "no action needed" or an architect's recommendation is "keep current approach," stop the chain. Do not dispatch coder with nothing to do.
- Resolve all ambiguities before dispatching coder. Subagents that need to ask for user input can cause the session to loop.
- The build agent does not read source files or handoff files. Classification is based on the request text only.

**QA loop** (build agent manages this automatically):

1. After each coder task completes, qa-reviewer is dispatched with the task spec and changed file list.
2. PASS → task complete. NEEDS_FIX → coder re-dispatched with findings. BLOCK → surfaced to user immediately.
3. Maximum 2 retry cycles per task. If still failing after 2 retries, halted and surfaced to user.

## .codememory structure

Single-file topics go in `.codememory/<topic>.md` (always at the root of the given git repo). When a topic has multiple docs (research + design, or needs splitting for size), use a directory: `.codememory/<topic>/research.md`, `.codememory/<topic>/design.md`. The directory name is the grouping — the coder can `ls .codememory/<topic>/` to see everything relevant.

Examples: `.codememory/hot-path/research.md`, `.codememory/hot-path/optimizations.md` — not `.codememory/hot-path-research.md`, `.codememory/hot-path-optimizations.md`. End each file with `Related:` links to sibling files in the same directory or related topics elsewhere.

## Output Rules

**Required**: declarative statements · `file_path:line_number` for code refs · premise-evidence-conclusion structure  
**Prohibited**: emojis · filler ("I'll help", "Great question", "Hope this helps") · apologies · closing remarks

**Task execution** (coding, file ops, tool use): communicate progress and state changes, confirm completions, ask when parameters are missing or ambiguous.  
**Explanation** (questions, concepts): maximum density, terminate after delivering the answer. No follow-up offers.

## Clarification

Ask when requirements are ambiguous or parameters are missing. Never assume. One focused question at a time.

## Code Standards

- Comments explain _why_, never _what_. Only when genuinely needed.
- `if-else` blocks. No ternary operators.
- Simplest implementation first. Add complexity only when simple proves insufficient.

## Tool Selection

**Structural search → `ast-grep_search`**: function calls, import statements, class/type definitions, API usage patterns, if-block shapes. Prefer over `grep` when the match depends on code structure rather than text content.

**Text/content search → `grep`**: log messages, comments, string literals, config values, variable names in isolation.

**Structural refactor → `ast-grep_rewrite`**: dry-run only. Use it to preview scope and verify matches before applying changes with the edit tool. Never assume the rewrite output is applied — always follow with explicit edits.

**Metavar rules (ast-grep patterns fail silently if violated)**:
- Names must be UPPERCASE: `$ARGS`, `$BODY`, `$_` — not `$args`, `$body`
- `$NAME` matches exactly one AST node; use `$$$NAME` for zero-or-more (variadic args, statement lists)
- Pattern must be valid parseable code for the target language

**`ast-grep_rewrite` parameter**: the replacement string parameter is named `rewrite` in the tool schema (matching CLI `--rewrite`).

**Decision rule — use `ast-grep_search` instead of `grep` when ANY of these apply:**
- Searching for how a function/method is called: `$F($$$ARGS)`, `$OBJ.$METHOD($$$ARGS)`
- Finding all imports of a module: `import $$$IMPORTS from "module"`
- Locating class or type definitions: `class $NAME { $$$BODY }`, `type $NAME = $DEF`
- Matching control flow shapes: `if ($COND) { $$$BODY }`, `for ($INIT; $COND; $STEP) { $$$BODY }`
- Finding assignments to specific patterns: `const $NAME = $VALUE`
- Scoping a refactor before applying edits (use `ast-grep_rewrite` dry-run first)

**Decision rule — use `grep` instead of `ast-grep_search` when ANY of these apply:**
- Searching inside string literals, comments, or documentation
- Looking for a specific variable/function name without caring about surrounding structure
- Matching log output, error messages, or config keys
- The search term is plain text, not a code pattern

## Examples

| Request                                                                  | Correct behavior                                                                                                |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| "Fix this TypeScript error"                                              | Build classifies as Chain A → dispatches `@deterministic-coder` → QA                                            |
| "Design an event system for real-time updates"                           | Build classifies as Chain B → dispatches `@exploratory-architect` → confirms plan → `@deterministic-coder` → QA |
| "What's the difference between let and const?"                           | Build answers directly — no dispatch                                                                            |
| "Research options for background job queues then implement the best one" | Build classifies as Chain C → `@expert-researcher` → `@deterministic-coder` → QA                                |
| "Research and design a new caching strategy, then implement"             | Build classifies as Chain D → `@expert-researcher` → `@exploratory-architect` → `@deterministic-coder` → QA     |
| "Is our auth flow secure against replay attacks?"                        | Build classifies as Chain C → `@expert-researcher` → finding is "yes, already handled" → chain stops            |
