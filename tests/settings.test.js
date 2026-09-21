const { test } = require('node:test');
const assert = require('node:assert/strict');

// 🔴 테스트 파일은 **병렬로** 돈다 — 설정을 공유하면 서로의 값을 덮어쓴다(경합은 초록불도 만든다)
process.env.SETTINGS_FILE = require('node:path').join(require('node:os').tmpdir(), `ss-set-settings-${process.pid}.json`);

test('getEffectiveAiConfig exposes runtime model and budget', () => {
  const { getEffectiveAiConfig, getPresetById, AI_PRESETS } = require('../server/settingsService');
  const config = getEffectiveAiConfig();
  assert.ok(config.model);
  assert.equal(typeof config.thinkingBudget, 'number');
  assert.equal(typeof config.includeThoughts, 'boolean');
  assert.ok(AI_PRESETS.length >= 2);
  assert.ok(getPresetById('balanced'));
});
