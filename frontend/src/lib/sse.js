/**
 * POST 로 여는 SSE 리더 (2026-09-21)
 *
 * 🔴 `EventSource` 는 **GET 만** 된다. 대화는 본문을 실어야 하므로 `fetch` + 스트림 리더로 읽는다.
 *
 * ⚠️ 프레임은 **네트워크 경계에서 잘려서 온다** — `data:` 한 줄이 두 청크에 나뉠 수 있다.
 *    청크마다 파싱하면 조용히 일부만 받는다 ⇒ **버퍼에 모아 `\n\n` 단위**로만 잘라낸다.
 * ⚠️ `data:` 뒤 공백은 **있을 수도 없을 수도** 있다(같은 날 서버 쪽에서도 밟은 함정).
 */
export function parseFrames(buffer) {
  const frames = [];
  let rest = buffer;
  let idx;
  // eslint-disable-next-line no-cond-assign
  while ((idx = rest.indexOf('\n\n')) !== -1) {
    const raw = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    let event = 'message';
    const dataLines = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (!dataLines.length) continue;
    let data = null;
    try {
      data = JSON.parse(dataLines.join('\n'));
    } catch {
      // 🔴 깨진 프레임을 조용히 버리지 않는다 — 원문을 담아 화면이 알 수 있게 한다
      data = { _unparsed: dataLines.join('\n') };
    }
    frames.push({ event, data });
  }
  return { frames, rest };
}

/**
 * @param {Response} res fetch 응답
 * @param {(event:string, data:any)=>void} onEvent
 */
export async function readSse(res, onEvent) {
  if (!res.body) throw new Error('스트림을 받을 수 없습니다(본문 없음).');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const { frames, rest } = parseFrames(buf);
    buf = rest;
    for (const f of frames) onEvent(f.event, f.data);
  }
  // 마지막에 개행 없이 끝난 프레임도 흘리지 않는다
  const tail = parseFrames(`${buf}\n\n`);
  for (const f of tail.frames) onEvent(f.event, f.data);
}
