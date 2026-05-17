import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3ResponseMetadata,
  LanguageModelV3Usage,
  SharedV3Headers,
  SharedV3ProviderMetadata,
  SharedV3Warning,
} from '@ai-sdk/provider';

// The ChatGPT-backed Codex `/responses` endpoint rejects non-streaming requests
// with `400 Bad Request: {"detail":"Stream must be set to true"}`. AiderDesk's
// handoff conversation flow calls the model via `generateText` (non-streaming),
// which would otherwise fail on every handoff. This wrapper makes any
// `doGenerate` call internally drive `doStream` and assemble a non-streaming
// result, so callers never see the protocol mismatch.
//
// The same backend also rejects some parameters the @ai-sdk/openai Responses
// provider sends by default. We strip those here so the inner model never
// forwards them. Add fields to `sanitizeForCodex` as the backend surfaces new
// `Unsupported parameter: <name>` rejections.

// Codex backend rejects `max_output_tokens` with
// `{"detail":"Unsupported parameter: max_output_tokens"}` even though the
// standard OpenAI Responses API accepts it. AiderDesk sets `maxOutputTokens`
// during handoff (and some streaming flows), so it must be cleared before the
// call reaches the inner OpenAI Responses provider.
const sanitizeForCodex = (options: LanguageModelV3CallOptions): LanguageModelV3CallOptions => ({
  ...options,
  maxOutputTokens: undefined,
});

// Codex error chunks arrive in two shapes that both need to read clearly to
// users: the inner `{message, code?, type?, param?}` the OpenAI adapter
// actually enqueues, and the wire-format envelope `{error: {...}}` that
// downstream loggers sometimes re-stringify back into view. Anything we don't
// recognise still falls through to JSON.stringify so no information is lost.

interface ParsedCodexError {
  message: string;
  code?: string;
  type?: string;
  param?: string;
}

const KNOWN_CODE_HINTS: Record<string, string> = {
  context_length_exceeded:
    "advertised maxInputTokens may exceed the model's effective context; the conversation likely needs compaction or handoff",
};

const tryParseJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

