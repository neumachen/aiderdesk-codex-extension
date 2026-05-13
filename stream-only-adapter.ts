import type {
  LanguageModelV2,
  LanguageModelV2CallWarning,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2ResponseMetadata,
  LanguageModelV2Usage,
  SharedV2Headers,
  SharedV2ProviderMetadata,
} from '@ai-sdk/provider';

// The ChatGPT-backed Codex `/responses` endpoint rejects non-streaming requests
// with `400 Bad Request: {"detail":"Stream must be set to true"}`. AiderDesk's
// handoff conversation flow calls the model via `generateText` (non-streaming),
// which would otherwise fail on every handoff. This wrapper makes any
// `doGenerate` call internally drive `doStream` and assemble a non-streaming
// result, so callers never see the protocol mismatch.

export const wrapStreamOnly = (model: LanguageModelV2): LanguageModelV2 => ({
  specificationVersion: 'v2',
  provider: model.provider,
  modelId: model.modelId,
  supportedUrls: model.supportedUrls,
  doStream: (options) => model.doStream(options),
  doGenerate: async (options) => {
    const { stream, request, response: streamResponse } = await model.doStream(options);

    // Streamed text and reasoning arrive as start/delta*/end triples keyed by
    // id. We keep one mutable Content entry per id and append deltas in-place
    // so the final ordering matches the order the model emitted parts in.
    const content: LanguageModelV2Content[] = [];
    const textIndexById = new Map<string, number>();
    const reasoningIndexById = new Map<string, number>();

    let finishReason: LanguageModelV2FinishReason = 'unknown';
    let usage: LanguageModelV2Usage = {
      inputTokens: undefined,
      outputTokens: undefined,
      totalTokens: undefined,
    };
    let providerMetadata: SharedV2ProviderMetadata | undefined;
    let warnings: LanguageModelV2CallWarning[] = [];
    const responseMetadata: LanguageModelV2ResponseMetadata & {
      headers?: SharedV2Headers;
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
            const entry = content[idx] as LanguageModelV2Content & { type: 'text' };
            entry.text += value.delta;
            break;
          }

          case 'text-end': {
            const idx = textIndexById.get(value.id);
            if (idx !== undefined && value.providerMetadata) {
              const entry = content[idx] as LanguageModelV2Content & { type: 'text' };
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
            const entry = content[idx] as LanguageModelV2Content & { type: 'reasoning' };
            entry.text += value.delta;
            break;
          }

          case 'reasoning-end': {
            const idx = reasoningIndexById.get(value.id);
            if (idx !== undefined && value.providerMetadata) {
              const entry = content[idx] as LanguageModelV2Content & { type: 'reasoning' };
              entry.providerMetadata = value.providerMetadata;
            }
            break;
          }

          case 'tool-call':
          case 'tool-result':
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
            const err = value.error;
            throw err instanceof Error ? err : new Error(typeof err === 'string' ? err : JSON.stringify(err));
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
