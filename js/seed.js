'use strict';
/* ===== 데모용 예시 데이터 ===== */
function makeSeed() {
  const ago = (days, hours = 0) => new Date(Date.now() - (days * 24 + hours) * 3600 * 1000).toISOString();
  const domain = 'example.hs.kr';
  const U = (id, name, local, role, status, generation, days) => ({ id, name, email: `${local}@${domain}`, role, status, generation, createdAt: ago(days) });
  const users = [
    U('u_teacher', '김지도 선생님', 'teacher', 'teacher', 'active', null, 200),
    U('u_sihu', '시후', 'sihu', 'admin', 'active', 3, 180),
    U('u_minjun', '민준', 'minjun', 'member', 'active', 4, 90),
    U('u_seoyeon', '서연', 'seoyeon', 'member', 'active', 4, 90),
    U('u_jiho', '지호', 'jiho', 'member', 'active', 4, 88),
    U('u_doyun', '도윤 (졸업)', 'doyun', 'member', 'graduated', 2, 400),
    U('u_haeun', '하은', 'haeun', 'member', 'pending', null, 1),
  ];

  /* ---------- 코드 내용 ---------- */
  const rocketReadme = `# 🚀 로켓 시뮬레이션

수직으로 발사한 로켓의 고도와 속도를 단순 오일러 적분으로 계산합니다.

## 실행 방법
\`\`\`
python main.py
\`\`\`

## 파일 구성
- \`main.py\` : 시뮬레이션 실행
- \`physics.py\` : 한 단계씩 상태를 진행하는 물리 계산
`;
  const physicsV1 = `G = 9.8  # 중력 가속도 (m/s^2)


def step(h, v, t, dt, thrust, burn_time):
    """한 시간 간격(dt)만큼 로켓의 상태를 진행합니다."""
    a = (thrust if t < burn_time else 0.0) - G
    v = v + a * dt
    h = h + v * dt
    return h, v
`;
  const mainV1 = `# 로켓 시뮬레이션 (원본)
from physics import step

THRUST = 15.0     # 추력 가속도 (m/s^2)
BURN_TIME = 10.0  # 연소 시간 (s)
DT = 0.5

t, h, v = 0.0, 0.0, 0.0
print("로켓 발사!")
while h >= 0:
    h, v = step(h, v, t, DT, THRUST, BURN_TIME)
    t += DT
    if round(t / DT) % 4 == 0 and h >= 0:
        print(f"t={t:5.1f}s  고도={h:8.1f}m  속도={v:7.1f}m/s")

print(f"비행 시간: {t:.1f} s")
`;
  const mainV2 = `# 로켓 시뮬레이션 (원본)
from physics import step

THRUST = 15.0     # 추력 가속도 (m/s^2)
BURN_TIME = 10.0  # 연소 시간 (s)
DT = 0.5

t, h, v = 0.0, 0.0, 0.0
max_h = 0.0
print("로켓 발사!")
while h >= 0:
    h, v = step(h, v, t, DT, THRUST, BURN_TIME)
    t += DT
    max_h = max(max_h, h)
    if round(t / DT) % 4 == 0 and h >= 0:
        print(f"t={t:5.1f}s  고도={h:8.1f}m  속도={v:7.1f}m/s")

print(f"최고 고도: {max_h:.1f} m, 비행 시간: {t:.1f} s")
`;
  const physicsDrag = `G = 9.8   # 중력 가속도 (m/s^2)
K = 0.002 # 공기저항 계수 (속도 제곱에 비례)


def step(h, v, t, dt, thrust, burn_time):
    """한 시간 간격(dt)만큼 로켓의 상태를 진행합니다.
    공기저항은 운동 방향의 반대로 작용합니다."""
    drag = K * v * abs(v)
    a = (thrust if t < burn_time else 0.0) - G - drag
    v = v + a * dt
    h = h + v * dt
    return h, v
`;
  const mainDrag = mainV2.replace('# 로켓 시뮬레이션 (원본)', '# 로켓 시뮬레이션 + 공기저항').replace('print("로켓 발사!")', 'print("로켓 발사! (공기저항 적용)")');
  const mainGraph = `# 로켓 시뮬레이션 + 공기저항 + 고도 그래프
from physics import step

THRUST = 15.0     # 추력 가속도 (m/s^2)
BURN_TIME = 10.0  # 연소 시간 (s)
DT = 0.5

t, h, v = 0.0, 0.0, 0.0
max_h = 0.0
samples = []
print("로켓 발사! (공기저항 적용)")
while h >= 0:
    h, v = step(h, v, t, DT, THRUST, BURN_TIME)
    t += DT
    max_h = max(max_h, h)
    if h >= 0:
        samples.append((t, h))

print(f"최고 고도: {max_h:.1f} m, 비행 시간: {t:.1f} s")
print()
print("고도 그래프")
for t_, h_ in samples[::3]:
    bar = "█" * int(h_ / max_h * 40) if max_h > 0 else ""
    print(f"{t_:5.1f}s | {bar} {h_:.0f}m")
`;
  const mainUI = `# 로켓 시뮬레이션 (표 형식 출력)
from physics import step

THRUST = 15.0     # 추력 가속도 (m/s^2)
BURN_TIME = 10.0  # 연소 시간 (s)
DT = 0.5

t, h, v = 0.0, 0.0, 0.0
max_h = 0.0
print("=" * 36)
print(f"{'시간(s)':>8} | {'고도(m)':>10} | {'속도(m/s)':>10}")
print("-" * 36)
while h >= 0:
    h, v = step(h, v, t, DT, THRUST, BURN_TIME)
    t += DT
    max_h = max(max_h, h)
    if round(t / DT) % 4 == 0 and h >= 0:
        print(f"{t:>8.1f} | {h:>10.1f} | {v:>10.1f}")
print("=" * 36)
print(f"최고 고도 {max_h:.1f} m / 비행 시간 {t:.1f} s")
`;
  const mealReadme = `# 🍱 급식 메뉴 추천기

오늘 기분에 맞는 급식 메뉴 조합을 추천해 줍니다.

## 실행 방법
\`python main.py\`
`;
  const mealMain = `import random

MENUS = {
    "밥": ["흰쌀밥", "잡곡밥", "카레라이스", "볶음밥"],
    "국": ["미역국", "된장국", "김치찌개", "어묵국"],
    "반찬": ["제육볶음", "돈가스", "계란말이", "닭강정", "떡볶이"],
    "후식": ["요구르트", "과일", "푸딩"],
}

print("오늘의 추천 급식")
for kind, items in MENUS.items():
    print(f"- {kind}: {random.choice(items)}")
`;
  const mealAllergy = `import random

MENUS = {
    "밥": ["흰쌀밥", "잡곡밥", "카레라이스", "볶음밥"],
    "국": ["미역국", "된장국", "김치찌개", "어묵국"],
    "반찬": ["제육볶음", "돈가스", "계란말이", "닭강정", "떡볶이"],
    "후식": ["요구르트", "과일", "푸딩"],
}
ALLERGY = {"계란말이": "난류", "돈가스": "밀", "푸딩": "우유", "요구르트": "우유"}
avoid = {"우유"}  # 피하고 싶은 알레르기 성분

print(f"오늘의 추천 급식 (제외: {', '.join(avoid)})")
for kind, items in MENUS.items():
    safe = [m for m in items if ALLERGY.get(m) not in avoid]
    print(f"- {kind}: {random.choice(safe)}")
`;
  const gameReadme = `# ⚡ 반응속도 테스트 게임

화면이 초록색으로 바뀌는 순간 클릭하세요! 반응 시간을 ms 단위로 보여 줍니다.

[실행] 탭에서 바로 해볼 수 있습니다.
`;
  const gameHtml = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <title>반응속도 테스트</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div id="box">클릭해서 시작</div>
  <p id="best">최고 기록: -</p>
  <script src="script.js"></script>
</body>
</html>
`;
  const gameCss = `body { font-family: sans-serif; display: flex; flex-direction: column; align-items: center; margin-top: 40px; }
#box { width: 320px; height: 200px; border-radius: 16px; background: #4b5563; color: white;
  display: flex; align-items: center; justify-content: center; font-size: 22px; cursor: pointer; user-select: none; }
