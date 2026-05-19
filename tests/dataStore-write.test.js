const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { writeJson, readJson } = require('../server/dataStore');

test('writeJson uses atomic rename', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'simplestock-ds-'));
  const filePath = path.join(dir, 'sample.json');
  const payload = { ok: true, n: 1 };
  writeJson(filePath, payload);
  assert.deepEqual(readJson(filePath, () => ({})), payload);
  const files = fs.readdirSync(dir);
  assert.equal(files.filter((name) => name.includes('.tmp')).length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
