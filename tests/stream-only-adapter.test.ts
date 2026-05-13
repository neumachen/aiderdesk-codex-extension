import { describe, expect, it, vi } from 'vitest';

import type { LanguageModelV2, LanguageModelV2CallOptions, LanguageModelV2StreamPart } from '@ai-sdk/provider';

import { wrapStreamOnly } from '../stream-only-adapter';

const stubCallOptions: LanguageModelV2CallOptions = {
  prompt: [],
} as unknown as LanguageModelV2CallOptions;

const mkStream = (parts: LanguageModelV2StreamPart[]): ReadableStream<LanguageModelV2StreamPart> =>
  new ReadableStream<LanguageModelV2StreamPart>({
    start(controller) {
      for (const p of parts) controller.enqueue(p);
      controller.close();
    },
  });

const mkModel = (
  parts: LanguageModelV2StreamPart[],
  extras: { request?: { body?: unknown }; response?: { headers?: Record<string, string> } } = {},
): LanguageModelV2 => ({
  specificationVersion: 'v2',
  provider: 'codex-auth',
  modelId: 'gpt-5.5',
  supportedUrls: {},
  doStream: vi.fn().mockResolvedValue({ stream: mkStream(parts), ...extras }),
  doGenerate: vi.fn().mockRejectedValue(new Error('doGenerate should not be called')),
});

