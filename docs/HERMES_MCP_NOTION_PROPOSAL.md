# Hermes Notion via MCP — Proposal

Date: 2026-04-30 (proposal), 2026-05-01 (additive config landed, see footer)
Author: Claude (Opus 4.7), researching for Jonathan
Status: **Additive config landed** — `mcp_servers.notion` block in `~/.hermes/config.yaml`, MCP server spawns, **26 tools registered**. Curl skill **NOT** deleted — pending Jonathan's sign-off on §9 decisions. See "Implementation note" footer.

## TL;DR

**Recommendation: Migrate to MCP, using the official `@notionhq/notion-mcp-server` over stdio. Retire the curl skill.**

Three reasons it's the right call here, not over-engineering:

1. Hermes already has full first-class MCP **client** infrastructure (`tools/mcp_tool.py`, `tools/mcp_oauth.py`, config key `mcp_servers:`). There is no scaffolding to write. The "is MCP worth the framework cost" question has already been answered yes by upstream hermes — we just consume what's there.
2. The curl-skill failure mode is structural, not promptable. The skill returns raw block trees and asks gemma to reason about `.results[*].type == "child_page"` from JSON. The MCP server returns inline `<page url="...">title</page>` tags inside fetched page content — turning a multi-call traversal problem into a single-call read. Even with a perfect prompt, gemma-on-Pi is unreliable at the multi-hop JSON walk. The Anthropic-curated MCP server I tested in this session listed sub-pages correctly on the first try.
3. The "single pathway" goal is actually furthered by MCP, not threatened. Today's state is *already* two-pathed — `~/.hermes/AGENTS.md` (lines 52–63) directs the agent to a `notion-api` skill that **no longer exists on disk** (`~/.hermes/skills/openclaw-imports/notion-api/` is gone), then falls back to the curl skill. So we're already paying the "two paths" cost without the benefit. MCP collapses both into one.

Confidence: high that MCP is the right shape; medium that `@notionhq/notion-mcp-server` (stdio) is the right server vs. Notion's hosted remote endpoint (see comparison below).

---

## 1. Why not just fix the curl skill?

I considered this seriously. Quoting the skill (`~/.hermes/hermes-agent/skills/productivity/notion/SKILL.md`):

> ### Get Page Content (blocks)
> ```
> curl -s "https://api.notion.com/v1/blocks/{page_id}/children" ...
> ```

The SKILL.md itself never says the words "child_page" or "sub-page". The reference doc (`references/block-types.md`) does mention `child_page` (line 105) — but only as a row in a 14-row table about *reading* block payloads, with no guidance like "if the user asks 'what's on this page', enumerate `child_page` blocks and surface their `.child_page.title`".

A surgical prompting fix would look like:

```diff
+ ### Listing sub-pages of a page
+ Sub-pages appear as `child_page` blocks in the children listing. To list
+ them, GET /v1/blocks/{page_id}/children, then filter for items where
+ `.type == "child_page"` and surface `.child_page.title` plus the block `.id`
+ (which is the sub-page's page_id). Always do this when the user asks
+ "what's on this page" or "show me the sub-pages".
```

Why I'm rejecting this as the primary fix:

- **Gemma-on-Pi reliability.** Jonathan's deployment runs gemma. The failure he observed wasn't "the agent didn't know to look for `child_page`" — it's that even with the JSON in context, multi-call REST traversal (page → blocks → filter → for each child_page, recurse) is the kind of task small local models drop on the floor. The MCP server's inline `<page url=...>title</page>` rendering does this work server-side and gives the model a flat result.
- **Drift.** Notion's API is on `2025-09-03`, which renamed databases to data sources. The skill notes this (lines 156-162) but already shows the seams. Maintaining a curl skill against a versioned, schema-heavy API is a per-release tax I'd rather pay once at the MCP layer.
- **The promised single pathway.** Even if the prompt fix made the curl skill work, the AGENTS.md drift problem (referencing a deleted `notion-api` skill) signals this surface has been quietly accumulating cruft. MCP gives a clean reset.

