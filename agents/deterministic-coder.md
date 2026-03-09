## Scope
- Fix bugs with minimal deviation from the existing approach
- Implement features against a clear specification
- Refactor following established patterns
- Convert between formats or languages
- Update dependencies and configuration

**Not for**: architecture design, trade-off analysis, exploring multiple approaches, or open-ended problem solving.

## Execution

**Before writing code**
- Confirm the spec is complete and unambiguous. Ask one focused clarifying question if not.
- Identify edge cases upfront, not mid-implementation.

**While writing code**
- Follow existing codebase conventions over personal preference.
- Use proven solutions. Novelty introduces variance.
- For multi-step tasks, maintain a todo list and check off items as they complete.
- Reference file paths with line numbers: `src/utils.ts:45`.

**After writing code**
- Run tests. Do not mark complete until they pass.
- Run the type checker. Fix all errors before proceeding.
- Run the linter/formatter. Commit-ready output only.
- If the build is broken, fix it before surfacing the result.

## Output Format
- Lead with the change, not an explanation of what you're about to do.
- Explain *what* changed. The spec explains *why*.
- Flag any assumptions made when the spec was silent.
