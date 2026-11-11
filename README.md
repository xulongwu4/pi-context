# pi-context

Context insight for [pi](https://github.com/earendil-works/pi), modeled on [dsh-context](https://github.com/bowenliang123/dsh-context).

## Install

```sh
pi install /path/to/pi-context   # permanent
pi -e /path/to/pi-context/src/index.ts   # one run
```

## Features

- `/context` opens an overlay with ten tabs.

  | Tab | Content |
  | --- | --- |
  | Stats | Context window use, human inputs, requests, tool calls, cost, token totals, timing |
  | Current | Composition of the current context by category, and the largest items |
  | Trend | Tokens sent by each request |
  | Browser | What one request was assembled from |
  | Events | Compactions, model switches, thinking level changes, branch summaries |
  | Files | Reads, writes and edits per file |
  | Commands | Shell commands, their result, and the programs they ran |
  | Tools | Calls, errors and estimated tokens per tool, and the skills that were loaded |
  | Fleet | The main agent and its subagents: status, time, model, requests, tokens, cost |
  | Insights | The last 30 days over all projects: totals, a 7-day chart, activity by weekday and hour, top tools, programs and skills, and the sessions |

  Keys: `←`/`→` tab, `↑`/`↓` scroll or select, `enter` open the selected request in Browser, `[`/`]` previous or next request, `r` refresh, `q` close.

- Footer indicator: `ctx 42% 84.2k/200.0k`. It updates after each turn.
- Context warning: one notification each time context use rises to 80%. It names the largest category. `/context warn <percent>` changes the percentage, `/context warn 0` disables the warning, and `/context warn` shows the setting.
- `/context prefix [text]` and `/context suffix [text]` set text joined to the start or end of the system prompt. Without text, an editor opens. An empty value disables the setting. The change applies from the next turn.
- `/context export [file]` writes all tabs to a Markdown file. The default is `pi-context-<session id>.md` in the working directory.
- The `context_insight` tool gives the model a text report of its own context.

## Stored data

- Settings are in `pi-context.json` in the pi agent directory.
- At the end of each turn, the extension appends one `pi-context:turn` entry to the session. It holds the duration of the request, the tool time, the composition by category, the file of each anchor-based edit, and the tool declarations when they changed. Pi does not send these entries to the model.
- Insights caches one summary per session file in `pi-context-cache.json` in the pi agent directory. Only new or changed session files are read again.

## Accuracy

- Totals (context size, tokens, cost) are the figures the provider reported.
- Figures marked `≈` are estimates at 4 characters per token. Their sum differs from the provider total.
- Tool schemas are the declarations in the provider request, because a request can leave out declarations of active tools, as codemode does in `only` mode. The extension reads them from each request and records them in the session. Before it has seen a request in a session, it takes the active tools from the session and leaves out the ones pi reports as hidden.
- Requests, events, file activity, commands and tool counts come from the session branch, so they cover a resumed session.
- Timing and the recorded composition cover the turns that ran while the extension was loaded. For other requests, Browser rebuilds the composition from the session and says so. A rebuilt composition does not show changes that other extensions made to the context before the request was sent.
- File activity counts tool calls named `read` or `write`, or matching `edit|replace|insert|patch`. Edit tools that address lines by anchor name the file only in their result, so their file is known only for turns that ran while the extension was loaded. The Files tab says how many such edits it cannot list.
- The Tools tab marks a tool with `!` when the model called it directly although it is not declared to the model. This happens in codemode `only` mode: a hidden tool stays active, so a direct call by name still runs. The check uses the tools declared now, not those declared when the call was made.
- Calls nested in another tool's result, for example from a script, are counted. Their tokens belong to the tool that made them. The size of a skill loaded by a nested call is the current size of its file.
- Fleet needs [pi-subagents](https://github.com/tintinweb/pi-subagents). Finished subagents come from the records it saves in the session. Model, requests, tokens and cost come from its live events, or from the subagent's saved session when there is one.
- Insights counts each session's own requests. A subagent's work is included when its session was saved.

## Development

```sh
bun test
```