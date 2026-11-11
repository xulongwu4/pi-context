# pi-context

Context insight for [pi](https://github.com/earendil-works/pi), modeled on [dsh-context](https://github.com/bowenliang123/dsh-context).

## Install

```sh
pi install /path/to/pi-context   # permanent
pi -e /path/to/pi-context/src/index.ts   # one run
```

## Features

- `/context` opens an overlay with twelve tabs.

  | Tab | Content |
  | --- | --- |
  | Stats | Context window use, human inputs, requests, tool calls, cost, token totals, prompt cache use, requests and cost per model, timing |
  | Current | Composition of the current context by category, and its items, largest first |
  | Hints | What could be dropped from the context, and the tokens that would free |
  | Trend | Tokens sent by each request, the share read from the prompt cache, and cache misses |
  | Browser | What one request was assembled from |
  | Events | Compactions, model switches, thinking level changes, branch summaries |
  | Files | Reads, writes and edits per file |
  | Commands | Shell commands, their result, and the programs they ran |
  | Tools | Calls, errors and estimated tokens per tool, and the skills that were loaded |
  | Fleet | The main agent and its subagents: status, time, model, requests, tokens, cost |
  | Insights | The last 7, 30 or 90 days, over all projects or the current one: totals, a 7-day chart, activity by weekday and hour, requests and cost per model, top tools, programs and skills, and the sessions |
  | Settings | The context warning and the system prompt prefix and suffix |

  Keys: `←`/`→` tab, `↑`/`↓` scroll or select, `[`/`]` previous or next request, `r` refresh, `q` close.

  | Tab | Keys |
  | --- | --- |
  | Trend | `enter` opens the selected request in Browser |
  | Current, Browser | `enter` shows the whole content of the selected item; `esc` goes back |
  | Insights | `p` changes the period, `a` switches between all projects and the current one, `s` changes the order of the sessions |
  | Settings | `enter` edits the selected setting, `x` clears it |

  While the agent or a subagent runs, the overlay refreshes every second and shows `● live`.

- Footer indicator: `ctx 42% 84.2k/200.0k`. It updates after each turn.
- Context warning: one notification each time context use rises to 80%. It names the largest category. `/context warn <percent>` changes the percentage, `/context warn 0` disables the warning, and `/context warn` shows the setting.
- `/context prefix [text]` and `/context suffix [text]` set text joined to the start or end of the system prompt. Without text, an editor opens. An empty value disables the setting. The change applies from the next turn.
- `/context export [file]` writes all tabs to a Markdown file. The default is `pi-context-<session id>.md` in the working directory.
- The `context_insight` tool gives the model a text report of its own context. Its optional `section` parameter returns one part in more detail: `composition`, `requests`, `tools`, `files`, `commands` or `hints`.

## Stored data

- Settings are in `pi-context.json` in the pi agent directory.
- At the end of each turn, the extension appends one `pi-context:turn` entry to the session. It holds the duration of the request, the tool time, the composition by category, the file of each anchor-based edit, and the tool declarations when they changed. Pi does not send these entries to the model.
- Insights caches one summary per session file in `pi-context-cache.json` in the pi agent directory. Only new or changed session files are read again. Summaries of files unchanged for 120 days are dropped.

## Accuracy

- Totals (context size, tokens, cost) are the figures the provider reported.
- Figures marked `≈` are sizes at 4 characters per token, scaled so that they add up to the provider-reported size of the context. The scale factor is shown below each composition. Without a provider-reported size, for example before the first request, the figures are not scaled.
- The scaling is needed because 4 characters per token is too high. In sessions measured on three model families, a token was 2.8 to 3.7 characters. A proxy or provider can also add content that pi does not see. One factor applies to all categories, so the shares are those of the character counts.
- When a proxy shortens the context after pi has built it, the factor is below 1 and all items shrink alike. The extension cannot tell which items the proxy shortened.
- A cache miss is a request that read less than half of the previous request from the prompt cache, with the same model and no compaction between them. The extra cost is an estimate: the tokens billed again, at the rate the request paid for input and cache writes, less the cache read rate.
- Hints lists reads that a later read with the same arguments supersedes, skills loaded more than once, and the ten largest tool results of at least 1000 estimated tokens from before the last user message. It considers direct tool calls only: the result of a read made inside a script is part of the script's result. The list is advice. The extension does not remove anything from the context.
- Tool schemas are the declarations in the provider request, because a request can leave out declarations of active tools, as codemode does in `only` mode. The extension reads them from each request and records them in the session. Before it has seen a request in a session, it takes the active tools from the session and leaves out the ones pi reports as hidden.
- Requests, events, file activity, commands and tool counts come from the session branch, so they cover a resumed session.
- Timing and the recorded composition cover the turns that ran while the extension was loaded. For other requests, Browser rebuilds the composition from the session and says so. A rebuilt composition does not show changes that other extensions made to the context before the request was sent.
- File activity counts tool calls named `read` or `write`, or matching `edit|replace|insert|patch`. Edit tools that address lines by anchor name the file only in their result, so their file is known only for turns that ran while the extension was loaded. The Files tab says how many such edits it cannot list.
- The Tools tab marks a tool with `!` when the model called it directly although it is not declared to the model. This happens in codemode `only` mode: a hidden tool stays active, so a direct call by name still runs. Each call is judged by the declarations the extension recorded for the request that made it. Calls made before the first record are judged by the tools declared now.
- Calls nested in another tool's result, for example from a script, are counted. Their tokens belong to the tool that made them. The size of a skill loaded by a nested call is the current size of its file.
- Fleet needs [pi-subagents](https://github.com/tintinweb/pi-subagents). Finished subagents come from the records it saves in the session. Model, requests, tokens and cost come from its live events, or from the subagent's saved session when there is one.
- The Insights project filter counts sessions that ran in the working directory or below it. The per-session figures in its session list cover the whole session, also the part before the period.
- Insights counts each session's own requests. A subagent's work is included when its session was saved.

## Development

```sh
bun test
```