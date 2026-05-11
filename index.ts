import { readFile, writeFile, stat } from 'node:fs/promises';
import { homedir, platform, release, arch } from 'node:os';
import { join } from 'node:path';

import { createOpenAI } from '@ai-sdk/openai';

import type {
  Extension,
  ExtensionContext,
  ProviderDefinition,
  LoadModelsResponse,
  ProviderProfile,
  Model,
  AgentStartedEvent,
} from '@aiderdesk/extensions';

// --- Constants ---

// Refresh-only OAuth client id (the official Codex CLI value, base64-encoded
// to match upstream and to avoid token-style strings sitting in plaintext).
const CLIENT_ID_BASE64 = 'YXBwX0VNb2FtRUVaNzNmMENrWGFYcDdocmFubg==';
const getClientId = (): string => atob(CLIENT_ID_BASE64);
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const JWT_CLAIM_PATH = 'https://api.openai.com/auth';
const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';

// Refresh if the access token is within this window of expiring.
const EXPIRY_BUFFER_MS = 60_000;

// Hard cap on the OAuth refresh request so a hung auth.openai.com doesn't
// stall every queued LLM call indefinitely.
const REFRESH_TIMEOUT_MS = 15_000;

const isEnvFalsy = (v: string | undefined): boolean => v === 'false' || v === '0';
const isEnvTruthy = (v: string | undefined): boolean => v === 'true' || v === '1';

// Responses API `store` flag. Defaults to false because the Codex backend
// rejects stored responses for some accounts; opt in via CODEX_STORE=true
// (or 1) when the AI SDK's item_reference replay path is needed for
// multi-turn tool flows.
const isStoreEnabled = (): boolean => isEnvTruthy(process.env.CODEX_STORE);

// Reasoning tier names the Codex backend exposes via the
// supported_reasoning_levels[].effort field. Tiers it advertises that aren't
// in this set are dropped at parse time — adding a new tier here is a
// deliberate opt-in.
type ReasoningTier = 'low' | 'medium' | 'high' | 'xhigh';
const REASONING_TIERS: readonly ReasoningTier[] = ['low', 'medium', 'high', 'xhigh'];

const DEFAULT_CONTEXT_WINDOW = 272000;
const DEFAULT_MAX_OUTPUT_TOKENS = 128000;

// Each tier suffix yields a separate AiderDesk model entry. The suffix drives
// reasoning.effort per-call via getProviderOptions; the slug (without suffix)
// is what gets sent to the Codex backend.
interface CodexRegistryModel {
  slug: string;
  contextWindow: number;
  reasoningTiers: readonly ReasoningTier[];
}

// Used when both the live /models fetch and the on-disk cache file fail.
// Mirrors the visible models the Codex backend was advertising when this was
// last refreshed; auto-discovered tiers/slugs from the live registry will
// replace this list whenever the network or cache file is reachable.
const FALLBACK_CODEX_MODELS: readonly CodexRegistryModel[] = [
  { slug: 'gpt-5.5', contextWindow: DEFAULT_CONTEXT_WINDOW, reasoningTiers: REASONING_TIERS },
  { slug: 'gpt-5.4', contextWindow: DEFAULT_CONTEXT_WINDOW, reasoningTiers: REASONING_TIERS },
  { slug: 'gpt-5.4-mini', contextWindow: DEFAULT_CONTEXT_WINDOW, reasoningTiers: REASONING_TIERS },
  { slug: 'gpt-5.3-codex', contextWindow: DEFAULT_CONTEXT_WINDOW, reasoningTiers: REASONING_TIERS },
  { slug: 'gpt-5.2', contextWindow: DEFAULT_CONTEXT_WINDOW, reasoningTiers: REASONING_TIERS },
];

const parseModelId = (id: string): { slug: string; reasoning: ReasoningTier } => {
  for (const tier of REASONING_TIERS) {
    const suffix = `-${tier}`;
    if (id.endsWith(suffix)) {
      return { slug: id.slice(0, -suffix.length), reasoning: tier };
    }
  }
  // Unknown / legacy id — pass through with the registry default.
  return { slug: id, reasoning: 'medium' };
};