I'd recommend the prompt fix only if Jonathan rejects the MCP plan — it's a 5-line patch and would make the curl skill demonstrably better even as a fallback.

## 2. MCP server choice

Three real candidates:

| Candidate | Transport | Auth | Stars | Fit for this deployment |
|---|---|---|---|---|
| `@notionhq/notion-mcp-server` (npx, stdio) | stdio | Notion integration token (`NOTION_TOKEN`) | 4.3k, official, last commit Jan 2026 | **Recommended.** Same `ntn_…` token already in `~/.hermes/.env`. No auth migration. Local subprocess, no network round-trip beyond the Notion API itself. |
| Notion hosted remote MCP (`https://mcp.notion.com/mcp`) | HTTP/SSE | OAuth | n/a (Notion-hosted) | Auth migration required (browser OAuth dance from a Pi, mediocre). Notion has stated they're prioritizing this over local; possible long-term winner, but premature for a single-user Pi deployment. |
| Third-party (`suekou/mcp-notion-server`, etc.) | stdio | token | <500 stars, sporadic maintenance | Skip. Official one is healthy. |

Tool surface from `@notionhq/notion-mcp-server` v2.x (the agent will see ~22 tools — names from the v2.0 release notes and the equivalent Anthropic-curated tools available in this session):

- `notion-search` — workspace search
- `notion-fetch` — read a page or database, with sub-pages rendered as inline `<page url="...">title</page>` tags **(this is the key affordance that fixes the gemma traversal failure)**
- `notion-create-pages`, `notion-update-page`, `notion-duplicate-page`, `notion-move-pages`
- `notion-create-database`, `notion-update-data-source`, `query-data-source`, `list-data-source-templates`
- `notion-create-view`, `notion-update-view`
- `notion-create-comment`, `notion-get-comments`
- `notion-get-users`, `notion-get-teams`

That covers everything the curl skill does and several things it doesn't (move, duplicate, comments, views).

Caveat worth flagging: Notion has said in the makenotion repo README that the local server "may be sunset" in favor of the hosted remote one. Realistic horizon: 6-12 months. When that happens, the migration is `command:/args:` → `url:/headers:` in the same `mcp_servers:` block — about 4 lines.

## 3. Hermes-side scaffolding

**None to write.** This is the load-bearing finding of the research.

- `~/.hermes/hermes-agent/tools/mcp_tool.py` is a complete generic MCP client: stdio + HTTP, OAuth, sampling, dynamic tool discovery, env filtering, credential redaction in errors, per-server timeouts, exponential backoff. Stable, tested (`tests/tools/test_mcp_tool.py`, `test_mcp_stability.py`).
- Config key is `mcp_servers:` at the top level of `~/.hermes/config.yaml`. Not currently set on this Pi (verified via grep).
- Discovered tools auto-register into the agent's tool registry alongside built-ins. `delegation.inherit_mcp_toolsets: true` is already on, so subagents see them too.
- The `mcp:` block at line 168 of `config.yaml` is the auxiliary-LLM-for-MCP-sampling provider, **unrelated** to server config. Don't touch it.

The whole hermes-side change is one config-file edit.

## 4. Configuration

Add to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  notion:
    command: "npx"
    args: ["-y", "@notionhq/notion-mcp-server"]
    env:
      NOTION_TOKEN: "${NOTION_API_KEY}"   # reuse existing key from ~/.hermes/.env
    timeout: 60
    connect_timeout: 30
