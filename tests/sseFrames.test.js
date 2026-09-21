const { test } = require('node:test');
const assert = require('node:assert/strict');

/**
 * SSE 프레임 파서 (프론트 `lib/sse.js`) — 2026-09-21
 *
 * ## 왜 자를 대나
 *
 * 스트리밍이 **조용히 일부만 도착**하는 실패 모드는 화면에서 안 보인다 —
 * 답이 조금 짧게 끝날 뿐이라 "모델이 짧게 답했나 보다" 로 읽힌다.
 * 원인은 거의 항상 **청크 경계**다: `data:` 한 줄이 두 번에 나뉘어 오는데
 * 청크마다 파싱하면 그 프레임이 통째로 사라진다.
 *
 * ⚠️ 서버 쪽에서도 같은 층의 함정을 오늘 두 번 봤다(`data:` 뒤 공백 · JSON 인코딩).
 *    **경계·표기에서 깨지는 것들**이라 정상 경로 테스트로는 안 잡힌다.
 */

async function sse() {
  return import('../frontend/src/lib/sse.js');
}

test('온전한 프레임을 이벤트·데이터로 나눈다', async () => {
  const { parseFrames } = await sse();
  const { frames, rest } = parseFrames('event: text_delta\ndata: {"text":"안녕"}\n\n');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].event, 'text_delta');
  assert.deepEqual(frames[0].data, { text: '안녕' });
  assert.equal(rest, '');
});

/**
 * 🔴 **이 테스트가 이 파일의 이유다.**
 * 한 프레임이 두 청크에 나뉘어 와도 잃어버리면 안 된다.
 */
test('청크 경계에서 잘린 프레임을 잃어버리지 않는다', async () => {
  const { parseFrames } = await sse();
  const whole = 'event: text_delta\ndata: {"text":"반가워요"}\n\n';

  // 모든 위치에서 잘라 본다 — 한 군데라도 새면 실제로 그 자리에서 샌다
  for (let cut = 1; cut < whole.length; cut += 1) {
    const a = parseFrames(whole.slice(0, cut));
    const b = parseFrames(a.rest + whole.slice(cut));
    const got = [...a.frames, ...b.frames];
    assert.equal(got.length, 1, `cut=${cut} 에서 프레임이 ${got.length}개다`);
    assert.deepEqual(got[0].data, { text: '반가워요' }, `cut=${cut} 에서 내용이 깨졌다`);
  }
});

test('연속 프레임을 한 버퍼에서 모두 꺼낸다', async () => {
  const { parseFrames } = await sse();
  const buf =
    'event: text_delta\ndata: {"text":"가"}\n\n' +
    'event: text_delta\ndata: {"text":"나"}\n\n' +
    'event: text_delta\ndata: {"text":"다"}\n\n';
  const { frames, rest } = parseFrames(buf);
  assert.equal(frames.map((f) => f.data.text).join(''), '가나다');
  assert.equal(rest, '');
});

/** ⚠️ `data:` 뒤 공백은 **있을 수도 없을 수도** 있다(서버 구현마다 다르다) */
test('data 뒤 공백 유무를 둘 다 받는다', async () => {
  const { parseFrames } = await sse();
  assert.deepEqual(parseFrames('data: {"a":1}\n\n').frames[0].data, { a: 1 });
  assert.deepEqual(parseFrames('data:{"a":2}\n\n').frames[0].data, { a: 2 });
});

/** 여러 `data:` 줄은 이어 붙인다(긴 JSON 을 서버가 쪼갤 수 있다) */
test('여러 data 줄을 이어 붙인다', async () => {
  const { parseFrames } = await sse();
  const { frames } = parseFrames('event: x\ndata: {"a":\ndata: 3}\n\n');
  assert.deepEqual(frames[0].data, { a: 3 });
});

/**
 * 🔴 깨진 프레임을 **조용히 버리지 않는다.**
 * 버리면 "아무 일도 없었던 것" 이 되고, 화면은 답이 짧아진 이유를 영영 모른다.
 */
test('파싱 못 한 프레임도 원문을 들고 올라온다', async () => {
  const { parseFrames } = await sse();
  const { frames } = parseFrames('event: x\ndata: {깨진\n\n');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].data._unparsed, '{깨진');
});

test('아직 완성되지 않은 프레임은 버퍼에 남는다', async () => {
  const { parseFrames } = await sse();
  const { frames, rest } = parseFrames('event: x\ndata: {"a":1}\n');
  assert.equal(frames.length, 0, '완성 전에 꺼내면 반쪽 JSON 을 파싱하게 된다');
  assert.equal(rest, 'event: x\ndata: {"a":1}\n');
});
