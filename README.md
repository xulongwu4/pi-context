# pi-context

Context insight for [pi](https://github.com/earendil-works/pi), modeled on [dsh-context](https://github.com/bowenliang123/dsh-context).

## Install

```sh
pi install /path/to/pi-context   # permanent
pi -e /path/to/pi-context/src/index.ts   # one run
```

## Features

- `/context` opens an overlay with thirteen tabs.

  | Tab | Content |
  | --- | --- |
  | Stats | Context window use, human inputs, requests, tool calls, cost, token totals, the tokens sent over the session by category, prompt cache use, requests and cost per model, timing |
  | Current | Composition of the current context by category, a strip of its items in reading order, and the items, largest first or in reading order |
  | Hints | What could be dropped from the context, the tokens that would free, and what was dropped |
  | Turns | One row per human input: its requests, tool calls, tokens, cost and duration |
  | Trend | Tokens sent by each request, the share read from the prompt cache, and cache misses |
  | Browser | What one request was assembled from, in reading order, and what changed since the request before it: items added, changed and removed, and the items and tokens each category gained or lost |
  | Events | Compactions, dropped and restored tool results, model switches, thinking level changes and branch summaries: the number of events of each kind, the request each event followed, and the tokens it added to the context or took from it |
  | Files | Reads, writes and edits per file |
  | Commands | Shell commands, their result, and the programs they ran |
  | Tools | Calls, errors and estimated tokens per tool, and the skills that were loaded |
  | Fleet | The main agent and its subagents: status, time, model, requests, tokens, cost |
  | Insights | The last 7, 30 or 90 days or all time, over all projects or the current one, or one day of that period: totals, a calendar of the tokens by day, a 7-day chart, activity by weekday and hour, the tokens sent by category, requests and cost per model, cost per project, top tools, programs and skills, and the sessions |
  | Settings | The context warning, auto-compact, the cost budget, the cache expiry warning, the footer, and the system prompt prefix and suffix |

  Keys: `←`/`→` tab, `↑`/`↓` scroll or select, `[`/`]` previous or next request, `r` refresh, `q` close.

  | Tab | Keys |
  | --- | --- |
  | Turns | `enter` opens the first request of the selected input in Browser |
  | Trend | `enter` opens the selected request in Browser |
  | Current, Browser | `enter` shows the whole content of the selected item; `esc` goes back |
  | Current | `o` switches the list between largest first and reading order |
  | Current, Hints | `d` drops the selected tool result from the context, `u` restores it |
  | Current, Browser, Files, Commands, Tools, Insights | `/` starts a filter: type text, `enter` keeps it, `esc` clears it. Only lines that contain the text stay |
  | Events | `k` lists one kind of event, then the next kind, then all again |
  | Insights | `p` changes the period, `[`/`]` narrow the tab to one day, `a` switches between all projects and the current one, `s` changes the order of the sessions, `enter` opens the selected session |
  | Fleet | `enter` opens the session of the selected subagent |
  | Settings | `enter` edits the selected setting, `x` clears it |

  While the agent or a subagent runs, the overlay refreshes every second and shows `● live`.

  A session opened from Insights or Fleet is read-only and shows the branch that ends at the last entry of its file. `esc` returns to the current session.

  In Insights and Fleet, `↑`/`↓` scroll the tab until the selected entry is in view, and then move the selection.

  In Insights, the first `[` selects today. Then `[` and `]` select the day before or after, and `]` on today shows the whole period again. The calendar marks the selected day with `[]`.

  In Current and Browser, the strip shows the prompt from its first token to its last, colored by category, and `▲` marks the selected item. Each item shows `#`, its position in the prompt, and `@`, the first request that carried it.

- Dropping tool results: `d` in Current or Hints replaces a tool result with a one-line stub in every later request. The session file keeps the original, and `u` restores it. The request after a change reads less from the prompt cache, because the context differs from the dropped result on.
- Footer indicator: `ctx 42% 84.2k/200.0k`. It updates after each turn. `/context footer <items>` chooses what it shows, from `context`, `cost` (session cost), `cache` (share of the sent tokens read from the prompt cache) and `ttl` (estimated time until the prompt cache expires). Example: `/context footer context cost ttl`.
- Cost budget: `/context budget <dollars>` gives one warning when the cost of the session reaches the amount, and adds the cost to the footer. `/context budget 0` removes it.
- Cache expiry warning: `/context expiry <seconds>` gives one warning that many seconds before the prompt cache expires, when the agent is idle at that time. A request sent after the expiry sends the whole context without the cache. `/context expiry 0` turns the warning off, which is the default.
- Auto-compact: `/context compact <percent>` starts pi's compaction when the agent stops and context use is at that percentage or above. `/context compact 0` turns it off. It is off by default.
- Context warning: one notification each time context use rises to 80%. It names the largest category. `/context warn <percent>` changes the percentage, `/context warn 0` disables the warning, and `/context warn` shows the setting.
- `/context prefix [text]` and `/context suffix [text]` set text joined to the start or end of the system prompt. Without text, an editor opens. An empty value disables the setting. The change applies from the next turn.
- `/context export [file]` writes all tabs to a Markdown file. The default is `pi-context-<session id>.md` in the working directory. A file name that ends in `.json` gets the same data as JSON.
- The `context_insight` tool gives the model a text report of its own context. Its optional `section` parameter returns one part in more detail: `composition`, `requests`, `tools`, `files`, `commands` or `hints`.

## Web page

`/context web` serves the dashboard as a web page and opens it in the browser. It also shows the address, for example `http://127.0.0.1:38811/?t=9ac7…`.

- The Context page shows the current session in cards: Context Stats, Token Stats, Timing Stats, Current Context, Context Browser, Context Trend, Hints, Turns, Context Events, File Activity, Command Executions, and Tools, Skills and Models.
- In Context Trend, each bar is one request, split by category. Click a bar to open the request in the Context Browser. `✂` marks the first request after a compaction, `!` a cache miss.
- In the Context Browser, click a category to list its items and an item to show its whole content. The select and the `‹` `›` buttons change the request. A request shows what was added (`+`) or changed (`~`) since the request before it, and the items and tokens each category gained or lost.
- The strip in the Context Browser has one band per item, in reading order. Click a band to show its item. `One list, in reading order` lists the items of all categories together. Each item shows `#`, its position in the prompt, and `@`, the first request that carried it.
- `Drop` and `Restore` on a tool result, in the Context Browser or in Hints, do what `d` and `u` do in the overlay.
- In Context Events, the buttons list one kind of event or all. The number in the After column opens that request in the Context Browser.
- The Settings card changes the context warning, auto-compact, the cost budget, the cache expiry warning, the footer, and the system prompt prefix and suffix. An empty number restores the default.
- The Insights page shows the last 7, 30 or 90 days or all time, over all projects or the current one. `Today` or a click on a day in the calendar narrows the page to that day; a second click shows the whole period again. Click a session to open its Context page. A saved session is read-only.
- The page loads the data again after each request and each turn of the current session, at most every 2 seconds.

The server listens on `127.0.0.1` only, on a free port. Every request for data must carry the token of the address, so keep the address to yourself: it gives read access to the content of the session and of the sessions that Insights lists, and it can drop tool results and change the settings. To use the page from another machine, forward the port, for example with `ssh -L`.

The server stops when the session ends, also on `/new`, `/resume` and `/reload`. `/context web stop` stops it earlier. Each pi session has its own server and address.

The page needs no build step: `web/` holds one HTML file, one style sheet and one script.

## Stored data

- Settings are in `pi-context.json` in the pi agent directory.
- At the end of each turn, the extension appends one `pi-context:turn` entry to the session. It holds the duration of the request, the tool time, the composition by category, the file of each anchor-based edit, and the tool declarations when they changed. Pi does not send these entries to the model.
- Each time a tool result is dropped or restored, the extension appends one `pi-context:prune` entry with the ids of the dropped tool calls. The last entry on the branch applies, so the dropped results follow the branch and survive a resume.
- Insights caches one summary per session file in `pi-context-cache.json` in the pi agent directory. Only new or changed session files are read again. Summaries of files unchanged for 120 days are dropped, so the period `All` reads those files again.

## Accuracy

- Totals (context size, tokens, cost) are the figures the provider reported.
- Figures marked `≈` are sizes at 4 characters per token, scaled so that they add up to the provider-reported size of the context. The scale factor is shown below each composition. Without a provider-reported size, for example before the first request, the figures are not scaled.
- The scaling is needed because 4 characters per token is too high. In sessions measured on three model families, a token was 2.8 to 3.7 characters. A proxy or provider can also add content that pi does not see. One factor applies to all categories, so the shares are those of the character counts.
- When a proxy shortens the context after pi has built it, the factor is below 1 and all items shrink alike. The extension cannot tell which items the proxy shortened.
- A cache miss is a request that read less than half of the previous request from the prompt cache, with the same model and no compaction between them. The extra cost is an estimate: the tokens billed again, at the rate the request paid for input and cache writes, less the cache read rate.
- Hints lists reads that a later read with the same arguments supersedes, skills loaded more than once, and the ten largest tool results of at least 1000 estimated tokens from before the last user message. For reads made inside a script, Hints only names the files read more than once, with the size of the file times the earlier reads as an upper bound; these are not in the total, and they cannot be dropped alone because they are part of the script's result. The list is advice. The extension removes nothing unless you drop it.
- Skill injections are the list of available skills in the system prompt, the skill files that `/skill:name` inputs load, and the results of reading a `SKILL.md` file. The System prompt figure leaves the list out. A `/skill:name` input counts as a load of the skill in Tools and Insights. Requests that an earlier version recorded count the list as System prompt.
- Tool schemas are the declarations in the provider request, because a request can leave out declarations of active tools, as codemode does in `only` mode. The extension reads them from each request and records them in the session. Before it has seen a request in a session, it takes the active tools from the session and leaves out the ones pi reports as hidden.
- A dropped tool result stays dropped only while the extension is loaded: the extension replaces it in each request. Compaction summarizes the original, not the stub. Browser rebuilds an earlier request without the drops of that time.
- "Sent over the session, by category" in Stats covers the requests that have a turn record. It scales the recorded composition of each request to the size the provider reported for it.
- In Turns, the duration is the time from the input to the last message it caused. It includes time spent waiting for the user inside a tool.
- The Browser comparison matches items by content. The system prompt, the tool schemas and a tool result keep their identity, so they show as changed (`~`) and not as removed and added.
- The time until the prompt cache expires is an estimate: 5 minutes after the last request, or 1 hour when a request of the session wrote to the 1-hour cache. It is shown only for models that have used the cache in the session. The cache expiry warning uses the same estimate, and it does not appear while the agent runs or when pi has no UI.
- The change that Events shows for a compaction is the size of the request after it minus the size before the compaction, so it includes what was added in between. A compaction without a later request shows no change. The change of a drop or a restore is the estimated size of the tool results at 4 characters per token; the stub that replaces a dropped result is not counted.
- Auto-compact acts when the agent stops, not between the requests of one run. Pi refuses to compact a session that is too small.
- In the web page, a grey bar in Context Trend is a request without a turn record: its split by category is not known. The Context Browser rebuilds such a request from the session when you open it.
- Requests, events, file activity, commands and tool counts come from the session branch, so they cover a resumed session.
- Timing and the recorded composition cover the turns that ran while the extension was loaded. For other requests, Browser rebuilds the composition from the session and says so. A rebuilt composition does not show changes that other extensions made to the context before the request was sent.
- The first request that carried an item is the first request made after the message of the item was created. The system prompt and the tool schemas have no such time and show none. An item that no request has carried yet shows none either. In the overlay, the strip does not show an item smaller than one cell.
- File activity counts tool calls named `read` or `write`, or matching `edit|replace|insert|patch`. Edit tools that address lines by anchor name the file only in their result, so their file is known only for turns that ran while the extension was loaded. The Files tab says how many such edits it cannot list.
- The Tools tab marks a tool with `!` when the model called it directly although it is not declared to the model. This happens in codemode `only` mode: a hidden tool stays active, so a direct call by name still runs. Each call is judged by the declarations the extension recorded for the request that made it. Calls made before the first record are judged by the tools declared now.
- Calls nested in another tool's result, for example from a script, are counted. Their tokens belong to the tool that made them. The size of a skill loaded by a nested call is the current size of its file.
- Fleet needs [pi-subagents](https://github.com/tintinweb/pi-subagents). Finished subagents come from the records it saves in the session. Model, requests, tokens and cost come from its live events, or from the subagent's saved session when there is one.
- The Insights project filter counts sessions that ran in the working directory or below it. The per-session figures in its session list cover the whole session, also the part before the period.
- With one day selected in Insights, the totals, the hours, the categories, the models, the projects and the top lists cover that day. The calendar and the 7-day chart still cover the period. The top tools, programs and skills count the whole of each session that has a request on the day or in the period.
- The Insights calendar shows the last 53 weeks at most. The totals of `All` also count what is older. A day is a day in the local time zone.
- The Insights tokens by category cover the requests that pi-context recorded, like the same figure in Stats.
- Insights counts each session's own requests. A subagent's work is included when its session was saved.

## Development

```sh
bun test
```