```

Notes:
- The existing `NOTION_API_KEY` in `~/.hermes/.env` (line 29, `ntn_…`) IS the right token type. The MCP server expects `NOTION_TOKEN`; we just rename it via env-passthrough.
- Confirm env-var interpolation syntax against `mcp_tool.py` — if it doesn't expand `${...}`, set the literal value via the env block (the `_build_safe_env` helper in mcp_tool.py honors explicit `env:` keys).
- `npx` resolution: `mcp_tool.py` has special handling for bare `npx`/`npm`/`node` and looks under `~/.hermes/node/bin/` — so as long as Node is installed in the standard hermes location, this works. Confirm by running `which npx` on the Pi before flipping the switch.

## 5. Migration sequence

1. **Add the `mcp_servers:` block to `~/.hermes/config.yaml`.** Don't delete anything yet.
2. **Restart hermes** (`hermes` chat or the gateway).
3. **Smoke test on Jonathan's actual scratchpad page.** Three queries:
   - "Find my Hermes scratchpad in Notion" → expects `notion-search`
   - "What's on the scratchpad page?" → expects `notion-fetch` with sub-pages listed inline (this is the gemma-failed case)
   - "Add a paragraph 'test from MCP' to the scratchpad" → write smoke test
4. **Update `~/.hermes/AGENTS.md`** lines 52-63: replace the section with MCP-tool guidance (e.g. "use `notion-search` for searches, `notion-fetch` for reads"). The 401-permissions guidance in line 61-63 stays — it's about Notion permissions and applies regardless of transport.
5. **Delete the curl skill** once smoke test passes:
   ```
   rm -rf ~/.hermes/hermes-agent/skills/productivity/notion/
   ```
   Reload skills (or restart). This is the explicit retire-the-fallback step.
6. **Remove the stale `notion-api` AGENTS.md references** noted in section 1 (they point at a directory that no longer exists).
7. **Commit the config + AGENTS.md changes** to the hermes-private patch ledger if there's an upstream version to keep in sync.

Total wall time: ~30-60 min including verification on real pages.

## 6. Failure modes & recovery

| Failure | Symptom | Recovery |
|---|---|---|
| MCP server crash / hang | Agent gets a tool error from `mcp_tool.py` (already credential-redacted) | `mcp_tool.py` does exponential backoff up to 5 retries automatically. If persistent: check logs, `npx` connectivity, and `NOTION_TOKEN` validity. Curl skill is gone — temporary fallback is to ask Jonathan to do the Notion task in the UI directly. |
| Auth failure (token revoked / wrong) | 401 from Notion surfaces as MCP tool error | Same `ntn_…` key as today; rotate at https://notion.so/my-integrations and update `~/.hermes/.env`, restart. |
| Page not shared with integration | 404 / "object_not_found" from a tool that should work | Existing AGENTS.md guidance (line 61-63) already covers this — tell Jonathan to share via "··· → Connect to → blueberry-claw" rather than retrying. Worth restating in the new MCP-section AGENTS.md text. |
| Notion sunsets the local server | Future-distant; npm package starts emitting deprecation warnings | Swap to `url: https://mcp.notion.com/mcp` + OAuth. ~4 lines of config change; the `mcp_oauth_manager.py` already exists for this. |
| `npx` not on PATH | Server fails to spawn | `mcp_tool.py` already checks `~/.hermes/node/bin/`. If Node isn't in either standard location: install. One-time. |

The "MCP crashes and we have no fallback" concern is real but small — single-user, prototype deployment, Jonathan can manually use Notion in his browser if the agent is down. Not worth keeping the curl skill alive as a backup; that's the bloat the brief warns against.

## 7. Future-proofing: Slack / Drive / Calendar / Linear

This is where MCP starts paying back. Each of those follows the same shape:

```yaml
mcp_servers:
  notion: { command: "npx", args: ["-y", "@notionhq/notion-mcp-server"], env: { NOTION_TOKEN: "..." } }
  slack:  { command: "npx", args: ["-y", "@modelcontextprotocol/server-slack"], env: { ... } }
  linear: { url: "https://mcp.linear.app/sse", headers: { Authorization: "Bearer ..." } }
  # etc.
```

