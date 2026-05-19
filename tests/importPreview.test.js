const { test } = require('node:test');
const assert = require('node:assert/strict');

test('buildImportPreview returns diff for portfolio baseline text', () => {
  const { buildImportPreview } = require('../server/importPreviewService');
  const sample = `[Portfolio Baseline & Rules]
투자 전략: 바벨 (공격+방어)
미국 계좌 목표 비중: 60%
한국 계좌 목표 비중: 40%

[Korean Account (KRW)]
KB 예수금: 1,000,000원
`;
  const preview = buildImportPreview(sample);
  assert.equal(preview.available, true);
  assert.ok(preview.diff.length >= 1);
  assert.ok(preview.diff.some((item) => item.message.includes('KB')));
});
