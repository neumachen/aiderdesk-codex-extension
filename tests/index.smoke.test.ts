import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentStartedEvent, ExtensionContext, ProviderProfile, SettingsData } from '@aiderdesk/extensions';

import AiderDeskCodexExtension, { advertisedInputBudget, parseRegistry, parseRegistryEntry } from '../index';

const stubContext = { log: () => {} } as unknown as ExtensionContext;

const mkAgentStartedEvent = (
  model: string,
  systemPrompt: string | undefined,
  providerName = 'codex-auth',
): AgentStartedEvent =>
  ({
    mode: 'code',
    prompt: null,
    agentProfile: {},
    providerProfile: { provider: { name: providerName } },
    model,
    systemPrompt,
    contextMessages: [],
    contextFiles: [],
  }) as unknown as AgentStartedEvent;

describe('AiderDeskCodexExtension', () => {
  describe('metadata', () => {
    it('matches the expected name, version, and author', () => {
      expect(AiderDeskCodexExtension.metadata).toMatchObject({
        name: 'AiderDesk Codex Extension',
        version: '1.3.0',
        author: 'Kareem Hepburn',
      });
    });
  });

  describe('getProviders', () => {
    it('registers a single codex-auth provider', () => {
      const ext = new AiderDeskCodexExtension();
      const providers = ext.getProviders(stubContext);

      expect(providers).toHaveLength(1);
      expect(providers[0]).toMatchObject({
        id: 'codex-auth',
        name: 'Codex Auth',
        provider: { name: 'codex-auth' },
      });
      expect(providers[0]?.strategy.createLlm).toBeTypeOf('function');
      expect(providers[0]?.strategy.loadModels).toBeTypeOf('function');
      expect(providers[0]?.strategy.getProviderOptions).toBeTypeOf('function');
    });
  });

  describe('strategy.loadModels (hardcoded fallback path)', () => {
    beforeEach(() => {
      // Force the hardcoded fallback so the assertion is independent of what
      // happens to live in ~/.codex/ on the test machine.
      vi.stubEnv('CODEX_FALLBACK_MODELS_ONLY', '1');
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('returns 4 reasoning-tier variants for each of 5 fallback base models', async () => {
      const ext = new AiderDeskCodexExtension();
      const [provider] = ext.getProviders(stubContext);
      if (!provider) throw new Error('expected at least one provider');

      const profile = { id: 'test-profile' } as unknown as ProviderProfile;
      const settings = {} as unknown as SettingsData;

      const result = await provider.strategy.loadModels(profile, settings);

      expect(result.success).toBe(true);
      expect(result.models).toBeDefined();
      expect(result.models).toHaveLength(20);

      const ids = result.models?.map((m) => m.id) ?? [];
      for (const tier of ['low', 'medium', 'high', 'xhigh']) {
        expect(ids).toContain(`gpt-5.5-${tier}`);
      }
      for (const slug of ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.2']) {
        expect(ids).toContain(`${slug}-medium`);
      }

      expect(result.models?.every((m) => m.providerId === 'test-profile')).toBe(true);
    });

    it('advertises a buffered maxInputTokens (contextWindow - output - headroom), not the raw window', async () => {
      const ext = new AiderDeskCodexExtension();
      const [provider] = ext.getProviders(stubContext);
      if (!provider) throw new Error('expected at least one provider');

      const profile = { id: 'test-profile' } as unknown as ProviderProfile;
      const settings = {} as unknown as SettingsData;

      const result = await provider.strategy.loadModels(profile, settings);

      // Fallback models all use DEFAULT_CONTEXT_WINDOW (272_000); the advertised
      // budget must reserve room for the worst-case output + headroom.
      const expected = advertisedInputBudget(272000);
      expect(result.models?.every((m) => m.maxInputTokens === expected)).toBe(true);
      expect(result.models?.every((m) => (m.maxInputTokens ?? 0) < 272000)).toBe(true);
    });
  });

  describe('advertisedInputBudget', () => {
    it('subtracts output budget and safety headroom from the context window', () => {
      // 272_000 − 128_000 (DEFAULT_MAX_OUTPUT_TOKENS) − 8_192 (headroom)
      expect(advertisedInputBudget(272000)).toBe(135808);
    });

    it('floors at 1024 so a misconfigured tiny window never goes negative', () => {
      expect(advertisedInputBudget(8000)).toBe(1024);
      expect(advertisedInputBudget(100)).toBe(1024);
      expect(advertisedInputBudget(0)).toBe(1024);
    });
  });

  describe('strategy.getProviderOptions', () => {
    it('forwards the reasoning tier parsed from the model id', () => {
      const ext = new AiderDeskCodexExtension();
      const [provider] = ext.getProviders(stubContext);
      if (!provider) throw new Error('expected at least one provider');

      const opts = provider.strategy.getProviderOptions?.({ id: 'gpt-5.5-xhigh' } as never);
      expect(opts?.openai).toMatchObject({ store: false, reasoningEffort: 'xhigh' });

      const lowOpts = provider.strategy.getProviderOptions?.({ id: 'gpt-5.4-low' } as never);
      expect(lowOpts?.openai).toMatchObject({ reasoningEffort: 'low' });
    });

    it('falls back to medium for unknown id shapes', () => {
      const ext = new AiderDeskCodexExtension();
      const [provider] = ext.getProviders(stubContext);
      if (!provider) throw new Error('expected at least one provider');

      const opts = provider.strategy.getProviderOptions?.({ id: 'mystery-model' } as never);
      expect(opts?.openai).toMatchObject({ reasoningEffort: 'medium' });
    });

    describe('CODEX_STORE env gate', () => {
      afterEach(() => {
        vi.unstubAllEnvs();
      });

      it('defaults store to false when unset', () => {
        vi.stubEnv('CODEX_STORE', '');
        const ext = new AiderDeskCodexExtension();
        const [provider] = ext.getProviders(stubContext);
        const opts = provider?.strategy.getProviderOptions?.({ id: 'gpt-5.5-medium' } as never);
        expect(opts?.openai).toMatchObject({ store: false });
      });

      it.each(['true', '1'])('honors CODEX_STORE=%s by setting store to true', (value) => {
        vi.stubEnv('CODEX_STORE', value);
        const ext = new AiderDeskCodexExtension();
        const [provider] = ext.getProviders(stubContext);
        const opts = provider?.strategy.getProviderOptions?.({ id: 'gpt-5.5-medium' } as never);
        expect(opts?.openai).toMatchObject({ store: true });
      });

      it('treats other values as falsy', () => {
        vi.stubEnv('CODEX_STORE', 'false');
        const ext = new AiderDeskCodexExtension();
        const [provider] = ext.getProviders(stubContext);
        const opts = provider?.strategy.getProviderOptions?.({ id: 'gpt-5.5-medium' } as never);
        expect(opts?.openai).toMatchObject({ store: false });
      });
    });
  });

  describe('onAgentStarted + getProviderOptions', () => {
    it('scopes system prompts by model id so concurrent runs do not clobber each other', async () => {
      const ext = new AiderDeskCodexExtension();

      await ext.onAgentStarted(mkAgentStartedEvent('gpt-5.5-high', 'system A'));
      await ext.onAgentStarted(mkAgentStartedEvent('gpt-5.4-low', 'system B'));

      const [provider] = ext.getProviders(stubContext);
      if (!provider) throw new Error('expected at least one provider');

      const optsA = provider.strategy.getProviderOptions?.({ id: 'gpt-5.5-high' } as never);
      const optsB = provider.strategy.getProviderOptions?.({ id: 'gpt-5.4-low' } as never);

      expect(optsA?.openai).toMatchObject({ instructions: 'system A' });
      expect(optsB?.openai).toMatchObject({ instructions: 'system B' });
    });

    it('clears the prompt when the agent starts with no systemPrompt', async () => {
      const ext = new AiderDeskCodexExtension();

      await ext.onAgentStarted(mkAgentStartedEvent('gpt-5.5-high', 'initial'));
      await ext.onAgentStarted(mkAgentStartedEvent('gpt-5.5-high', undefined));

      const [provider] = ext.getProviders(stubContext);
      if (!provider) throw new Error('expected at least one provider');

      const opts = provider.strategy.getProviderOptions?.({ id: 'gpt-5.5-high' } as never);
      expect(opts?.openai).toMatchObject({ instructions: '' });
    });

    it('ignores agent-started events from other providers', async () => {
      const ext = new AiderDeskCodexExtension();

      await ext.onAgentStarted(mkAgentStartedEvent('gpt-5.5-high', 'leak attempt', 'some-other-provider'));

      const [provider] = ext.getProviders(stubContext);
      if (!provider) throw new Error('expected at least one provider');

      const opts = provider.strategy.getProviderOptions?.({ id: 'gpt-5.5-high' } as never);
      expect(opts?.openai).toMatchObject({ instructions: '' });
    });

    it('rewrites the event to clear the systemPrompt for forwarding via instructions', async () => {
      const ext = new AiderDeskCodexExtension();
      const result = await ext.onAgentStarted(mkAgentStartedEvent('gpt-5.5-high', 'forwarded prompt'));
      expect(result).toEqual({ systemPrompt: '' });
    });
  });

  describe('strategy.isRetryable', () => {
    const getStrategy = () => {
      const ext = new AiderDeskCodexExtension();
      const [provider] = ext.getProviders(stubContext);
      if (!provider) throw new Error('expected at least one provider');
      return provider.strategy;
    };

    it.each([
      { name: 'top-level statusCode', error: { statusCode: 401 } },
      { name: 'top-level status', error: { status: 401 } },
      { name: 'nested response.status', error: { response: { status: 401 } } },
      { name: 'message contains 401', error: { message: 'Request failed with 401 Unauthorized' } },
    ])('marks 401 errors as retryable: $name', ({ error }) => {
      expect(getStrategy().isRetryable?.(error)).toBe(true);
    });

    it.each([
      { name: '500 server error', error: { statusCode: 500 } },
      { name: 'plain Error', error: new Error('boom') },
      { name: 'undefined', error: undefined },
      { name: 'null', error: null },
      { name: 'string with 4012 (no word boundary)', error: { message: 'something 4012 something' } },
    ])('does not mark non-401 errors as retryable: $name', ({ error }) => {
      expect(getStrategy().isRetryable?.(error)).toBe(false);
    });
  });
});

describe('parseRegistryEntry', () => {
  it('parses a typical live-registry entry', () => {
    const result = parseRegistryEntry({
      slug: 'gpt-5.5',
      context_window: 272000,
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }],
      visibility: 'list',
      supported_in_api: true,
    });
    expect(result).toEqual({
      slug: 'gpt-5.5',
      contextWindow: 272000,
      reasoningTiers: ['low', 'medium', 'high', 'xhigh'],
    });
  });

  it('drops entries hidden from the list', () => {
    expect(parseRegistryEntry({ slug: 'codex-auto-review', visibility: 'hide' })).toBeNull();
  });

  it('drops entries that are not API-supported', () => {
    expect(parseRegistryEntry({ slug: 'gpt-5.3-codex-spark', supported_in_api: false })).toBeNull();
  });

  it('drops unknown reasoning tiers and dedupes', () => {
    const result = parseRegistryEntry({
      slug: 'gpt-5.5',
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'extreme' }, { effort: 'high' }, { effort: 'low' }],
    });
    expect(result?.reasoningTiers).toEqual(['low', 'high']);
  });

  it('falls back to all known tiers when the entry omits supported_reasoning_levels', () => {
    expect(parseRegistryEntry({ slug: 'gpt-5.5' })?.reasoningTiers).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('falls back to all known tiers when no level matches the canonical set', () => {
    expect(
      parseRegistryEntry({
        slug: 'gpt-5.5',
        supported_reasoning_levels: [{ effort: 'extreme' }, { effort: 'plaid' }],
      })?.reasoningTiers,
    ).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('falls back to default context window for missing or invalid values', () => {
    expect(parseRegistryEntry({ slug: 'gpt-5.5' })?.contextWindow).toBe(272000);
    expect(parseRegistryEntry({ slug: 'gpt-5.5', context_window: 0 })?.contextWindow).toBe(272000);
    expect(parseRegistryEntry({ slug: 'gpt-5.5', context_window: 'huge' })?.contextWindow).toBe(272000);
  });

  it.each([null, undefined, 'string', 42, true, {}, { slug: '' }, { slug: 123 }])(
    'rejects invalid input: %s',
    (raw) => {
      expect(parseRegistryEntry(raw)).toBeNull();
    },
  );
});

describe('parseRegistry', () => {
  it('parses the {models: [...]} envelope used by /models and models_cache.json', () => {
    const result = parseRegistry({ models: [{ slug: 'gpt-5.5' }, { slug: 'gpt-5.4' }] });
    expect(result.map((m) => m.slug)).toEqual(['gpt-5.5', 'gpt-5.4']);
  });

  it('parses a bare array', () => {
    const result = parseRegistry([{ slug: 'gpt-5.5' }, { slug: 'gpt-5.4' }]);
    expect(result.map((m) => m.slug)).toEqual(['gpt-5.5', 'gpt-5.4']);
  });

  it('skips invalid entries inline', () => {
    const result = parseRegistry({
      models: [
        { slug: 'gpt-5.5' },
        null,
        { slug: 'codex-auto-review', visibility: 'hide' },
        { slug: 'gpt-5.3-codex-spark', supported_in_api: false },
        { slug: 'gpt-5.4' },
      ],
    });
    expect(result.map((m) => m.slug)).toEqual(['gpt-5.5', 'gpt-5.4']);
  });

  it.each([null, undefined, 42, 'foo', { data: [] }])('returns empty for unrecognized shape: %s', (data) => {
    expect(parseRegistry(data)).toEqual([]);
  });
});
