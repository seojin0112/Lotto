// 조합 인기도 추정 모듈
//
// 원리: 동행복권은 조합별 판매량을 공개하지 않지만, 회차별 1등 당첨자 수(자동/수동/반자동 구분 포함)와
// 총판매액은 공개한다. 자동 구매는 균등 무작위이므로 인기 편향은 수동 구매에서만 나온다.
// 수동(+반자동) 1등 당첨자 수의 기댓값은 조합의 수동 구매 인기도에 비례하므로,
// 262회 이후 전 회차를 표본으로 당첨 조합의 특성(생일 범위 번호 수, 번호 합, 연속수 등)에 대해
// 푸아송 회귀(로그 링크, 오프셋 = log(판매 게임 수 / 8,145,060))를 적합해 임의 조합의 인기도를 추정한다.
//
// 점수(score)는 "평균적인 조합 대비 수동 구매 빈도 배수"로, 당첨 확률과는 무관하다.
const LottoPop = (() => {
  const TOTAL_COMBOS = 8145060; // C(45,6)

  // 특성 벡터. 순서는 FEATURES와 일치해야 한다.
  // 번호 구간(≤12 / 13~31 / 32~39 / 40~45)별 개수를 쓰고 32~39 구간을 기준(계수 0)으로 둔다.
  // 생일(월·일) 효과를 잡으면서도, 합계 같은 연속 특성과의 공선성으로 인한
  // 훈련 범위 밖 외삽(예: "높은 합 + 생일 번호 다수" 조합)을 피하기 위한 구성이다.
  // 연속 쌍 개수는 원자료에서 U자형(0쌍 > 1~2쌍 회피, 3쌍 이상 선호)이라 선형이 아닌 범주형으로 넣는다.
  // short/unit은 조합 검색의 특징 분해 표시용 (unit이 null이면 여부 특성)
  const FEATURES = [
    { key: 'small', label: '12 이하 번호 개수(월·일 범위)', short: '12 이하', unit: '개' },
    { key: 'mid', label: '13~31 번호 개수(일 범위)', short: '13~31', unit: '개' },
    { key: 'high', label: '40 이상 번호 개수', short: '40 이상', unit: '개' },
    { key: 'consec1', label: '연속 번호 1쌍(여부)', short: '연속 1쌍', unit: null },
    { key: 'consec2', label: '연속 번호 2쌍(여부)', short: '연속 2쌍', unit: null },
    { key: 'consec3', label: '연속 번호 3쌍 이상(여부)', short: '연속 3쌍+', unit: null },
    { key: 'mult7', label: '7의 배수 개수', short: '7의 배수', unit: '개' },
    { key: 'lastd', label: '끝자리 같은 쌍 개수', short: '같은 끝자리', unit: '쌍' },
  ];

  function features(nums) {
    let small = 0, mid = 0, high = 0, consec = 0, mult7 = 0, lastd = 0;
    for (let i = 0; i < 6; i++) {
      const n = nums[i];
      if (n <= 12) small++;
      else if (n <= 31) mid++;
      else if (n >= 40) high++;
      if (n % 7 === 0) mult7++;
      for (let j = i + 1; j < 6; j++) {
        if (nums[j] - n === 1) consec++;
        if (n % 10 === nums[j] % 10) lastd++;
      }
    }
    return [small, mid, high, consec === 1 ? 1 : 0, consec === 2 ? 1 : 0, consec >= 3 ? 1 : 0, mult7, lastd];
  }

  // ----- 선형계 풀이 (가우스 소거, p ~ 12라 충분) -----
  function solve(A, b) {
    const n = b.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let col = 0; col < n; col++) {
      let piv = col;
      for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      if (Math.abs(M[piv][col]) < 1e-12) throw new Error('특이 행렬 — 회귀 적합 실패');
      [M[col], M[piv]] = [M[piv], M[col]];
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const f = M[r][col] / M[col][col];
        for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
      }
    }
    return M.map((row, i) => row[n] / M[i][i]);
  }

  // ----- 모델 적합 -----
  // data: [{epsd, nums, y, games}] — y = 수동(+반자동) 1등 당첨자 수, games = 판매 게임 수
  // 설계 행렬 = [절편, 시대 더미(회차 구간별), 특성들]. 절편·시대 더미는 수동 구매 비중과
  // 그 시대별 변화를 흡수하고, 특성 계수만 조합 인기도로 쓴다.
  const ERA_BOUNDS = [500, 800, 1100]; // 절편 포함 4개 시대 (262회~ 데이터 기준)

  function fit(data, lambda = 0.5) {
    const p = 1 + ERA_BOUNDS.length + FEATURES.length;
    const X = [], y = [], off = [];
    for (const d of data) {
      const row = new Array(p).fill(0);
      row[0] = 1;
      ERA_BOUNDS.forEach((b, i) => { if (d.epsd >= b) row[1 + i] = 1; });
      features(d.nums).forEach((v, i) => { row[1 + ERA_BOUNDS.length + i] = v; });
      X.push(row);
      y.push(d.y);
      off.push(Math.log(d.games / TOTAL_COMBOS));
    }

    // IRLS (릿지 벌점은 특성 계수에만)
    let beta = new Array(p).fill(0);
    let XtWX;
    for (let iter = 0; iter < 50; iter++) {
      XtWX = Array.from({ length: p }, () => new Array(p).fill(0));
      const XtWz = new Array(p).fill(0);
      for (let i = 0; i < X.length; i++) {
        let eta = off[i];
        for (let j = 0; j < p; j++) eta += X[i][j] * beta[j];
        const mu = Math.max(Math.exp(eta), 1e-10);
        const z = eta - off[i] + (y[i] - mu) / mu;
        for (let j = 0; j < p; j++) {
          XtWz[j] += X[i][j] * mu * z;
          for (let k = j; k < p; k++) XtWX[j][k] += X[i][j] * mu * X[i][k];
        }
      }
      for (let j = 0; j < p; j++)
        for (let k = 0; k < j; k++) XtWX[j][k] = XtWX[k][j];
      for (let j = 1 + ERA_BOUNDS.length; j < p; j++) XtWX[j][j] += lambda;

      const next = solve(XtWX, XtWz);
      const delta = Math.max(...next.map((v, j) => Math.abs(v - beta[j])));
      beta = next;
      if (delta < 1e-9) break;
    }

    // 표준오차: (XᵀWX + λR)⁻¹ 대각 성분 (단위 벡터별 풀이로 역행렬 열 계산)
    const se = beta.map((_, j) => {
      const ej = new Array(p).fill(0);
      ej[j] = 1;
      return Math.sqrt(solve(XtWX, ej)[j]);
    });

    const model = { featBeta: beta.slice(1 + ERA_BOUNDS.length), featSe: se.slice(1 + ERA_BOUNDS.length), norm: 1 };
    // 무작위 조합 표본의 평균 점수로 정규화해 "평균 조합 = ×1.0"이 되게 한다.
    const sample = sampleDist(model, 20000);
    model.norm = sample.reduce((a, b) => a + b, 0) / sample.length;
    return model;
  }

  // 평균 조합 대비 수동 구매 인기도 배수. 시대·절편 항은 순위에 영향이 없어 제외한다.
  function score(model, nums) {
    const x = features(nums);
    let eta = 0;
    for (let i = 0; i < x.length; i++) eta += model.featBeta[i] * x[i];
    return Math.exp(eta) / model.norm;
  }

  // ----- 점수 분포 (무작위 표본) -----
  // 전 조합 스캔 전에도 백분위를 보여줄 수 있도록 표본 분포를 만든다.
  function sampleDist(model, n = 50000) {
    const scores = new Array(n);
    const pool = Array.from({ length: 45 }, (_, i) => i + 1);
    for (let s = 0; s < n; s++) {
      for (let i = 0; i < 6; i++) {
        const j = i + Math.floor(Math.random() * (45 - i));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      const nums = pool.slice(0, 6).sort((a, b) => a - b);
      scores[s] = score(model, nums);
    }
    scores.sort((a, b) => a - b);
    return scores;
  }

  // dist에서 s의 백분위(0~100, 낮을수록 비인기)
  function percentile(dist, s) {
    let lo = 0, hi = dist.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (dist[mid] < s) lo = mid + 1;
      else hi = mid;
    }
    return (lo / dist.length) * 100;
  }

  // 청크 사이 양보용 스케줄러. setTimeout은 백그라운드 탭에서 1Hz로 스로틀되어 스캔이 수 분씩
  // 걸리게 되므로, 스로틀 대상이 아닌 MessageChannel 태스크로 다음 청크를 예약한다.
  function defer(fn) {
    if (typeof MessageChannel === 'undefined') {
      setTimeout(fn, 0);
      return;
    }
    const ch = new MessageChannel();
    ch.port1.onmessage = () => { ch.port1.close(); fn(); };
    ch.port2.postMessage(0);
  }

  // ----- 전 조합 스캔 -----
  // 8,145,060개 전 조합을 청크로 나눠 훑으며 log-점수 히스토그램(버킷별 개수 + 예시 저장소 표본)을 만든다.
  // 조합당 exp/log 호출을 피하려고 버킷 키는 선형 예측값(log 점수)에서 바로 만든다.
  // 반환된 핸들의 cancel()로 중단할 수 있다.
  const EXAMPLES_PER_BUCKET = 6;

  function scan(model, { chunkSize = 250000, onProgress, onDone }) {
    const buckets = new Map(); // round(log(score)*1000) → {c: 개수, ex: 예시 조합들}
    const nums = [0, 0, 0, 0, 0, 0];
    const beta = model.featBeta;
    const logNorm = Math.log(model.norm);
    let a = 1, b = 2, c = 3, d = 4, e = 5, f = 6;
    let done = 0, cancelled = false;

    function step() {
      if (cancelled) return;
      let n = 0;
      while (n < chunkSize) {
        nums[0] = a; nums[1] = b; nums[2] = c; nums[3] = d; nums[4] = e; nums[5] = f;
        const x = features(nums);
        let eta = -logNorm;
        for (let i = 0; i < x.length; i++) eta += beta[i] * x[i];
        const key = Math.round(eta * 1000);
        let bk = buckets.get(key);
        if (!bk) { bk = { c: 0, ex: [] }; buckets.set(key, bk); }
        bk.c++;
        if (bk.ex.length < EXAMPLES_PER_BUCKET) bk.ex.push([a, b, c, d, e, f]);
        else {
          const j = Math.floor(Math.random() * bk.c);
          if (j < EXAMPLES_PER_BUCKET) bk.ex[j] = [a, b, c, d, e, f];
        }
        n++; done++;
        // 다음 조합 (사전식)
        if (f < 45) f++;
        else if (e < 44) { e++; f = e + 1; }
        else if (d < 43) { d++; e = d + 1; f = e + 1; }
        else if (c < 42) { c++; d = c + 1; e = d + 1; f = e + 1; }
        else if (b < 41) { b++; c = b + 1; d = c + 1; e = d + 1; f = e + 1; }
        else if (a < 40) { a++; b = a + 1; c = b + 1; d = c + 1; e = d + 1; f = e + 1; }
        else {
          const keys = [...buckets.keys()].sort((x, y) => x - y);
          onDone({ buckets, keys, total: done });
          return;
        }
      }
      if (onProgress) onProgress(done / TOTAL_COMBOS);
      defer(step);
    }

    defer(step);
    return { cancel: () => { cancelled = true; } };
  }

  // 스캔 결과 전체를 인기 높은 순 티어 목록으로 변환한다. 표시 배수(소수 2자리)가 같은
  // 인접 버킷은 하나로 합친다. keyLo/keyHi는 티어에 속한 버킷 키 범위(enumerateTier용).
  // 반환: [{mult, count, combos(예시 최대 2), rankStart(1=최고 인기), keyLo, keyHi}]
  function buildTiers(scanResult) {
    const tiers = [];
    let rank = 1;
    for (let i = scanResult.keys.length - 1; i >= 0; i--) {
      const k = scanResult.keys[i];
      const bk = scanResult.buckets.get(k);
      const mult = Math.exp(k / 1000);
      const last = tiers[tiers.length - 1];
      if (last && last.mult.toFixed(2) === mult.toFixed(2)) {
        last.count += bk.c;
        last.keyLo = k; // 키는 내림차순으로 순회하므로 마지막이 최소
        if (last.combos.length < 2) last.combos.push(bk.ex[0]);
      } else {
        tiers.push({ mult, count: bk.c, combos: bk.ex.slice(0, 2), rankStart: rank, keyLo: k, keyHi: k });
      }
      rank += bk.c;
    }
    return tiers;
  }

  // 티어(버킷 키 범위 keyLo~keyHi)에 속한 조합을 사전식 순서로 열거한다. limit개를 찾으면
  // 멈추고 재개용 state를 넘겨주므로 "더 불러오기"로 이어서 열거할 수 있다.
  // onDone({combos, state, exhausted}) — exhausted면 전 조합 순회가 끝난 것. cancel()로 중단.
  function enumerateTier(model, tier, { limit = 60, state = null, chunkSize = 400000, onDone }) {
    let { a, b, c, d, e, f } = state || { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 };
    const nums = [0, 0, 0, 0, 0, 0];
    const beta = model.featBeta;
    const logNorm = Math.log(model.norm);
    const combos = [];
    let cancelled = false;

    function step() {
      if (cancelled) return;
      let n = 0;
      while (n < chunkSize) {
        nums[0] = a; nums[1] = b; nums[2] = c; nums[3] = d; nums[4] = e; nums[5] = f;
        const x = features(nums);
        let eta = -logNorm;
        for (let i = 0; i < x.length; i++) eta += beta[i] * x[i];
        const key = Math.round(eta * 1000);
        if (key >= tier.keyLo && key <= tier.keyHi) combos.push([a, b, c, d, e, f]);
        n++;
        // 다음 조합으로 이동한 뒤 종료 검사 — state가 항상 "다음에 볼 조합"을 가리키게 한다
        if (f < 45) f++;
        else if (e < 44) { e++; f = e + 1; }
        else if (d < 43) { d++; e = d + 1; f = e + 1; }
        else if (c < 42) { c++; d = c + 1; e = d + 1; f = e + 1; }
        else if (b < 41) { b++; c = b + 1; d = c + 1; e = d + 1; f = e + 1; }
        else if (a < 40) { a++; b = a + 1; c = b + 1; d = c + 1; e = d + 1; f = e + 1; }
        else { onDone({ combos, state: null, exhausted: true }); return; }
        if (combos.length >= limit) { onDone({ combos, state: { a, b, c, d, e, f }, exhausted: false }); return; }
      }
      defer(step);
    }

    defer(step);
    return { cancel: () => { cancelled = true; } };
  }

  // 조합의 특성별 인기 기여 분해. x가 0이 아닌 특성만 반환: [{short, unit, x, mult}]
  function breakdown(model, nums) {
    const x = features(nums);
    return FEATURES
      .map((f, i) => ({ short: f.short, unit: f.unit, x: x[i], mult: Math.exp(model.featBeta[i] * x[i]) }))
      .filter((b) => b.x !== 0);
  }

  // 번호별 수동 선택 인기도(전체 평균 = 1). data는 fit()과 같은 형식.
  // 번호 n이 포함된 당첨 조합의 수동 당첨자 수를 기대치 대비 비율로 집계한 실측 통계다.
  function numberStats(data) {
    const act = new Array(46).fill(0), exp = new Array(46).fill(0);
    let totAct = 0, totExp = 0;
    for (const d of data) {
      const e = d.games / TOTAL_COMBOS;
      totAct += d.y;
      totExp += e;
      for (const n of d.nums) { act[n] += d.y; exp[n] += e; }
    }
    const base = totAct / totExp;
    return Array.from({ length: 46 }, (_, n) => (n >= 1 && exp[n] > 0 ? act[n] / exp[n] / base : 0));
  }

  // ----- 예상 기대값 -----
  // 1,000원 1게임의 기대 환급액(세전). 4·5등은 고정 금액이고 1~3등은 당첨자끼리 나누므로,
  // 이 조합을 산 사람이 적을수록(인기도가 낮을수록) 기대값이 올라간다.
  // params: {games: 회차 판매 게임 수, pool1~3: 등수별 총 배분액, autoShare: 자동 구매 비중} — 최근 회차 평균으로 추정
  // 동시 당첨자 K ~ Poisson(λ)일 때 E[pool/(K+1)] = pool·(1−e^−λ)/λ 를 쓴다.
  const MATCH4_COMBOS = 11115;  // C(6,4)·C(39,2)
  const MATCH3_COMBOS = 182780; // C(6,3)·C(39,3)

  function expectedValue(model, params, nums, taxFn) {
    return expectedValueAt(params, score(model, nums), taxFn);
  }

  // 인기도 배수 r을 직접 지정해 기대값을 계산 (비교 표 등에 사용).
  // taxFn(당첨금)→세금을 주면 세후 기대값: 등수별 기대 당첨금(당첨 시 1인당 금액)에 세금을 적용한다.
  // 세율 구간이 등수별로 사실상 고정이라(1등 ≫ 3억, 2등 22% 구간, 3~5등 비과세) 선형 근사가 정확하다.
  function expectedValueAt(params, r, taxFn) {
    const mix = params.autoShare + (1 - params.autoShare) * r; // 이 조합의 구매율 (평균 조합 = 1)
    const share = (lam) => (lam < 1e-9 ? 1 : (1 - Math.exp(-lam)) / lam);
    const net = (amt) => (taxFn ? amt - taxFn(amt) : amt);
    const perComboWinners = params.games / TOTAL_COMBOS;
    // pool × share(λ) = 당첨됐을 때 받는 1인당 금액의 기댓값 (λ = 나 외 동시 당첨자 수 기대치)
    const ev1 = (1 / TOTAL_COMBOS) * net(params.pool1 * share(perComboWinners * mix));
    const ev2 = (6 / TOTAL_COMBOS) * net(params.pool2 * share(6 * perComboWinners * mix));
    const ev3 = (228 / TOTAL_COMBOS) * net(params.pool3 * share(228 * perComboWinners * mix));
    const ev4 = (MATCH4_COMBOS / TOTAL_COMBOS) * net(50000);
    const ev5 = (MATCH3_COMBOS / TOTAL_COMBOS) * net(5000);
    return { total: ev1 + ev2 + ev3 + ev4 + ev5, ev1, ev2, ev3, ev4, ev5 };
  }

  // 스캔 히스토그램 기반 정확한 백분위
  function scanPercentile(scanResult, s) {
    const key = Math.round(Math.log(s) * 1000);
    let below = 0;
    for (const k of scanResult.keys) {
      if (k >= key) break;
      below += scanResult.buckets.get(k).c;
    }
    return (below / scanResult.total) * 100;
  }

  return { TOTAL_COMBOS, FEATURES, features, fit, score, sampleDist, percentile, scan, scanPercentile, buildTiers, enumerateTier, breakdown, numberStats, expectedValue, expectedValueAt };
})();
