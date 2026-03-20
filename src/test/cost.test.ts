import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { calculateCost, getModelProfile, registerModelProfile } from '../core/cost';

describe('calculateCost', () => {
  it('returns correct cost for claude-sonnet-4-6', () => {
    const result = calculateCost('anthropic', 'claude-sonnet-4-6', 1_000_000, 1_000_000);
    assert.equal(result.inputCost, 3);    // $3 per 1M input
    assert.equal(result.outputCost, 15);   // $15 per 1M output
    assert.equal(result.totalCost, 18);
  });

  it('returns correct cost for claude-opus-4-6', () => {
    const result = calculateCost('anthropic', 'claude-opus-4-6', 1_000_000, 1_000_000);
    assert.equal(result.inputCost, 15);
    assert.equal(result.outputCost, 75);
    assert.equal(result.totalCost, 90);
  });

  it('returns correct cost for gpt-4o', () => {
    const result = calculateCost('openai', 'gpt-4o', 1_000_000, 1_000_000);
    assert.equal(result.inputCost, 2.5);
    assert.equal(result.outputCost, 10);
  });

  it('returns zero cost for unknown model', () => {
    const result = calculateCost('unknown', 'nonexistent-model', 1000, 500);
    assert.equal(result.totalCost, 0);
  });

  it('returns zero cost for ollama models', () => {
    const result = calculateCost('ollama', 'llama3', 100_000, 50_000);
    assert.equal(result.totalCost, 0);
  });

  it('handles zero tokens', () => {
    const result = calculateCost('anthropic', 'claude-sonnet-4-6', 0, 0);
    assert.equal(result.totalCost, 0);
  });

  it('calculates proportional cost for small token counts', () => {
    const result = calculateCost('anthropic', 'claude-sonnet-4-6', 1000, 100);
    // 1000/1M * 3 = 0.003, 100/1M * 15 = 0.0015
    assert.ok(Math.abs(result.inputCost - 0.003) < 0.0001);
    assert.ok(Math.abs(result.outputCost - 0.0015) < 0.0001);
  });
});

describe('getModelProfile', () => {
  it('exact match', () => {
    const profile = getModelProfile('anthropic', 'claude-sonnet-4-6');
    assert.ok(profile);
    assert.equal(profile.inputPricePer1M, 3);
  });

  it('prefix match (model without date suffix)', () => {
    const profile = getModelProfile('anthropic', 'claude-3-5-sonnet');
    assert.ok(profile);
    assert.equal(profile.model, 'claude-3-5-sonnet-20241022');
  });

  it('reverse prefix match (model with extra suffix)', () => {
    const profile = getModelProfile('anthropic', 'claude-sonnet-4-6-latest');
    assert.ok(profile);
    assert.equal(profile.inputPricePer1M, 3);
  });

  it('returns undefined for unknown model', () => {
    const profile = getModelProfile('unknown', 'nonexistent');
    assert.equal(profile, undefined);
  });
});

describe('registerModelProfile', () => {
  it('registers and retrieves a custom model', () => {
    registerModelProfile({
      provider: 'custom',
      model: 'test-model-v1',
      inputPricePer1M: 5,
      outputPricePer1M: 25,
    });

    const profile = getModelProfile('custom', 'test-model-v1');
    assert.ok(profile);
    assert.equal(profile.inputPricePer1M, 5);
    assert.equal(profile.outputPricePer1M, 25);

    const cost = calculateCost('custom', 'test-model-v1', 1_000_000, 1_000_000);
    assert.equal(cost.totalCost, 30);
  });

  it('overwrites existing model profile', () => {
    registerModelProfile({
      provider: 'custom',
      model: 'test-model-v1',
      inputPricePer1M: 10,
      outputPricePer1M: 50,
    });

    const cost = calculateCost('custom', 'test-model-v1', 1_000_000, 1_000_000);
    assert.equal(cost.totalCost, 60);
  });
});