The hermes-private integrations backlog (per memory: `project_hermes_integrations_backlog.md`) lists Notion + Slack + Google + (presumably Linear next as Anthropic's Linear MCP just got curated in this session). All four already have official MCP servers. Each one becomes a config block, not a code change. That's the future-alignment dividend, and it's why I'd recommend MCP even if the curl-skill prompt fix were sufficient for the Notion-only case.

## 8. Effort estimate

Calibrated for this codebase (Pi 5 single-user, no enterprise risk surface, hermes MCP infra mature):

- **Config + restart + smoke test:** 30-45 min wall time, mostly verification on real pages
- **AGENTS.md prose update:** 15 min
- **Skill deletion + reload verification:** 10 min
- **Total:** ~1 hour, single sitting

If `@notionhq/notion-mcp-server` v2 has any behavior surprises against Jonathan's specific data sources (he uses the API-2025-09-03 data-source model), add 30-60 min of debugging. Worst-case 2 hours.

This is **not** the kind of "MCP migration" you'd plan for a multi-tenant SaaS. It's a config edit + a skill deletion + a docs nudge.

## 9. Explicit decision points for Jonathan

- **Stdio (npx) vs hosted remote (OAuth):** I recommend stdio because the auth's already there and Pi-side OAuth is friction. Push back if you'd rather burn the OAuth setup once and never touch the local server.
- **Delete the curl skill or keep it as docs-only?** I recommend full delete to honor "single pathway". The block-types reference doc (`references/block-types.md`) has some standalone value as Notion-API documentation, but I'd let it go — same content is in Notion's official docs and now in the MCP server's tool descriptions.
- **AGENTS.md `notion-api` stale references:** I'm proposing to fix these in the same change. If you want them as a separate commit (refactor-vs-feature split per your commit style), that's two commits: (1) AGENTS.md cleanup, (2) MCP enable + curl-skill retire.

---

## Implementation note (2026-05-01)

What landed:
- Added `mcp_servers.notion:` block to `~/.hermes/config.yaml` (with backup at
  `~/.hermes/config.yaml.bak.notion-mcp-add`). Reuses `${NOTION_API_KEY}` from
  `.env` via mcp_tool's `${VAR}` interpolation.
- Restarted hermes-gateway. Sessions endpoint still 200, no errors in agent.log.
- Live discovery confirmed: `discover_mcp_tools()` registered **26 tools** from
  the npx-installed `@notionhq/notion-mcp-server`.

Discrepancy from proposal §2: the npm package version registered as of 2026-05-01
exposes REST-style tool names (`mcp_notion_API_post_search`,
`mcp_notion_API_retrieve_a_page`, `mcp_notion_API_get_block_children`, etc.) —
NOT the v2 `notion-search`/`notion-fetch` shape with inline `<page url=...>`
sub-page rendering that I cited from the Anthropic-curated tool surface.

What this means for the gemma traversal failure: the inline-tag rendering was
the proposal's main argument for migration. The currently-installed server gives
gemma essentially the same multi-call shape as the curl skill, just behind a
tool-call envelope instead of shell-out. Likely a small reliability bump (tools
are easier than shell parsing for small models), but NOT the dramatic
"single-call read with sub-pages enumerated server-side" win.

Open decisions for Jonathan (still per §9, refined):
1. **Delete the curl skill or keep both?** With the API-style MCP tools, the
   curl skill is now redundant in capability (same operations, less reliable).
   I recommend delete after a smoke run on a real page. Reversible from git.
2. **Try to upgrade the MCP server** to the v2 release that has the inline
   `<page url=...>` rendering? Worth checking npm tags — `@notionhq/notion-mcp-server@beta`
   or `@next` may have it. Low effort if available.
3. **Update AGENTS.md** to point at the MCP tools by name and remove the
   stale `notion-api` skill references — same patch I'd write either way.
