<!--
  D-1 운용 규칙 설정 — 운용 에이전트 설정 종합 (2026-10-04 전면 확장)

  대시보드·상단바에서 걷어낸 조작이 전부 여기로 왔다(사용자: "대시보드는 순전히 보는 용도"):
    ① 운용 상태(운용 중/정지됨) · 오늘 손익       ② 일시정지/재개
    ③ 비상정지 모달(범위 3단 + "정지" 타이핑 확인) — 구 AppShell(HEAD) 구현을 그대로 이식
    ④ 자율 수준 3단(0단 고정 — 전환은 사람만)      ⑤ 한도 표
    ⑥ 브리핑·분석 설정 인라인(구 SettingsPanel 의 폼·저장 API 를 이 페이지 섹션으로)
    ⑦ 수동 분석 실행(POST /api/analyst/run)

  🔴 상태 폴링(30초)은 운용 상태만 다시 읽는다 — 설정 폼까지 다시 읽으면
     사용자가 입력하던 값을 폴링이 조용히 덮어쓴다.
-->
<template>
  <div class="page">
    <header class="page__head"><h1>운용 규칙 설정</h1></header>

    <!-- ①+④ 운용 상태 · 자율 수준 · AI 예산 — 한 카드 2열 (2026-10-05 글자 다이어트:
         산문은 한 줄 이하, 긴 설명은 ⓘ 툴팁(title)으로. 기능·API 는 전부 그대로다) -->
    <section class="card">
      <h2>운용 상태</h2>
      <div class="st">
        <span class="st__state" :class="{ 'st__state--paused': control?.paused }">
          {{ control?.paused ? `⏸ 정지됨 (${scopeLabel})` : '● 에이전트 운용 중' }}
        </span>
        <span class="st__chip">{{ autonomy }}</span>
        <span v-if="control?.paused && control?.resumeAt" class="st__chip">
          재개 예약 {{ fmtAt(control.resumeAt) }}
        </span>
        <span v-if="control?.paused && control?.at" class="st__chip">
          정지 {{ fmtAt(control.at) }}{{ control?.reason ? ` · ${control.reason}` : '' }}
        </span>
        <span class="st__spacer"></span>
        <!-- 오늘 손익 — /api/portfolio summary.dailyRate (숫자 %) -->
        <span v-if="dailyPct != null" class="st__chip mono-num" :class="dailyPct < 0 ? 'down' : 'up'">
          오늘 {{ dailyPct > 0 ? '+' : '' }}{{ dailyPct }}%
        </span>
        <span v-else class="st__chip">오늘 손익 —</span>
        <button v-if="!control?.paused" class="btn btn--sm" @click="quickPause">일시정지</button>
        <button v-if="!control?.paused" class="btn btn--sm btn--danger" @click="stopOpen = true">비상정지</button>
        <button v-else class="btn btn--sm btn--primary" @click="resume">▶ 재개</button>
      </div>
      <p v-if="statusError" class="err">{{ statusError }}</p>
      <p class="mut">재개는 사람만 — 정지·재개 기록은 활동 로그에 남습니다.</p>

      <div class="ops">
        <div class="ops__col">
          <h3 class="subh">자율 수준
            <span class="info" title="1단: 에이전트 발 제안 중 계좌 한도·가드 전부 통과한 것만 자동 승인·전송 — 한도에 걸리면 승인 대기로 남습니다. 2단: 집행은 1단과 동일, 2단 고유 동작(예약 자동 등록)은 아직 코드가 없습니다. 전환은 이 화면의 사람만 — 코드는 스스로 올리지 않습니다.">ⓘ</span>
          </h3>
          <div class="levels">
            <button
              v-for="(lv, i) in LEVELS" :key="i"
              class="level" :class="{ 'level--on': autonomyLevel === i }"
              @click="askLevel(i)"
            >
              <b>{{ i }}단 · {{ lv.name }}</b><small>{{ lv.desc }}</small>
              <small v-if="autonomyLevel === i" class="level__now">현재 단계</small>
            </button>
          </div>
          <p class="mut">전환은 사람만 · 1단부터 한도 통과 제안은 자동 전송 — 상세는 ⓘ.</p>
        </div>

        <!-- 📒 AI 운용 예산 (2026-10-05 — "비율 일임") -->
        <div class="ops__col">
          <h3 class="subh">AI 운용 예산
            <span class="info" title="자동 매수는 이 예산 안에서만 나갑니다. 자동 매도는 AI 가 산 것만 — 기존 보유는 항상 승인 대기입니다. 예산을 비우면(미설정) 1단을 켜도 자동 매수가 0 입니다.">ⓘ</span>
          </h3>
          <p v-if="ledger && ledger.budgetUsd == null" class="mut">🔒 예산 미설정 = 자동 매수 0 — 맡기기 전엔 사지 않습니다.</p>
          <div class="ledger__row">
            <label>예산(USD)
              <input v-model.number="budgetInput" type="number" min="0" step="50" class="xs" placeholder="예: 150" />
            </label>
            <button class="btn btn--sm btn--primary" :disabled="budgetBusy" @click="saveBudget">저장</button>
            <button class="btn btn--sm" :disabled="budgetBusy || ledger?.budgetUsd == null" @click="clearBudget">예산 해제</button>
            <span v-if="budgetMsg" class="mut">{{ budgetMsg }}</span>
          </div>
          <dl v-if="ledger" class="ledger__stats">
