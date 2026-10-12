/**
 * 화면이 **실제로 그려지는가** 를 재는 하니스 (2026-10-12 신설)
 *
 * ## 왜 필요했나
 *
 * 분석 리포트 화면이 **통째로 비어 있는 것을 사용자가 먼저 발견했다.** 테스트 1022개가
 * 전부 초록이었고 `npm run build` 도 통과했다 — Vue 는 템플릿 바인딩이 실재하는지
 * 빌드 때 안 보고, 단위 테스트는 **브라우저에서 렌더되는가**를 원리상 못 본다.
 *
 * ## ⚠️ 쓸 수 없었던 길 셋 — 먼저 적어 둔다(다음 세션이 같은 걸 또 시도한다)
 *
 *   1. **시스템 Chrome 헤드리스** → 이 맥에서 `CVDisplayLinkCreateWithCGDisplay failed` 로 죽는다
 *   2. **Playwright 캐시 Chromium + LAN 주소** → macOS 로컬 네트워크 권한 때문에
 *      `ERR_ADDRESS_UNREACHABLE`. ⇒ **SSH 터널로 `127.0.0.1` 에 붙인다**(로컬호스트는 그 권한 밖)
 *   3. 🔴 **`--virtual-time-budget` + `--screenshot`/`--dump-dom`** → ES 모듈이 로드되기 전에 찍는다.
 *      **정상 화면도 똑같이 흰 PNG(7,279바이트)** 가 나와서 *"화면이 비었다"* 로 읽을 뻔했다.
 *      ★자를 먼저 의심한 덕에 걸렀다 — **정상이라고 아는 화면으로 대조**해서 갈렸다.
 *
 * ⇒ 유일하게 되는 길이 **CDP**(`--remote-debugging-port`)다. 의존성을 안 늘리려고
 *   WebSocket 클라이언트를 직접 썼다(텍스트 프레임만 다루면 짧다).
 *
 * ## 무엇을 판정하는가
 *
 *   · `main` 안의 **보이는 텍스트 길이** — 0 이면 렌더 실패다
 *   · **콘솔 에러·미처리 예외** — Vue 는 렌더 중 예외가 나면 서브트리를 버리고 **조용히** 끝낸다
 *   · 화면마다 **반드시 있어야 할 문구** — 있으면 "그려졌다", 없으면 어디가 빠졌는지 짚어 준다
 *
 * 사용법: `node verify/render-check.mjs [베이스URL]`  (기본 http://127.0.0.1:18099)
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';

/**
 * 🔴 **nginx 를 통과시켜야 한다.** 앱 포트(50000)에 직접 붙으면 `index.html` 은 200 인데
 *    그 안의 `<script src="/simpleStock/assets/…">` 가 404 라 **JS 가 아예 안 돈다**
 *    (증상: `body` 가 30바이트 = `<div id="app">` 뿐, 모든 화면이 똑같이 "0자").
 *    ★ 정상 화면도 같이 0 이 나오는 것이 **자가 틀렸다는 신호**였다.
 * 터널: `ssh -f -N -L 18099:127.0.0.1:80 homelab25`
 */
const BASE = process.argv[2] || 'http://127.0.0.1:18099/simpleStock';
const CHROME = '/Users/seunghyun.oh/Library/Caches/ms-playwright/chromium-1117/chrome-mac/Chromium.app/Contents/MacOS/Chromium';
const PORT = 9333;

/** 화면마다 "그려졌으면 반드시 보이는" 문구. 이름이 아니라 **사용자가 읽는 글자**로 고른다. */
const PAGES = [
  // ⚠️ 기대 문구는 **지금 화면에 실제로 있는 글자**로 — 낡으면 자가 멀쩡한 화면을 빨간불로 만든다
  { path: '/', name: '분석 리포트', must: ['분석 리포트', '국면'] },
  { path: '/portfolio', name: '포트폴리오', must: ['총평가액', '보유 종목', '한도 대비 현재 위치'] },
  { path: '/lab', name: '전략 연구소', must: ['전략'] },
  { path: '/activity', name: '활동 로그', must: ['활동'] },
  { path: '/settings', name: '설정', must: ['감시'] },
];

