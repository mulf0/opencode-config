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

| Agent                    | Role                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| `@deterministic-coder`   | Bug fixes, spec implementations, refactoring. Low temperature, haiku model. Edit/bash allowed. |
| `@exploratory-architect` | Architecture design, trade-off analysis. Thinking enabled. Read-only.                          |
| `@expert-researcher`     | Evidence gathering, source evaluation, synthesis. Thinking enabled. Read-only.                 |
| `@qa-reviewer`           | Post-implementation code review. Returns PASS / NEEDS_FIX / BLOCK. Read-only.                  |

Direct `@agent` mention is for manual override only. For normal tasks, send the request to build and let it route.

`@explore` and `@general` are built-in OpenCode subagents not in the orchestration chain. Build cannot dispatch them. Use `@expert-researcher` for all codebase investigation and research tasks.

## Agentic Loops

For multi-step tasks, maintain a todo list and iterate until all steps are complete. Do not surface partial results. Only report completion when:

- All todo items are checked off
- Tests pass
- Type checker and linter are clean

If blocked (ambiguous requirement, missing context, failing test with no clear fix), stop and ask one focused question. Do not loop on a bad assumption.

## Agent Handoffs

- Each phase must complete fully before the next dispatches — researcher before architect, architect before coder.
- Pass output explicitly: summarise the previous agent's output in the task description sent to the next agent. Do not assume context carries over between subagent sessions.
- Resolve all ambiguities before dispatching coder. Subagents that need to ask for user input can cause the session to loop.
- The build agent does not read source files before dispatching. Classification is based on the request text and context nodes only.

**QA loop** (build agent manages this automatically):

1. After each coder task completes, qa-reviewer is dispatched with the task spec and changed file list.
2. PASS → task complete. NEEDS_FIX → coder re-dispatched with findings. BLOCK → surfaced to user immediately.
3. Maximum 2 retry cycles per task. If still failing after 2 retries, halted and surfaced to user.

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

## Examples

| Request                                                                  | Correct behavior                                                                                                |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| "Fix this TypeScript error"                                              | Build classifies as Chain A → dispatches `@deterministic-coder` → QA                                            |
| "Design an event system for real-time updates"                           | Build classifies as Chain B → dispatches `@exploratory-architect` → confirms plan → `@deterministic-coder` → QA |
| "What's the difference between let and const?"                           | Build answers directly — no dispatch                                                                            |
| "Research options for background job queues then implement the best one" | Build classifies as Chain C → `@expert-researcher` → `@deterministic-coder` → QA                                |
| "Research and design a new caching strategy, then implement"             | Build classifies as Chain D → `@expert-researcher` → `@exploratory-architect` → `@deterministic-coder` → QA     |
