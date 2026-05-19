const { test } = require('node:test');
const assert = require('node:assert/strict');

test('getEffectiveAiConfig exposes runtime model and budget', () => {
  const { getEffectiveAiConfig, getPresetById, AI_PRESETS } = require('../server/settingsService');
  const config = getEffectiveAiConfig();
  assert.ok(config.model);
  assert.equal(typeof config.thinkingBudget, 'number');
  assert.equal(typeof config.includeThoughts, 'boolean');
  assert.ok(AI_PRESETS.length >= 2);
  assert.ok(getPresetById('balanced'));
});
