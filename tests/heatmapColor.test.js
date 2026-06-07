const { test } = require('node:test');
const assert = require('node:assert/strict');

async function loadHeatmapColor() {
  return import('../frontend/src/lib/heatmapColor.js');
}

test('heatmapStyleFromChangePct returns neutral for null', async () => {
  const { heatmapStyleFromChangePct } = await loadHeatmapColor();
  const style = heatmapStyleFromChangePct(null);
  assert.match(style.background, /heatmap-neutral/);
});

test('heatmapStyleFromChangePct tints green for positive', async () => {
  const { heatmapStyleFromChangePct } = await loadHeatmapColor();
  const style = heatmapStyleFromChangePct(3.2);
  assert.match(style.background, /74,\s*158,\s*120/);
});

test('heatmapStyleFromChangePct tints red for negative', async () => {
  const { heatmapStyleFromChangePct } = await loadHeatmapColor();
  const style = heatmapStyleFromChangePct(-2.1);
  assert.match(style.background, /184,\s*90,\s*98/);
});

test('formatChangePct formats signed percent', async () => {
  const { formatChangePct } = await loadHeatmapColor();
  assert.equal(formatChangePct(1.234), '+1.23%');
  assert.equal(formatChangePct(-0.5), '-0.50%');
  assert.equal(formatChangePct(null), '—');
});
