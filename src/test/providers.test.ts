import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectProvider, extractModel, extractUsage, extractResponseText } from '../proxy/providers';

describe('detectProvider', () => {
  it('detects Anthropic from /v1/messages', () => {
    const result = detectProvider('/v1/messages', {});
    assert.ok(result);
    assert.equal(result.name, 'anthropic');
  });

  it('detects OpenAI from /v1/chat/completions', () => {
    const result = detectProvider('/v1/chat/completions', {});
    assert.ok(result);
    assert.equal(result.name, 'openai');
  });

  it('detects Gemini from /v1beta/ paths', () => {
    const result = detectProvider('/v1beta/models/gemini-pro:generateContent', {});
    assert.ok(result);
    assert.equal(result.name, 'gemini');
  });

  it('returns null for unknown paths', () => {
    const result = detectProvider('/unknown/path', {});
    assert.equal(result, null);
  });

  it('detects Anthropic via x-api-key header on /v1/ paths', () => {
    const result = detectProvider('/v1/chat/completions', { 'x-api-key': 'sk-ant-xxx' });
    assert.ok(result);
    assert.equal(result.name, 'anthropic');
  });

  it('detects OpenAI when authorization header is present', () => {
    const result = detectProvider('/v1/chat/completions', { 'authorization': 'Bearer sk-xxx' });
    assert.ok(result);
    assert.equal(result.name, 'openai');
  });
});

describe('extractModel', () => {
  it('extracts model from body', () => {
    assert.equal(extractModel({ model: 'gpt-4o' }), 'gpt-4o');
  });

  it('returns unknown for missing model', () => {
    assert.equal(extractModel({}), 'unknown');
  });

  it('returns unknown for non-object input', () => {
    assert.equal(extractModel(null), 'unknown');
    assert.equal(extractModel('string'), 'unknown');
  });
});

describe('extractUsage', () => {
  it('extracts Anthropic usage format', () => {
    const usage = extractUsage('anthropic', {
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    assert.equal(usage.tokensIn, 100);
    assert.equal(usage.tokensOut, 50);
  });

  it('extracts OpenAI usage format', () => {
    const usage = extractUsage('openai', {
      usage: { prompt_tokens: 200, completion_tokens: 80 },
    });
    assert.equal(usage.tokensIn, 200);
    assert.equal(usage.tokensOut, 80);
  });

  it('returns zeros for missing usage', () => {
    const usage = extractUsage('anthropic', {});
    assert.equal(usage.tokensIn, 0);
    assert.equal(usage.tokensOut, 0);
  });

  it('returns zeros for null body', () => {
    const usage = extractUsage('anthropic', null);
    assert.equal(usage.tokensIn, 0);
    assert.equal(usage.tokensOut, 0);
  });
});

describe('extractResponseText', () => {
  it('extracts Anthropic content blocks', () => {
    const text = extractResponseText('anthropic', {
      content: [
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'world' },
      ],
    });
    assert.equal(text, 'Hello world');
  });

  it('extracts OpenAI choices format', () => {
    const text = extractResponseText('openai', {
      choices: [{ message: { content: 'Hello from GPT' } }],
    });
    assert.equal(text, 'Hello from GPT');
  });

  it('returns empty string for missing content', () => {
    assert.equal(extractResponseText('anthropic', {}), '');
    assert.equal(extractResponseText('openai', null), '');
  });
});
