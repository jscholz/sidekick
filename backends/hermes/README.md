# Hermes backend

Sidekick + [hermes-agent](https://github.com/NousResearch/hermes-agent) —
the recommended path for full features (cross-platform drawer,
agent-declared model picker, openrouter-backed catalog).

## Layout

| Path | What |
|---|---|
| `plugin/__init__.py` | The hermes plugin. Exposes the agent contract (`/v1/responses`, `/v1/conversations*`, `/v1/events`) plus the optional `/v1/gateway/conversations` (cross-platform drawer) and `/v1/settings/*` (model picker) extensions. Loads into hermes-agent's process via the plugin loader. |
| `plugin/0001-add-sidekick-platform.patch` | One-time patch against hermes-core that registers `Platform.SIDEKICK`. Apply to your hermes install before first run. |
| `plugin/plugin.yaml` | Hermes plugin manifest. |
| `plugin/README.md` | Plugin-specific install + protocol notes. |
| `config.example.yaml` | Hermes-side config keys the plugin reads/writes — annotated subset of `~/.hermes/config.yaml`. |

## Install

```bash
# 1. Install hermes-agent itself per its docs:
#    https://github.com/NousResearch/hermes-agent

# 2. Apply the one-time hermes-core patch (registers Platform.SIDEKICK):
cd <your hermes-agent install>
patch -p1 < <sidekick-repo>/backends/hermes/plugin/0001-add-sidekick-platform.patch

# 3. Symlink the plugin into hermes's plugin search path:
ln -s "<sidekick-repo>/backends/hermes/plugin" ~/.hermes/plugins/sidekick

# 4. Set the shared bearer token on the hermes side:
echo "SIDEKICK_PLATFORM_TOKEN=$(openssl rand -hex 32)" >> ~/.hermes/.env

# 5. Restart hermes-gateway to load the plugin.
systemctl --user restart hermes-gateway
```

Then in sidekick's `.env`:
```
SIDEKICK_PLATFORM_URL=http://127.0.0.1:8645
SIDEKICK_PLATFORM_TOKEN=<same token from ~/.hermes/.env>
```

## What hermes contributes

- **Drawer / replay / delete** — backed by hermes's state.db. The
  plugin's `/v1/conversations*` handlers translate state.db rows
  into the agent contract's row shape.
- **Cross-platform drawer** (`/v1/gateway/conversations`) — telegram,
  whatsapp, slack sessions surface alongside sidekick in the drawer
  with per-row source badges. Sidekick's composer goes read-only on
  non-sidekick rows (since you'd be hijacking another platform's
  thread).
- **Model picker** (`/v1/settings/*`) — the `model` setting wraps
  `~/.hermes/config.yaml`'s `model:` field plus the openrouter
  catalog. Updates write back to config.yaml via
  `hermes_cli.model_switch.switch_model(is_global=True)`. New
  conversations pick up the new model immediately; existing cached
  agents keep their model until evicted.
- **Tool calls** — `tool_call` / `tool_result` envelopes flow
  through to the PWA's activity row renderer.

## Config keys hermes-side

See `config.example.yaml` in this directory. Sidekick reads:
- `model:` (scalar or `model.default:`) — current model id, also
  the value sidekick's settings panel displays.
- `model.provider:`, `model.base_url:` — passed into `switch_model`
  when the user picks a new model.
- `providers:`, `custom_providers:`, `fallback_providers:` —
  hermes's own provider config. Sidekick doesn't write these but
  the model picker honors them.

Sidekick writes (only via the model picker):
- `model.default:` (or `model:` scalar form, depending on the
  shape already present).
- `model.provider:`, `model.base_url:` if `switch_model` resolves
  a different provider for the chosen model.
