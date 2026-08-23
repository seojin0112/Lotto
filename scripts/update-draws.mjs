// 동행복권 로또 6/45 당첨번호 데이터를 받아 draws.js를 생성/갱신하는 스크립트.
// 사용법: node scripts/update-draws.mjs  (의존성 없음, Node 18+)
//
// 데이터 출처: https://www.dhlottery.co.kr/lt645/selectPstLt645InfoNew.do
//  - srchDir=latest & srchCursorLtEpsd=N : N회차보다 새로운 회차를 10개씩 반환 (없으면 빈 배열)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const OUT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'draws.js');
const API = 'https://www.dhlottery.co.kr/lt645/selectPstLt645InfoNew.do';
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  Accept: 'application/json, text/javascript, */*; q=0.01',
  'X-Requested-With': 'XMLHttpRequest',
  Referer: 'https://www.dhlottery.co.kr/lt645/result',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// cursor >= 1: 해당 회차보다 새로운 회차 10개 / cursor 0: 1회차부터 시작 (srchCursorLtEpsd=0은 서버가 빈 배열을 반환)
async function fetchNewerThan(cursor) {
  const qs = cursor >= 1 ? `srchDir=latest&srchCursorLtEpsd=${cursor}` : 'srchDir=center&srchLtEpsd=1';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${API}?${qs}`, { headers: HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.text();
      let json;
      try {
        json = JSON.parse(body);
      } catch {
        throw new Error('응답이 JSON이 아님 — 해외 IP 차단 또는 API 변경 가능성: ' + body.slice(0, 120));
      }
      return json?.data?.list ?? [];
    } catch (err) {
      if (attempt === 3) throw err;
      console.warn(`  재시도 ${attempt}/2 (cursor=${cursor}): ${err.message}`);
      await sleep(1500 * attempt);
    }
  }
}

// API 항목 → [회차, 추첨일, 번호1..6, 보너스, 1등금액..5등금액, 1등수..5등수, 총판매액, 1등자동, 1등수동, 1등반자동]
function toRow(it) {
  const nums = [it.tm1WnNo, it.tm2WnNo, it.tm3WnNo, it.tm4WnNo, it.tm5WnNo, it.tm6WnNo].map(Number);
  nums.sort((a, b) => a - b);
  const amounts = [it.rnk1WnAmt, it.rnk2WnAmt, it.rnk3WnAmt, it.rnk4WnAmt, it.rnk5WnAmt].map(Number);
  const counts = [it.rnk1WnNope, it.rnk2WnNope, it.rnk3WnNope, it.rnk4WnNope, it.rnk5WnNope].map(Number);
  const sales = Number(it.wholEpsdSumNtslAmt);
  // winType1/2/3 = 1등 당첨자의 자동/수동/반자동 구분 (초기 회차는 미집계라 전부 0)
  const winTypes = [it.winType1, it.winType2, it.winType3].map(Number);
  const winType0 = Number(it.winType0);
  const epsd = Number(it.ltEpsd);
  const ymd = Number(it.ltRflYmd);
  const bns = Number(it.bnsWnNo);

  const winTypeSum = winTypes.reduce((a, b) => a + b, 0) + winType0;
  const valid =
    Number.isInteger(epsd) && epsd >= 1 &&
    /^\d{8}$/.test(String(ymd)) &&
    nums.every((n) => Number.isInteger(n) && n >= 1 && n <= 45) &&
    new Set(nums).size === 6 &&
    Number.isInteger(bns) && bns >= 1 && bns <= 45 && !nums.includes(bns) &&
    amounts.every((a) => Number.isInteger(a) && a >= 0) &&
    counts.every((c) => Number.isInteger(c) && c >= 0) &&
    Number.isInteger(sales) && sales > 0 &&
    winTypes.every((w) => Number.isInteger(w) && w >= 0) &&
    Number.isInteger(winType0) && winType0 >= 0 &&
    // 자동/수동 구분이 집계된 회차라면 합계가 1등 당첨자 수와 일치해야 함
    (winTypeSum === 0 || winTypeSum === counts[0]);
  if (!valid) throw new Error(`비정상 데이터 (회차 ${it.ltEpsd}): ` + JSON.stringify(it));

  return [epsd, ymd, ...nums, bns, ...amounts, ...counts, sales, ...winTypes];
}

const ROW_LEN = 23;

function loadExisting() {
  let src;
  try {
    src = readFileSync(OUT_FILE, 'utf8');
  } catch {
    return [];
  }
  const m = src.match(/const LOTTO_DRAWS = (\[[\s\S]*\]);/);
  if (!m) throw new Error(`${OUT_FILE}에서 LOTTO_DRAWS 배열을 찾지 못함 — 파일이 손상되었으면 삭제 후 재실행`);
  const rows = JSON.parse(m[1]);
  // 구 스키마(열 수가 다름) 파일이면 버리고 전체 재수집
  if (rows.length && rows[0].length !== ROW_LEN) {
    console.log(`기존 파일이 구 형식(${rows[0].length}열) — 전체 재수집합니다`);
    return [];
  }
  return rows;
}

const rows = new Map(loadExisting().map((r) => [r[0], r]));
let cursor = rows.size ? Math.max(...rows.keys()) : 0;
console.log(rows.size ? `기존 데이터: ${rows.size}회차 (최신 ${cursor}회)` : '기존 데이터 없음 — 전체 수집 시작');

let added = 0;
while (true) {
  const list = await fetchNewerThan(cursor);
  if (list.length === 0) break;
  for (const it of list) rows.set(Number(it.ltEpsd), toRow(it));
  added += list.length;
  cursor = Math.max(...list.map((it) => Number(it.ltEpsd)));
  if (added % 200 < 10) console.log(`  ...${cursor}회까지 수집`);
  await sleep(120);
}

if (added === 0) {
  console.log('새 회차 없음 — draws.js 변경 없이 종료');
} else {
  const sorted = [...rows.values()].sort((a, b) => a[0] - b[0]);
  // 회차 연속성 검증 (중간 누락 시 조기 발견)
  sorted.forEach((r, i) => {
    if (r[0] !== i + 1) throw new Error(`회차 누락/불일치: index ${i}에 ${r[0]}회`);
  });

  const latest = sorted[sorted.length - 1];
  const out =
    '// 이 파일은 scripts/update-draws.mjs가 생성합니다. 직접 수정하지 마세요.\n' +
    '// 형식: [회차, 추첨일(YYYYMMDD), 번호1..6, 보너스, 1등금액..5등금액, 1등수..5등수, 총판매액, 1등자동, 1등수동, 1등반자동]\n' +
    '// 금액은 해당 회차 1게임당 당첨금(원). 0이면 해당 등수 당첨자가 없어 이월된 회차.\n' +
    '// 1등 자동/수동/반자동은 미집계 회차(초기)에서 전부 0.\n' +
    'const LOTTO_DRAWS = [\n' +
    sorted.map((r) => JSON.stringify(r)).join(',\n') +
    '\n];\n';
  writeFileSync(OUT_FILE, out, 'utf8');
  console.log(`완료: ${added}회차 추가, 총 ${sorted.length}회차 (최신 ${latest[0]}회, ${latest[1]} 추첨)`);
}