// --- Model registry parsing ---
//
// Shape we accept: either { models: [...] } (Codex CLI's models_cache.json
// format and the live /models response) or a bare array. Each entry follows
// the documented Codex backend shape; unknown fields are ignored.

interface RawCodexModel {
  slug?: unknown;
  context_window?: unknown;
  supported_reasoning_levels?: unknown;
  visibility?: unknown;
  supported_in_api?: unknown;
}

const isReasoningTier = (s: unknown): s is ReasoningTier =>
  typeof s === 'string' && (REASONING_TIERS as readonly string[]).includes(s);

export const parseRegistryEntry = (raw: unknown): CodexRegistryModel | null => {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as RawCodexModel;
  if (typeof r.slug !== 'string' || r.slug.length === 0) return null;
  // Hidden entries (e.g. codex-auto-review) and ones that aren't reachable via
  // the API surface we use are deliberately dropped.
  if (r.visibility !== undefined && r.visibility !== 'list') return null;
  if (r.supported_in_api === false) return null;

  const contextWindow =
    typeof r.context_window === 'number' && r.context_window > 0 ? r.context_window : DEFAULT_CONTEXT_WINDOW;

  const tiers: ReasoningTier[] = [];
  if (Array.isArray(r.supported_reasoning_levels)) {
    for (const lvl of r.supported_reasoning_levels) {
      if (lvl && typeof lvl === 'object') {
        const effort = (lvl as { effort?: unknown }).effort;
        if (isReasoningTier(effort) && !tiers.includes(effort)) {
          tiers.push(effort);
        }
      }
    }
  }
  // Registry didn't declare any tiers we know about — fall back to all known.
  const reasoningTiers = tiers.length > 0 ? tiers : [...REASONING_TIERS];

  return { slug: r.slug, contextWindow, reasoningTiers };
};

export const parseRegistry = (data: unknown): CodexRegistryModel[] => {
  let arr: unknown[];
  if (Array.isArray(data)) {
    arr = data;
  } else if (data && typeof data === 'object' && Array.isArray((data as { models?: unknown }).models)) {
    arr = (data as { models: unknown[] }).models;
  } else {
    return [];
  }
  return arr.map(parseRegistryEntry).filter((m): m is CodexRegistryModel => m !== null);
};

const isFallbackModelsOnly = (): boolean => {
  const v = process.env.CODEX_FALLBACK_MODELS_ONLY;
  return v !== undefined && v !== '' && !isEnvFalsy(v);
};

// --- Auth file resolution ---

interface ResolvedAuthPath {
  path: string;
  source: string;
}

const fileExists = async (path: string): Promise<boolean> => {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
};

const candidateAuthPaths = (): ResolvedAuthPath[] => {
  const out: ResolvedAuthPath[] = [];
  const explicit = process.env.CODEX_AUTH_FILE;
  if (explicit) {
    out.push({ path: explicit, source: 'CODEX_AUTH_FILE' });
  }
  const codexHome = process.env.CODEX_HOME;
  if (codexHome) {
    out.push({ path: join(codexHome, 'auth.json'), source: 'CODEX_HOME' });
  }
  const home = homedir();
  if (home) {
    out.push({ path: join(home, '.codex', 'auth.json'), source: '$HOME/.codex' });
  }
  out.push({ path: '/root/.codex/auth.json', source: '/root/.codex (container fallback)' });
  return out;
};

const resolveAuthPath = async (): Promise<ResolvedAuthPath> => {
  const candidates = candidateAuthPaths();
  for (const c of candidates) {
    if (await fileExists(c.path)) {
      return c;
    }
  }
  const tried = candidates.map((c) => `  - ${c.path} (${c.source})`).join('\n');
  throw new Error(
    `Codex auth file not found. Set CODEX_AUTH_FILE to an absolute path or place auth.json under ~/.codex/. Tried:\n${tried}`,
  );
};

// --- Auth file shape normalization ---