/* ── 최소 WebSocket 클라이언트 (텍스트 프레임 전용) ───────────────── */
function wsConnect(url) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(Number(u.port), u.hostname, () => {
      sock.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\n`
        + `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    let buf = Buffer.alloc(0);
    let open = false;
    const handlers = [];
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!open) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        if (!buf.slice(0, end).toString().includes('101')) { reject(new Error('핸드셰이크 실패')); return; }
        buf = buf.slice(end + 4); open = true;
        resolve({ send, onMessage: (fn) => handlers.push(fn), close: () => sock.destroy() });
      }
      // 프레임 파싱 — 서버(브라우저)는 마스킹하지 않는다
      for (;;) {
        if (buf.length < 2) return;
        const len0 = buf[1] & 0x7f;
        let off = 2; let len = len0;
        if (len0 === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len0 === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const payload = buf.slice(off, off + len).toString('utf8');
        buf = buf.slice(off + len);
        for (const h of handlers) h(payload);
      }
    });
    sock.on('error', reject);

    function send(obj) {
      const data = Buffer.from(JSON.stringify(obj), 'utf8');
      const mask = crypto.randomBytes(4);
      const masked = Buffer.from(data.map((b, i) => b ^ mask[i % 4]));
      let head;
      if (data.length < 126) head = Buffer.from([0x81, 0x80 | data.length]);
      else if (data.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0xfe; head.writeUInt16BE(data.length, 2); }
      else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 0xff; head.writeBigUInt64BE(BigInt(data.length), 2); }
      sock.write(Buffer.concat([head, mask, masked]));
    }
  });
}

/**
 * ⚠️ `/json/new` 는 요즘 Chromium 에서 **PUT** 을 요구한다. GET 으로 치면 JSON 이 아니라
 *    `Using unsafe HTTP verb GET …` 이라는 **평문**이 와서 파싱 에러가 난다
 *    (처음에 `Unexpected token U` 로 나와 원인이 가려졌다 — U 는 "Using" 의 U 였다).
 */