<!-- 🔴 손실 이월(10-05): 유효 예산 = 예산 + min(0, 실현손익). 잃은 돈은 잔액으로 돌아오지
                 않는다 — 예산과 달라졌을 때만 보여 "왜 잔액이 안 맞지" 를 화면이 먼저 답한다 -->
            <div><dt>예산</dt><dd class="mono-num">{{ ledger.budgetUsd == null ? '미설정' : '$' + ledger.budgetUsd }}<template v-if="ledger.effectiveBudgetUsd != null && ledger.effectiveBudgetUsd !== ledger.budgetUsd"> <span class="mut">(손실 반영 ${{ ledger.effectiveBudgetUsd }})</span></template></dd></div>
            <div><dt>투입 중</dt><dd class="mono-num">${{ ledger.openCostUsd }}</dd></div>
            <div><dt>잔액</dt><dd class="mono-num">${{ ledger.availableUsd }}</dd></div>
            <div><dt>실현손익</dt><dd class="mono-num" :class="ledger.realizedUsd >= 0 ? 'up' : 'down'">{{ ledger.realizedUsd >= 0 ? '+' : '' }}${{ ledger.realizedUsd }}</dd></div>
          </dl>
          <p v-if="ledger && Object.keys(ledger.positions || {}).length" class="mut">
            AI 보유: <span v-for="(p, s2) in ledger.positions" :key="s2" class="mono-num">{{ s2 }} {{ p.qty }}주(평단 ${{ p.avgUsd }}) </span>
          </p>
        </div>
      </div>

      <!-- 전환 확인 모달 — 실거래 자동 발사가 걸린 조작이라 타이핑 확인 -->
      <div v-if="levelAsk != null" class="stop__scrim" @click.self="levelAsk = null">
        <section class="stop" role="dialog" aria-modal="true">
          <h2>자율 수준 전환 — {{ autonomyLevel }}단 → {{ levelAsk }}단</h2>
          <p class="stop__sub" v-if="levelAsk >= 1">
            🔴 {{ levelAsk }}단부터는 에이전트 발 제안이 한도 통과 시 <b>자동으로 전송</b>됩니다.
            지금 <b>실거래 모드</b>면 실제 주문이 나갑니다. 확인을 위해 "자율"을 입력하세요.
          </p>
          <p class="stop__sub" v-else>0단으로 내리면 모든 제안이 다시 승인 대기로 옵니다.</p>
          <label v-if="levelAsk >= 1" class="stop__confirm">
            <input v-model="levelWord" class="input" placeholder="자율" />
          </label>
          <footer class="stop__foot">
            <small>전환 기록은 활동 로그에 남습니다</small>
            <span class="stop__gap"></span>
            <button class="btn" @click="levelAsk = null">취소</button>
            <button class="btn btn--danger" :disabled="levelAsk >= 1 && levelWord !== '자율'" @click="setLevel">전환</button>
          </footer>
        </section>
      </div>
    </section>

    <!-- ⑤+⑦ 한도 · 수동 분석 — 둘 다 짧은 카드라 한 줄 2열로 묶어 세로를 줄인다 -->
    <div class="row2">
      <section class="card">
        <h2>한도 <span class="info" title="일일 손실·MDD 자동 정지는 아직 수동(위 비상정지)입니다 — 자동 발동 백엔드가 생기면 여기서 켭니다. 없는 안전장치를 있다고 적지 않습니다.">ⓘ</span></h2>
        <table class="tbl">
          <tr><td>종목당 최대 비중</td><td class="mono-num">20%</td><td class="mut">초과 시 추가 매수 차단</td></tr>
          <tr><td>현금 최소 비중</td><td class="mono-num">10%</td><td class="mut">하회하는 매수 제안 경고</td></tr>
          <tr><td>제안 유효시간</td><td class="mono-num">10분</td><td class="mut">무응답 시 자동 만료</td></tr>
          <tr><td>신용·미수</td><td class="mono-num">불가</td><td class="mut">고정 — 설정으로도 못 켠다</td></tr>
          <tr v-if="dailyLossPct != null"><td>일일 손실 기준</td><td class="mono-num">-{{ dailyLossPct }}%</td><td class="mut">표시 기준 — 자동 정지 아님</td></tr>
        </table>
        <p class="mut">⚠️ 손실·MDD 자동 정지는 아직 수동(위 비상정지) — 상세는 ⓘ.</p>
      </section>

      <!-- 수동 분석 실행 — 관리 작업이라 여기가 맞다 -->
      <section class="card">
        <h2>수동 분석 실행</h2>
        <p class="mut">지금 한 번 실행 — 보고서는 대시보드 분석 패널에 저장됩니다.</p>
        <div class="run">
          <label class="run__opt">
            <input v-model="runDry" type="checkbox" />
            점검 실행 (dryRun) — 발송·제안 없이 돌려만 본다
          </label>
          <button class="btn btn--primary" :disabled="runBusy" @click="runAnalysis">
            {{ runBusy ? '분석 중… (수십 초 걸릴 수 있습니다)' : '분석 실행' }}
          </button>
        </div>
        <p v-if="runErr" class="banner banner--error">{{ runErr }}</p>
        <p v-if="runMsg" class="ok">{{ runMsg }}</p>
      </section>
    </div>

    <!-- ⑥ 브리핑·분석 설정 — 구 SettingsPanel 의 폼을 인라인으로.
         GET /api/system/status → dashboardSettings · 저장 PUT /api/system/settings -->
    <section class="card">
      <h2>브리핑·분석 설정</h2>
      <p v-if="err" class="err">{{ err }}</p>
      <p v-if="msg" class="ok">{{ msg }}</p>

      <div class="frm">
        <!-- 🔄 2026-10-04 사용자: "테이블화 시켜서 구체적으로 확인 및 설정, 규격화" —
             나열형 폼을 표로: 항목 | 저장된 값(확인) | 변경(입력) | 설명. 저장 전엔 "변경됨" 배지. -->
        <table class="settbl frm__row--wide">
          <thead><tr><th class="settbl__k">항목</th><th class="settbl__cur">저장된 값</th><th class="settbl__in">변경</th><th>설명</th></tr></thead>
          <tbody>
            <tr>
              <td class="settbl__k">모멘텀 임계값
                <em v-if="usingDefault.includes('momentumPct')" class="defbadge">기본값</em>
                <em v-else-if="dirty('momentumPct')" class="dirtybadge">변경됨</em>
              </td>
              <td class="settbl__cur mono-num">{{ saved.momentumPct }}%</td>
              <td class="settbl__in">
                <div class="chips">
                  <button v-for="v in [1, 2, 3, 5, 10]" :key="v" class="chip"
                    :class="{ 'chip--on': form.momentumPct === v }" @click.prevent="form.momentumPct = v">{{ v }}</button>
                </div>
                <input v-model.number="form.momentumPct" type="number" step="0.1" min="0.1" max="50" class="xs" />
              </td>
              <td class="settbl__d">당일 등락이 이만큼 움직인 종목만 모멘텀에 올라옵니다. 작을수록 많이 보입니다.</td>
            </tr>
            <tr>
              <td class="settbl__k">자동 갱신 주기
                <em v-if="usingDefault.includes('refreshSec')" class="defbadge">기본값</em>
                <em v-else-if="dirty('refreshSec')" class="dirtybadge">변경됨</em>
              </td>
              <td class="settbl__cur mono-num">{{ saved.refreshSec }}초</td>
              <td class="settbl__in">
                <div class="chips">
                  <button v-for="v in [30, 60, 180, 600]" :key="v" class="chip"
                    :class="{ 'chip--on': form.refreshSec === v }" @click.prevent="form.refreshSec = v">{{ v < 60 ? v + '초' : v / 60 + '분' }}</button>
                </div>
                <input v-model.number="form.refreshSec" type="number" min="15" max="3600" class="xs" />
              </td>
              <td class="settbl__d">화면 숫자를 새로 받는 간격. 짧을수록 토스 호출이 늘어납니다.</td>
            </tr>
            <tr>
              <td class="settbl__k">랭킹 종류
                <em v-if="usingDefault.includes('rankingTypes')" class="defbadge">기본값</em>
              </td>
              <td class="settbl__cur">{{ (saved.rankingTypes || []).map((t) => RANKING_LABELS[t] || t).join(' · ') || '—' }}</td>
              <td class="settbl__in">
                <div class="chips">
                  <button v-for="(label, t) in RANKING_LABELS" :key="t" class="chip"
                    :class="{ 'chip--on': form.rankingTypes.includes(t) }" @click="toggleRanking(t)">{{ label }}</button>
                </div>
              </td>
              <td class="settbl__d">대시보드 랭킹 패널에 보여줄 순위 종류.</td>
            </tr>
            <tr>
              <td class="settbl__k">랭킹 시장</td>
              <td class="settbl__cur">{{ (saved.rankingCountries || []).map((c) => c === 'US' ? '미국' : '한국').join(' · ') || '—' }}</td>
              <td class="settbl__in">
                <div class="chips">
                  <button v-for="c in ['US', 'KR']" :key="c" class="chip"
                    :class="{ 'chip--on': form.rankingCountries.includes(c) }" @click="toggleCountry(c)">{{ c === 'US' ? '미국' : '한국' }}</button>
                </div>
              </td>
              <td class="settbl__d">미국장을 주로 보면 미국만 켜 둬도 됩니다.</td>
            </tr>
            <tr>
              <td class="settbl__k">분석 자동 실행 (cron)
                <em v-if="usingDefault.includes('briefingCron')" class="defbadge">없음</em>
                <em v-else-if="dirty('briefingCron')" class="dirtybadge">변경됨</em>
              </td>
              <td class="settbl__cur mono-num">{{ saved.briefingCron || '—' }}</td>
              <td class="settbl__in"><input v-model="form.briefingCron" type="text" placeholder="0 9,15 * * 1-5" class="xs" /></td>
              <td class="settbl__d">비우면 자동 실행 없음 — 장 시점 트리거와 별개의 보조 크론.</td>
            </tr>
          </tbody>
        </table>

        <div class="frm__row frm__row--sep frm__row--wide">
          <span class="frm__label">관심 테마</span>
          <ul class="groups">
            <li v-for="g in groups" :key="g.id">
              <span>{{ g.name }}</span>
              <span class="gcount">{{ g.tickers?.length || 0 }}</span>
              <button class="gdel" title="삭제" @click="removeGroup(g)">×</button>
            </li>
            <li v-if="!groups.length" class="gempty">아직 테마가 없습니다.</li>
          </ul>
          <div class="gadd">
            <input v-model="newGroup" type="text" placeholder="예: 반도체, 미국 ETF, 배당주" @keyup.enter="addGroup" />
            <button class="btn btn--primary" :disabled="groupBusy || !newGroup.trim()" @click="addGroup">추가</button>
          </div>
          <small>테마는 대시보드 상단 스트립에 카드로 뜹니다 — 종목은 거기서 넣습니다.</small>
          <!-- 멱등이다 — 이미 있는 이름은 건너뛴다. 두 번 눌러도 안 늘어난다 -->
          <button class="btn add" :disabled="presetBusy" @click="addPresets">
            {{ presetBusy ? '추가 중…' : '+ 대표 테마 8종 추가' }}
          </button>
          <p v-if="presetMsg" class="hint">{{ presetMsg }}</p>
        </div>

        <label class="frm__row frm__row--sep frm__row--wide">
          <span class="frm__label">
            매매 분석 추가 지시 (프롬프트)
            <em v-if="usingDefault.includes('briefingPrompt')">없음</em>
          </span>
          <textarea v-model="form.briefingPrompt" class="area" rows="5"
            placeholder="예: 보유 비중과 환율 영향을 먼저 보고, 단기 대응보다 리스크를 우선해서 써 줘." />
          <small>매매 분석 AI 가 <b>이 문장을 그대로</b> 따릅니다. 비워도 됩니다.</small>
        </label>

        <div class="frm__row frm__row--sep frm__row--wide">
          <span class="frm__label">가격 기준선 <small class="inlh">기준선을 넘으면 텔레그램으로 알립니다 — 하향선은 용도(진입·청산 등)를 정하지 않습니다(방향만 알림)</small></span>
          <!--
            🔴 사람이 정한 기준이라 오경보가 없다 — 급변(%)은 시장이 정하지만 이건 내가 정한다.
            ⚠️ 통화를 환산하지 않는다 — 그 종목 화면에서 보는 단위 그대로 적는다.
            🔴 자유 입력이 아니라 보유에서 고른다 — 없는 종목에 기준선을 걸 수 없다.
          -->
          <p v-if="holdingsError" class="err">{{ holdingsError }}</p>
          <p v-else-if="!holdings.length" class="hint">보유 종목이 없어 기준선을 걸 수 없습니다.</p>

          <div v-for="(row, i) in form.targetRows" :key="i" class="target">
            <select v-model="row.symbol" class="xs">
              <option value="">종목 선택</option>
              <option v-for="h in pickable(row.symbol)" :key="h.symbol" :value="h.symbol">
                {{ h.name }} ({{ h.symbol }})
              </option>
            </select>