interface NormalizedAuth {
  accessToken: string;
  refreshToken: string | null;
  accountId: string | null;
  expiresAt: number | null;
}

const pickString = (obj: Record<string, unknown> | undefined, ...keys: string[]): string | null => {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) {
      return v;
    }
  }
  return null;
};

const parseExpiry = (raw: unknown): number | null => {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // Heuristic: treat values < 10^12 as seconds since epoch, else ms.
    return raw < 1e12 ? raw * 1000 : raw;
  }
  if (typeof raw === 'string' && raw.length > 0) {
    const asNum = Number(raw);
    if (Number.isFinite(asNum) && asNum > 0) {
      return asNum < 1e12 ? asNum * 1000 : asNum;
    }
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : null;
  }
  return null;
};

interface JwtPayload {
  exp?: number;
  [JWT_CLAIM_PATH]?: { chatgpt_account_id?: string };
  [key: string]: unknown;
}

const decodeJwt = (token: string): JwtPayload | null => {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf-8')) as JwtPayload;
  } catch {
    return null;
  }
};

const getAccountIdFromJwt = (accessToken: string): string | null => {
  const p = decodeJwt(accessToken);
  const id = p?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
  return typeof id === 'string' && id.length > 0 ? id : null;
};

const normalizeAuth = (raw: unknown): NormalizedAuth => {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Auth file is not a JSON object');
  }
  const root = raw as Record<string, unknown>;
  const tokens =
    typeof root.tokens === 'object' && root.tokens !== null ? (root.tokens as Record<string, unknown>) : undefined;

  const accessToken =
    pickString(tokens, 'access_token', 'accessToken', 'token') ??
    pickString(root, 'accessToken', 'access_token', 'token');
  if (!accessToken) {
    throw new Error('Auth file is missing access_token');
  }

  const refreshToken =
    pickString(tokens, 'refresh_token', 'refreshToken') ?? pickString(root, 'refreshToken', 'refresh_token');

  let accountId = pickString(tokens, 'account_id', 'accountId') ?? pickString(root, 'accountId', 'account_id');
  if (!accountId) {
    accountId = getAccountIdFromJwt(accessToken);
  }

  let expiresAt: number | null = null;
  for (const k of ['expiresAt', 'expires_at', 'expiry', 'expires']) {
    const v = (tokens?.[k] ?? root[k]) as unknown;
    expiresAt = parseExpiry(v);
    if (expiresAt !== null) break;
  }
  if (expiresAt === null) {
    const exp = decodeJwt(accessToken)?.exp;
    if (typeof exp === 'number' && Number.isFinite(exp)) {
      expiresAt = exp * 1000;
    }
  }

  return { accessToken, refreshToken, accountId, expiresAt };
};

const loadAuthFile = async (path: string): Promise<NormalizedAuth> => {
  let data: string;
  try {
    data = await readFile(path, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read Codex auth file at ${path}: ${msg}`, { cause: err });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Codex auth file at ${path} is not valid JSON: ${msg}`, { cause: err });
  }
  return normalizeAuth(parsed);
};

// --- Persistence (writeback after refresh) ---

