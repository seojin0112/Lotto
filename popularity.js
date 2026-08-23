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
  const FEATURES = [
    { key: 'small', label: '12 이하 번호 개수(월·일 범위)' },
    { key: 'mid', label: '13~31 번호 개수(일 범위)' },
    { key: 'high', label: '40 이상 번호 개수' },
    { key: 'consec1', label: '연속 번호 1쌍(여부)' },
    { key: 'consec2', label: '연속 번호 2쌍(여부)' },
    { key: 'consec3', label: '연속 번호 3쌍 이상(여부)' },
    { key: 'mult7', label: '7의 배수 개수' },
    { key: 'lastd', label: '끝자리 같은 쌍 개수' },
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
    let done = 0, cancelled = false, timer = null;

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
      timer = setTimeout(step, 0);
    }

    timer = setTimeout(step, 0);
    return { cancel: () => { cancelled = true; clearTimeout(timer); } };
  }

  // 스캔 결과에서 최하위/최상위 인기도 그룹을 뽑는다. 표시 배수(소수 2자리)가 같은
  // 인접 버킷은 하나로 합친다. 반환: [{mult, count, combos(예시 최대 2)}] — take개 그룹
  function extremes(scanResult, take = 6) {
    const walk = (keys) => {
      const groups = [];
      for (const k of keys) {
        const bk = scanResult.buckets.get(k);
        const mult = Math.exp(k / 1000);
        const last = groups[groups.length - 1];
        if (last && last.mult.toFixed(2) === mult.toFixed(2)) {
          last.count += bk.c;
          if (last.combos.length < 2) last.combos.push(bk.ex[0]);
        } else {
          if (groups.length === take) break;
          groups.push({ mult, count: bk.c, combos: bk.ex.slice(0, 2) });
        }
      }
      return groups;
    };
    return { least: walk(scanResult.keys), most: walk([...scanResult.keys].reverse()) };
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

  return { TOTAL_COMBOS, FEATURES, features, fit, score, sampleDist, percentile, scan, extremes, scanPercentile };
})();