const extractCodexError = (raw: unknown): ParsedCodexError | null => {
  if (raw == null) return null;

  if (typeof raw === 'string') {
    const parsed = tryParseJson(raw);
    if (parsed !== undefined && parsed !== raw) {
      const inner = extractCodexError(parsed);
      if (inner) return inner;
    }
    return { message: raw };
  }

  if (typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  if (obj.error && typeof obj.error === 'object') {
    const inner = extractCodexError(obj.error);
    if (inner) return inner;
  }

  if (typeof obj.message === 'string') {
    return {
      message: obj.message,
      code: typeof obj.code === 'string' ? obj.code : undefined,
      type: typeof obj.type === 'string' ? obj.type : undefined,
      param: typeof obj.param === 'string' ? obj.param : undefined,
    };
  }

  return null;
};

const buildMessage = (p: ParsedCodexError, modelId: string): string => {
  const prefix = p.code ? `Codex API error (${p.code})` : p.type ? `Codex API error (${p.type})` : 'Codex API error';
  const ctx: string[] = [`model=${modelId}`];
  if (p.param) ctx.push(`param=${p.param}`);
  const hint = p.code && KNOWN_CODE_HINTS[p.code] ? ` ${KNOWN_CODE_HINTS[p.code]}` : '';
  return `${prefix}: ${p.message}${hint} [${ctx.join(', ')}]`;
};

export const formatStreamError = (raw: unknown, modelId: string): Error => {
  if (raw instanceof Error) {
    const parsed = extractCodexError(raw.message);
    if (parsed && parsed.message !== raw.message) {
      return new Error(buildMessage(parsed, modelId), { cause: raw });
    }
    return raw;
  }

  const parsed = extractCodexError(raw);
  if (parsed) {
    return new Error(buildMessage(parsed, modelId), { cause: raw });
  }

  return new Error(typeof raw === 'string' ? raw : JSON.stringify(raw), { cause: raw });
};

export const wrapStreamOnly = (model: LanguageModelV3): LanguageModelV3 => ({
  specificationVersion: 'v3',
  provider: model.provider,
  modelId: model.modelId,
  supportedUrls: model.supportedUrls,
  doStream: (options) => model.doStream(sanitizeForCodex(options)),
  doGenerate: async (options) => {
    const { stream, request, response: streamResponse } = await model.doStream(sanitizeForCodex(options));

    // Streamed text and reasoning arrive as start/delta*/end triples keyed by
    // id. We keep one mutable Content entry per id and append deltas in-place
    // so the final ordering matches the order the model emitted parts in.
    const content: LanguageModelV3Content[] = [];
    const textIndexById = new Map<string, number>();
    const reasoningIndexById = new Map<string, number>();

    // 'other' is the safest default for the V3 unified finish reason if no
    // 'finish' chunk arrives (V3 dropped V2's 'unknown' value).
    let finishReason: LanguageModelV3FinishReason = { unified: 'other', raw: undefined };
    let usage: LanguageModelV3Usage = {
      inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined },
    };
    let providerMetadata: SharedV3ProviderMetadata | undefined;
    let warnings: SharedV3Warning[] = [];
    const responseMetadata: LanguageModelV3ResponseMetadata & {
      headers?: SharedV3Headers;
      body?: unknown;
    } = {};
    if (streamResponse?.headers) responseMetadata.headers = streamResponse.headers;

    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;

        switch (value.type) {
          case 'stream-start':
            warnings = value.warnings;
            break;

          case 'response-metadata':
            if (value.id !== undefined) responseMetadata.id = value.id;
            if (value.timestamp !== undefined) responseMetadata.timestamp = value.timestamp;
            if (value.modelId !== undefined) responseMetadata.modelId = value.modelId;
            break;

          case 'text-start': {
            if (!textIndexById.has(value.id)) {
              textIndexById.set(value.id, content.length);
              content.push({ type: 'text', text: '', providerMetadata: value.providerMetadata });
            }
            break;
          }

          case 'text-delta': {
            let idx = textIndexById.get(value.id);
            if (idx === undefined) {
              idx = content.length;
              textIndexById.set(value.id, idx);
              content.push({ type: 'text', text: '', providerMetadata: value.providerMetadata });
            }
            const entry = content[idx] as LanguageModelV3Content & { type: 'text' };
            entry.text += value.delta;
            break;
          }

          case 'text-end': {
            const idx = textIndexById.get(value.id);
            if (idx !== undefined && value.providerMetadata) {
              const entry = content[idx] as LanguageModelV3Content & { type: 'text' };
              entry.providerMetadata = value.providerMetadata;
            }
            break;
          }

          case 'reasoning-start': {
            if (!reasoningIndexById.has(value.id)) {
              reasoningIndexById.set(value.id, content.length);
              content.push({ type: 'reasoning', text: '', providerMetadata: value.providerMetadata });
            }
            break;
          }

          case 'reasoning-delta': {
            let idx = reasoningIndexById.get(value.id);
            if (idx === undefined) {
              idx = content.length;
              reasoningIndexById.set(value.id, idx);
              content.push({ type: 'reasoning', text: '', providerMetadata: value.providerMetadata });
            }
            const entry = content[idx] as LanguageModelV3Content & { type: 'reasoning' };
            entry.text += value.delta;
            break;
          }

          case 'reasoning-end': {
            const idx = reasoningIndexById.get(value.id);
            if (idx !== undefined && value.providerMetadata) {
              const entry = content[idx] as LanguageModelV3Content & { type: 'reasoning' };
              entry.providerMetadata = value.providerMetadata;
            }
            break;
          }

          case 'tool-call':
          case 'tool-result':
          case 'tool-approval-request':
          case 'file':
          case 'source':
            content.push(value);
            break;

          case 'finish':
            finishReason = value.finishReason;
            usage = value.usage;
            if (value.providerMetadata) providerMetadata = value.providerMetadata;
            break;

          case 'error': {
            throw formatStreamError(value.error, model.modelId);
          }

          case 'tool-input-start':
          case 'tool-input-delta':
          case 'tool-input-end':
          case 'raw':
            // tool-input-* parts are intermediate; the canonical tool-call
            // part arrives separately. raw is telemetry passthrough only.
            break;
        }
      }
    } finally {
      reader.releaseLock();
    }

    return {
      content,
      finishReason,
      usage,
      providerMetadata,
      warnings,
      request,
      response: responseMetadata,
    };
  },
});