const persistRefreshedTokens = async (
  path: string,
  refreshed: { accessToken: string; refreshToken: string; accountId: string | null; expiresAt: number },
  context: ExtensionContext,
): Promise<void> => {
  if (process.env.CODEX_AUTH_PERSIST === 'false' || process.env.CODEX_AUTH_PERSIST === '0') {
    return;
  }
  // Preserve unknown sibling fields on the existing file.
  let prior: Record<string, unknown> = {};
  try {
    const text = await readFile(path, 'utf-8');
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') prior = parsed as Record<string, unknown>;
  } catch {
    // File may have been deleted between read and write; fall through.
  }
  const priorTokens = prior.tokens && typeof prior.tokens === 'object' ? (prior.tokens as Record<string, unknown>) : {};
  const next = {
    ...prior,
    auth_mode: typeof prior.auth_mode === 'string' ? prior.auth_mode : 'ChatGPT',
    last_refresh: new Date().toISOString(),
    tokens: {
      ...priorTokens,
      access_token: refreshed.accessToken,
      refresh_token: refreshed.refreshToken,
      account_id: refreshed.accountId ?? priorTokens.account_id ?? '',
      expires_at: refreshed.expiresAt,
    },
  };
  try {
    await writeFile(path, JSON.stringify(next, null, 2), { encoding: 'utf-8', mode: 0o600 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    context.log(`Could not persist refreshed Codex tokens to ${path}: ${msg}`, 'warn');
  }
};

// --- Token refresh (non-interactive) ---

interface RefreshedTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

const refreshAccessToken = async (refreshToken: string, context: ExtensionContext): Promise<RefreshedTokens> => {
  context.log('Codex Auth: attempting non-interactive token refresh', 'info');
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: getClientId(),
    }),
    signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Token refresh failed: ${response.status} ${text}`);
  }
  const json = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== 'number') {
    throw new Error('Token refresh response missing required fields');
  }
  context.log('Codex Auth: token refresh succeeded', 'info');
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
};

// --- Get valid access token (no interactive fallback) ---
//
// In-memory cache + single-flight: concurrent callers coalesce onto one
// refresh promise so we never POST the same refresh_token twice (which would
// have one caller succeed and the rotation invalidate the other), and we stop
// stat'ing + reading the auth file on every LLM call.

interface CachedAuth {
  accessToken: string;
  accountId: string;
  expiresAt: number | null;
}

let cachedAuth: CachedAuth | null = null;
let inflightAuth: Promise<CachedAuth> | null = null;

const isCachedAuthFresh = (cached: CachedAuth | null): cached is CachedAuth => {
  if (!cached) return false;
  // Tokens with no expiry metadata aren't cached — re-read the file each time
  // so external updates (e.g. a concurrent `codex login`) are picked up.
  if (cached.expiresAt === null) return false;
  return Date.now() < cached.expiresAt - EXPIRY_BUFFER_MS;
};

const fetchAuth = async (context: ExtensionContext): Promise<CachedAuth> => {
  const resolved = await resolveAuthPath();
  const auth = await loadAuthFile(resolved.path);

  const expired = auth.expiresAt !== null && Date.now() >= auth.expiresAt - EXPIRY_BUFFER_MS;

  if (!expired) {
    const accountId = auth.accountId ?? getAccountIdFromJwt(auth.accessToken);
    if (!accountId) {
      throw new Error(
        `Codex auth at ${resolved.path} has an access token without a chatgpt_account_id claim and no account_id field.`,
      );
    }
    return { accessToken: auth.accessToken, accountId, expiresAt: auth.expiresAt };
  }

  if (!auth.refreshToken) {
    throw new Error(
      `Codex access token at ${resolved.path} is expired and the file has no refresh_token. Run \`codex login\` (or refresh externally) and retry.`,
    );
  }

  let refreshed: RefreshedTokens;
  try {
    refreshed = await refreshAccessToken(auth.refreshToken, context);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Codex access token at ${resolved.path} is expired and refresh failed: ${msg}. Re-authenticate externally (e.g. \`codex login\`) and retry.`,
      { cause: err },
    );
  }

  const accountId = auth.accountId ?? getAccountIdFromJwt(refreshed.accessToken);
  if (!accountId) {
    throw new Error('Failed to extract account ID from refreshed Codex token');
  }
  await persistRefreshedTokens(resolved.path, { ...refreshed, accountId }, context);
  return { accessToken: refreshed.accessToken, accountId, expiresAt: refreshed.expiresAt };
};

const getValidAccessToken = async (context: ExtensionContext): Promise<{ accessToken: string; accountId: string }> => {
  if (isCachedAuthFresh(cachedAuth)) {
    return { accessToken: cachedAuth.accessToken, accountId: cachedAuth.accountId };
  }
  if (inflightAuth) {
    const cached = await inflightAuth;
    return { accessToken: cached.accessToken, accountId: cached.accountId };
  }
  inflightAuth = fetchAuth(context);
  try {
    const fresh = await inflightAuth;
    cachedAuth = fresh;
    return { accessToken: fresh.accessToken, accountId: fresh.accountId };
  } finally {
    inflightAuth = null;
  }
};