#box.wait { background: #dc2626; }
#box.go { background: #16a34a; }
`;
  const gameJs = `const box = document.getElementById('box');
const bestEl = document.getElementById('best');
let state = 'idle', start = 0, timer = null, best = Infinity;

box.addEventListener('click', () => {
  if (state === 'idle') {
    state = 'wait'; box.className = 'wait'; box.textContent = '기다리세요...';
    timer = setTimeout(() => { state = 'go'; box.className = 'go'; box.textContent = '지금 클릭!'; start = performance.now(); },
      1000 + Math.random() * 2000);
  } else if (state === 'wait') {
    clearTimeout(timer); state = 'idle'; box.className = ''; box.textContent = '너무 빨라요! 다시 클릭';
  } else if (state === 'go') {
    const ms = Math.round(performance.now() - start);
    best = Math.min(best, ms); bestEl.textContent = '최고 기록: ' + best + 'ms';
    state = 'idle'; box.className = ''; box.textContent = ms + 'ms — 다시 하려면 클릭';
  }
});
`;

  /* ---------- 프로젝트·버전 ---------- */
  const projects = [], versions = [];
  function P(id, title, description, ownerId, parentId, rootId, permission, generation, days) {
    const p = { id, title, description, ownerId, parentId, rootId, permission, generation, createdAt: ago(days), updatedAt: ago(days), deleted: false, hidden: false, headVersionId: null };
    projects.push(p); return p;
  }
  function V(id, p, authorId, message, days, files, extra = {}) {
    const v = { id, projectId: p.id, message, authorId, createdAt: ago(days), files: Object.entries(files).map(([path, content]) => ({ path, content })), ...extra };
    versions.push(v); p.headVersionId = id; p.updatedAt = v.createdAt; return v;
  }

  const rocket = P('p_rocket', '로켓 시뮬레이션', '수직 발사 로켓의 고도와 속도를 계산하는 파이썬 시뮬레이션', 'u_sihu', null, 'p_rocket', 'free', 3, 60);
  V('v_rocket1', rocket, 'u_sihu', '처음 업로드', 60, { 'README.md': rocketReadme, 'main.py': mainV1, 'physics.py': physicsV1 });
  V('v_rocket2', rocket, 'u_sihu', '최고 고도 출력 추가', 45, { 'README.md': rocketReadme, 'main.py': mainV2, 'physics.py': physicsV1 });

  const drag = P('p_drag', '공기저항 추가', '로켓 시뮬레이션에 속도 제곱에 비례하는 공기저항을 넣었습니다.', 'u_minjun', 'p_rocket', 'p_rocket', 'free', 4, 30);
  V('v_drag1', drag, 'u_minjun', '「로켓 시뮬레이션」에서 수정본 생성', 30, { 'README.md': rocketReadme, 'main.py': mainV2, 'physics.py': physicsV1 }, { forkedFromVersionId: 'v_rocket2' });
  V('v_drag2', drag, 'u_minjun', '공기저항 항 추가', 29, { 'README.md': rocketReadme, 'main.py': mainDrag, 'physics.py': physicsDrag });

  const graph = P('p_graph', '그래프 개선', '고도 변화를 텍스트 막대그래프로 보여줍니다.', 'u_seoyeon', 'p_drag', 'p_rocket', 'free', 4, 20);
  V('v_graph1', graph, 'u_seoyeon', '「공기저항 추가」에서 수정본 생성', 20, { 'README.md': rocketReadme, 'main.py': mainDrag, 'physics.py': physicsDrag }, { forkedFromVersionId: 'v_drag2' });
  V('v_graph2', graph, 'u_seoyeon', '고도 막대그래프 출력', 19, { 'README.md': rocketReadme, 'main.py': mainGraph, 'physics.py': physicsDrag });

  const ui = P('p_ui', 'UI 변경', '결과를 표 형식으로 깔끔하게 출력합니다.', 'u_jiho', 'p_rocket', 'p_rocket', 'free', 4, 15);
  V('v_ui1', ui, 'u_jiho', '「로켓 시뮬레이션」에서 수정본 생성', 15, { 'README.md': rocketReadme, 'main.py': mainV2, 'physics.py': physicsV1 }, { forkedFromVersionId: 'v_rocket2' });
  V('v_ui2', ui, 'u_jiho', '표 형식 출력으로 변경', 14, { 'README.md': rocketReadme, 'main.py': mainUI, 'physics.py': physicsV1 });

  const meal = P('p_meal', '급식 메뉴 추천기', '랜덤으로 오늘의 급식 조합을 추천합니다. (2기 작품)', 'u_doyun', null, 'p_meal', 'approval', 2, 300);
  V('v_meal1', meal, 'u_doyun', '처음 업로드', 300, { 'README.md': mealReadme, 'main.py': mealMain });
  const allergy = P('p_allergy', '알레르기 필터 추가', '피하고 싶은 알레르기 성분이 들어간 메뉴를 빼고 추천합니다.', 'u_seoyeon', 'p_meal', 'p_meal', 'free', 4, 40);
  V('v_allergy1', allergy, 'u_seoyeon', '「급식 메뉴 추천기」에서 수정본 생성', 40, { 'README.md': mealReadme, 'main.py': mealMain }, { forkedFromVersionId: 'v_meal1' });
  V('v_allergy2', allergy, 'u_seoyeon', '알레르기 성분 필터 추가', 39, { 'README.md': mealReadme, 'main.py': mealAllergy });

  const game = P('p_game', '반응속도 테스트 게임', 'HTML/JS로 만든 반응속도 측정 게임', 'u_jiho', null, 'p_game', 'view', 4, 10);
  V('v_game1', game, 'u_jiho', '처음 업로드', 10, { 'README.md': gameReadme, 'index.html': gameHtml, 'style.css': gameCss, 'script.js': gameJs });

  return {
    schema: SCHEMA,
    settings: {
      clubName: '코딩 동아리', domain, signupMode: 'approval', maxFileKB: 2048,
      whitelist: ['newbie@' + domain],
    },
    session: { userId: null },
    users, projects, versions,
    mergeRequests: [
      { id: 'mr_drag', fromProjectId: 'p_drag', toProjectId: 'p_rocket', fromVersionId: 'v_drag2', baseVersionId: 'v_rocket2', authorId: 'u_minjun',
        message: '공기저항을 넣으면 실제 로켓과 더 비슷해져요. 원본에 반영해 주세요!', status: 'pending', createdAt: ago(28) },
    ],
    forkRequests: [
      { id: 'fr_meal', projectId: 'p_meal', requesterId: 'u_jiho', title: '급식 메뉴 GUI 버전', message: '메뉴 추천을 웹 화면으로 바꿔 보고 싶습니다.', status: 'pending', createdAt: ago(2) },
      { id: 'fr_meal_old', projectId: 'p_meal', requesterId: 'u_seoyeon', title: '알레르기 필터 추가', message: '알레르기 필터를 넣고 싶어요', status: 'approved', forkId: 'p_allergy', createdAt: ago(41) },
    ],
    comments: [
      { id: 'cm1', versionId: 'v_rocket2', path: 'physics.py', line: 6, authorId: 'u_minjun', text: '여기에 공기저항 항을 넣으면 더 현실적일 것 같아요!', createdAt: ago(31) },
      { id: 'cm2', versionId: 'v_rocket2', path: 'physics.py', line: 6, authorId: 'u_sihu', text: '좋아요, 수정본 만들어서 해보세요 👍', createdAt: ago(31, -2) },
    ],
    contributors: [],
    reports: [],
    notifications: [
      { id: 'n1', userId: 'u_sihu', text: '민준 님이 「로켓 시뮬레이션」에 반영 요청을 보냈습니다: 공기저항을 넣으면 실제 로켓과 더 비슷해져요.', link: '#/p/p_rocket/merge', read: false, createdAt: ago(28) },
      { id: 'n2', userId: 'u_sihu', text: '지호 님이 「로켓 시뮬레이션」의 수정본 「UI 변경」을 만들었습니다.', link: '#/p/p_ui', read: false, createdAt: ago(15) },
      { id: 'n3', userId: 'u_sihu', text: '하은(haeun@example.hs.kr) 님이 가입 승인을 기다립니다.', link: '#/admin?tab=pending', read: false, createdAt: ago(1) },
      { id: 'n4', userId: 'u_teacher', text: '하은(haeun@example.hs.kr) 님이 가입 승인을 기다립니다.', link: '#/admin?tab=pending', read: false, createdAt: ago(1) },
    ],
  };
}