<!-- 🔴 10-06 의미 중립화 — 사용자는 하향선을 "진입가" 로도 쓴다(QLD $90 하향 진입).
                 필드는 서버 호환상 target/stop 그대로, 화면은 방향(상향/하향)만 말한다 -->
            <input v-model="row.target" class="xs" type="number" placeholder="상향 알림가 (이상이면 알림)" title="상향 알림가 — 이 값 이상이면 알림" />
            <input v-model="row.stop" class="xs" type="number" placeholder="하향 알림가 (이하면 알림)" title="하향 알림가 — 이 값 이하면 알림" />
            <button class="icon" aria-label="삭제" title="삭제" @click="form.targetRows.splice(i, 1)">×</button>
            <!-- 현재가를 옆에 적는다 — 없으면 기준선을 감으로 넣게 된다 -->
            <small v-if="priceOf(row.symbol) != null" class="now mono-num">
              현재 {{ Number(priceOf(row.symbol)).toLocaleString('ko-KR') }}
            </small>
          </div>
          <button class="btn add" @click="form.targetRows.push({ symbol: '', target: '', stop: '' })">
            + 기준선 추가
          </button>
        </div>

        <footer class="foot">
          <button class="btn btn--primary" :disabled="busy" @click="save">{{ busy ? '저장 중…' : '설정 저장' }}</button>
        </footer>
      </div>
    </section>

    <!-- 🛑 비상정지 모달 (D-4) — 구 AppShell(HEAD) 구현 이식: 범위 3단 + "정지" 타이핑 확인 -->
    <div v-if="stopOpen" class="stop__scrim" @click.self="stopOpen = false">
      <section class="stop" role="dialog" aria-modal="true">
        <h2>에이전트 비상정지</h2>
        <p class="stop__sub">정지 범위를 고르세요. 정지 중에는 어떤 자동 주문도 나가지 않습니다.</p>
        <label class="stop__opt"><input v-model="stopScope" type="radio" value="halt_new" />
          <span><b>신규 주문만 중단</b><small>보유 종목과 미체결 주문은 그대로 둡니다</small></span></label>
        <label class="stop__opt"><input v-model="stopScope" type="radio" value="halt_cancel" />
          <span><b>미체결 주문 취소 + 중단</b><small>대기 중인 제안을 모두 거절 처리합니다</small></span></label>
        <label class="stop__opt stop__opt--danger"><input v-model="stopScope" type="radio" value="halt_flatten" />
          <span><b>전 포지션 청산 요청 + 중단</b><small>⚠️ 청산 주문 자동 발사는 아직 막혀 있습니다 — 요청이 기록되고 사람이 집행합니다</small></span></label>
        <label class="stop__resume"><input v-model="stopResume" type="checkbox" /> 다음 거래일에 자동 재개</label>
        <!-- 🔴 타이핑 확인 — 실수 클릭으로 전 포지션이 멈추면 안 된다 (와이어프레임 그대로) -->
        <label class="stop__confirm">확인을 위해 "정지"를 입력하세요
          <input v-model="stopWord" class="input" placeholder="정지" />
        </label>
        <footer class="stop__foot">
          <small>정지·재개 기록은 활동 로그에 남습니다</small>
          <span class="stop__gap"></span>
          <button class="btn" @click="stopOpen = false">취소</button>
          <button class="btn btn--danger" :disabled="stopWord !== '정지'" @click="doStop">에이전트 정지</button>
        </footer>
      </section>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { apiFetch } from '../lib/apiClient';