const invalidateAuthCache = (): void => {
  cachedAuth = null;
};

// Match common shapes that AI SDK / fetch-based errors take when the API
// returns 401: top-level status codes, nested response objects, or status
// embedded in the message string (e.g. "401 Unauthorized").
const is401Error = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const obj = error as Record<string, unknown>;
  if (obj.status === 401 || obj.statusCode === 401) return true;
  const response = obj.response;
  if (response && typeof response === 'object' && (response as Record<string, unknown>).status === 401) {
    return true;
  }
  if (typeof obj.message === 'string' && /\b401\b/.test(obj.message)) return true;
  return false;
};

// --- Codex backend HTTP helpers ---

const codexHeaders = (accountId: string): Record<string, string> => ({
  'chatgpt-account-id': accountId,
  'OpenAI-Beta': 'responses=experimental',
  originator: 'aiderdesk',
  'User-Agent': `aiderdesk (${platform()} ${release()}; ${arch()})`,
});

// --- Dynamic model registry ---
//
// Strategy on each loadModels call:
//   1. Try the live /models endpoint with the user's auth token. This auto-
//      discovers new model slugs and reasoning tiers as OpenAI ships them.
//   2. If that fails (offline, 4xx, 5xx, etc.), fall back to the on-disk
//      models_cache.json the Codex CLI maintains.
//   3. If that's also unreachable, fall back to FALLBACK_CODEX_MODELS.
//
// CODEX_FALLBACK_MODELS_ONLY=1 short-circuits straight to the hardcoded list,
// useful for air-gapped runs and deterministic tests.

