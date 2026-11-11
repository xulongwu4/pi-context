# pi-context

Context insight for [pi](https://github.com/earendil-works/pi), modeled on [dsh-context](https://github.com/bowenliang123/dsh-context).

## Install

```sh
pi install /path/to/pi-context   # permanent
pi -e /path/to/pi-context/src/index.ts   # one run
```

## Features

- `/context` opens an overlay with seven tabs.

  | Tab | Content |
  | --- | --- |
  | Stats | Context window use, human inputs, requests, tool calls, cost, token totals, timing |
  | Current | Composition of the current context by category, and the largest items |
  | Trend | Tokens sent by each request |
  | Browser | What one request was assembled from |
  | Events | Compactions, model switches, thinking level changes, branch summaries |
  | Files | Reads, writes and edits per file |
  | Commands | Shell commands, their result, and the programs they ran |

  Keys: `←`/`→` tab, `↑`/`↓` scroll or select, `enter` open the selected request in Browser, `[`/`]` previous or next request, `r` refresh, `q` close.

- Footer indicator: `ctx 42% 84.2k/200.0k`. It updates after each turn.
- `/context prefix [text]` and `/context suffix [text]` set text joined to the start or end of the system prompt. Without text, an editor opens. An empty value disables the setting. The change applies from the next turn. The values are stored in `pi-context.json` in the pi agent directory.
- The `context_insight` tool gives the model a text report of its own context.

## Accuracy

- Totals (context size, tokens, cost) are the figures the provider reported.
- Category figures marked `≈` are estimates at 4 characters per token. Their sum differs from the provider total.
- Requests, events, file activity and commands come from the session branch, so they cover a resumed session.
- Composition snapshots (Browser) and timing exist only for requests made while the extension is loaded.
- File activity counts tool calls named `read` or `write`, or matching `edit|replace|insert|patch`, that have a `path` argument. Commands are `bash` tool calls and `!` commands. Calls nested in another tool's result are included.

## Development

```sh
bun test
```
