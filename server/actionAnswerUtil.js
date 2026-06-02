function buildAnswerFromActionResults(actionResults = [], userInput = '') {
  const results = Array.isArray(actionResults) ? actionResults : [];
  const applied = results.filter((item) => item?.status === 'applied');
  const ignored = results.filter((item) => item?.status === 'ignored');

  if (!applied.length && !ignored.length) {
    return '요청을 확인했지만 반영할 변경 사항을 찾지 못했습니다. 금액·종목명·수량을 구체적으로 적어 주세요.';
  }

  const lines = [];
  if (applied.length) {
    lines.push('다음 변경을 포트폴리오에 반영했습니다.');
    for (const item of applied) {
      lines.push(`- ${item.message || item.type || '변경 완료'}`);
    }
  }
  if (ignored.length) {
    lines.push('');
    lines.push('아래 항목은 반영하지 않았습니다.');
    for (const item of ignored) {
      lines.push(`- ${item.message || item.type || '무시됨'}`);
    }
  }

  const preview = String(userInput || '').trim();
  if (preview && applied.length) {
    lines.push('');
    lines.push('왼쪽 포트폴리오 패널에서 즉시 확인할 수 있습니다.');
  }

  return lines.join('\n');
}

module.exports = {
  buildAnswerFromActionResults,
};