describe('wrapStreamOnly', () => {
  it('routes doGenerate through doStream and never invokes the underlying doGenerate', async () => {
    const inner = mkModel([
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'Hello, ' },
      { type: 'text-delta', id: 't1', delta: 'world!' },
      { type: 'text-end', id: 't1' },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
      },
    ]);

    const wrapped = wrapStreamOnly(inner);
    const result = await wrapped.doGenerate(stubCallOptions);

    expect(inner.doStream).toHaveBeenCalledTimes(1);
    expect(inner.doGenerate).not.toHaveBeenCalled();
    expect(result.content).toEqual([{ type: 'text', text: 'Hello, world!', providerMetadata: undefined }]);
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 3, totalTokens: 8 });
  });

  it('preserves stream-emission order across reasoning and text parts', async () => {
    const inner = mkModel([
      { type: 'stream-start', warnings: [] },
      { type: 'reasoning-start', id: 'r1' },
      { type: 'reasoning-delta', id: 'r1', delta: 'thinking...' },
      { type: 'reasoning-end', id: 'r1' },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'answer' },
      { type: 'text-end', id: 't1' },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
    ]);

    const result = await wrapStreamOnly(inner).doGenerate(stubCallOptions);

    expect(result.content.map((c) => c.type)).toEqual(['reasoning', 'text']);
    expect((result.content[0] as { text: string }).text).toBe('thinking...');
    expect((result.content[1] as { text: string }).text).toBe('answer');
  });

  it('captures warnings from stream-start and response-metadata fields', async () => {
    const ts = new Date('2026-05-13T03:20:13.000Z');
    const inner = mkModel([
      { type: 'stream-start', warnings: [{ type: 'other', message: 'unsupported foo' }] },
      { type: 'response-metadata', id: 'resp_1', timestamp: ts, modelId: 'gpt-5.5' },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'ok' },
      { type: 'text-end', id: 't1' },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
    ]);

    const result = await wrapStreamOnly(inner).doGenerate(stubCallOptions);

    expect(result.warnings).toEqual([{ type: 'other', message: 'unsupported foo' }]);
    expect(result.response).toMatchObject({ id: 'resp_1', timestamp: ts, modelId: 'gpt-5.5' });
  });

  it('appends tool-call parts as-is in stream order', async () => {
    const inner = mkModel([
      { type: 'stream-start', warnings: [] },
      { type: 'tool-call', toolCallId: 'tc_1', toolName: 'do_thing', input: '{"a":1}' },
      {
        type: 'finish',
        finishReason: 'tool-calls',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
    ]);

    const result = await wrapStreamOnly(inner).doGenerate(stubCallOptions);

    expect(result.content).toEqual([{ type: 'tool-call', toolCallId: 'tc_1', toolName: 'do_thing', input: '{"a":1}' }]);
    expect(result.finishReason).toBe('tool-calls');
  });

  it('passes doStream through to the inner model so streamText keeps its native streaming path', async () => {
    const inner = mkModel([]);
    const wrapped = wrapStreamOnly(inner);

    const opts = { foo: 'bar' } as unknown as LanguageModelV2CallOptions;
    await wrapped.doStream(opts);

    expect(inner.doStream).toHaveBeenCalledTimes(1);
    expect(inner.doStream).toHaveBeenCalledWith(expect.objectContaining({ foo: 'bar' }));
  });

  it('strips maxOutputTokens before calling doStream (Codex rejects it as Unsupported parameter)', async () => {
    const inner = mkModel([]);
    const wrapped = wrapStreamOnly(inner);

    const opts = { prompt: [], maxOutputTokens: 128000 } as unknown as LanguageModelV2CallOptions;
    await wrapped.doStream(opts);

    const forwarded = (inner.doStream as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(forwarded.maxOutputTokens).toBeUndefined();
  });

  it('strips maxOutputTokens on the doGenerate path too', async () => {
    const inner = mkModel([
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'ok' },
      { type: 'text-end', id: 't1' },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
    ]);
    const wrapped = wrapStreamOnly(inner);

    const opts = { prompt: [], maxOutputTokens: 128000 } as unknown as LanguageModelV2CallOptions;
    await wrapped.doGenerate(opts);

    const forwarded = (inner.doStream as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(forwarded.maxOutputTokens).toBeUndefined();
  });

  it('does not mutate the caller-supplied options object', async () => {
    const inner = mkModel([]);
    const wrapped = wrapStreamOnly(inner);

    const opts = { prompt: [], maxOutputTokens: 128000 } as unknown as LanguageModelV2CallOptions & {
      maxOutputTokens: number;
    };
    await wrapped.doStream(opts);

    expect(opts.maxOutputTokens).toBe(128000);
  });

  it('throws when the stream emits an error part', async () => {
    const inner = mkModel([
      { type: 'stream-start', warnings: [] },
      { type: 'error', error: new Error('upstream blew up') },
    ]);

    await expect(wrapStreamOnly(inner).doGenerate(stubCallOptions)).rejects.toThrow('upstream blew up');
  });

  it('wraps non-Error error payloads from the error part', async () => {
    const inner = mkModel([
      { type: 'stream-start', warnings: [] },
      { type: 'error', error: 'string error' },
    ]);

    await expect(wrapStreamOnly(inner).doGenerate(stubCallOptions)).rejects.toThrow('string error');
  });

  it('forwards request/response metadata from doStream onto the doGenerate result', async () => {
    const inner = mkModel(
      [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'hi' },
        { type: 'text-end', id: 't1' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
      { request: { body: { foo: 'bar' } }, response: { headers: { 'x-request-id': 'abc' } } },
    );

    const result = await wrapStreamOnly(inner).doGenerate(stubCallOptions);

    expect(result.request).toEqual({ body: { foo: 'bar' } });
    expect(result.response?.headers).toEqual({ 'x-request-id': 'abc' });
  });

  it('forwards provider, modelId, specificationVersion, and supportedUrls from the inner model', () => {
    const inner = mkModel([]);
    const wrapped = wrapStreamOnly(inner);

    expect(wrapped.specificationVersion).toBe('v2');
    expect(wrapped.provider).toBe('codex-auth');
    expect(wrapped.modelId).toBe('gpt-5.5');
    expect(wrapped.supportedUrls).toBe(inner.supportedUrls);
  });

  it('handles deltas that arrive before their text-start (defensive)', async () => {
    const inner = mkModel([
      { type: 'stream-start', warnings: [] },
      { type: 'text-delta', id: 't1', delta: 'a' },
      { type: 'text-delta', id: 't1', delta: 'b' },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
    ]);

    const result = await wrapStreamOnly(inner).doGenerate(stubCallOptions);

    expect(result.content).toEqual([{ type: 'text', text: 'ab', providerMetadata: undefined }]);
  });
});
