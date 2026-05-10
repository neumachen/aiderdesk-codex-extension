import { describe, expect, it } from 'vitest';

import type { AgentStartedEvent, ExtensionContext, ProviderProfile, SettingsData } from '@aiderdesk/extensions';

import AiderDeskCodexExtension from '../index';

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
        version: '1.0.0',
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

  describe('strategy.loadModels', () => {
    it('returns 4 reasoning-tier variants for each of 5 base models', async () => {
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
  });

  describe('strategy.getProviderOptions', () => {
    it('forwards the reasoning tier parsed from the model id', () => {
      const ext = new AiderDeskCodexExtension();
      const [provider] = ext.getProviders(stubContext);
      if (!provider) throw new Error('expected at least one provider');

      const opts = provider.strategy.getProviderOptions?.({ id: 'gpt-5.5-xhigh' } as never);
      expect(opts?.openai).toMatchObject({ store: true, reasoningEffort: 'xhigh' });

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
});
