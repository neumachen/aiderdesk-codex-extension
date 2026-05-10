import { describe, expect, it } from 'vitest';

import type { ExtensionContext, ProviderProfile, SettingsData } from '@aiderdesk/extensions';

import AiderDeskCodexExtension from '../index';

const stubContext = { log: () => {} } as unknown as ExtensionContext;

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
});
