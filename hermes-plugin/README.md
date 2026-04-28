# Sidekick hermes plugin

Hermes platform adapter that turns sidekick (PWA + Node proxy) into a
peer of telegram/slack/signal — replacing the brittle `/v1/responses`
integration with a proper gateway-managed chat surface.

This directory contains the **plugin source**. It is NOT installed
automatically. Jonathan opts in manually when he is ready to test.

## Files

| File | Purpose |
|------|---------|
| `sidekick_platform.py` | The adapter (WS server + `BasePlatformAdapter` subclass). |
| `plugin.yaml` | Hermes plugin manifest. |
| `0001-add-sidekick-platform.patch` | Required hermes-agent patch (NOT applied). |
| `wscat-test.py` | Standalone smoke test that connects as a fake proxy. |

## Install (manual opt-in)

The hermes plugin loader expects a directory layout, not a flat file:

```bash
# 1. Apply the gateway patch (registers Platform.SIDEKICK and the
#    adapter factory branch). Maintain in your patch ledger.
cd ~/.hermes/hermes-agent
patch -p1 < ~/code/sidekick/hermes-plugin/0001-add-sidekick-platform.patch

# 2. Install the plugin into ~/.hermes/plugins/sidekick/.
mkdir -p ~/.hermes/plugins/sidekick
cp ~/code/sidekick/hermes-plugin/sidekick_platform.py \
   ~/.hermes/plugins/sidekick/__init__.py
cp ~/code/sidekick/hermes-plugin/plugin.yaml \
   ~/.hermes/plugins/sidekick/plugin.yaml

# 3. Enable the plugin (~/.hermes/config.yaml):
#    plugins:
#      enabled:
#        - sidekick
# Or:
hermes plugins enable sidekick

# 4. Set the auth token + (optionally) the port in ~/.hermes/.env:
echo 'SIDEKICK_PLATFORM_TOKEN=$(openssl rand -hex 32)' >> ~/.hermes/.env
# echo 'SIDEKICK_PLATFORM_PORT=8645' >> ~/.hermes/.env  # default

# 5. Restart the gateway.
systemctl --user restart hermes-gateway
journalctl --user -u hermes-gateway -f | grep sidekick
```

## Smoke test

With the plugin running, in another terminal:

```bash
cd ~/code/sidekick/hermes-plugin
SIDEKICK_PLATFORM_TOKEN=<the-token> python3 wscat-test.py \
    --chat-id test-conv-1 \
    --text "count to 5"
```

Expected output: a `hello` envelope, then streaming `reply_delta`
envelopes, then `reply_final`.

## Wire protocol

See the module docstring at the top of `sidekick_platform.py` for the
full envelope catalogue. Single persistent WS at `ws://127.0.0.1:8645/ws`
authenticated with a shared `Authorization: Bearer <token>` header on
the upgrade request.

## Phase 1 vs. Phase 2

This file lands the **adapter only**. The sidekick proxy (Phase 2) and
PWA backend (Phase 3) still need to be built before end users see any
behaviour change. See
`/home/jscholz/.claude/projects/-home-jscholz/memory/project_sidekick_platform_adapter_plan.md`
for the full plan.

## Known Phase-1 limitations

* `session_changed` envelope is documented but not yet emitted — needs a
  gateway-side compression hook (Phase 2).
* `reply_to` threading is ignored on outbound — sidekick has no thread
  primitive in the PWA today.
* Single proxy client per gateway. Reconnect drops the previous
  connection cleanly.
