/**
 * 대표 관심 테마 프리셋 (2026-09-21)
 *
 * 사용자: *"각 테마에 대표주 **10개씩** 넣어두도록 해."* (앞판은 5개였다)
 *
 * ## 🔴 종목 선정 기준 — **내가 고른 것이고 추천이 아니다**
 *
 * 각 테마에서 **시가총액·거래대금이 큰 대표 종목**을 골랐다. 그래야 "테마를 훑는" 목적에 맞고,
 * 유동성이 있어 시세·차트가 비지 않는다. **매수 추천이 아니다** — 관심 목록일 뿐이다.
 *
 * ⚠️ **티커는 바뀐다** — 상장폐지·합병·티커 변경이 실제로 일어난다.
 *    그래서 추가할 때 `watchlistService` 가 **실제로 조회되는지 확인**하고 넣게 했다
 *    (안 되면 그 종목만 건너뛰고 **몇 개를 건너뛰었는지 돌려준다**).
 *    조용히 빠지면 "원래 4개짜리 테마" 로 보인다.
 *
 * ⚠️ 국내는 **6자리 코드**, 미국은 티커다. 시장을 함께 적어 둔다.
 */

const THEME_PRESETS = [
  {
    name: '반도체',
    tickers: [
      { symbol: '005930', name: '삼성전자', market: 'KR' },
      { symbol: '000660', name: 'SK하이닉스', market: 'KR' },
      { symbol: '042700', name: '한미반도체', market: 'KR' },
      { symbol: '403870', name: 'HPSP', market: 'KR' },
      { symbol: 'NVDA', name: 'NVIDIA', market: 'US' },
      { symbol: 'TSM', name: 'TSMC', market: 'US' },
      { symbol: 'AMD', name: 'AMD', market: 'US' },
      { symbol: 'AVGO', name: 'Broadcom', market: 'US' },
      { symbol: 'ASML', name: 'ASML', market: 'US' },
      { symbol: 'MU', name: 'Micron', market: 'US' },
    ],
  },
  {
    name: 'AI·빅테크',
    tickers: [
      { symbol: 'MSFT', name: 'Microsoft', market: 'US' },
      { symbol: 'GOOGL', name: 'Alphabet', market: 'US' },
      { symbol: 'META', name: 'Meta', market: 'US' },
      { symbol: 'AMZN', name: 'Amazon', market: 'US' },
      { symbol: 'AAPL', name: 'Apple', market: 'US' },
      { symbol: 'PLTR', name: 'Palantir', market: 'US' },
      { symbol: 'ORCL', name: 'Oracle', market: 'US' },
      { symbol: 'CRM', name: 'Salesforce', market: 'US' },
      { symbol: 'NOW', name: 'ServiceNow', market: 'US' },
      { symbol: '035420', name: 'NAVER', market: 'KR' },
    ],
  },
  {
    name: '2차전지',
    tickers: [
      { symbol: '373220', name: 'LG에너지솔루션', market: 'KR' },
      { symbol: '006400', name: '삼성SDI', market: 'KR' },
      { symbol: '096770', name: 'SK이노베이션', market: 'KR' },
      { symbol: '247540', name: '에코프로비엠', market: 'KR' },
      { symbol: '086520', name: '에코프로', market: 'KR' },
      { symbol: '066970', name: '엘앤에프', market: 'KR' },
      { symbol: '003670', name: '포스코퓨처엠', market: 'KR' },
      { symbol: 'TSLA', name: 'Tesla', market: 'US' },
      { symbol: 'ALB', name: 'Albemarle', market: 'US' },
      { symbol: 'LIT', name: 'Global X Lithium ETF', market: 'US' },
    ],
  },
  {
    name: '방산·우주',
    tickers: [
      { symbol: '012450', name: '한화에어로스페이스', market: 'KR' },
      { symbol: '047810', name: '한국항공우주', market: 'KR' },
      { symbol: '064350', name: '현대로템', market: 'KR' },
      { symbol: '079550', name: 'LIG넥스원', market: 'KR' },
      { symbol: '272210', name: '한화시스템', market: 'KR' },
      { symbol: 'LMT', name: 'Lockheed Martin', market: 'US' },
      { symbol: 'RTX', name: 'RTX', market: 'US' },
      { symbol: 'NOC', name: 'Northrop Grumman', market: 'US' },
      { symbol: 'GD', name: 'General Dynamics', market: 'US' },
      { symbol: 'RKLB', name: 'Rocket Lab', market: 'US' },
    ],
  },
  {
    name: '바이오·헬스케어',
    tickers: [
      { symbol: '207940', name: '삼성바이오로직스', market: 'KR' },
      { symbol: '068270', name: '셀트리온', market: 'KR' },
      { symbol: '128940', name: '한미약품', market: 'KR' },
      { symbol: '326030', name: 'SK바이오팜', market: 'KR' },
      { symbol: 'LLY', name: 'Eli Lilly', market: 'US' },
      { symbol: 'NVO', name: 'Novo Nordisk', market: 'US' },
      { symbol: 'UNH', name: 'UnitedHealth', market: 'US' },
      { symbol: 'JNJ', name: 'Johnson & Johnson', market: 'US' },
      { symbol: 'MRK', name: 'Merck', market: 'US' },
      { symbol: 'VRTX', name: 'Vertex', market: 'US' },
    ],
  },
  {
    name: '금융·보험',
    tickers: [
      { symbol: '105560', name: 'KB금융', market: 'KR' },
      { symbol: '055550', name: '신한지주', market: 'KR' },
      { symbol: '086790', name: '하나금융지주', market: 'KR' },
      { symbol: '316140', name: '우리금융지주', market: 'KR' },
      { symbol: '032830', name: '삼성생명', market: 'KR' },
      { symbol: 'JPM', name: 'JPMorgan', market: 'US' },
      { symbol: 'BAC', name: 'Bank of America', market: 'US' },
      { symbol: 'GS', name: 'Goldman Sachs', market: 'US' },
      // 🔴 `BRK-B` 제거(2026-09-21 사용자 결정) — **토스가 이 티커를 모른다**(quote null).
      //    야후는 안다(509.77). 폴백을 새로 놓는 대신 목록에서 뺐다.
      //    ⚠️ 이미 라이브 데이터에 들어간 것은 **코드로 안 지워진다**(프리셋은 add 만 한다) — pm2 가 따로 지웠다.
      { symbol: 'AXP', name: 'American Express', market: 'US' },
      { symbol: 'V', name: 'Visa', market: 'US' },
    ],
  },
  {
    name: '에너지·원자재',
    tickers: [
      { symbol: '010950', name: 'S-Oil', market: 'KR' },
      { symbol: '096770', name: 'SK이노베이션', market: 'KR' },
      { symbol: '006260', name: 'LS', market: 'KR' },
      { symbol: '005490', name: 'POSCO홀딩스', market: 'KR' },
      { symbol: 'XOM', name: 'Exxon Mobil', market: 'US' },
      { symbol: 'CVX', name: 'Chevron', market: 'US' },
      { symbol: 'COP', name: 'ConocoPhillips', market: 'US' },
      { symbol: 'FCX', name: 'Freeport-McMoRan', market: 'US' },
      { symbol: 'NEM', name: 'Newmont', market: 'US' },
      { symbol: 'SLB', name: 'SLB', market: 'US' },
    ],
  },
  {
    name: '지수 ETF',
    tickers: [
      { symbol: 'SPY', name: 'S&P 500 ETF', market: 'US' },
      { symbol: 'QQQ', name: 'Nasdaq 100 ETF', market: 'US' },
      { symbol: 'IWM', name: 'Russell 2000 ETF', market: 'US' },
      { symbol: 'DIA', name: 'Dow Jones ETF', market: 'US' },
      { symbol: 'VTI', name: 'Total Market ETF', market: 'US' },
      { symbol: 'SOXX', name: 'Semiconductor ETF', market: 'US' },
      { symbol: 'TLT', name: '20Y+ Treasury ETF', market: 'US' },
      { symbol: 'GLD', name: 'Gold ETF', market: 'US' },
      { symbol: '069500', name: 'KODEX 200', market: 'KR' },
      { symbol: '229200', name: 'KODEX 코스닥150', market: 'KR' },
    ],
  },
];

module.exports = { THEME_PRESETS };
