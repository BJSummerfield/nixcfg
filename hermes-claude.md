# Using Claude models in Hermes (devbox container)

Operator runbook for the Claude (Anthropic) model integration in the `devbox`
agent sandbox on `redtruck`. Written so another operator can reproduce, verify,
and roll back the setup without additional context.

**Status as of 2026-09-21:** implemented in PR [#201](https://github.com/BJSummerfield/nixcfg/pull/201)
(service plumbing) and PR [#202](https://github.com/BJSummerfield/nixcfg/pull/202)
(selectable `claude` alias); both end-to-end verified in the devbox container.
The default model remains the local Qwen custom endpoint — nothing changes until
you explicitly select Claude.

## How it works (mechanism)

- Hermes routes the `anthropic` provider through the **native Anthropic
  Messages API**. It does **not** spawn the `claude` CLI as a subprocess, and
  there is no "command template" config field.
- Auth is **borrowed at runtime from the logged-in Claude Code OAuth**. The
  credential store lives at `CLAUDE_CONFIG_DIR=/home/agent/.claude-state`
  (**not** the default `~/.claude` — Hermes auto-detection would miss it).
  No API key is stored in any nix config or `config.yaml`.
- The `claude` CLI (2.1.276) on the gateway's `PATH` is a **separate,
  complementary capability**: it lets Hermes *delegate shell commands* to
  Claude Code from a turn. It is not the model-routing path.

Two config pieces (both in `modules/devbox/hermes.nix`):

1. **PR #201** — `services.hermes-agent.extraPackages = [ pkgs.claude-code ]`
   (the gateway unit runs a narrow `processPath`, so `claude` must be added
   explicitly) and `services.hermes-agent.environment.CLAUDE_CONFIG_DIR =
   "/home/agent/.claude-state"`. The module writes non-secret env into
   `$HERMES_HOME/.env` at activation.
2. **PR #202** — a `model_aliases` entry so `claude` is a selectable alias:

   ```nix
   model_aliases = {
     claude = {
       model = "claude-opus-5";
       provider = "anthropic";
     };
   };
   ```

   No `api_key`/`base_url` — the alias carries only the route. The default
   `model.{provider,base_url,default}` block (local Qwen) is untouched.

**Deployment requirement:** merge both PRs, then `(re)start` the devbox
container so `hermes-agent.service` picks up the new unit env and `PATH`.
Either merge order works; both touch adjacent regions of the same file.

## Selecting Claude

Per invocation (flags override config):

```sh
hermes -z "your prompt" -m claude                  # alias
hermes -z "your prompt" --provider anthropic --model claude-opus-5   # explicit
```

In an interactive session: `/model claude` (or `/provider anthropic` + model).
To make Claude the *default* model, edit the `model.default`/`model.provider`
values in `modules/devbox/hermes.nix` and re-activate — not recommended while
the local Qwen default is the intended fallback posture, since **no fallback
provider is configured** (`hermes fallback list` → "No fallback providers
configured"). An Anthropic failure is therefore a **hard error**
(nonzero exit), never a silent switch to the local model.

## Verification

Run these inside the devbox container as user `agent`.

1. **Claude CLI auth** (prerequisite, independent of Hermes):

   ```sh
   claude --version                # 2.1.276
   claude auth status              # loggedIn: true, subscriptionType: max
   claude -p "Reply with exactly the single token: CLI_OK"
                                   # expect: CLI_OK, exit 0, ~5 s
   ```

2. **Hermes one-shot probe with the alias** (authoritative route check):

   ```sh
   hermes -z "Reply with exactly the single token: ALIAS_OK" \
          -m claude --usage-file /tmp/alias_probe.json
   ```

   Expect output `ALIAS_OK`, exit 0. Then inspect the usage file — it records
   the *actual* route, which is the real proof:

   ```sh
   jq '{model, provider, api_calls, completed, failed, turn_exit_reason,
        input_tokens, cache_read_tokens, cache_write_tokens, total_tokens}' \
       /tmp/alias_probe.json
   ```

   Expected shape: `provider: "anthropic"`, `api_calls: 1`, `completed: true`,
   `failed: false`, `turn_exit_reason: "text_response(finish_reason=stop)"`,
   and Anthropic prompt-cache accounting (e.g. `cache_write_tokens ≈
   total_tokens`, `input_tokens` small) — that cache signature confirms a real
   Anthropic wire call, not a local-model echo. The resolved `model` is
   whatever Anthropic serves for this login (observed: `claude-fable-5-1` for
   the `claude-opus-5` alias; the alias is a route, not a frozen model id).

   Note: one-shot mode suppresses INFO logging by design and does **not**
   append to `agent.log` — the `--usage-file` JSON is the expected invocation
   record, not its absence from logs.

3. **Environment sanity:** `hermes status` should still show the default as
   the local Qwen custom endpoint with no Anthropic API key set (by design).

## Auth persistence and re-login

- Credentials live in `/home/agent/.claude-state` (`.credentials.json` with
  Claude Max OAuth access/refresh tokens; `settings.json` is regenerated by
  home-manager on activation — don't hand-edit it).
- The `hermes-agent` unit has `/home/agent` writable, so the gateway can read
  the persisted OAuth state across restarts. No per-run login needed.
- Tokens refresh automatically while valid. If a session has expired or a
  re-auth is required, run interactively in the container:
  `claude` → `/login` (browser OAuth). After login, re-verify with the probes
  above. **Never** paste tokens into nix configs, `config.yaml`, or chat.

## Common failures and remedies

| Symptom | Meaning | Remedy |
| --- | --- | --- |
| `No Anthropic credentials found. Run 'hermes auth add anthropic'…` (exit 1) | `CLAUDE_CONFIG_DIR` unset, points at an empty dir, or the OAuth session is gone | Check `env | grep CLAUDE_CONFIG_DIR` (must be `/home/agent/.claude-state`); re-login with `claude` → `/login`; confirm `claude auth status` shows `loggedIn: true`; restart the devbox container if the service env is missing the variable (pre-PR #201) |
| `Anthropic didn't answer after 3 attempts … Provider said: HTTP 404: model: …` (exit 2) | The requested model id is not served for this login | Use a model id the account actually serves (probe with `claude -p` or the alias); the alias resolves through the login, so the served model name can differ from the requested one |
| `Anthropic didn't answer after 3 attempts …` (other HTTP errors, e.g. 429/5xx) | Rate limit, quota, or a transient Anthropic outage | Wait and `/retry`; check Anthropic status; one transient API 500 was observed and cleared on retry — a single retry is normal. No fallback provider exists, so this stays a hard error |
| `command not found: claude` from a Hermes terminal delegation | Container not restarted after PR #201 (narrow unit `PATH` lacks it) | Restart the devbox container; verify `systemctl show -p Environment,ExecStart …` or eval `nixosConfigurations.redtruck.config.system.build.toplevel` |
| Hermes answers with the local Qwen model instead of Claude | You didn't select it — the default is untouched by design | Pass `-m claude` / `--provider anthropic`, or `/model claude` in the session |
| Suspected credential leak in logs | Should never happen | Scan outputs/usage files and `agent.log`/`errors.log` for `sk-ant-*`, `eyJ…` JWTs, `accessToken` values (a *code snippet* containing the literal key name `accessToken` can appear in logs from user scripts — that is code, not a token) |

## Rollback

The integration is additive; the default Qwen path is unaffected either way.

1. **Alias only:** revert the `model_aliases` block from PR #202 (or drop the
   block manually) and re-activate. `-m claude` no longer resolves; explicit
   `--provider anthropic` still works as long as auth exists.
2. **Service plumbing:** revert PR #201 (`extraPackages` +
   `CLAUDE_CONFIG_DIR`) and restart the container. `claude` disappears from
   the gateway `PATH` and Anthropic model routes fail with the missing-auth
   error above. Local Qwen default is never touched.
3. **Full reset:** revert both PRs, restart the container, and confirm with
   `hermes status` that the default custom endpoint is serving as before.
   Optionally `claude` → `/logout` to revoke the OAuth session, then delete
   `/home/agent/.claude-state` if you want the credential state gone too.

## Evidence (this verification run)

- Alias probe: `hermes -z … -m claude` → `ALIAS_OK`, exit 0; usage file
  `provider=anthropic, api_calls=1, completed=true, cache_write_tokens=19794,
  total_tokens=19808` (`alias_probe.json`, scratch 2026-09-21).
- Failure probes reproduced: bad model → exit 2 with the clean 404 message;
  empty `CLAUDE_CONFIG_DIR` → exit 1 with the clean missing-credentials message.
  No raw tracebacks to the user in either case.
- Earlier end-to-end report: `t_0631a5ef-e2e-claude-report.md` (scratch),
  including the credential-leak scan (clean).
