# AiderDesk Codex Extension

An [AiderDesk](https://aiderdesk.hotovo.com) extension that registers an OpenAI Codex provider authenticated against ChatGPT Plus/Pro/Max using **pre-provisioned auth supplied externally** — no browser OAuth, no localhost callback, no PKCE. Designed for headless / containerized environments (e.g. the `brownie` container) where interactive login is not possible.

## Origin

This project takes inspiration from [`wladimiiir/aider-desk-codex-auth-extension`](https://github.com/wladimiiir/aider-desk-codex-auth-extension), which pioneered the pattern of consuming a pre-provisioned Codex auth file inside AiderDesk. The original is MIT-licensed; that license and copyright are preserved in [LICENSE](./LICENSE).

## How it works

On first model invocation the extension:

1. Resolves the path to a Codex `auth.json` file (see [Auth file resolution](#auth-file-resolution)).
2. Reads and normalizes the file (Codex CLI native format and the legacy flat format are both supported).
3. Decides if the access token is still valid using the explicit `expires_at` field if present, otherwise the JWT `exp` claim.
4. If expired and a `refresh_token` is available, performs a non-interactive refresh against `https://auth.openai.com/oauth/token` using the bundled Codex CLI client id and writes the refreshed tokens back to the same file.
5. If expired and no refresh is possible, fails with an actionable error. **It will never open a browser.**
6. Constructs the OpenAI Codex provider with the access token and the `chatgpt-account-id` header.

## Auth file resolution

Resolution stops at the first existing file:

| Order | Source                                     |
| ----- | ------------------------------------------ |
| 1     | `$CODEX_AUTH_FILE` (absolute path)         |
| 2     | `$CODEX_HOME/auth.json`                    |
| 3     | `$HOME/.codex/auth.json`                   |
| 4     | `/root/.codex/auth.json` (container default) |

If none exist, the extension throws an error listing all candidates.

## Environment variables

| Variable             | Purpose                                                                               |
| -------------------- | ------------------------------------------------------------------------------------- |
| `CODEX_AUTH_FILE`    | Absolute path to the auth JSON file. Highest precedence.                              |
| `CODEX_HOME`         | If set, `${CODEX_HOME}/auth.json` is used.                                            |
| `CODEX_AUTH_PERSIST` | Set to `false` or `0` to disable writeback after a successful refresh. Default: write back. |

## Supported auth file shapes

### Codex CLI native (recommended)

This is what `codex login` writes to `~/.codex/auth.json`:

```json
{
  "auth_mode": "ChatGPT",
  "last_refresh": "2026-04-27T00:00:00.000Z",
  "OPENAI_API_KEY": null,
  "tokens": {
    "access_token": "<JWT>",
    "account_id": "<uuid>",
    "id_token": "<JWT>",
    "refresh_token": "<opaque>"
  }
}
```

### Legacy flat shape

Also accepted (as written by the upstream extension's old OAuth flow):

```json
{
  "accessToken": "<JWT>",
  "refreshToken": "<opaque>",
  "expiresAt": 1735689600000
}
```

### Field name aliases

The loader accepts these alternatives:

| Concept       | Recognized keys                                                |
| ------------- | -------------------------------------------------------------- |
| Access token  | `tokens.access_token`, `accessToken`, `access_token`, `token`  |
| Refresh token | `tokens.refresh_token`, `refreshToken`, `refresh_token`        |
| Account id    | `tokens.account_id`, `accountId`, `account_id`                 |
| Expiry        | `expiresAt`, `expires_at`, `expiry`, `expires` (epoch ms, epoch s, or ISO 8601). Falls back to the JWT `exp` claim. |

If `account_id` isn't present in the file, it is decoded from the access token's `https://api.openai.com/auth.chatgpt_account_id` claim.

## Expiry and refresh

- Token is treated as expired when `now >= expiresAt - 60s`.
- Refresh is non-interactive (HTTP POST to OpenAI's token endpoint with the refresh token).
- After refresh, the file is rewritten in Codex CLI native shape (mode `0600`), preserving any unknown sibling fields. Set `CODEX_AUTH_PERSIST=false` to skip writeback (useful for read-only mounts).
- If refresh fails or is impossible, the extension throws — it never falls back to interactive OAuth. The error names the path so you can re-provision externally (`codex login`, copy a fresh `auth.json` into the container, etc.).

## Container usage (brownie)

Two practical patterns:

1. **Bind-mount your host's `~/.codex/`** into the container at `/root/.codex/`. The default fallback finds it; no env vars needed.
   ```bash
   docker run -v "$HOME/.codex:/root/.codex:ro" ...
   ```
   Read-only mounts are safe — refresh writeback failures are warned, not fatal.

2. **Place the file anywhere and point at it**:
   ```bash
   docker run -e CODEX_AUTH_FILE=/secrets/codex-auth.json -v /path/to/auth.json:/secrets/codex-auth.json:ro ...
   ```

For long-running containers where the access token will expire and the volume is read-only, periodically refresh on the host (`codex login` or any tool that updates `auth.json`) and re-mount, or set up a writable volume so refresh-and-save works in-process.

## Installation

```bash
cd ~/.aider-desk/extensions/
git clone <this repo url> aiderdesk-codex-extension
cd aiderdesk-codex-extension
npm install
```

AiderDesk picks up the extension via hot reload.

## Available models

Codex OAuth tokens cannot access `/v1/models`, so the model list is hardcoded. It mirrors the user-visible models from the Codex backend's `/models` endpoint (also cached at `~/.codex/models_cache.json` after any `codex` invocation). To refresh, update `CODEX_BASE_MODELS` in [`index.ts`](./index.ts).

Each base model is exposed at four reasoning tiers, so the picker shows `<slug>-low`, `<slug>-medium`, `<slug>-high`, and `<slug>-xhigh`. The suffix drives `reasoning.effort` per request; the underlying slug sent to the Codex backend is the same.

| Base slug       | Context window | Description (from registry)                                       |
| --------------- | -------------- | ----------------------------------------------------------------- |
| `gpt-5.5`       | 272k           | Frontier model for complex coding, research, and real-world work  |
| `gpt-5.4`       | 272k           | Strong model for everyday coding                                  |
| `gpt-5.4-mini`  | 272k           | Small, fast, and cost-efficient for simpler coding tasks          |
| `gpt-5.3-codex` | 272k           | Coding-optimized model                                            |
| `gpt-5.2`       | 272k           | Optimized for professional work and long-running agents           |

Reasoning tiers (per registry):

| Tier     | When to pick it                                          |
| -------- | -------------------------------------------------------- |
| `low`    | Fast responses with lighter reasoning                    |
| `medium` | Balanced — registry default                              |
| `high`   | Greater reasoning depth for complex problems             |
| `xhigh`  | Extra-high reasoning depth for the hardest problems      |

## Responses API state (`store: true`)

The extension calls the OpenAI Responses API with `store: true` so that tool results from previous turns can be replayed via `item_reference` IDs. With `store: false`, the AI SDK silently drops tool results between turns (it warns: `Results for OpenAI tool ... are not sent to the API when store is false`), which would break multi-step tool flows. If you observe Codex-backend rejections of `store: true`, edit `getProviderOptions` in [`index.ts`](./index.ts) and flip it back.

## Troubleshooting

- **"Codex auth file not found"** — set `CODEX_AUTH_FILE` to an absolute path or place a Codex CLI `auth.json` at one of the resolution candidates.
- **"is expired and the file has no refresh_token"** — re-run `codex login` (or refresh externally) and replace the file.
- **"refresh failed: 401 …"** — the refresh token has been invalidated. Re-authenticate externally and replace the file.
- **Refresh appears to work but a later run sees the same expiry** — `CODEX_AUTH_PERSIST=false` is set, or the file location is read-only. Provide a writable file or accept that each run will refresh.

## Requirements

- AiderDesk with extension support
- ChatGPT Plus, Pro, or Max subscription (auth provisioned externally, e.g. via the official Codex CLI)
- Node.js ≥ 22

## License

[MIT](./LICENSE). Includes the original copyright from [`wladimiiir/aider-desk-codex-auth-extension`](https://github.com/wladimiiir/aider-desk-codex-auth-extension).

## Notice

For personal development use with your own ChatGPT subscription. For production or multi-user applications, use the OpenAI Platform API.