/* ── ①②③ 운용 상태 · 일시정지/재개 · 비상정지 (구 AppShell HEAD 에서 이식) ── */
const control = ref(null);
const autonomy = ref('승인 후 실행');
const autonomyLevel = ref(0);
const LEVELS = [
  { name: '제안 + 승인', desc: '모든 제안이 승인 대기(HITL) — 기본' },
  { name: '한도 내 자동', desc: '한도·가드 통과한 에이전트 제안만 자동 전송' },
  { name: '안내 후 자율', desc: '집행은 1단과 동일 (고유 동작은 추후)' },
];
const ledger = ref(null);
const budgetInput = ref(null);
const budgetBusy = ref(false);
const budgetMsg = ref('');
async function saveBudget() {
  budgetBusy.value = true; budgetMsg.value = '';
  try {
    const r = await apiFetch('/api/agent/budget', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usd: budgetInput.value }) });
    const b = await r.json();
    if (!r.ok || !b.ok) throw new Error(b.error || `저장 실패 (${r.status})`);
    budgetMsg.value = '저장됨';
    await loadStatus();
  } catch (e) { budgetMsg.value = `실패: ${e.message}`; }
  finally { budgetBusy.value = false; }
}
async function clearBudget() {
  budgetBusy.value = true;
  try {
    await apiFetch('/api/agent/budget', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usd: null }) });
    budgetInput.value = null;
    await loadStatus();
  } finally { budgetBusy.value = false; }
}
const levelAsk = ref(null);
const levelWord = ref('');
function askLevel(i) {
  if (i === autonomyLevel.value) return;
  levelAsk.value = i; levelWord.value = '';
}
async function setLevel() {
  try {
    const r = await apiFetch('/api/agent/autonomy', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: levelAsk.value }),
    });
    const b = await r.json();
    if (!r.ok || !b.ok) throw new Error(b.error || `전환 실패 (${r.status})`);
    levelAsk.value = null; levelWord.value = '';
    await loadStatus();
  } catch (e) { statusError.value = e.message; }
}
const dailyPct = ref(null);
const dailyLossPct = ref(null);
const statusError = ref('');