const fetchLiveModels = async (context: ExtensionContext): Promise<CodexRegistryModel[]> => {
  const { accessToken, accountId } = await getValidAccessToken(context);
  const response = await fetch(`${CODEX_BASE_URL}/models`, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...codexHeaders(accountId),
    },
    signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Codex /models endpoint returned ${response.status} ${response.statusText}`);
  }
  return parseRegistry((await response.json()) as unknown);
};

const candidateCachePaths = (): string[] => {
  const out: string[] = [];
  const codexHome = process.env.CODEX_HOME;
  if (codexHome) out.push(join(codexHome, 'models_cache.json'));
  const home = homedir();
  if (home) out.push(join(home, '.codex', 'models_cache.json'));
  out.push('/root/.codex/models_cache.json');
  return out;
};

const readCacheModels = async (): Promise<CodexRegistryModel[]> => {
  for (const path of candidateCachePaths()) {
    if (await fileExists(path)) {
      const text = await readFile(path, 'utf-8');
      return parseRegistry(JSON.parse(text) as unknown);
    }
  }
  throw new Error('models_cache.json not found in any candidate path');
};

const loadCodexModels = async (context: ExtensionContext): Promise<CodexRegistryModel[]> => {
  if (isFallbackModelsOnly()) {
    context.log('Codex models: CODEX_FALLBACK_MODELS_ONLY set — using hardcoded list', 'debug');
    return [...FALLBACK_CODEX_MODELS];
  }

  try {
    const live = await fetchLiveModels(context);
    if (live.length > 0) {
      context.log(`Codex models: loaded ${live.length} entries from /models endpoint`, 'debug');
      return live;
    }
  } catch (err) {
    context.log(`Codex models: /models fetch failed: ${err instanceof Error ? err.message : String(err)}`, 'debug');
  }

  try {
    const cached = await readCacheModels();
    if (cached.length > 0) {
      context.log(`Codex models: loaded ${cached.length} entries from models_cache.json`, 'debug');
      return cached;
    }
  } catch (err) {
    context.log(
      `Codex models: models_cache.json read failed: ${err instanceof Error ? err.message : String(err)}`,
      'debug',
    );
  }

  context.log('Codex models: falling back to hardcoded list', 'warn');
  return [...FALLBACK_CODEX_MODELS];
};

// --- Extension class ---

const PROVIDER_ID = 'codex-auth';

export default class AiderDeskCodexExtension implements Extension {
  static metadata = {
    name: 'AiderDesk Codex Extension',
    version: '1.0.0',
    description:
      'OpenAI Codex provider that consumes pre-provisioned Codex auth from a configurable filesystem path (no browser OAuth).',
    author: 'Kareem Hepburn',
  };

  // Keyed by model id, not stored in a single field, because a second agent
  // run starting before the first finishes would otherwise overwrite the
  // first's prompt and corrupt mid-flight getProviderOptions reads. Same-model
  // concurrent runs still race on a single key — that's a known limitation.
  private systemPromptByModel = new Map<string, string>();

  async onLoad(context: ExtensionContext): Promise<void> {
    try {
      const resolved = await resolveAuthPath();
      let state = 'present';
      try {
        const auth = await loadAuthFile(resolved.path);
        if (auth.expiresAt === null) {
          state = 'present (no expiry metadata; will trust until 401)';
        } else if (Date.now() >= auth.expiresAt - EXPIRY_BUFFER_MS) {
          state = auth.refreshToken
            ? 'expired (will refresh on next use)'
            : 'expired and not refreshable (calls will fail until file is updated)';
        } else {
          state = 'valid';
        }
      } catch (err) {
        state = `unreadable (${err instanceof Error ? err.message : String(err)})`;
      }
      context.log(`Codex Shared Auth: using ${resolved.path} via ${resolved.source} — ${state}`, 'info');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      context.log(`Codex Shared Auth: ${msg}`, 'warn');
    }
  }

  async onAgentStarted(event: AgentStartedEvent) {
    if (event.providerProfile.provider.name !== PROVIDER_ID) {
      return undefined;
    }
    if (event.systemPrompt) {
      this.systemPromptByModel.set(event.model, event.systemPrompt);
    } else {
      this.systemPromptByModel.delete(event.model);
    }
    return {
      systemPrompt: '', // Forwarded as providerOptions.openai.instructions instead.
    };
  }

  getProviders(context: ExtensionContext): ProviderDefinition[] {
    const createLlm = async (_profile: ProviderProfile, model: Model) => {
      const { slug, reasoning } = parseModelId(model.id);
      context.log(`Creating OpenAI Codex model: ${slug} (reasoning=${reasoning})`, 'debug');
      const { accessToken, accountId } = await getValidAccessToken(context);
      const provider = createOpenAI({
        baseURL: CODEX_BASE_URL,
        apiKey: accessToken,
        headers: codexHeaders(accountId),
      });
      return provider.responses(slug);
    };

    const loadModels = async (profile: ProviderProfile): Promise<LoadModelsResponse> => {
      const registry = await loadCodexModels(context);
      const models: Model[] = registry.flatMap(({ slug, contextWindow, reasoningTiers }) =>
        reasoningTiers.map((tier) => ({
          id: `${slug}-${tier}`,
          providerId: profile.id,
          maxInputTokens: contextWindow,
          maxOutputTokensLimit: DEFAULT_MAX_OUTPUT_TOKENS,
        })),
      );
      return { models, success: true };
    };

    const getProviderOptions = (model: Model) => ({
      openai: {
        store: isStoreEnabled(),
        instructions: this.systemPromptByModel.get(model.id) ?? '',
        reasoningEffort: parseModelId(model.id).reasoning,
      },
    });

    const isRetryable = (error: unknown): boolean => {
      if (is401Error(error)) {
        // The cached access token is stale or has been revoked externally.
        // Drop it so the next createLlm call re-reads auth.json (and refreshes
        // if needed) instead of handing back the same dead token.
        invalidateAuthCache();
        context.log('Codex Auth: 401 detected — invalidating cached token before retry', 'warn');
        return true;
      }
      return false;
    };

    return [
      {
        id: PROVIDER_ID,
        name: 'Codex Auth',
        provider: { name: PROVIDER_ID },
        strategy: { createLlm, loadModels, getProviderOptions, isRetryable },
      },
    ];
  }
}
