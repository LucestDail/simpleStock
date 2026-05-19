export async function consumeNdjsonStream(body, onEvent) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

    let lineBreakIndex = buffer.indexOf('\n');
    while (lineBreakIndex >= 0) {
      const line = buffer.slice(0, lineBreakIndex).trim();
      buffer = buffer.slice(lineBreakIndex + 1);
      if (line) {
        onEvent(JSON.parse(line));
      }
      lineBreakIndex = buffer.indexOf('\n');
    }

    if (done) break;
  }

  if (buffer.trim()) {
    onEvent(JSON.parse(buffer.trim()));
  }
}

export function parseNdjsonText(text) {
  const events = [];
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    events.push(JSON.parse(trimmed));
  }
  return events;
}