const stopOpen = ref(false);
const stopScope = ref('halt_new');
const stopResume = ref(false);
const stopWord = ref('');

const scopeLabel = computed(() => ({
  halt_new: '신규 중단', halt_cancel: '미체결 취소', halt_flatten: '청산 요청',
}[control.value?.scope] || control.value?.scope || ''));

/** 시각 표기는 MM-DD HH:mm 로 통일한다 */
function fmtAt(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 🔴 상태만 다시 읽는다 — 설정 폼(form)은 건드리지 않는다.
 *    30초 폴링이 입력 중인 폼을 덮으면 "내가 적던 값이 사라졌다" 가 된다.
 */
async function loadStatus() {
  try {
    const r = await apiFetch('/api/agent/status');
    const b = await r.json();
    control.value = b.control || null;
    autonomy.value = b.autonomy || '승인 후 실행';
    autonomyLevel.value = Number(b.autonomyLevel) || 0;
    ledger.value = b.ledger || null;
    if (budgetInput.value == null && b.ledger?.budgetUsd != null) budgetInput.value = b.ledger.budgetUsd;
    const lim = Number(b?.limits?.dailyLossPct);
    dailyLossPct.value = Number.isFinite(lim) ? lim : null;
    statusError.value = '';
  } catch {
    statusError.value = '운용 상태를 불러오지 못했습니다 — 아래 버튼은 동작하지 않을 수 있습니다.';
  }
  try {
    const r = await apiFetch('/api/portfolio');
    const b = await r.json();
    const v = Number(b?.summary?.dailyRate);
    dailyPct.value = Number.isFinite(v) ? v : null;
    // 보유 종목은 가격 기준선 선택지로도 쓴다(같은 응답 재사용)
    if (Array.isArray(b?.items)) { holdings.value = b.items; holdingsError.value = ''; }
  } catch { dailyPct.value = null; }
}

async function quickPause() {
  // 일시정지 = 신규 중단 + 사유 고정. 비상정지 모달과 달리 한 번에 — 가장 흔한 동작이라 가볍게.
  try {
    const r = await apiFetch('/api/agent/pause', { method: 'POST', body: JSON.stringify({ scope: 'halt_new', reason: '운용 규칙 화면 일시정지' }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `일시정지 실패 (${r.status})`);
  } catch (e) { statusError.value = e.message; }
  await loadStatus();
}
async function resume() {
  try {
    const r = await apiFetch('/api/agent/resume', { method: 'POST' });
    if (!r.ok) throw new Error(`재개 실패 (${r.status})`);
  } catch (e) { statusError.value = e.message; }
  await loadStatus();
}
async function doStop() {
  try {
    const r = await apiFetch('/api/agent/pause', {
      method: 'POST',
      body: JSON.stringify({ scope: stopScope.value, reason: '비상정지', resumeNextDay: stopResume.value }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `정지 실패 (${r.status})`);
  } catch (e) { statusError.value = e.message; }
  stopOpen.value = false; stopWord.value = '';
  await loadStatus();
}

/* ── ⑥ 브리핑·분석 설정 — 구 SettingsPanel 의 폼·API 를 인라인으로 ──
 * 읽기  GET /api/system/status → dashboardSettings (+ usingDefault)
 * 저장  PUT /api/system/settings  body { dashboard: {...} }
 * 테마  GET /api/watchlist · POST /api/watchlist/groups · DELETE /api/watchlist/groups/:id
 *       POST /api/watchlist/presets
 * ⚠️ 서버가 범위를 벗어난 값을 기본값으로 되돌린다 — 저장 후 서버 값을 다시 읽어 그린다.
 */
const form = ref({
  momentumPct: 3, refreshSec: 60, rankingTypes: [], rankingCountries: [],
  briefingPrompt: '', briefingCron: '',
  // 화면은 행 배열, 서버는 객체 — 저장할 때 한 번만 바꾼다
  targetRows: [],
});
const groups = ref([]);
const holdings = ref([]);
const holdingsError = ref('');
const presetBusy = ref(false);
const presetMsg = ref('');
const newGroup = ref('');
const groupBusy = ref(false);
const usingDefault = ref([]);
const saved = ref({ momentumPct: null, refreshSec: null, rankingTypes: [], rankingCountries: [], briefingPrompt: '', briefingCron: '' });
/** 입력이 저장값과 다른가 — "변경됨" 배지(저장을 잊는 사고 방지) */
const dirty = (k) => JSON.stringify(form.value?.[k]) !== JSON.stringify(saved.value?.[k]);
const busy = ref(false);
const msg = ref('');
const err = ref('');

/** 🔴 토스 실제 enum 이다. 임의로 만들면 400 이 나고 랭킹이 빈다(2026-09-21에 겪었다) */
const RANKING_LABELS = {
  TOP_GAINERS: '급등',
  TOP_LOSERS: '급락',
  MARKET_TRADING_AMOUNT: '거래대금',
  MARKET_TRADING_VOLUME: '거래량',
  TOSS_SECURITIES_TRADING_AMOUNT: '토스 거래대금',
  TOSS_SECURITIES_TRADING_VOLUME: '토스 거래량',
};

/** 행 배열 → 심볼 키 객체. ⚠️ 빈 행은 버린다(빈 껍데기를 저장하지 않는다) */
function targetsObject() {
  const out = {};
  for (const r of form.value.targetRows) {
    const sym = String(r.symbol || '').trim().toUpperCase();
    if (!sym) continue;
    const target = r.target === '' || r.target == null ? null : Number(r.target);
    const stop = r.stop === '' || r.stop == null ? null : Number(r.stop);
    if (target == null && stop == null) continue;
    out[sym] = { target, stop };
  }
  return out;
}

/** 이미 다른 행이 쓴 종목은 빼고 보여준다(한 종목에 기준선 두 벌을 만들지 않게) */
function pickable(current) {
  const used = new Set(form.value.targetRows.map((r) => r.symbol).filter((x) => x && x !== current));
  return holdings.value.filter((h) => !used.has(h.symbol));
}
function priceOf(symbol) {
  return holdings.value.find((h) => h.symbol === symbol)?.lastPrice ?? null;
}

async function loadSettings() {
  err.value = '';
  try {
    const res = await apiFetch('/api/system/status');
    if (!res.ok) throw new Error(`설정을 불러오지 못했습니다 (${res.status})`);
    const d = await res.json();
    const s = d?.dashboardSettings || null;
    if (s) {
      form.value = {
        momentumPct: s.momentumPct,
        refreshSec: s.refreshSec,
        rankingTypes: [...(s.rankingTypes || [])],
        rankingCountries: [...(s.rankingCountries || [])],
        briefingPrompt: s.briefingPrompt || '',
        briefingCron: s.briefingCron || '',
        targetRows: Object.entries(s.targets || {}).map(([symbol, v]) => ({
          symbol, target: v?.target ?? '', stop: v?.stop ?? '',
        })),
      };
      usingDefault.value = s.usingDefault || [];
      // 테이블의 "저장된 값" 열 — 입력(form)과 분리해 확인/변경을 가른다(규격화)
      saved.value = JSON.parse(JSON.stringify(form.value));
    }
    const w = await apiFetch('/api/watchlist');
    if (w.ok) groups.value = (await w.json())?.groups || [];
  } catch (e) {
    err.value = e.message;
  }
}

async function addPresets() {
  presetBusy.value = true;
  presetMsg.value = '';
  try {
    const res = await apiFetch('/api/watchlist/presets', { method: 'POST' });
    const b = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(b.error || `추가 실패 (${res.status})`);
    // 🔴 건너뛴 것·실패한 것을 숨기지 않는다 — "왜 5개가 아니지" 를 겪지 않게
    const parts = [];
    if (b.added?.length) parts.push(`추가 ${b.added.length}개`);
    if (b.skipped?.length) parts.push(`이미 있음 ${b.skipped.length}개`);
    if (b.failedTickers?.length) parts.push(`종목 실패 ${b.failedTickers.length}건`);
    presetMsg.value = parts.join(' · ') || '변경 없음';
    await loadSettings();
  } catch (e) {
    presetMsg.value = e.message;
  } finally {
    presetBusy.value = false;
  }
}

async function addGroup() {
  const name = newGroup.value.trim();
  if (!name || groupBusy.value) return;
  groupBusy.value = true;
  err.value = '';
  try {
    const res = await apiFetch('/api/watchlist/groups', { method: 'POST', body: JSON.stringify({ name }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `추가 실패 (${res.status})`);
    newGroup.value = '';
    await loadSettings();
  } catch (e) {
    err.value = e.message;
  } finally {
    groupBusy.value = false;
  }
}

async function removeGroup(g) {
  // ⚠️ 되돌릴 수 없다 — 담긴 종목이 함께 사라진다. 한 번 묻는다.
  if (!window.confirm(`"${g.name}" 테마를 지웁니다. 담긴 종목 ${g.tickers?.length || 0}개도 함께 사라집니다.`)) return;
  err.value = '';
  try {
    const res = await apiFetch(`/api/watchlist/groups/${encodeURIComponent(g.id)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`삭제 실패 (${res.status})`);
    await loadSettings();
  } catch (e) {
    err.value = e.message;
  }
}

async function save() {
  busy.value = true;
  msg.value = '';
  err.value = '';
  try {
    const res = await apiFetch('/api/system/settings', {
      method: 'PUT',
      // 🔴 화면은 행 배열, 서버는 객체 — 여기서 한 번만 바꾼다
      body: JSON.stringify({ dashboard: { ...form.value, targetRows: undefined, targets: targetsObject() } }),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      throw new Error(b.error || `저장 실패 (${res.status})`);
    }
    // 🔴 서버가 정규화한 값을 다시 읽어 그린다 — 잘린 값을 모른 채 쓰지 않게
    await loadSettings();
    msg.value = '저장했습니다. 서버가 정규화한 값을 다시 표시합니다.';
  } catch (e) {
    err.value = e.message;
  } finally {
    busy.value = false;
  }
}

function toggleCountry(c) {
  const i = form.value.rankingCountries.indexOf(c);
  if (i >= 0) form.value.rankingCountries.splice(i, 1);
  else form.value.rankingCountries.push(c);
}

function toggleRanking(t) {
  const i = form.value.rankingTypes.indexOf(t);
  if (i >= 0) form.value.rankingTypes.splice(i, 1);
  else form.value.rankingTypes.push(t);
}

/* ── ⑦ 수동 분석 실행 ── */
const runBusy = ref(false);
const runDry = ref(false);
const runMsg = ref('');
const runErr = ref('');

async function runAnalysis() {
  if (runBusy.value) return;
  runBusy.value = true;
  runMsg.value = '';
  runErr.value = '';
  try {
    const res = await apiFetch('/api/analyst/run', {
      method: 'POST',
      body: JSON.stringify({ dryRun: runDry.value }),
    });
    const b = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(b.error || `분석 실행 실패 (${res.status})`);
    const parts = [];
    if (b.marketView) parts.push(b.marketView);
    parts.push(`제안 ${Array.isArray(b.proposals) ? b.proposals.length : 0}건`);
    if (Number(b.dashFailed) > 0) parts.push(`데이터 부분 실패 ${b.dashFailed}건`);
    runMsg.value = `${b.dryRun ? '[점검 실행 — 발송·제안 없음] ' : ''}${parts.join(' · ')}`
      + (b.dryRun ? '' : ' — 전체 보고서는 대시보드 분석 패널에 저장됐습니다.');
  } catch (e) {
    runErr.value = e.message;
  } finally {
    runBusy.value = false;
  }
}

let timer = null;
onMounted(() => {
  loadStatus();
  loadSettings();
  timer = setInterval(loadStatus, 30_000);
});
onUnmounted(() => clearInterval(timer));
</script>

<style scoped>
/*
 * 🔴 자기 스타일만 쓴다 — 전역(styles/ui.css)에 있는 .btn·.input·.banner·.mono-num·.up/.down 외에는
 *    전부 이 파일이 정의한다. 다른 뷰의 scoped 에 기대지 않는다(2026-09-21 설정 패널 사고의 규율).
 */
.page { flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-base); display: flex; flex-direction: column; gap: var(--space-sm); }
/* 🔄 10-06 사용자: "max-width 금지, 전폭 사용" — 1440px 중앙 정렬 상한(10-04~05 결정)을 걷어냈다.
   폭은 .ops/.row2/.frm 2열 그리드가 채우고, 길어지는 절은 자기 높이(50vh)만 제한한다.
   비상정지 스크림 전폭 보정도 상한이 사라져 함께 불필요해졌다(position: fixed 라 영향 없음). */

.page__head h1 { margin: 0; font-size: var(--text-lg); color: var(--color-ink); }
.card { background: var(--color-surface); border: 1px solid var(--color-hairline); border-radius: var(--rounded-md); padding: var(--space-base); }
.card h2 { margin: 0 0 8px; font-size: var(--text-md); color: var(--color-ink); }
.mut { font-size: var(--text-xs); color: var(--color-muted); }

/* ① 운용 상태 줄 — 구 상단바의 모양을 카드 안으로 */
.st { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-sm); font-size: var(--text-xs); margin-bottom: 6px; }
.st__state { font-weight: 700; color: var(--color-open); white-space: nowrap; font-size: var(--text-sm); }
.st__state--paused { color: var(--color-danger); }
.st__chip { border: 1px solid var(--color-hairline); border-radius: var(--rounded-pill); padding: 2px 10px; color: var(--color-body); white-space: nowrap; }
.st__spacer { flex: 1; }

/* ①+④ 한 카드 2열 — 자율 수준 | AI 예산 (2026-10-05 세로 다이어트) */
.ops {
  display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-base) var(--space-lg, 24px);
  margin-top: var(--space-sm); border-top: 1px solid var(--color-hairline-soft);
  padding-top: var(--space-sm); align-items: start;
}
.ops__col { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.subh { margin: 0; font-size: var(--text-sm); color: var(--color-ink); display: flex; align-items: center; gap: 6px; }
/* ⓘ 긴 설명은 title 툴팁으로 옮겼다 — 본문은 한 줄 이하 */
.info { cursor: help; color: var(--color-faint); font-size: var(--text-xs); font-weight: 400; }

/* ⑤+⑦ 짧은 카드 2열 묶음 */
.row2 { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-sm); align-items: stretch; }
@media (max-width: 960px) { .ops, .row2 { grid-template-columns: 1fr; } }

/* ④ 자율 수준 */
.levels { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--space-sm); margin-bottom: 6px; }
.level {
  border: 1px solid var(--color-hairline); border-radius: var(--rounded-md);
  padding: var(--space-sm) var(--space-base); display: flex; flex-direction: column; gap: 2px;
  background: none; text-align: left; cursor: pointer; font: inherit;
}
.level:hover { border-color: var(--color-primary-line); }
.level__now { color: var(--color-primary); font-weight: 700; }
.level b { color: var(--color-ink); font-size: var(--text-sm); }
.level small { color: var(--color-muted); font-size: var(--text-xs); }
.level--on { border-color: var(--color-ai-line); background: var(--color-ai-soft); }
.level--locked { opacity: .75; }

/* ⑥-표준화: 설정 테이블 (2026-10-04 — 항목·저장값·변경·설명 4열 규격) */
.settbl { width: 100%; border-collapse: collapse; font-size: var(--text-sm); }
.settbl th { text-align: left; font-size: var(--text-2xs); color: var(--color-faint); padding: 6px var(--space-sm); border-bottom: 1px solid var(--color-hairline); }
.settbl td { padding: 8px var(--space-sm); border-bottom: 1px solid var(--color-hairline-soft); vertical-align: top; }
.settbl__k { width: 190px; font-weight: 600; color: var(--color-ink); }
.settbl__cur { width: 170px; color: var(--color-body); }
.settbl__in { width: 330px; }
.settbl__in .chips { margin-bottom: 4px; }
.settbl__in .xs { max-width: 140px; }
.settbl__d { color: var(--color-muted); font-size: var(--text-xs); }
.defbadge, .dirtybadge {
  display: inline-block; margin-left: 4px; font-style: normal; font-size: var(--text-2xs);
  padding: 0 6px; border-radius: var(--rounded-pill);
}
.defbadge { color: var(--color-faint); background: var(--color-flat-soft); }
.dirtybadge { color: var(--color-warn); border: 1px solid var(--color-warn); }

.ledger__row { display: flex; align-items: center; gap: var(--space-sm); flex-wrap: wrap; margin: 6px 0; }
.ledger__row label { display: flex; align-items: center; gap: 6px; font-size: var(--text-sm); color: var(--color-body); }
.ledger__stats { display: flex; gap: var(--space-lg, 24px); margin: 4px 0 0; flex-wrap: wrap; }
.ledger__stats dt { font-size: var(--text-2xs); color: var(--color-faint); }
.ledger__stats dd { margin: 0; font-weight: 600; color: var(--color-ink); }

/* ⑤ 한도 표 */
.tbl { width: 100%; border-collapse: collapse; font-size: var(--text-sm); margin-bottom: 6px; }
.tbl td { padding: 5px var(--space-sm); border-bottom: 1px solid var(--color-hairline-soft); }

/* ⑥ 설정 폼 — 구 SettingsPanel 의 .sp__* 규칙을 이 페이지 이름으로 가져왔다 */
/* 🔴 2026-10-04 사용자: "width 무턱대고 100% 넣지 말고 정리" — 1440px 화면에서 입력이
   풀폭으로 퍼져 난잡했다. 폼은 2열 그리드, 입력은 읽기 좋은 폭(≤420px)으로 멈춘다.
   긴 것(프롬프트·crontab)만 전폭 행(span 2)을 쓴다. */
.frm { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-base) var(--space-lg, 24px); align-items: start; }
.frm__row--wide { grid-column: 1 / -1; }
.frm__row { display: flex; flex-direction: column; gap: 6px; }
.frm__row--sep { border-top: 1px solid var(--color-hairline); padding-top: var(--space-base); }
.frm__label { font-size: var(--text-md); font-weight: 600; color: var(--color-ink); display: flex; gap: 8px; align-items: center; }
.frm__label em {
  font-style: normal; font-size: var(--text-2xs); font-weight: 600;
  color: var(--color-faint); background: var(--color-flat-soft);
  padding: 1px 6px; border-radius: var(--rounded-pill);
}
.frm__row small { font-size: var(--text-xs); color: var(--color-muted); line-height: 1.5; }
.inlh { margin-left: 6px; font-weight: 500; color: var(--color-faint); font-size: var(--text-2xs); }

/* 입력 — 전역 .input 은 레이아웃만 준다. 색·테두리는 여기서(브라우저 기본으로 안 남긴다) */
.frm select,
.frm input[type='text'],
.frm input[type='number'] {
  width: 100%;
  max-width: 420px;
  background: var(--color-surface-sunken);
  border: 1px solid var(--color-hairline-strong);
  border-radius: var(--rounded-md);
  color: var(--color-ink);
  font-size: var(--text-base);
  padding: 10px var(--space-base);
}
.frm input::placeholder,
.frm .area::placeholder { color: var(--color-faint); }
.frm input:focus,
.frm .area:focus { outline: none; border-color: var(--color-primary-line); box-shadow: var(--ring); }
.frm .area {
  width: 100%; max-width: 760px; resize: vertical; line-height: 1.6;
  background: var(--color-surface-sunken); border: 1px solid var(--color-hairline-strong);
  border-radius: var(--rounded-md); color: var(--color-ink); font-size: var(--text-base);
  padding: 10px var(--space-base);
}

.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip {
  border: 1px solid var(--color-hairline); background: var(--color-surface-sunken);
  color: var(--color-muted); font-size: var(--text-sm); padding: 4px 10px;
  border-radius: var(--rounded-pill); cursor: pointer;
}
.chip--on { background: var(--color-primary-soft); border-color: var(--color-primary-line); color: var(--color-primary); }

/* 테마가 쌓여 절이 길어지면 자기 안에서만 스크롤 — 페이지를 못 늘인다 */
.groups { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-height: 50vh; overflow-y: auto; }
.groups li { display: flex; align-items: center; gap: 8px; font-size: var(--text-md); color: var(--color-ink); }
.gcount { margin-left: auto; font-size: var(--text-xs); color: var(--color-faint); }
.gdel { border: 0; background: none; color: var(--color-muted); cursor: pointer; font-size: var(--text-lg); }
.gdel:hover { color: var(--color-danger); }
.gempty { color: var(--color-faint); font-size: var(--text-sm); }
.gadd { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; }

.target { display: grid; grid-template-columns: 1.4fr 1fr 1fr 26px; gap: 4px; margin-bottom: 4px; align-items: center; }
.now { grid-column: 1 / -1; color: var(--color-faint); font-size: var(--text-2xs); }
/* .xs 는 위의 .frm select/input 패딩을 덮어 한 줄 높이로 줄인다 */
.frm .xs { height: 28px; font-size: var(--text-xs); padding: 0 8px; }
.icon {
  width: 26px; height: 28px; padding: 0; line-height: 1; cursor: pointer;
  border: 1px solid var(--color-hairline); border-radius: var(--rounded-sm);
  background: var(--color-surface-sunken); color: var(--color-body);
}
.icon:hover { background: var(--color-surface-hover); }
.add {
  height: 28px; padding: 0 10px; font-size: var(--text-xs);
  background: var(--color-primary-soft); border-color: var(--color-primary-line); color: var(--color-primary);
  align-self: flex-start;
}
.hint { color: var(--color-faint); font-size: var(--text-xs); margin: 0; }
.err { margin: 4px 0 0; color: var(--color-down); font-size: var(--text-xs); }
.ok { margin: 4px 0 0; color: var(--color-up); font-size: var(--text-xs); }
.foot { display: flex; justify-content: flex-end; gap: var(--space-sm); padding-top: var(--space-xs); }

/* ⑦ 수동 분석 실행 */
.run { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-sm); margin: 6px 0; }
.run__opt { display: flex; align-items: center; gap: var(--space-xs); font-size: var(--text-xs); color: var(--color-body); }

/* 🛑 비상정지 모달 — 구 AppShell(HEAD) scoped 그대로 */
.stop__scrim { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; z-index: 60; }
.stop {
  width: min(480px, 92vw); background: var(--color-surface); color: var(--color-body);
  border: 1px solid var(--color-hairline); border-radius: var(--rounded-lg);
  padding: var(--space-md); display: flex; flex-direction: column; gap: var(--space-sm);
  box-shadow: var(--shadow-pop);
}
.stop h2 { margin: 0; font-size: var(--text-lg); color: var(--color-danger); }
.stop__sub { margin: 0; font-size: var(--text-sm); }
.stop__opt {
  display: flex; gap: var(--space-sm); align-items: flex-start;
  border: 1px solid var(--color-hairline); border-radius: var(--rounded-md); padding: var(--space-sm);
  cursor: pointer;
}
.stop__opt b { display: block; color: var(--color-ink); font-size: var(--text-sm); }
.stop__opt small { color: var(--color-muted); font-size: var(--text-xs); }
.stop__opt--danger { border-color: var(--color-danger-soft); }
.stop__resume, .stop__confirm { font-size: var(--text-xs); display: flex; align-items: center; gap: var(--space-xs); }
.stop__confirm .input { max-width: 120px; }
/* 모달 입력도 맨몸으로 안 남긴다 — 전역 .input 은 레이아웃만 준다 */
.stop__confirm input {
  background: var(--color-surface-sunken); border: 1px solid var(--color-hairline-strong);
  border-radius: var(--rounded-md); color: var(--color-ink); font-size: var(--text-sm); padding: 6px 10px;
}
.stop__foot { display: flex; align-items: center; gap: var(--space-xs); font-size: var(--text-2xs); color: var(--color-faint); }
.stop__gap { flex: 1; }
</style>
