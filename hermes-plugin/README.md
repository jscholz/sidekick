# Sidekick hermes plugin

Hermes platform adapter that turns sidekick (PWA + Node proxy) into a
peer of telegram / slack / signal — a gateway-managed chat surface where
hermes owns the `chat_id → session_id` mapping natively.

This directory contains the **plugin source**. Installing it is opt-in.

## Files

| File | Purpose |
|------|---------|
| `sidekick_platform.py` | The adapter — `BasePlatformAdapter` subclass + WebSocket server. |
| `plugin.yaml` | Hermes plugin manifest. |
| `0001-add-sidekick-platform.patch` | Required `hermes-agent` patch (see below). |
| `wscat-test.py` | Standalone smoke test that connects as a fake proxy. |

## Install

Hermes' plugin loader doesn't currently support registering a new
platform adapter via `PluginContext` (the API exposes hooks, tools, slash
commands, etc — not platform registration). Until upstream issue
[hermes-agent#3823](https://github.com/.../issues/3823) lands, the
adapter must be registered by patching the gateway directly. The plugin
files still load through the normal plugin loader; only the
`Platform.SIDEKICK` enum + `_create_adapter` factory branch live in the
patch.

```bash
# 1. Patch hermes-agent.
cd <your hermes-agent install>
patch -p1 < <path-to-this-dir>/0001-add-sidekick-platform.patch

# 2. Install the plugin.
mkdir -p ~/.hermes/plugins/sidekick
cp <path-to-this-dir>/sidekick_platform.py ~/.hermes/plugins/sidekick/__init__.py
cp <path-to-this-dir>/plugin.yaml          ~/.hermes/plugins/sidekick/plugin.yaml

# 3. Enable in ~/.hermes/config.yaml:
#    plugins:
#      enabled:
#        - sidekick

# 4. Auth token + (optional) port in ~/.hermes/.env:
echo "SIDEKICK_PLATFORM_TOKEN=$(openssl rand -hex 32)" >> ~/.hermes/.env
# echo 'SIDEKICK_PLATFORM_PORT=8645' >> ~/.hermes/.env  # default

# 5. Restart the gateway.
```

The same `SIDEKICK_PLATFORM_TOKEN` value goes into the sidekick proxy
config so the proxy's WebSocket client can authenticate.

## Smoke test

With the plugin running, in another terminal:

```bash
SIDEKICK_PLATFORM_TOKEN=<the-token> python3 wscat-test.py \
    --chat-id test-conv-1 \
    --text "count to 5"
```

Expected: a `hello` envelope, then streaming `reply_delta` envelopes,
then `reply_final`.

## Wire protocol

See the module docstring at the top of `sidekick_platform.py` for the
envelope catalogue. Single persistent WS at
`ws://127.0.0.1:8645/ws` authenticated via
`Authorization: Bearer <token>` on the upgrade request.

## Known limitations

* `session_changed` envelope is documented but not yet emitted — needs a
  gateway-side compression hook.
* `reply_to` threading is ignored on outbound — sidekick has no thread
  primitive in the PWA today.
* Single proxy client per gateway. A second connection cleanly drops
  the previous one.
