# Tool-selection evals

Unit tests check that a tool works. They cannot check that an agent _finds_ it:
whether a description, a schema, the instructions or a view's composition lead
a model to the right tool. `npm run eval` measures that. It runs realistic
owner and administrator requests through a real MCP host against this build,
once per view, and scores what the host called.

## What it does

1. Starts this build's HTTP server on a free local port.
2. Runs every task in [`tasks.ts`](tasks.ts) through the host CLI, connected to
   each view (`/mcp` and `/mcp/compact` by default).
3. Scores each run from the host's own event stream. A run **passes** when the
   agent reaches one of the task's expected tools, directly or through
   `tools_call_read` / `tools_call_write`, with arguments that tool's own
   validation accepts.
4. Writes one JSON per run and `summary.md` to `evals/out/<timestamp>-<host>/`
   (not committed).

Tasks fall into three groups, derived from the views:

| Group      | Expected tool                                                             |
| ---------- | ------------------------------------------------------------------------- |
| core       | listed on `/mcp` and on `/mcp/compact`                                    |
| dispatched | listed on `/mcp`; on `/mcp/compact`, found and run through the dispatcher |
| beyond     | not on `/mcp` at all; reachable only through the compact dispatcher       |

## Safety

Every request carries the proxy's read-only grant (`x-mcp-auth-scope:
mcp:pro:read`) and confines the session to the test location
(`x-altegio-company-id`). A write is chosen and called by the agent, which is
what is scored, and then refused by the scope gate before anything reaches
Altegio; Codex also stops writes itself, since it runs without approvals. Its
arguments are scored offline against the tool's own schema. Reads run against
the test location. Use a disposable test location, never a real business.

## Run

```sh
ALTEGIO_API_TOKEN=… ALTEGIO_USER_TOKEN=… \
ALTEGIO_EVAL_LOCATION_ID=… ALTEGIO_EVAL_TEAM_MEMBER_ID=… \
  npm run eval -- --host codex
```

| Flag            | Default           | Meaning                                          |
| --------------- | ----------------- | ------------------------------------------------ |
| `--host`        | `codex`           | `codex` (`codex exec`) or `gemini` (`gemini -p`) |
| `--views`       | `default,compact` | views to compare                                 |
| `--tasks`       | all               | comma-separated task ids                         |
| `--model`       | host default      | the host's model id                              |
| `--effort`      | `medium`          | Codex reasoning effort                           |
| `--repeat`      | `1`               | runs per task and view                           |
| `--concurrency` | `3`               | parallel runs                                    |

`CODEX_BIN` and `GEMINI_BIN` name the binaries when they are not on `PATH`.

## Hosts differ in what a listing costs

- **Codex** defers MCP tools behind its own tool search: a request carries the
  same tokens with no server, `/mcp` or `/mcp/compact` connected (17,373 in a
  measured one-word reply, Codex 0.162). A smaller listing saves it nothing.
- **Gemini CLI** sends every listed tool with every request, as hosts without
  tool search do. This is where the listing's size shows up: a one-call task
  cost 95–97k input tokens on `/mcp` and 42–44k on `/mcp/compact`. A free-tier
  key allows about 20 requests a day per model, too few for a full run.
- **Claude Code** defers MCP tools too (ADR-001 §1.3). Its CLI can be added as
  a host the same way.

So compare views per host, and read the input tokens per run next to the pass
rate: on a deferring host the dispatcher's extra calls cost turns and buy
nothing.

## When to attach a summary

Any change to the compact view's list, the dispatcher, the server
instructions, or a description or schema of a tool the evals reach: run the
affected tasks on both views and paste `summary.md` into the pull request.
