import { describe, expect, it } from 'vitest';
import { describeRegistryCall } from '../main/services/registry-log';

describe('describeRegistryCall', () => {
  it('opisuje filtry wyszukiwania assetów i zachowuje je do rozwinięcia', () => {
    const result = describeRegistryCall({
      type: 'dynamicToolCall',
      namespace: 'registry',
      tool: 'search_assets',
      arguments: { query: 'kamienna droga', category: 'flat_tile', tags: ['mech', 'road'], statuses: ['approved'], limit: 5 },
    });

    expect(result.message).toContain('fraza „kamienna droga”');
    expect(result.message).toContain('kategoria flat_tile');
    expect(result.message).toContain('tagi: mech, road');
    expect(result.details).toEqual({
      tool: 'registry.search_assets',
      arguments: { query: 'kamienna droga', category: 'flat_tile', tags: ['mech', 'road'], statuses: ['approved'], limit: 5 },
    });
  });

  it('obsługuje zagnieżdżony wariant protokołu z argumentami JSON', () => {
    const result = describeRegistryCall({
      type: 'dynamicToolCall',
      toolCall: { name: 'registry.get_asset', arguments: '{"assetId":"asset-1","versionId":"version-2"}' },
    });

    expect(result.message).toContain('asset-1');
    expect(result.message).toContain('version-2');
    expect(result.details.tool).toBe('registry.get_asset');
  });

  it('opisuje pobranie projektowej referencji', () => {
    const result = describeRegistryCall({
      type: 'dynamicToolCall', namespace: 'registry', tool: 'get_reference', arguments: { referenceId: 'reference-1' },
    });
    expect(result.message).toContain('reference-1');
    expect(result.details).toEqual({ tool: 'registry.get_reference', arguments: { referenceId: 'reference-1' } });
  });

  it('pokazuje uzasadnienie i wartości propozycji ustawień', () => {
    const result = describeRegistryCall({
      type: 'dynamicToolCall', namespace: 'registry', tool: 'propose_project_settings',
      arguments: {
        reason: 'Referencja wymaga siatki 512×256.',
        settings: { tileWidthPx: 512 },
        referenceIds: ['reference-1'],
      },
    });
    expect(result.message).toContain('proponuje zmianę ustawień');
    expect(result.details).toEqual({
      tool: 'registry.propose_project_settings',
      arguments: {
        reason: 'Referencja wymaga siatki 512×256.',
        settings: { tileWidthPx: 512 },
        referenceIds: ['reference-1'],
      },
    });
  });
});