const getJson = (path, method = 'GET') => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: PORT, path, method }, (res) => {
    let d = ''; res.on('data', (c) => { d += c; });
    res.on('end', () => {
      try { resolve(JSON.parse(d)); }
      catch { reject(new Error(`${path} 가 JSON 이 아니다: ${d.slice(0, 80)}`)); }
    });
  });
  req.on('error', reject); req.end();
});

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function main() {
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--window-size=1680,950',
    `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/render-check-profile', 'about:blank',
  ], { stdio: 'ignore' });

  // 디버깅 포트가 뜰 때까지 — 고정 sleep 으로 기다리면 느린 날 거짓 실패가 난다
  let version = null;
  for (let i = 0; i < 50 && !version; i += 1) {
    try { version = await getJson('/json/version'); } catch { await sleep(200); }
  }
  if (!version) { console.log('🔴 Chromium 디버깅 포트가 안 열렸다'); chrome.kill(); process.exit(2); }

  let bad = 0;
  for (const page of PAGES) {
    const tab = await getJson(`/json/new?${encodeURIComponent(BASE + page.path)}`, 'PUT');
    const ws = await wsConnect(tab.webSocketDebuggerUrl);
    const errors = [];
    let id = 0;
    const pending = new Map();
    ws.onMessage((raw) => {
      const msg = JSON.parse(raw);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        errors.push(msg.params.args.map((a) => a.value || a.description || '').join(' '));
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        errors.push(d.exception?.description || d.text || '예외');
      }
    });
    const call = (method, params = {}) => new Promise((res) => { id += 1; pending.set(id, res); ws.send({ id, method, params }); });

    await call('Runtime.enable');
    await call('Page.enable');
    await sleep(3500); // SPA 라우팅 + 첫 API 왕복. ⚠️ 짧으면 "랭킹 0" 류 오경보가 난다(10-06 선례)

    /**
     * 🔴 **문서 높이로 "한 화면" 을 재면 안 된다.** 이 앱은 .page 가 overflow-y:auto 라
     *    스크롤이 그 안에서 일어난다 ⇒ document.scrollHeight === innerHeight 가 되어
     *    화면이 **잘려 있는데도 "한 화면에 들어옴"** 으로 보고했다(스크린샷이 잡았다).
     *    ⇒ main 안에서 **실제로 넘치는 요소**를 찾아 초과 px 를 잰다.
     * ⚠️ 아래 식은 템플릿 리터럴 안이라 **백틱을 쓸 수 없다** — 주석은 여기 바깥에 둔다.
     */
    const r = await call('Runtime.evaluate', {
      expression: `(() => {
        const m = document.querySelector('main') || document.body;
        const t = (m.innerText || '').replace(/\\s+/g, ' ').trim();
        return JSON.stringify({ len: t.length, head: t.slice(0, 80),
          url: location.href, ready: document.readyState,
          bodyLen: (document.body.innerHTML || '').length,
          hasMain: !!document.querySelector('main'),
          over: (() => {
            var pg = document.querySelector('.page') || document.querySelector('main');
            var pageOver = pg ? pg.scrollHeight - pg.clientHeight : 0;
            var inner = [];
            var all = document.querySelectorAll('main *');
            for (var i = 0; i < all.length; i += 1) {
              var el = all[i];
              if (el === pg) continue;
              var d = el.scrollHeight - el.clientHeight;
              if (d > 8 && el.clientHeight > 80) inner.push(String(el.className || el.tagName).slice(0, 24));
            }
            return { page: pageOver, inner: inner.slice(0, 4) };
          })(),
          h: document.documentElement.scrollHeight, v: window.innerHeight });
      })()`,
      returnByValue: true,
    });
    const info = JSON.parse(r.result.value);
    const missing = page.must.filter((k) => !info.head.includes(k) && !r.result.value.includes(k));
    // 문구 확인은 전체 텍스트로 다시
    const full = await call('Runtime.evaluate', {
      expression: "(document.querySelector('main')||document.body).innerText",
      returnByValue: true,
    });
    const text = full.result.value || '';
    const miss = page.must.filter((k) => !text.includes(k));
    const ok = info.len > 100 && miss.length === 0 && errors.length === 0;
    if (!ok) bad += 1;
    /**
     * **페이지 넘침**(사용자가 *"한 화면에 다 보이게"* 라고 한 그것)과
     * **카드 안 스크롤**(의도된 것 — 활동 로그·채팅 로그)을 **가른다.**
     * 안 가르면 의도된 내부 스크롤이 전부 위반으로 보여 자가 쓸모없어진다.
     */
    const scroll = info.over.page > 8
      ? `🔻 페이지 ${info.over.page}px 넘침`
      : '한 화면 ✓';
    const innerNote = info.over.inner.length ? ` · 카드내 스크롤: ${info.over.inner.join(', ')}` : '';
    console.log(`${ok ? '✅' : '🔴'} ${page.name.padEnd(8)} 텍스트 ${String(info.len).padStart(5)}자 · ${scroll}${innerNote}`);
    if (process.env.DEBUG) console.log('     debug:', JSON.stringify({ url: info.url, ready: info.ready, bodyLen: info.bodyLen, hasMain: info.hasMain }));
    if (miss.length) console.log(`     빠진 문구: ${miss.join(', ')}`);
    for (const e of errors.slice(0, 3)) console.log(`     에러: ${e.split("\n").slice(0,2).join(" | ").slice(0, 240)}`);
    if (process.env.SHOT) {
      // CDP 스크린샷 — `--screenshot` 플래그와 달리 **로드가 끝난 뒤** 찍는다
      const png = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      if (png?.data) {
        const file = `/tmp/shot-${page.path.replace(/\W/g, '_') || 'root'}.png`;
        fs.writeFileSync(file, Buffer.from(png.data, 'base64'));
        console.log(`     스크린샷: ${file}`);
      }
    }
    ws.close();
  }
  chrome.kill();
  // 🔴 "검사 못 함" 과 "통과" 를 구분한다 — 2 는 측정 불가, 1 은 실제 실패
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.log('🔴 하니스 실패:', e.message); process.exit(2); });
