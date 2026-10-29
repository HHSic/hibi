'use strict';
/**
 * 실사 고양이 리깅 — 고양이 사진 한 장을 Live2D 처럼 부위마다 살짝 움직인다.
 * 처음엔 회색 고양이(cat-rb) 하나였고, 지금은 같은 코드가 고양이마다 rig.json 데이터만 바꿔 일곱 마리를 움직인다
 * (자리·크기·끈 부위는 아래 «rig.json 항목» 에 모았다. 항목이 없으면 회색 고양이 때 그대로 움직인다).
 *
 * 코드로 그린 고양이(anim/cat.js)는 «이상하다», 만화 같은 그림은 «ㄴㄴ 실제 고양이같은 비주얼» 이라는 말을 들었다.
 * 영상(anim/clip.js)은 진짜 같지만 손을 대도 아무 반응이 없다. 그래서 진짜 사진을 그물(메시)에 붙이고,
 * 부위마다 조금씩 늘이고 돌려 «살아 있는 사진»처럼 움직인다:
 *   커서 쪽으로 고개·눈을 돌리고, 숨 쉬고, 가끔 눈을 깜박이고 귀를 쫑긋한다.
 *   쓰다듬으면 눈을 지그시 감고 그르렁댄다 — 어디를 쓰다듬느냐에 따라 몸짓이 다르다(부위별 반응):
 *     이마는 머리를 손에 밀어 올리고, 턱·볼은 턱을 들고 볼을 손 쪽으로 비비고, 엉덩이(꼬리 밑동)는 엉덩이를 살짝
 *     들고 꼬리 끝을 조금 들며 눈을 지그시 감고, 등은 손이 지나가는 자리를 손에 밀어 올린다. 귀는 예민해서 만지면 그 귀를
 *     파르르 털고 잠깐 젖힌다(그르렁 없음, 자꾸 만지면 짜증이 쌓여 꼬리 끝을 톡톡 친다). 누르면 귀를 털고 고개를 살짝 든다.
 *   기분(기분 표현): 너무 오래 쓰다듬으면 진짜 고양이처럼 몸으로 먼저 «그만» 한다 — 그르렁이 잦아들고 눈을 뜨고
 *     귀를 옆으로 돌리고(비행기 귀) 꼬리 끝을 털다 탁 치고 등 피부가 파르르 떤다. 그래도 계속하면 귀를 젖히고
 *     고개를 홱 돌려 한동안 커서를 모른 척한다. 커서를 얼굴 앞에 가만히 두면 천천히 눈을 깜박여 인사한다.
 *   친밀도(친해지기): 쓰다듬을수록 조금씩 오른다(앱이 저장). 높을수록 빨리 그르렁대고, 오래 참고, 커서를 더
 *     오래·선뜻 따라보고, 눈인사를 잘 받아 주고, 쉴 때 귀·눈이 조금 더 느긋하다.
 * 하트·반짝이 같은 만화 효과는 일부러 없다 — 사진이 진짜처럼 보이는 게 먼저다. 모든 움직임은 작게 묶었다.
 *
 * ── 가볍게 ────────────────────────────────────────────────
 * 휴식 창은 모니터마다 하나씩 뜬다(사용자는 3대). «자원을 많이 안먹으면 좋겠는데» 라는 요청이라:
 *   · 변형은 전부 셰이더에서 uniform 몇 개로 한다 — 머리·귀·숨은 정점 셰이더, 눈동자·꺼풀만 조각 셰이더
 *     (홍채가 메시 칸 두세 개 크기라 정점으로 밀면 각이 진다). 프레임마다 JS 가 정점을 돌지 않고, 텍스처를
 *     다시 올리지 않고, readPixels 도 없다. 프레임마다 새 객체·배열을 만들지 않는다(GC 가 돌 일이 없게).
 *   · 그리기는 프레임당 drawElements 한 번. 화면에서 0.35px(숨쉬기만일 땐 0.28px) 넘게 안 바뀌었으면 아예 안 그린다.
 *   · 빠르기 단계 — 2: 60fps (빠른 깜박임·귀 털기 첫 순간·누르면 고개 들기), 1: 30fps (쓰다듬는 동안,
 *     느린 깜박임, 커서를 눈으로 따라갈 때, 눈 다시 뜨기), 0: 숨쉬기만 — 100ms 앞을 내다보고 10~20fps 에서 골라
 *     한 장에 윤곽이 0.45 기기 px 남짓 가게(보통 숨 등선은 미리보기 크기에서 초당 최고 4.5~5.3 기기 px 라 가장 빠른 곳이
 *     11~13fps. 잰 걸음: 중앙값 0.38, p99 0.46(미리보기)~0.55(텍스처 1:1), 최대 0.52~0.58px — 0.5 넘는 건 거의
 *     두리번 20fps 와 겹친 장. 꼭대기·바닥 쉼은 10fps 에 거의 안 그린다). 혼자 크게 두리번거릴 때만 20fps.
 *     간격은 «마지막 tick 에서 목표 간격» 으로 잡는다 — 144Hz 화면에서도 30fps·숨 10~20fps 가 그대로다. 60fps 단계는
 *     15ms 안에 다시 온 화면 갱신을 건너뛰어 144Hz 에서 144fps 로 돌지 않는다.
 *     창이 가려지거나 pause()·destroy() 면 완전히 쉰다(그르렁도 그친다).
 *   · 캔버스 크기 = CSS 크기 × min(devicePixelRatio, 2), 단 텍스처보다 촘촘하게는 안 잡는다.
 *   · WebGL2 가 되면 텍스처에 밉맵을 둔다 — 구석 자리(1080p, dpr 1)에선 1.8배 줄여 그려, 밉맵 없이
 *     2x2 텍셀만 읽으면 가는 수염이 끊기고 숨 쉴 때 반짝였다. 셰이더는 GLSL 100 그대로다.
 *   · 앱은 고양이를 마우스가 있는 화면 하나에만 앉힌다(영상과 같다 — 다른 모니터는 비워 둔다). static: true 는 WebGL 없이
 *     그림 한 장(<img>)만 띄우는 길이다. 루프도 입력 리스너도 없다(자리가 바뀔 때 다시 맞추는 ResizeObserver 하나만).
 *   · WebGL 이 없거나 소프트웨어로만 돌면(failIfMajorPerformanceCaveat) 같은 그림 한 장으로 물러난다 —
 *     CPU 로 셰이더를 돌리느니 가만히 있는 사진이 낫다.
 *   · 그르렁 소리(WebAudio 합성, 파일 없음)는 그르렁댈 때만 AudioContext 를 돌리고, 그치면 suspend() 한다 —
 *     소리가 없어도 돌고 있는 AudioContext 는 CPU 를 먹는다(코어의 2% 남짓). destroy() 때 close().
 *     처음 만드는 AudioContext 는 소리 장치를 여느라 메인 스레드를 0.4~0.9초 붙잡는다. 그래서
 *       ① 창이 보이기 전에 preload({ audio: true }) 로 만들어 두거나(휴식 창은 10초 앞서 숨겨서 만든다),
 *       ② 알림음이 이미 연 컨텍스트를 opts.audioContext 로 넘기거나(창마다 하나만 — 출력 스트림이 둘이 안 되게),
 *       ③ 둘 다 없으면 첫 그림 뒤 한가할 때(requestIdleCallback) 만든다 — 첫 그림이 늦지 않게.
 *
 * ── 텍스처 (고양이마다 폴더 하나 assets/catrig/<rig>/, rig.json 이 설명 — 아래는 회색 고양이 grey/) ─────────────
 *   base.webp — cat-rb.webm 의 330번째 프레임(고개 정면, 눈 뜬 채 가만히). 알파는 곱하지 않은 채.
 *               오른귀는 그 순간 돌던 중이라 흐려서, 굽는 단계에서 귀 둘레만 알파 대비와 선명도를 세웠다.
 *   eyes.webp — 눈꺼풀 «층» 아틀라스. 영상에 눈 감는 장면이 한 번도 없어서, base 에서 위 꺼풀 털을 아래로
 *               늘여 덮는 변형으로 구웠다(1/8 걸음 8장). 칸의 알파는 «꺼풀이 덮은 정도» 다 — 늘어난 털은 1,
 *               그대로인 픽셀은 0, 꺼풀 그늘은 검정 + 반투명. 그래서 꺼풀은 시선과 상관없이 제자리에 얹히고
 *               그 아래 눈동자는 시선만큼 민 채 비친다(깜박일 때 눈동자가 가운데로 튀지 않는다).
 *               이웃한 두 장끼리만 섞어 꺼풀 끝이 내려오는 것처럼 보이게 한다.
 *               맨 아래 줄엔 각막 반사(하이라이트)를 지운 동공과 반사의 밝은 몫이 있다 — 눈동자를 밀어도
 *               반사는 제자리에 둔다(진짜 눈은 돌아도 반사가 광원 기준으로 거의 그대로다).
 *   rig.json  — 눈·코·귀·머리·쓰다듬는 몸통 자리(텍스처 px), 숨 쉬는 자리(breathing — 등선 들림 띠, 옆구리·가슴 타원),
 *               꺼풀 아틀라스 칸, 반사 상자, 투명해서 안 그리는 메시 칸(고양이 위인가도 이것으로 본다),
 *               부위(zones — 턱·볼 경계, 귀 범위, 등·엉덩이 타원, 엉덩이 들림 장, 꼬리 축·반폭·앞발 붙듦,
 *               등 피부 떨림이 지나가는 x 범위와 아래로 사라지는 y).
 *               zones·breathing 이 없는 옛 굽기는 기본값(DEF_ZONES·DEF_BREATHING)으로 움직인다.
 *               꼬리 뒤(위)는 몸통 털, 아래는 투명이다 — 사진에 꼬리에 가려진 픽셀이 없어 꼬리를 몸 위로 크게 들 수 없다.
 *               그래서 꼬리는 그물을 휘는 만큼만(끝 4~7px) 움직이고, 위쪽 털이 눌리는 띠를 34px 로 둔다.
 *   다른 고양이 — 리그는 «머리 왼쪽, 몸·꼬리 오른쪽» 사진을 바탕으로 짰다. 영상이 반대로 앉은 고양이(cat-lie·cat-roll·cat-loaf)는
 *               텍스처를 좌우로 뒤집어 굽고 rig.json display.mirror 로 화면에서만 다시 뒤집는다(커서 x 도 거울로 읽는다).
 *               꼬리·엉덩이가 안 보이는 고양이는 그 부위를 끈다(null) — 회색 자리로 채우지 않는다.
 *
 * ── 쓰는 법 ───────────────────────────────────────────────
 *   nunsCatRig.preload({ audio: true })   — 숨은 휴식 창이 읽힐 때(보이기 전). 그림 풀기·소리 장치 열기를 미리
 *   nunsCatRig.release()                  — 이 창에는 고양이가 안 뜬다(미리 연 소리 장치를 닫는다)
 *   const h = nunsCatRig.mount(host, { sound: true, volume: 0.7, affinity: 0.4, todayStrokes: 12, onPet(p) {}, onMood(m) {}, onAffinity(v) {} });
 *   host 는 자리를 잡은(position 이 static 이 아닌) 상자다. 고양이는 그 안에 비율을 지켜(contain) 바닥에 앉는다
 *   (opts.align 으로 바꿀 수 있다). 영상 고양이와 같은 자리·크기의 host 는 clip.js 의 rigBox(w, h, clip, rig, worldOf(rig))가
 *   정한다 — rig.json display.video(또는 굽기 기록 source)로 사진이 영상 프레임의 어디서 왔는지 보고 옮긴다. worldOf(rig) 의 w·h 를
 *   그대로 layout 에 넣으면 안 된다(영상과 리그는 투명 여백이 달라 크기·자리가 어긋난다). worldOf 는 h.ready 의 width·height 와
 *   같다 — 고양이마다 다르다(nunsCatRig.WORLD 는 회색 고양이 값). 거울(display.mirror)이면 그림 요소에 scale: -1 1 이 붙는다(h.ready 의 mirror).
 *   h.ready (Promise) · h.pause() · h.resume() · h.settle(ms) · h.setSound(on, volume) · h.destroy()
 *     settle — 쉬는 자세(= static 그림)로 돌아간 뒤 풀리는 Promise. 라이브 ↔ static 을 바꾸기 직전에 부르면
 *              자리가 튀지 않는다. resume() 하면 다시 움직인다.
 *   h.getAffinity() · h.setAffinity(v, todayStrokes) · h.stats() — 친밀도, 기분, 쓰다듬은 횟수(부위별)·세션·화낸 횟수·눈인사
 *     (setAffinity 의 todayStrokes 는 선택 — 다른 화면에서 오늘 친밀도에 든 횟수. 이 창이 센 것보다 크면 그것으로 하루 몫을 이어 간다)
 *   opts: base(텍스처 폴더 주소), textures { base, eyes }, rig(객체 — 주면 rig.json 을 안 읽는다),
 *         static, sound, volume(0~1), audioContext(남이 연 컨텍스트 — 닫지 않고 그르렁 graph 만 뗀다),
 *         affinity(0~1, 기본 0.3 — 앱이 저장한 친밀도), todayStrokes(오늘 앞서 쓰다듬은 횟수 — 하루 몫이 줄게),
 *         onPet({ zone, strokes, ms, credited }) (쓰다듬기 한 판이 끝날 때 — zone 은 가장 많이 쓸어 준 곳: head·chin·back·rump·body,
 *           credited 는 그중 친밀도에 든 횟수 — 경고 중 쓸기는 안 든다),
 *         onMood(mood) ('calm'·'content'·'warning'·'annoyed' — 바뀔 때만), onAffinity(v) (한 판이 끝날 때·화냈을 때),
 *         className(그림 요소에 붙일 클래스 — 그리기 시작하면 'in' 이 붙는다),
 *         align [x, y] (0~1, 기본 [0.5, 1] = 가운데 아래), debug(시험용 h.debug — hold·zone·earTouch·tailFlick·irk·fold·moodCfg…)
 *   nunsCatRig.affinityAfter(prev, { strokes, todayBefore, annoyed, daysAway }) — 친밀도 규칙(앱·미리보기가 같이 쓴다)
 *   커서는 window 에서 듣는다 — 휴식 화면의 연출 층(.curtain)은 pointer-events: none 이라 캔버스에는 안 온다.
 *   손가락으로 쓰다듬으려면 페이지가 html, body { touch-action: none } 이어야 한다(아니면 Chromium 이 몇 px
 *   움직인 손가락을 팬 제스처로 가져가며 pointercancel 을 낸다). 휴식 화면은 스크롤이 없다.
 */
(() => {
  const DEFAULT_BASE = '../assets/catrig/';
  /** 싣고 다니는 회색 고양이 텍스처의 세계 크기 (텍스처 px) — 예전 자리 잡기용으로 남겨 둔다. 고양이마다 다르니 자리 잡기는
   *  worldOf(rig) 를 쓴다. 회색 rig.json 을 다시 구우면 맞는지 debug 가 콘솔에 알린다. 그림을 불러온 뒤엔 h.ready 의 width·height 가 기준이다 */
  const WORLD = { width: 834, height: 893 };

  // 텍스처 둘레 여백 (텍스처 px) — 귀를 젖히고 고개를 들면 몇 px 밖으로 나간다. 아래는 발끝 바로 밑에서 자른다
  // (발이 상자 아래 끝에 닿게 — 영상 고양이처럼 창 아래 끝에 앉는다). FLOOR_PAD 는 rig.json body.floorPad 가 없을 때
  const PAD_L = 16, PAD_T = 18, FLOOR_PAD = 4;

  // 움직임 크기 (텍스처 px·라디안). 사진은 늘일수록 고무처럼 보인다 — 진짜처럼 보이는 만큼만.
  // px 값은 전부 회색 고양이 크기(머리 반지름 188.8) 기준이다 — 다른 크기로 구운 고양이는 rig.json scale 배로 움직인다
  const YAW_PX = 11, PITCH_PX = 7;         // 얼굴 안쪽(코 > 눈 > 윤곽) 시차 — 고개를 돌린 것처럼
  const YAW_RIGID = 3.5, PITCH_RIGID = 2.5; // 머리 통째 옮김
  const ROLL_MAX = 0.035;                  // 고개 갸웃 한계 (2°)
  const LEAN_PX = 6;                       // 쓰다듬는 쪽으로 기대기
  const LIFT_PET = 2.5;                    // 쓰다듬을 때 손에 머리를 밀어 올림
  const GAZE_X = 3.5, GAZE_Y = 2.5;        // 눈동자 (홍채 안쪽만 민다)
  // 귀 회전 한계: 바깥 ≈17°, 안쪽 ≈6° (안쪽으로 돌면 이마 털에 눌려 뭉개진다). 0.24 였을 땐 부드러운 한계가 경고 귀(비행기 귀)를
  // 만족 귀와 1° 차이로 눌러 경고가 화면에서 안 보였다
  const EAR_MAX = 0.3, EAR_IN = 0.1;
  const EAR_RELAX = 0.06;                  // 쓰다듬을 때 귀를 옆으로 조금 (≈3.4°) — 중립 가까이 둬야 경고의 비행기 귀와 갈려 보인다
  // 귀 스프링 — 빠르게 나갔다 거의 넘치지 않고 돌아온다(정점 ~28ms, 넘침 ~7%). 감쇠 0.32 는 세 번 출렁여
  // 고무 귀처럼 보였다. 두 번 털 때는 넘침에 기대지 않고 짧은 털기를 한 번 더 건다
  const EAR_W = 40, EAR_Z = 0.65;
  // 귀마다 털기 폭은 rig.json ears.*.flick (기본 1) — 회색 고양이는 굽은 프레임에서 덜 또렷한 오른귀를 0.6 으로 덜 흔든다
  // 숨 (텍스처 px, 숨 1 = 보통 들숨 끝). 몸통 큰 타원을 통째 키우던 때는 «사진을 살짝 확대» 로만 보였다.
  // 진짜 쉬는 고양이처럼 어깨 뒤 갈비뼈 위 등선이 오르고 옆구리가 조금 부풀고 흰 가슴이 앞으로 조금 나온다.
  // 발·바닥에 닿은 곳·꼬리, 접어 넣은 뒷다리 허벅지(엉덩이)는 거의 그대로, 머리·어깨는 1px 남짓 따라 오른다
  // (자리는 rig.json breathing — 줄무늬 동심 호가 감싼 x 600~790 덩어리는 허벅지라 숨 자리가 아니다)
  // 아래 넷은 rig.json breathing.amp·ribs.push·chest.push 가 없을 때 (× scale)
  const BREATH_LIFT = 5;                   // 등선(갈비뼈 위) 들림 — 미리보기 크기 화면에선 3.7px 남짓
  const BREATH_SIGH = 0.8;                 // 한숨 끝에 어깨·머리가 더 오르는 몫
  // 옆구리 부풂 — 카메라 쪽 부풂을 사진에선 못 그려 오른쪽 위 옆밀림으로 대신한다. 이 항은 윤곽에서 0 이라
  // 실루엣은 거의 그대로고 안쪽 털(줄무늬)만 미끄러진다 — 2.2 였을 땐 줄무늬가 젤리처럼 출렁일 만했다. 작게만
  const FLANK_X = 0.6, FLANK_Y = -0.3;
  const CHEST_X = -0.6, CHEST_Y = -0.2;    // 흰 가슴 앞(왼쪽)·위로 — 같은 까닭으로 작게
  // 숨 빠르기 — 쉬는 고양이는 분당 20~30번(2.2~3.2초). 들숨 38%(천천히 시작·끝), 날숨 50%(힘 빼고 놓듯 — 들숨보다
  // 조금 길게, I:E ≈ 1:1.2), 바닥에서 12% 쉰다. 날숨은 앞쪽이 조금만 빠르다(bK) — 1.8 이었을 땐 «푹 꺼졌다» 끝을 오래
  // 끌어 숨마다 1초 가까이 멈춰 펌프 같았다. 숨마다 길이 ±10%·깊이 ±15%. 25~60초에 한 번 한숨(1.6~2배, 길게
  // 들이쉬고 꼭대기에서 잠깐 멈췄다 천천히 내쉬고, 바닥에서 조금 더 쉰다). 숨 길이는 rig.json breathing.period 가 있으면 그것
  // (아기 고양이는 숨이 빠르다)
  const BREATH_PER = 2.7, BREATH_IN = 0.38, BREATH_OUT = 0.5, BREATH_K = 1.25;
  const PET_SLOW = 0.3, PET_DEEP = 0.3;    // 쓰다듬는 동안 숨이 이만큼 느리고 깊다(편안하다)
  const SIGH_PET = 0.25;                   // 한숨엔 쓰다듬기 깊이 몫을 이만큼만 — 다 겹치면 2.6배, 털이 9% 늘어 고무 같다
  // 숨 자리 기본값 — rig.json 에 breathing(또는 그 일부)이 없는 옛 굽기도 숨 쉬게. 지금 rig.json 과 같다
  const DEF_BREATHING = {
    lift: { y: [380, 760], x: [380, 490, 590, 740], keep: [0.25, 0.12] },
    shoulder: [440, 640],
    ribs: { center: [520, 470], rx: 150, ry: 200 },
    chest: { center: [185, 530], rx: 140, ry: 125 }
  };
  // 부위 기본값 — rig.json 에 zones(또는 그 일부)가 없는 옛 굽기도 부위별로 반응하게. 지금 rig.json 과 같다.
  // chin: 머리 타원 안에서 y > max(min, y - k(x - x)²) 아래 — 가운데는 입·수염 패드 아래(코와 코 위 주둥이는 이마 갈래 —
  // 345 였을 땐 코를 쓸면 턱을 들었다), 옆 볼은 눈 아래 300 부터.
  // ear: 귀 축 비율 t 범위와 옆 여유(px). back·rump: 몸 위 타원. rump.lift: 엉덩이 들림 장(x 여기서 시작·여기부터 다,
  // y 여기까지 다·여기서 0 — 아래 꼬리·바닥은 그대로). tail: 밑동·끝(축), 위·아래 반폭, 위로 사라지는 폭,
  // 끝 말기 축 자리(길이 비), 앞발 붙듦 x(여기서 0·여기부터 다 — 꼬리 끝이 오른 앞발에 닿아 있다).
  // ripple: 등 피부 떨림·손 밑 혹이 놓이는 x 범위(어깨 ~ 엉덩이), 이 y 아래로 fade(190px)에 걸쳐 사라진다(등 위쪽 띠만 움직인다)
  const DEF_ZONES = {
    chin: { x: 262, y: 378, k: 0.003, min: 300 },
    ear: { t: [0.12, 1.2], pad: 10 },
    back: { center: [505, 335], rx: 150, ry: 92 },
    rump: { center: [705, 478], rx: 112, ry: 125, lift: { x: [585, 700], y: [525, 690] } },
    tail: { base: [785, 718], tip: [338, 832], halfWidth: [46, 46], fade: 34, curl: 0.5, hold: [326, 360] },
    ripple: { x: [430, 770], y: 360 }
  };
  // ── rig.json 항목 (자리는 텍스처 px, 텍스처 왼쪽 위가 0,0. «선택» 이 아닌 항목은 있어야 한다) ──
  // 끄기: «끌 수 있다» 고 적은 항목은 null 이나 { enabled: false } 로 끈다. 끈 항목은 기본값(회색 자리)으로 채우지 않고, 그 움직임·
  //   부위 판정·그 때문에 빠르기를 올리던 판단까지 없앤다. 아예 빠진 항목만 기본값(DEF_ZONES·DEF_BREATHING — 회색 고양이 자리)으로
  //   채운다(옛 굽기). 일부만 적은 항목은 빠진 값만 기본값이다.
  //   version, source, synthetic, mouth, chest·breath(맨 위) — 굽기 기록. 리그는 안 읽는다
  //   cat                    — (선택) 같은 고양이를 찍은 영상끼리 같은 이름(예: 'tabby-kitten'). 리그는 안 읽는다 — 앱이 쓰다듬은
  //                            횟수·친밀도를 이 이름으로 모은다(없으면 사진 폴더 이름. src/breakwin.js catKey)
  //   size { w, h }          — 텍스처 크기
  //   scale                  — (선택, 기본 1) 움직임 배율 ≈ 머리 반지름 / 188.8. px 로 정한 움직임(고개 시차·통째 옮김·눈동자·기대기·들기·
  //                            턱·엉덩이·등 혹·피부 떨림·숨 기본값)과 px 문턱(쓸기 길이·되돌림·귀 문지름·눈인사 «가만히»·따라보기
  //                            나눗수·얼굴 앞 타원 기본값·머리 가중치 기본 띠·갸웃 중심·귀 옆 여유·꼬리 끝 거리)에 곱한다
  //   display { mirror }     — (선택) mirror: true 면 그림(캔버스·정지 그림)을 화면에서 좌우로 뒤집고 커서 x 도 거울로 읽는다.
  //                            영상과 반대로(머리 왼쪽으로) 뒤집어 구운 텍스처를 영상 방향으로 보여 준다 — 시선·고개·부위가 진짜 커서를 따른다.
  //                            display.video [x0, y0, x1, y1](선택)·source(crop·scale·videoSize)는 리그가 안 읽는다 — 앱이 영상 고양이와
  //                            같은 자리에 앉히는 데 쓴다(clip.js rigSource·rigBox)
  //   eyes.left / right      — center(시선 기준 — 두 눈 가운데), mask { center, rx, ry, angle(°), feather }(꺼풀 층이 얹히는 타원),
  //                            irisMask { center, rx, ry }(눈동자를 미는 타원), catch { box: [x, y, w, h], bg, exc }(선택 — 각막 반사를
  //                            제자리에 둔다. bg·exc 는 아틀라스 자리). rx·ry·radius·pupil·pupilR 은 기록
  //   nose { center }        — 고개 돌릴 때 가장 많이 나오는 곳 (tip 은 기록)
  //   chin [x, y], neck [x, y] — 머리 가중치 기본 y 띠(턱 − 12 ~ 목 + 30)와 갸웃 중심(목 x, 턱 + 25)
  //   head { center, rx, ry, radius, faceCenter } — 머리 타원(이마·턱 부위), 얼굴 시차 타원(faceCenter, rx·0.88, ry·0.9),
  //                            코 시차 폭(radius·0.24), 머리 가중치 기본 x 띠(center + rx·0.9 에서 줄어 + rx·1.6 에서 0 — 몸이 머리 오른쪽)
  //     head.weight          — (선택) 머리 통째 움직임(갸웃·옮김)과 숨의 «머리 한 덩어리» 가 미치는 장. 머리 타원과 따로 —
  //                            { x: [x0, x1](x0 까지 1, x1 에서 0) 또는 [x0, x1, x2, x3](x0 에서 0·x1 부터 1·x2 부터 줄어·x3 에서 0),
  //                              y: [y0, y1](y0 까지 1, y1 에서 0), ellipse: { center, rx, ry, falloff: [r0, r1] }(정규 반지름 r0 까지 1,
  //                              r1 에서 0 — 기본 [1, 1.5]) }. 준 것끼리 곱하고, 안 준 것은 1. head.weight 가 없으면 기본 띠
  //     head.face            — (선택) 얼굴 앞 타원 { center, rx, ry } — 눈인사·먼저 건네기의 «커서가 얼굴 앞인가».
  //                            없으면 가운데 (faceCenter.x, 두 눈 y + 40), 150 x 115 (× scale)
  //     head.zone            — (선택) 이마·턱 부위 판정 타원 { center, rx, ry } — 얼굴 시차 타원과 따로. 볼 갈기·넓은 아래 볼이 머리 타원
  //                            밖이라 «그 밖의 몸» 으로 잡히던 고양이용. 없으면 머리 타원(세로 × 1.05)
  //   ears.left / right      — tip, base, baseInner, baseOuter (귀 축·밑동 폭 — 귀 휨·귀 부위). flick(선택, 기본 1): 털기 폭.
  //                            length·radius 는 기록
  //   ears.flatMax           — (선택, 기본 0.2) 귀 눕힘 한계 — 화난 채 귀를 만지면 이 값에 붙는다. 밑동이 좁고 긴 귀는 0.2 에서 쐐기처럼 늘어
  //                            0.15~0.17 로 묶는다
  //   body { floorY, floorPad } — 발끝 y. 세계 상자는 floorY + floorPad(선택, 기본 4)에서 끝난다 — 영상이 몸을 자른 고양이는
  //                            floorY = 자른 줄, floorPad 0. bbox·cut 은 기록
  //   breathing              — 숨 자리. 통째로 끌 수 있다(숨 박자·그르렁은 그대로, 움직이는 곳이 없다)
  //     lift { y: [y0, y1], x: [x0, x1, x2, x3], keep: [앞, 엉덩이], head } — 등선 들림: y0 위는 다, y1 아래는 0(바닥·발·꼬리).
  //                            x0 에서 오르기 시작해 x1 ~ x2 다, x3 에서 엉덩이 몫(keep[1])까지. x0 왼쪽(앞)은 keep[0].
  //                            head(선택, 기본 keep[0]): 머리 장(head.weight) 안에 남는 몫. 끌 수 있다 — 한숨 어깨도 같은 y 띠라 같이 꺼진다
  //     shoulder [x0, x1]    — 한숨 끝에 어깨·머리가 더 오르는 x(x0 까지 다, x1 에서 0). [x0, x1, x2, x3] 이면 x0 에서 0·x1 부터 다·
  //                            x2 부터 줄어 x3 에서 0(어깨 왼쪽에 꼬리가 있는 고양이 — 한숨에 꼬리가 같이 안 뜨게). 끌 수 있다
  //     ribs { center, rx, ry, push } — 옆구리 타원, 숨 1 에서 미는 px [x, y](push 선택, 기본 [0.6, −0.3] × scale). 끌 수 있다
  //     ribs2 { center, rx, ry, push } — (선택) 둘째 옆구리 — 정면 고양이의 반대쪽 옆구리. push 기본은 ribs.push 의 x 를 뒤집은 것
  //                            (두 옆구리가 바깥으로 대칭으로 부푼다)
  //     chest { center, rx, ry, push } — 흰 가슴 타원(push 선택, 기본 [−0.6, −0.2] × scale). 끌 수 있다
  //     amp { lift, sigh }   — (선택) 등선 들림 px(기본 5 × scale), 한숨 어깨 px(기본 0.8 × scale)
  //     period               — (선택) 보통 숨 한 번 길이(초, 기본 2.7)
  //   lids { tiles, origin, atlas } — 꺼풀 아틀라스: 칸 자리(1/8 걸음 차례), 칸 원점(텍스처 px), 아틀라스 크기. t·tile·layer·shape 는 기록
  //     lids.dimCatch [a, b] — (선택) 꺼풀이 a 에서 b 까지 내려오는 동안 각막 반사의 밝은 몫을 거둔다 — 감은 칸의 틈으로 반사 점이
  //                            비치던 고양이용. 없으면 반사는 꺼풀과 상관없다
  //   grid { cols, rows, cells } — 메시 칸, 칸 채움(줄마다 16진, 글자 하나에 4칸) — 빈 칸은 안 그리고 «고양이 위가 아니다»
  //   zones                  — 부위. 통째로 null 이면 귀만 남는다(머리 타원은 다 이마, 그 밖은 «그 밖의 몸»)
  //     hit { alpha, pad }   — (선택) «고양이 위인가» 를 메시 칸(20px 남짓)에 더해 사진 알파로도 본다: 알파 alpha(0~255, 기본 32) 넘는
  //                            털에서 pad px(기본 6 × scale — 손 크기 여유) 안만. 귀 부위도 이 안에서만. true 면 기본값.
  //                            없으면 메시 칸만 — 칸 안의 투명 여백·귀 옆 허공·바닥 흐림 띠까지 쓰다듬기로 쳤다
  //     chin { x, y, k, min } — 머리 타원 안에서 y > max(min, y − k(x − x)²) 아래가 턱·볼. 끌 수 있다(머리 타원이 다 이마)
  //     ear { t: [a, b], pad } — 귀 축 비율 범위, 옆 여유 px
  //     back { center, rx, ry, weight } — 등 타원(쓰다듬으면 손 밑 혹). 끌 수 있다. weight(선택): 혹이 오르는 장
  //                            { x: [x0, x1, x2, x3], y: [y0, y1](y0 위는 0, y1 부터 다) } — 없으면 숨 들림 장(lift)을 같이 쓴다.
  //                            어느 쪽이든 아래로는 ripple.y 에서 ripple.fade 에 걸쳐 사라진다
  //     rump { center, rx, ry, lift } — 엉덩이 타원(긁으면 엉덩이 들기·꼬리 끝 들기·덜 감기). 끌 수 있다.
  //                            lift { x: [x0, x1] 또는 [x0, x1, x2, x3](x2 부터 줄어 x3 에서 0 — 꼬리가 엉덩이와 같이 들리지 않게),
  //                            y: [y0, y1](y0 까지 다, y1 에서 0) } — 엉덩이 들림 장. lift 만 끌 수도 있다(반응은 남고 몸은 안 든다)
  //     tail { base, tip, halfWidth: [위, 아래], fade, curl, hold, upSign, below, gain } — 꼬리 축(밑동 → 끝), 축에서 위·아래 반폭,
  //                            위로 사라지는 폭, 끝 말기 축(길이 비), 앞발 붙듦 x [여기서 0, 여기부터 다](끌 수 있다 — 끝이 떠 있으면 null).
  //                            upSign(선택, 기본 1): 몸 쪽(위)이 밑동 → 끝 방향의 왼쪽 법선이면 1(−x 로 뻗은 꼬리), 오른쪽이면 −1(+x 로 뻗은 꼬리).
  //                            below(선택): 축 아래로 같이 도는 반폭 px — 여기서 fade 에 걸쳐 0. 꼬리 축 아래에 앞발이 있는 고양이용
  //                            (없으면 아래로는 끝없이 같이 돈다 — 회색은 꼬리 아래가 투명이다).
  //                            움직임은 꼬리 끝 px 로 맞춘다 — 회색 꼬리 끝과 같은 px(× scale)라 짧은 꼬리는 그만큼 더 돈다.
  //                            gain(선택): 그 대신 쓸 배율 — 수 하나 또는 [굽힘, 끝 말기](회색 rad 상수에 곱한다). 끌 수 있다
  //     ripple { x: [x0, x1], y, fade, weight } — 등 피부 떨림·손 밑 혹이 놓이는 x 범위(어느 쪽이 먼저든), 이 y 아래로
  //                            fade px(선택, 기본 190 × scale)에 걸쳐 사라진다. weight(선택): 피부 떨림 장 — back.weight 와 같은 꼴.
  //                            끌 수 있다(경고에 피부 떨림이 없다)
  // 꺼진 항목인가 — null 이나 { enabled: false }. 손으로 고칠 때 쓰기 쉬운 false 도 끈 것으로 본다(아니면 회색 기본 자리로 켜졌다)
  const off = (v) => v === null || v === false || !!(v && v.enabled === false);
  // rig.json zones 에 빠진 항목은 기본값으로 (하나만 빠져도 예외로 물러나지 않게). 끈 항목은 null — 회색 자리로 채우지 않는다
  function zoneCfg(R) {
    const Z = off(R.zones) ? { chin: null, back: null, rump: null, tail: null, ripple: null } : R.zones || {}, D = DEF_ZONES;
    const part = (k) => (off(Z[k]) ? null : Object.assign({}, D[k], Z[k]));
    const rump = part('rump');
    if (rump) rump.lift = off(Z.rump && Z.rump.lift) ? null : Object.assign({}, D.rump.lift, rump.lift);
    const tail = part('tail');
    if (tail && off(Z.tail && Z.tail.hold)) tail.hold = null;
    // 알파 판정(zones.hit) — 기본값이 없다(회색 고양이는 메시 칸만). true 면 빈 객체(값은 zonesSetup 의 기본값)
    const hit = Z.hit === true ? {} : Z.hit && !off(Z.hit) ? Z.hit : null;
    return { chin: part('chin'), ear: Object.assign({}, D.ear, Z.ear), back: part('back'), rump, tail, ripple: part('ripple'), hit };
  }
  // 숨 자리 — 빠진 항목은 기본값(옛 굽기), 끈 항목은 null. 크기(px)는 rig.json 값, 없으면 상수 × scale
  function breathCfg(R, k) {
    const Bj = off(R.breathing) ? { lift: null, shoulder: null, ribs: null, chest: null } : R.breathing || {}, D = DEF_BREATHING;
    const part = (n) => (off(Bj[n]) ? null : Object.assign({}, D[n], Bj[n]));
    const lift = part('lift'), ribs = part('ribs'), chest = part('chest');
    const shoulder = off(Bj.shoulder) ? null : Bj.shoulder || D.shoulder;
    const ribs2 = Bj.ribs2 && !off(Bj.ribs2) ? Bj.ribs2 : null;   // 기본값 없음 — 회색 고양이엔 없다
    const amp = Bj.amp || {};
    const rp = ribs ? ribs.push || [FLANK_X * k, FLANK_Y * k] : [0, 0];
    return {
      lift, shoulder, ribs, chest, ribs2,
      liftPx: lift ? (amp.lift != null ? amp.lift : BREATH_LIFT * k) : 0,
      sighPx: lift && shoulder ? (amp.sigh != null ? amp.sigh : BREATH_SIGH * k) : 0,
      ribsPush: rp,
      chestPush: chest ? chest.push || [CHEST_X * k, CHEST_Y * k] : [0, 0],
      ribs2Push: ribs2 ? ribs2.push || [-(ribs ? rp[0] : FLANK_X * k), ribs ? rp[1] : FLANK_Y * k] : [0, 0],
      head: lift ? (lift.head != null ? lift.head : lift.keep[0]) : 0,
      period: Bj.period > 0 ? Bj.period : BREATH_PER
    };
  }
  // 부위 → 반응 갈래 (0 이마, 1 턱·볼, 2 등, 3 엉덩이, 4 그 밖의 몸). 귀·없음은 -1
  const ZKIND = [-1, 0, 1, -1, -1, 2, 3, 4, 4];
  // 쓰다듬을 때 눈 — 거의 감음(지그시). 꺼풀 칸(1/8 걸음)에 딱 맞춰 칸 7번째(t=0.875) 한 장만 쓴다.
  // 0.92 였을 땐 두 칸을 36% 섞은 채 멈춰, 남은 홍채 띠가 털 아래 반쯤 비치고 꺼풀 끝이 두 겹이 됐다
  const LID_CONTENT = 0.875;
  const STROKE_MIN = 30;                   // 한 번 쓸었다고 볼 길이 (텍스처 px, 화면 ~22px)
  const STROKE_BACK = 12;                  // 끝에서 이만큼 되돌아와야 «방향이 바뀌었다» — 손 떨림은 안 친다
  const ZONE_VMAX = 1500;                  // 이보다 빠른 걸음(텍스처 px/s)은 부위 몫에 안 넣는다 — 쓰다듬기가 아니라 가로지르기다

  // ── 부위별 반응 («쓰다듬기까지밖에 못하나?») ──
  // 어디를 쓰다듬느냐에 따라 받는 몸짓이 다르다. 진짜 고양이처럼 — 크기는 전부 사진이 고무처럼 안 보이는 만큼만.
  // 이마: 턱은 당긴 채 머리를 손에 밀어 올린다. 턱·볼: 턱을 들고 손 쪽 볼을 손가락에 비빈다.
  // 엉덩이(꼬리 밑동): 엉덩이를 살짝 들고 꼬리 끝을 조금 들며 눈을 지그시 감는다. 등: 손 밑 자리를 손에 밀어 올린다.
  // 귀: 예민하다 — 그 귀를 세게 털고 잠깐 옆·뒤로 젖힌다. 그르렁은 없고, 자꾸 만지면 짜증(irk)이 쌓인다.
  const HEAD_PITCH = 0.08;                 // 이마 — 턱을 살짝 당긴다(얼굴 시차 0.5px)
  const CHIN_PITCH = -0.42, CHIN_LIFT = 3; // 턱 — 턱을 든다(코 쪽 시차 ≈3px, 머리 통째 ≈4px 오름)
  const CHIN_ROLL = 0.03, CHIN_LEAN = 4, CHIN_YAW = 0.12; // 손 쪽으로 기울고 기대며, 얼굴은 조금 돌려 볼을 내민다
  const BODY_LIFT = 0.8;                   // 몸을 쓰다듬을 땐 머리를 조금만 든다
  const RUMP_PX = 5;                       // 엉덩이 들기 (허벅지 위 윤곽이 오르는 px — 바닥·꼬리는 그대로)
  // 등을 손에 밀어 올리는 혹 — 손 밑에서만 오르고 손을 따라간다(높이 px, 폭 σ px). 숨 장 전체를 올리던 때는 같은 장의 숨(5px)에
  // 묻혀 안 보였다
  const BACK_PX = 2.8, BACK_W = 45;
  // 엉덩이를 긁을 땐 조금 덜 감는다 — 꺼풀 칸 6 에 딱 맞다. 0.5 는 화난 눈(0.375)과 정면에서 거의 같아 «째려본다» 로 읽혔다.
  // 엉덩이 반응은 몸(엉덩이·꼬리)으로 갈라 보인다
  const LID_HALF = 0.75;
  const EAR_BACK = 0.16, EAR_BACK_FLAT = 0.07; // 귀를 만지면 옆·뒤로 젖힘(≈9°, 귀 8% 짧게 — 뒤로 돈 것처럼)
  const EAR_HOLD = 0.5, EAR_FADE = 0.7;    // 젖힌 채 이만큼(초) 있다가 이만큼에 걸쳐 돌아온다
  // 만지면 먼저 파르르(털고 0.1초 뒤 반만큼 한 번 더) 턴 뒤 이만큼(초) 지나 젖힌다 — 털기와 젖힘이 같은 쪽이라 함께 걸면 털기가
  // 젖힘에 묻혀 «돌아가 멈춤» 으로만 보였다
  const EAR_LAG = 0.18;
  const EAR_RUB = 22;                      // 귀 위를 이만큼(텍스처 px) 문지르면 «만졌다»
  const EAR_DWELL = 0.2;                   // 귀 위에 이만큼(초) 머문 뒤부터 센다 — 화면을 가로지르다 귀를 스친 커서는 안 친다
  const IRK_EAR = 0.12, IRK_TAU = 20;      // 귀를 만질 때마다 쌓이는 짜증, 잊는 빠르기(초) — 기분(다음 단계)이 읽는 손잡이
  // 꼬리 (rad) — 굽힘은 밑동을 축으로, 말기는 꼬리 가운데를 축으로 끝만. 양수 = 위(몸 쪽)로.
  // 꼬리 뒤(위)는 몸통 털이고 아래는 투명이라, 위로 들면 위쪽 털이 눌리고 아래로 내리면 늘어난다 — 사진에 꼬리 밑
  // 픽셀이 없어 겹쳐 그릴 수 없다. 그래서 위쪽은 34px 띠에서만 사라지게 하고, 끝에서 4~6px 를 넘지 않는다
  // 엉덩이 긁기: 꼬리 끝 ≈1.8px 들림 — 진짜는 밑동이 들리는데 사진은 끝만 움직일 수 있어 작게
  const TAIL_LIFT = 0.008;
  const TAIL_W = 9, TAIL_Z = 0.55;         // 끝 말기 스프링 — 휙 들었다 조금 넘쳐 내려앉는다(털기 «툭»)
  // 툭 털기(끝 ≈5px). 짜증이 많을 땐 탁 치기 — 들기(THUMP_UP 초, 느긋)와 내리치기(THUMP_DN 초, 빠르게 조금 넘쳐) 두 단계.
  // 털기처럼 순간 속도로 치면 «빨리 들고 천천히 내림» 이라 거꾸로였다 — 짜증 난 꼬리의 «탁» 은 내려치는 쪽이 빠르다
  const TAIL_FLICK = 0.022, TAIL_THUMP = 0.03, THUMP_UP = 0.14, THUMP_DN = 0.15, THUMP_LOW = -0.004;
  const KIND_NAME = ['head', 'chin', 'back', 'rump', 'body'];   // 부위 갈래 이름 (onPet·stats)

  // ── 기분 («기분 표현») ──
  // 진짜 고양이는 오래 만지면 «이제 그만» 을 몸으로 먼저 알린다(과자극): 그르렁이 잦아들고, 감던 눈을 뜨고, 귀를 옆으로
  // 돌리고(비행기 귀), 꼬리 끝을 털다 탁 치고, 등 피부가 파르르 떤다. 그래도 계속 만지면 귀를 젖히고 고개를 홱 돌려
  // 한동안 커서를 모른 척한다. 경고 때 손을 떼면 화내지 않고 가라앉는다. 하트·말풍선 같은 기호는 없다 — 몸짓만, 작게.
  // 상태: 쉼 → (쓰다듬어 그르렁) 만족 → (참을성이 다 차면) 경고 → (그래도 만지면) 화남(홱 돌림) → 외면 → 쉼
  const M_CALM = 0, M_CONTENT = 1, M_WARN = 2, M_MAD = 3, M_COOL = 4;
  const MOOD_NAME = ['calm', 'content', 'warning', 'annoyed', 'cooldown'];
  const MOOD_OUT = ['calm', 'content', 'warning', 'annoyed', 'annoyed'];   // 앱에 알리는 이름 — 외면도 «화남»
  // 참을성(tol)은 «이마를 쓰다듬은 초» 로 센다. 부위마다 차오르는 빠르기가 다르다 — 엉덩이·등은 빨리, 턱은 조금 천천히
  // (고양이가 가장 좋아하는 곳은 얼굴, 오래 못 참는 곳은 엉덩이·등이다)
  const TOL_RATE = [1, 0.9, 1.3, 1.6, 1.15];  // 갈래별: 이마, 턱·볼, 등, 엉덩이, 그 밖의 몸
  const TOL_EAR = 3, TOL_DRAIN = 1.5;          // 귀를 만질 때마다 더하는 몫(초) / 안 만지면 초당 빠지는 몫
  // 문턱(초) — 친밀도 0.1 아래 / 0.9 위(그 사이는 곧게). 세션(mount)마다 범위 안 자리 하나를 뽑고, 그 세션의 친밀도로 정한다(쓰다듬는 동안 오르는
  // 몫으로는 안 바꾼다 — 한 판 안에서 문턱이 멀어지면 «15~25초» 가 30초를 넘었다). setAffinity 로 바꾸면 다시 정한다
  const TOL_LO = [15, 25], TOL_HI = [35, 60];
  const WARN_SEC = [3, 6], WARN_QUIT = 1.2;     // 경고 길이(만지는 동안만 흐른다) / 손을 떼고 이만큼이면 가라앉는다
  const COOL_SEC = [10, 20], TURN_SEC = 1.6;    // 외면하는 동안 / 그중 고개를 홱 돌린 채 버티는 처음
  // 경고 — 귀를 옆으로(비행기 귀), 화남 — 귀를 젖혀 눕힌다. 부드러운 한계(EAR_MAX)를 지나 화면에선 경고 ≈11°·눕힘 0.12,
  // 화남 ≈13°·0.15 (만족은 ≈3.4°·0.05). 귀 늘어남(눌림)은 1.9 안쪽(debug.fold — 눕힘 0.18 은 구멍이 좁아지는 몫까지 2.0 이었다)
  const AIR_ROT = 0.24, AIR_FLAT = 0.12;
  const MAD_ROT = 0.3, MAD_FLAT = 0.15;
  const MAD_YAW = 0.85, MAD_EASE = 0.65, MAD_PITCH = 0.1; // 고개를 커서 반대로(버틴 뒤엔 이 비만큼만) / 턱을 조금 당긴다
  // 홱 돌리기 — 순간 속도(rad/s)와 화난 동안 고개 스프링(빠르기·감쇠). 90% 까지 0.2초 남짓 (진짜 고양이는 0.15~0.3초).
  // 손에서 머리를 빼며 뒤로 살짝 움츠린다(px) — 그냥 «다른 데를 봄» 과 갈라 보이게
  const MAD_KICK = 3, MAD_W = 16, MAD_Z = 0.8, MAD_LEAN = 4, MAD_DUCK = 1;
  const LID_MAD = 0.375;                        // 화나면 눈을 가늘게 — 꺼풀 칸 3 에 딱 맞다
  const COOL_DODGE = 1.5;                       // 외면 중 커서가 고양이가 돌아본 쪽에 이만큼(초) 머물면 반대로 천천히 돌아앉는다
  // 등 피부 떨림 — 손 밑 등 위쪽 띠가 «파르르» (이웃 털이 서로 반대로 움직이는 잔물결이 빠르게 흐른다). 한 방향 혹 하나가 지나가던
  // 때는 2.2px 라도 거의 안 보였다. 짧게 두 번(초·사이 초), 높이 px, 결 길이 px, 초당 도는 번, 폭 σ px
  const RIPPLE_SEC = 0.35, RIPPLE_GAP = 0.12, RIPPLE_N = 2, RIPPLE_PX = 1.6, RIPPLE_L = 48, RIPPLE_HZ = 14, RIPPLE_W = 70;
  // 셰이더에 굳혀 넣는 상수 (GLSL 소수 글자) — 매 draw 다시 올리지 않게
  const glf = (v) => v.toFixed(8);
  // 눈인사 — 커서가 얼굴 앞에 가만히 머물면 천천히 깜박여 답한다(감기·멈춤·뜨기 초) + 고개를 살짝 숙인다
  const GREET_CLOSE = 0.6, GREET_HOLD = 0.3, GREET_OPEN = 0.8;
  const GREET_DIP = 0.12, GREET_LIFT = 1;       // 숙임(pitch)·내림(px)
  const GREET_STILL = 9;                        // 이만큼(텍스처 px) 안에서만 움직이면 «가만히» — 손 떨림은 봐준다
  const GREET_COOL = [8, 15];

  // ── 친밀도 («친해지기») ──
  // 0~1. 앱이 갖고 저장한다 — mount 의 opts.affinity 로 받고 onAffinity 로 알린다. 하루 지남도 앱이 센다.
  // 규칙은 affinityAfter 하나라 앱과 미리보기가 똑같이 셈한다:
  //   · 쓰다듬기 한 번마다 남은 몫(1 - a)의 조금. 그날 처음 몇 번이 가장 크고 갈수록 준다(n 번째 몫 ∝ e^(-n/50) —
  //     하루 내내 쓰다듬어도 남은 몫의 14% 남짓이라 0.1 에서 0.9 까지 두세 주 걸린다)
  //   · 화나게 하면 0.025 깎인다
  //   · 오래 안 오면 이틀째부터 하루 3% 씩 식는다
  const AFF_DEF = 0.3, AFF_G = 0.003, AFF_N = 50, AFF_MAD = 0.025, AFF_FADE = 0.97;
  // 숫자이거나 공백이 아닌 숫자 글자만 받는다 — 앱이 저장값을 못 읽어 '' 나 [] 를 넘기면 Number() 가 0 을 줘 친밀도가 0 에서 시작했다
  const unit = (v, d) => {
    const x = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
    return Number.isNaN(x) ? d : x < 0 ? 0 : x > 1 ? 1 : x;
  };
  // 오늘 n0 번째부터 n 번 쓰다듬었을 때 — 몫의 합(등비 합)만큼 남은 몫을 지수로 줄인다. 그래서 한 번씩 나눠 셈해도 한꺼번에
  // 셈해도 값이 같다. 리그는 쓸기마다 셈해 onAffinity 로 알린다 — 앱은 그 값을 저장하면 된다(경고 중 쓸기는 정이 안 들어
  // onPet 의 strokes 와 친밀도에 든 횟수(credited)가 다를 수 있다. 다시 셈하려면 credited 를 쓴다).
  // 프레임마다 부르지 않는다 — 쓸기 한 번에 한 번
  function affGain(a, n, n0) {
    if (!(n > 0)) return a;
    const g = AFF_G * (Math.exp(-n0 / AFF_N) - Math.exp(-(n0 + n) / AFF_N)) / (1 - Math.exp(-1 / AFF_N));
    return 1 - (1 - a) * Math.exp(-g);
  }
  /** 친밀도 다음 값 — prev 0~1, o: { strokes 이번에 쓰다듬은 횟수(onPet 의 credited), todayBefore 오늘 앞서 쓰다듬은 횟수,
   *  annoyed 화나게 한 횟수, daysAway 마지막으로 본 날부터 지난 날 수(1 = 어제) }.
   *  앱은 보통 onAffinity 값을 저장하고, 이것은 창을 열 때 daysAway(하루 지남)에만 쓴다 */
  function affinityAfter(prev, o) {
    o = o || {};
    let a = unit(prev, AFF_DEF);
    const days = Math.max(0, Number(o.daysAway) || 0);
    if (days > 1) a *= Math.pow(AFF_FADE, days - 1);
    a = affGain(a, Math.max(0, Math.floor(Number(o.strokes) || 0)), Math.max(0, Number(o.todayBefore) || 0));
    a -= AFF_MAD * Math.max(0, Number(o.annoyed) || 0);
    return a < 0 ? 0 : a > 1 ? 1 : a;
  }

  // 빠르기 단계별 목표 간격 (ms) — 0: 숨쉬기만, 1: 따라보기·쓰다듬기, 2: 빠른 움직임(화면 갱신마다)
  // 숨쉬기만일 땐 앞을 내다보고 BREATH_MS~IDLE_MS 사이에서 고른다 — 한 장에 윤곽이 STEP_DEV(기기 px) 넘게 안 가게
  const IDLE_MS = 100, BREATH_MS = 50, DRIFT_MS = 50, FOLLOW_MS = 33;
  // 숨 한 장 걸음 목표 — 등선이 숨 한 번에 화면에서 7~10px 오르내리니 0.45px 걸음이면 숨만으로 초당 6~8장이다.
  // 걸음을 줄이면 장 수가 그만큼 는다
  const STEP_DEV = 0.45;
  const VSYNC_PAD = 8;                     // 타이머 뒤 다음 화면 갱신까지 평균 반 장 늦게 온다 — 그만큼 더 앞을 본다
  const ACTIVE_AFTER_MOVE = 2;             // 커서가 멈추고 이만큼(초)은 따라보기 빠르기로
  // 커서가 멈추고 이만큼(초)은 커서 쪽을 본다, 그 뒤엔 혼자 두리번 / 고개를 커서로 돌리는 빠르기 — 친밀도 0 / 1
  // (기본 친밀도 0.3 에서 예전 값 6초·5 와 같다. 0.1 → 4.9초·4.5, 0.9 → 9.4초·6.3)
  const FOLLOW_SEC = [4.3, 10], FOLLOW_W = [4.2, 6.6];
  const EPS_DEV = 0.35;                    // 화면(기기 px)에서 이보다 덜 움직였으면 안 그린다
  // 숨만 쉴 땐 문턱을 이만큼 낮춘다 — 간격을 이미 숨 빠르기로 골랐으니 고른 대로 그린다. 문턱이 STEP_DEV 와 붙어
  // 있으면 0.34px 처럼 바로 아래로 떨어진 tick 을 건너뛰고 다음 장에 두 걸음을 한꺼번에 그렸다. 더 낮추면 꼭대기·바닥
  // 근처 느린 곳에서 잔걸음을 그려 장 수만 는다(한 장이 렌더러+GPU 를 꽤 먹는다 — 초당 1장에 0.5~0.7점)
  const EPS_BREATH = 0.8;

  // ── 셰이더 ─────────────────────────────────────────────
  // 정점: 텍스처 px 자리(aP)를 받아 부위별 변형을 더한다. 각 변형은 매끄러운 가중치 장(場)이라
  // 그물이 찢어지지 않고, 크기를 묶어 두어 뒤집히지도 않는다(시험: debug.fold).
  // k = rig.json scale — 셰이더에 굳혀 넣는 px 상수(귀 옆 여유, 등 혹·피부 떨림 폭·결)를 고양이 크기에 맞춘다(1 이면 예전 글자 그대로)
  // 꺼둔 장(머리 가중치 왼쪽·타원, 엉덩이 들림 오른쪽 끝)은 smoothstep 이 딱 1·0 이 되는 먼 자리(±1e5)로 둔다 — 곱해도 값이 그대로다
  const vsSrc = (k) => [
    'attribute vec2 aP;',
    'uniform vec4 uView;',  // 세계 px → clip
    'uniform vec4 uHead;',  // 갸웃(rad), 옮김 x, y
    'uniform vec4 uPar;',   // 시차 x, y (px), 숨(보통 들숨 끝 = 1, 한숨은 2 가까이), 한숨 어깨(0~1)
    'uniform vec4 uEar;',   // 왼귀·오른귀 회전(rad), 왼귀·오른귀 눕힘
    'uniform vec4 uHW;',    // 머리 가중치: x 끝까지 1, x 여기서 0, y 끝까지 1, y 여기서 0
    'uniform vec4 uHL;',    // 머리 가중치 왼쪽: x 여기서 0, 여기부터 1 / 타원 정규 반지름² 여기까지 1, 여기서 0 (head.weight)
    'uniform vec4 uHE;',    // 머리 가중치 타원 중심, 1/rx, 1/ry (없으면 0 — 늘 1)
    'uniform vec4 uPiv;',   // 갸웃 중심 x, y
    'uniform vec4 uFace;',  // 얼굴 타원 중심, 1/rx, 1/ry
    'uniform vec4 uNose;',  // 코 중심, 1/(2σ²), 세기
    'uniform vec4 uEL;', 'uniform vec4 uELs;', 'uniform vec4 uER;', 'uniform vec4 uERs;', // 귀 밑동, 축 방향 / 길이, 반폭
    'uniform vec4 uBl;',    // 숨 들림: 이 y 위는 다, 이 y 아래는 0 (바닥·발·꼬리), 등선 px, 한숨 어깨 px
    'uniform vec4 uBx;',    // 들림 가로: x0 에서 커지기 시작, x1~x2 다, x3 에서 엉덩이 몫까지
    'uniform vec4 uBw;',    // 앞(머리·어깨·가슴)에 남는 몫, 엉덩이 몫, (비움 2)
    'uniform vec4 uBs;',    // 한숨 어깨 x 띠: 여기서 오르기 시작, 여기부터 다, 여기부터 줄어, 여기서 0 (왼쪽 끝이 없으면 먼 자리)
    'uniform vec4 uBf;',    // 옆구리 타원 중심, 1/rx, 1/ry
    'uniform vec4 uBc;',    // 흰 가슴 타원 중심, 1/rx, 1/ry
    'uniform vec4 uBd;',    // 옆구리 옮김 x, y, 가슴 옮김 x, y (px, 숨 1 에서)
    'uniform vec4 uBg;',    // 둘째 옆구리 타원 중심, 1/rx, 1/ry (정면 고양이의 반대쪽 — 없으면 옮김 0)
    'uniform vec4 uBe;',    // 머리 장 안에 남는 숨 몫, 둘째 옆구리 옮김 x, y (px, 숨 1 에서), (비움)
    // 부위·기분 uniform — 매 draw 바뀌는 건 uZone·uMood 둘, 나머지는 setStatic 에서 한 번
    'uniform vec4 uZone;',  // 부위 반응: 엉덩이 들림 px, 손 밑 등 혹 높이 px, 꼬리 굽힘(rad, 밑동 축), 꼬리 끝 말기(rad, 가운데 축)
    'uniform vec4 uTl;',    // 꼬리 밑동 x, y, 끝 쪽 방향 x, y
    'uniform vec4 uTs;',    // 꼬리 길이, 위 반폭, 위로 사라지는 폭, 끝 말기 축(길이 비)
    'uniform vec4 uTh;',    // 앞발 붙듦 x: 여기서 0, 여기부터 다 / 엉덩이 들림 y: 여기까지 다, 여기서 0
    'uniform vec4 uRl;',    // 엉덩이 들림 x: 여기서 시작, 여기부터 다 / 등 물결·혹이 이 y 아래로 / 이만큼(px)에 걸쳐 사라짐
    'uniform vec4 uRm;',    // 엉덩이 들림 x: 여기부터 줄어, 여기서 0 (오른쪽 끝 — 없으면 먼 자리) / 꼬리 위쪽 부호(±1) / 꼬리 아래 반폭(없으면 먼 자리)
    'uniform vec4 uKx;', 'uniform vec4 uKy;', // 손 밑 등 혹 장 (zones.back.weight): x 띠 / y 여기서 0, 여기부터 다, 켬(0 이면 숨 들림 장)
    'uniform vec4 uQx;', 'uniform vec4 uQy;', // 등 피부 떨림 장 (zones.ripple.weight) — 같은 꼴
    'uniform vec4 uMood;',  // 등 피부 떨림: 가운데 x, 높이(px), 위상(rad) / 손 밑 등 혹 가운데 x
    'varying vec2 vP;',
    'vec2 rot(vec2 v, float a) { float c = cos(a); float s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }',
    // x 띠: e.x 에서 오르기 시작해 e.y 부터 다, e.z 부터 줄어 e.w 에서 0
    'float band(vec4 e, float x) { return smoothstep(e.x, e.y, x) * (1.0 - smoothstep(e.z, e.w, x)); }',
    // 꼬리: 축을 따라 갈수록 많이 돈다(휘어진 꼬리). 꼬리 위(몸 쪽)는 uTs.z 띠에서 사라지고, 아래(투명)는 꼬리와 함께
    // 통째로 움직여 아래 윤곽이 늘지 않는다. 끝은 오른 앞발에 닿아 있어 발 쪽으로는 붙든다.
    // 몸 쪽이 축의 어느 법선인지는 uRm.z — +x 로 뻗은 꼬리는 −1 (각도 부호는 JS 가 uZone 에 곱해 둔다).
    // 아래도 uRm.w(rig.json tail.below)를 주면 거기서 uTs.z 띠에 걸쳐 사라진다 — 꼬리 축 아래에 앞발이 있는 고양이가 털기마다 발을 끌지 않게
    'vec2 tailD(vec2 p) {',
    '  vec2 d = p - uTl.xy;',
    '  float al = dot(d, uTl.zw);',
    '  float up = uRm.z * (uTl.z * d.y - uTl.w * d.x);',
    '  float w = (1.0 - smoothstep(uTs.y, uTs.y + uTs.z, up)) * (1.0 - smoothstep(uRm.w, uRm.w + uTs.z, -up)) * smoothstep(uTh.x, uTh.y, p.x);',
    '  vec2 o = rot(d, uZone.z * w * smoothstep(0.0, uTs.x, al)) - d;',
    '  float c0 = uTs.x * uTs.w;',
    '  vec2 dc = d - uTl.zw * c0;',
    '  return o + rot(dc, uZone.w * w * smoothstep(c0, uTs.x, al)) - dc;',
    '}',
    // 귀: 밑동을 축으로 돌린다. 밑동 아래(머리)는 0, 귀 중간부터 1 — 이마 털은 따라 돌지 않게 옆 폭도 본다
    'vec2 earD(vec2 p, vec4 e, vec4 s, float ang, float fl) {',
    '  vec2 d = p - e.xy;',
    '  float al = dot(d, e.zw);',
    '  float t = al / s.x;',
    '  float side = abs(d.x * e.w - d.y * e.z);',
    '  float hw = s.y * (1.0 - 0.5 * clamp(t, 0.0, 1.0));',
    '  float w = smoothstep(-0.2, 0.6, t) * (1.0 - smoothstep(hw * 1.15, hw * 1.9 + ' + glf(16 * k) + ', side));',
    '  vec2 q = d - e.zw * (al * fl * w);',
    // 눕힐수록 귀 구멍이 좁아진다(옆으로도 눌림) — 짧아지기만 하면 뒤로 돈 귀가 아니라 작아진 귀로 보였다
    '  vec2 nn = vec2(-e.w, e.z);',
    '  q -= nn * (dot(d, nn) * fl * 1.5 * w);',
    '  return rot(q, ang * w) - d;',
    '}',
    'void main() {',
    '  vec2 p = aP;',
    '  vec2 q = p + earD(p, uEL, uELs, uEar.x, uEar.z) + earD(p, uER, uERs, uEar.y, uEar.w);',
    // 고개 돌리기 시차: 얼굴 가운데(볼록한 곳)일수록, 코끝은 더 많이 움직이고 윤곽은 거의 그대로
    '  vec2 f = (p - uFace.xy) * uFace.zw;',
    '  float r2 = min(dot(f, f), 1.0);',
    '  float z = (1.0 - r2) * (1.0 - r2);',
    '  vec2 dn = p - uNose.xy;',
    '  z += uNose.w * exp(-dot(dn, dn) * uNose.z);',
    '  q += uPar.xy * z;',
    // 머리 통째: 목 쪽으로 갈수록 가중치가 0 이 된다 — 몸은 그대로. 몸이 머리 왼쪽에도 있는 고양이는 왼쪽 띠(uHL.xy)·
    // 타원(uHE)으로 머리 장을 따로 준다 (타원은 반지름² 으로 재 — sqrt 없이)
    '  float wh = smoothstep(uHL.x, uHL.y, p.x) * (1.0 - smoothstep(uHW.x, uHW.y, p.x)) * (1.0 - smoothstep(uHW.z, uHW.w, p.y));',
    '  vec2 he = (p - uHE.xy) * uHE.zw;',
    '  wh *= 1.0 - smoothstep(uHL.z, uHL.w, dot(he, he));',
    '  q = uPiv.xy + rot(q - uPiv.xy, uHead.x * wh) + uHead.yz * wh;',
    // 숨: 갈비뼈 위 등선이 오르고(아래 띠는 늘고, 바닥·발·꼬리는 그대로), 옆구리는 바깥으로, 흰 가슴은 앞으로.
    // 머리 안(wh = 1)은 한 덩어리로 같은 만큼만 따라 오른다 — 귀·얼굴이 숨 따라 기울거나 늘지 않게.
    // 가중치는 전부 넓고 매끄러운 장(場)이라 털 무늬가 미끄러지거나 늘어나 보이지 않는다(전단까지 넣은 주 변형률 들숨 끝
    // 3.4%, 한숨 5.9% — 가장 큰 곳은 어깨·앞다리 위 민무늬 털이다. 옆구리 옆밀림은 작게 둬 줄무늬가 거의 안 미끄러진다)
    '  float hy = 1.0 - smoothstep(uBl.x, uBl.y, p.y);',
    '  float wx = mix(uBw.x, 1.0, smoothstep(uBx.x, uBx.y, p.x)) - (1.0 - uBw.y) * smoothstep(uBx.z, uBx.w, p.x);',
    '  float ws = band(uBs, p.x);',
    '  wx = mix(wx, uBe.x, wh); ws = mix(ws, 1.0, wh);',
    '  vec2 fb = (p - uBf.xy) * uBf.zw; float wf = max(1.0 - dot(fb, fb), 0.0);',
    '  vec2 cb = (p - uBc.xy) * uBc.zw; float wc = max(1.0 - dot(cb, cb), 0.0);',
    '  vec2 gb = (p - uBg.xy) * uBg.zw; float wg = max(1.0 - dot(gb, gb), 0.0);',
    '  q += uPar.z * (uBd.xy * (wf * wf) + uBd.zw * (wc * wc) + uBe.yz * (wg * wg));',
    '  q.y -= hy * (wx * uBl.z * uPar.z + uBl.w * ws * uPar.w);',
    // 등 위쪽 띠 — 손 밑 혹: 등을 쓰다듬으면 손이 지나가는 자리만 손에 밀어 올린다.
    // 피부 떨림: 손 밑에서 이웃 털이 서로 반대로 움직이는 잔물결이 빠르게 흐른다(경고 때 짧게 두 번). 높이가 0 이면 아무 일도 없다.
    // 장은 보통 등선 들림 장(hy·wx) 그대로 — 숨 몫을 바꾸면 둘 다 약해지던 고양이는 제 장(uKx·uQx)을 켠다(uKy.z·uQy.z)
    '  float wb = hy * wx;',
    '  float bf = 1.0 - smoothstep(uRl.z, uRl.z + uRl.w, p.y);',
    '  float bk = mix(wb, band(uKx, p.x) * smoothstep(uKy.x, uKy.y, p.y), uKy.z) * bf;',
    '  float br = mix(wb, band(uQx, p.x) * smoothstep(uQy.x, uQy.y, p.y), uQy.z) * bf;',
    '  float dr = p.x - uMood.x;',
    '  float db = p.x - uMood.w;',
    '  q.y -= br * (uMood.y * exp(-dr * dr * ' + glf(1 / (2 * (RIPPLE_W * k) * (RIPPLE_W * k))) + ') * sin(dr * ' + glf(2 * Math.PI / (RIPPLE_L * k)) + ' + uMood.z))',
    '        + bk * (uZone.y * exp(-db * db * ' + glf(1 / (2 * (BACK_W * k) * (BACK_W * k))) + '));',
    // 엉덩이 들기: 허벅지 위는 통째로 오르고(윤곽이 늘지 않게), 아래 띠에서 0 이 된다 — 꼬리·바닥은 그대로.
    // 오른쪽 끝(uRm.xy)을 주면 거기서 다시 0 — 엉덩이 오른쪽에 꼬리가 붙은 고양이는 꼬리가 같이 안 들린다
    '  q.y -= uZone.x * smoothstep(uRl.x, uRl.y, p.x) * (1.0 - smoothstep(uRm.x, uRm.y, p.x)) * (1.0 - smoothstep(uTh.z, uTh.w, p.y));',
    '  q += tailD(p);',
    '  vP = p;',
    '  gl_Position = vec4(q * uView.xy + uView.zw, 0.0, 1.0);',
    '}'
  ].join('\n');
  const FAR = 1e5;   // 꺼둔 장의 먼 자리 (텍스처 px — float 로도 정확하고, 그 너머 smoothstep 은 딱 0·1)

  // 조각: 눈동자는 여기서 민다 — 홍채가 메시 칸 두세 개 크기라 정점으로 밀면 각이 진다.
  // 눈꺼풀은 «층»이다: 아틀라스의 이웃한 두 장(곱한 알파 = 꺼풀이 덮은 정도)을 섞어, 시선과 상관없는 제자리(vP)에서
  // 읽어 민 눈 위에 얹는다(premultiplied over). 바뀌지 않은 곳은 알파 0 이라 base 가 그대로 보인다.
  const FS_HEAD = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',   // 텍스처 px(최대 ~900)를 다룬다 — mediump 면 1px 가까이 뭉개진다
    '#else',
    'precision mediump float;',
    '#endif',
    'varying vec2 vP;',
    'uniform sampler2D uBase;'
  ].join('\n');
  const FS = FS_HEAD + '\n' + [
    'uniform sampler2D uEyes;',
    'uniform vec4 uInv;',     // 1/텍스처 크기, 마스크 깃털(정규화) 왼, 오른
    'uniform vec4 uIrL;', 'uniform vec4 uIrR;', // 홍채 타원 중심, 1/rx, 1/ry
    'uniform vec4 uMkL;', 'uniform vec4 uMkR;', // 꺼풀 마스크 타원
    'uniform vec4 uRot;',     // 눈 기울기 cos·sin (왼, 오른)
    'uniform vec4 uGaze;',    // 눈동자 옮김 x, y (px), 두 눈 사이 x
    'uniform vec4 uLid;',     // 섞기 f, A 칸 대신 빈 층, 꺼풀 켬, 반사 거둠(0~1 — rig.json lids.dimCatch)
    'uniform vec4 uTile;',    // A 칸 x, y, B 칸 x, y (아틀라스 px)
    'uniform vec4 uAtl;',     // 아틀라스 칸 원점(텍스처 px) x, y, 1/아틀라스 폭, 1/높이
    'uniform vec4 uHbL;', 'uniform vec4 uHbR;', // 반사 상자 x, y, w, h (텍스처 px)
    'uniform vec4 uHoL;', 'uniform vec4 uHoR;', // 반사 지운 동공, 반사 밝은 몫 — 아틀라스 자리 - 상자 원점
    'float er(vec2 p, vec4 e, float c, float s) {',
    '  vec2 d = p - e.xy;',
    '  return length(vec2(c * d.x + s * d.y, -s * d.x + c * d.y) * e.zw);',
    '}',
    // 밉맵 단계를 반 단 당겨 읽는다 — 휴식 창 크기(0.7배 안팎)에선 1단과 섞여 정지 그림보다 흐려졌다.
    // 1.8배 넘게 줄일 때(구석 1080p)만 1단이 섞여 수염이 끊기지 않는다. 밉맵이 없으면(WebGL1) 아무 일도 안 한다
    'const float MB = -0.5;',
    'bool inBox(vec2 q, vec4 b) { return q.x >= b.x && q.y >= b.y && q.x <= b.x + b.z && q.y <= b.y + b.w; }',
    'void main() {',
    '  float ri = min(er(vP, uIrL, uRot.x, uRot.y), er(vP, uIrR, uRot.z, uRot.w));',
    '  vec2 p = vP - uGaze.xy * (1.0 - smoothstep(0.35, 1.0, ri));',
    '  vec4 c = texture2D(uBase, p * uInv.xy, MB);',
    '  if (ri < 1.0) {',
    // 각막 반사는 제자리: 민 눈동자는 반사를 지운 동공에서 읽고, 반사의 밝은 몫은 원래 자리에 더한다.
    // 시선이 0 이면 (지운 동공 + 밝은 몫) = 원본이다. 반사 상자 안에서만 읽는다. 감는 동안 밝은 몫을 거두는 고양이도 있다(uLid.w) —
    // 감은 칸 틈으로 반사 점이 비쳤다
    '    bool lf = vP.x < uGaze.z;',
    '    vec4 hb = lf ? uHbL : uHbR;',
    '    vec4 ho = lf ? uHoL : uHoR;',
    '    if (inBox(p, hb)) c = texture2D(uEyes, (p + ho.xy) * uAtl.zw, MB);',
    '    if (inBox(vP, hb)) c.rgb += texture2D(uEyes, (vP + ho.zw) * uAtl.zw, MB).rgb * (1.0 - uLid.w);',
    '  }',
    '  if (uLid.z > 0.5) {',
    '    float wl = 1.0 - smoothstep(1.0, 1.0 + uInv.z, er(vP, uMkL, uRot.x, uRot.y));',
    '    float wr = 1.0 - smoothstep(1.0, 1.0 + uInv.w, er(vP, uMkR, uRot.z, uRot.w));',
    '    float wm = max(wl, wr);',
    '    if (wm > 0.0) {',
    '      vec2 a = vP - uAtl.xy;',
    '      vec4 la = texture2D(uEyes, (a + uTile.xy) * uAtl.zw, MB) * (1.0 - uLid.y);',
    '      vec4 lb = texture2D(uEyes, (a + uTile.zw) * uAtl.zw, MB);',
    '      vec4 l = mix(la, lb, uLid.x) * wm;',
    '      c = l + c * (1.0 - l.a);',
    '    }',
    '  }',
    '  gl_FragColor = c;',
    '}'
  ].join('\n');

  // 시험용(debug.fold) — 화면 1px 에 텍스처가 얼마나 늘었나(넓이 비). 0 아래면 그물이 뒤집힌 것
  const FS_FOLD_BODY = [
    'uniform vec4 uInv;',
    'uniform vec4 uRest;',  // x: 쉬는 자세의 넓이 비, y: 1 이면 눈으로 보는 색
    'void main() {',
    '  vec4 t = texture2D(uBase, vP * uInv.xy);',
    '  if (t.a < 0.5) discard;',
    '  vec2 a = dFdx(vP); vec2 b = dFdy(vP);',
    '  float r = (a.x * b.y - a.y * b.x) / uRest.x;',
    '  if (uRest.y > 0.5) {',   // 눌린 곳 빨강, 늘어난 곳 파랑, 뒤집힌 곳 초록 — 사진 위에 옅게
    '    float g = dot(t.rgb, vec3(0.3, 0.5, 0.2)) * 0.6;',
    '    gl_FragColor = vec4(g + clamp((r - 1.0) * 2.0, 0.0, 1.0), g + (r < 0.0 ? 1.0 : 0.0), g + clamp((1.0 - r) * 3.0, 0.0, 1.0), 1.0);',
    '  } else {',
    '    gl_FragColor = vec4(clamp(r * 0.25, 0.0, 1.0), r < 0.0 ? 1.0 : 0.0, 0.0, 1.0);',
    '  }',
    '}'
  ].join('\n');
  const FS_FOLD = '#extension GL_OES_standard_derivatives : enable\n' + FS_HEAD + '\n' + FS_FOLD_BODY;
  // WebGL2 에는 OES_standard_derivatives 확장이 없다 — 시험용 접기 셰이더만 GLSL 300 es 로 바꿔 쓴다
  function es3(src, frag) {
    let s = '#version 300 es\n' + src.replace(/#extension[^\n]*\n/, '');
    if (frag) s = s.replace(/\bvarying\b/g, 'in').replace(/texture2D\(/g, 'texture(').replace(/gl_FragColor/g, 'oC').replace('void main()', 'out vec4 oC;\nvoid main()');
    else s = s.replace(/\battribute\b/g, 'in').replace(/\bvarying\b/g, 'out');
    return s;
  }

  // ── 불러오기 ───────────────────────────────────────────
  function loadImage(url) {
    return new Promise((res, rej) => {
      const im = new Image();
      im.decoding = 'async';
      im.onload = () => res(im);
      im.onerror = () => rej(new Error('그림을 못 열었다: ' + String(url).slice(0, 80)));
      im.src = url;
    });
  }
  // 그림을 미리 풀어 둔다 — texImage2D 가 첫 그림 때 디코딩하느라 멈칫하지 않게
  const decoded = (u) => loadImage(u).then((i) => (i.decode ? i.decode().then(() => i, () => i) : i));
  function xhrJson(url) {
    return new Promise((res, rej) => {
      const x = new XMLHttpRequest();
      x.open('GET', url);
      x.responseType = 'json';
      x.onload = () => (x.response ? res(x.response) : rej(new Error('rig.json 이 비었다')));
      x.onerror = () => rej(new Error('rig.json 을 못 읽었다'));
      x.send();
    });
  }
  function loadJson(url) {
    // file:// 에서는 fetch 가 막힌다 — 바로 XHR 로 (fetch 부터 하면 콘솔에 오류 한 줄 + 왕복 한 번 더)
    if (/^file:/.test(String(url)) || (location.protocol === 'file:' && !/^[a-z]+:/i.test(String(url)))) return xhrJson(url);
    return fetch(url).then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); }).catch(() => xhrJson(url));
  }

  /** 그려질 세계(텍스처 + 여백) — 텍스처 px. 자리 잡는 쪽(clip.js layout)이 비율을 알도록 내보낸다 — 고양이(rig.json)마다 다르다.
   *  거울(display.mirror)이어도 크기는 같다(상자째 뒤집는다 — 왼쪽 여백이 화면에선 오른쪽에 온다) */
  function worldOf(rig) {
    const x0 = -PAD_L, y0 = -PAD_T;
    const fp = rig.body.floorPad != null ? rig.body.floorPad : FLOOR_PAD;
    const x1 = rig.size.w, y1 = Math.min(rig.size.h, Math.ceil(rig.body.floorY + fp));
    return { x0, y0, w: x1 - x0, h: y1 - y0 };
  }

  // ── 그르렁 (WebAudio, 소리 파일 없음) ───────────────────
  // 갈색 잡음을 낮게 거르고, 초당 26번 크기를 오르내리게 해 «르르르» 떨림을 만든다(진짜 그르렁은 25Hz 안팎).
  // 크기·빠르기는 고양이 숨을 따른다 — 들숨에 조금 크고 높게, 날숨에 조금 작게, 사이(쉼)에 살짝 잦아든다.
  // 전에는 숨과 상관없는 0.38Hz 출렁임이라 몸이 내쉴 때 소리가 커지기도 했다
  const PURR_VOL = 0.4;   // RMS ≈ -30 dBFS — 귀 기울이면 들리는 정도 (debug.purrLevel 로 잰다)
  const PURR_BR = [0.62, 0.86, 0.72];      // 숨 단계별 크기: 쉼, 들숨, 날숨 (평균은 예전 출렁임과 같은 0.75 안팎)
  const PURR_HZ = [25.6, 26.6, 25.8];      // 숨 단계별 떨림 빠르기
  function purrGraph(ctx, dest) {
    const sr = ctx.sampleRate, n = Math.round(sr * 1.5), F = Math.round(sr * 0.05);
    const buf = ctx.createBuffer(1, n, sr), d = buf.getChannelData(0);
    let y = 0;
    for (let i = 0; i < n; i++) { y = y * 0.985 + (Math.random() * 2 - 1); d[i] = y * 0.06; }
    // 되풀이 이음매에서 «틱» 소리가 나지 않게 끝을 처음으로 이어 섞는다
    for (let i = 0; i < F; i++) { const k = i / F; d[n - F + i] = d[n - F + i] * (1 - k) + d[i] * k; }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 30; hp.Q.value = 0.7;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 260; lp.Q.value = 0.8;
    // 떨림 — 사인보다 짧은 «툭툭» 이 그르렁에 가깝다: 배음을 겹친 펄스
    const am = ctx.createGain(); am.gain.value = 0.3;
    const osc = ctx.createOscillator();
    const re = new Float32Array([0, 1, 0.8, 0.55, 0.3, 0.15]);
    osc.setPeriodicWave(ctx.createPeriodicWave(re, new Float32Array(re.length)));
    osc.frequency.value = PURR_HZ[2];
    const depth = ctx.createGain(); depth.gain.value = 0.7;
    osc.connect(depth).connect(am.gain);
    const breathG = ctx.createGain(); breathG.gain.value = PURR_BR[2];
    const master = ctx.createGain(); master.gain.value = 0;
    src.connect(hp).connect(lp).connect(am).connect(breathG).connect(master).connect(dest);
    src.start(); osc.start();
    return { master, breathG, osc, srcs: [src, osc] };
  }

  /**
   * 그르렁 — ext 를 주면 남의 AudioContext 를 빌려 쓴다(닫지 않는다). 빌린 컨텍스트에선 그르렁댈 때만 graph 를
   * 붙이고 그치면 뗀다 — 소리 없이 도는 노드도 돌고 있는 컨텍스트에선 CPU 를 먹는다.
   */
  function makePurr(win, ext, volume) {
    const own = !ext;
    // closed — close() 뒤에는 다시 열지 않는다 (닫힌 뒤 늦게 온 warm·start 가 소리 장치를 새로 열면 닫을 사람이 없다)
    let ctx = ext || null, g = null, on = false, offTimer = 0, kickT = 0, woke = false, closed = false;
    let vol = volume == null ? 1 : volume;
    const hold = (t) => {
      const p = g.master.gain;
      if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(t);
      else { const v = p.value; p.cancelScheduledValues(t); p.setValueAtTime(v, t); }
    };
    const make = () => {
      if (closed) return false;
      if (!ctx) {
        const AC = win.AudioContext || win.webkitAudioContext;
        if (!AC) return false;
        try { ctx = new AC({ latencyHint: 'playback' }); } catch { ctx = null; return false; }
      }
      if (!g) g = purrGraph(ctx, ctx.destination);
      return true;
    };
    const unhook = () => {
      // 빌린 컨텍스트에서 그르렁 graph 를 떼어 낸다
      if (!g) return;
      for (const s of g.srcs) { try { s.stop(); } catch { /* 이미 멈춤 */ } }
      try { g.master.disconnect(); } catch { /* 이미 뗌 */ }
      g = null;
    };
    const quiet = () => {
      // 소리가 다 잦아든 뒤: 내 컨텍스트는 재우고, 빌린 컨텍스트는 graph 만 뗀다(내가 깨웠으면 다시 재운다)
      if (on || !ctx) return;
      if (own) { ctx.suspend().catch(() => {}); return; }
      unhook();
      if (woke) { woke = false; ctx.suspend().catch(() => {}); }
    };
    return {
      get on() { return on; },
      get state() { return ctx ? ctx.state : 'none'; },
      get shared() { return !own; },
      setVolume(v) {
        vol = v == null ? 1 : Math.max(0, Math.min(1, v));
        if (on && g) { const t = ctx.currentTime; hold(t); g.master.gain.setTargetAtTime(PURR_VOL * vol, t, 0.2); }
      },
      /**
       * 미리 만들어 두고 바로 재운다. 처음 만드는 AudioContext 는 소리 장치를 여느라 메인 스레드를 0.4~0.9초
       * 붙잡았다 — 쓰다듬기 시작하는 순간에 만들면 고양이가 그만큼 멈춘다. 재운 AudioContext 는 CPU 를 쓰지 않는다.
       * 빌린 컨텍스트는 이미 열려 있으니 할 일이 없다.
       */
      warm() {
        if (!own) return;
        if (!make()) return;
        if (!on && ctx.state === 'running') ctx.suspend().catch(() => {});
      },
      start(level) {
        if (on) return;
        if (!make()) return;
        clearTimeout(offTimer);
        on = true;
        if (ctx.state !== 'running') {
          if (!own) woke = true;
          ctx.resume().catch(() => { /* 사용자 손짓 전이면 막힌다 — 다음 손짓에 다시 */ });
        }
        const t = ctx.currentTime;
        hold(t);
        g.master.gain.setTargetAtTime(PURR_VOL * vol * (level || 1), t, 0.35);
      },
      /**
       * 숨을 따라 — k: 0 쉼, 1 들숨, 2 날숨. 숨 단계가 바뀔 때만 부른다(숨 한 번에 세 번 — 프레임마다가 아니다).
       * 앞 목표를 지우고 지금 값에서 천천히 옮겨 가 «툭» 하고 바뀌지 않는다
       */
      breathe(k) {
        if (!on || !g) return;
        const t = ctx.currentTime, a = g.breathG.gain, f = g.osc.frequency;
        a.cancelScheduledValues(t); a.setTargetAtTime(PURR_BR[k], t, 0.12);
        f.cancelScheduledValues(t); f.setTargetAtTime(PURR_HZ[k], t, 0.25);
      },
      /** 그르렁대는 중인데 브라우저가 소리를 막아 두었으면(사용자 손짓 전) 1초에 한 번 다시 깨워 본다 */
      kick(now) {
        if (!on || !ctx || ctx.state === 'running' || now - kickT < 1) return;
        kickT = now;
        ctx.resume().catch(() => {});
      },
      /** tau: 잦아드는 빠르기(초) — 기분이 상해 그칠 땐 천천히 (뚝 끊기면 소리를 끈 것처럼 들린다) */
      stop(tau) {
        if (!on) return;
        on = false;
        const k = tau || 0.25, t = ctx.currentTime;
        hold(t);
        g.master.gain.setTargetAtTime(0, t, k);
        clearTimeout(offTimer);
        offTimer = setTimeout(quiet, Math.max(1500, k * 6000));
      },
      close() {
        closed = true;
        clearTimeout(offTimer);
        const c = ctx, wasOn = on && g;
        on = false;
        if (!c) return;
        if (wasOn) {
          // 낮은 소리 파형을 중간에 자르면 «틱» 한다 — 12ms 동안 줄인 뒤 닫는다
          const t = c.currentTime;
          hold(t);
          g.master.gain.setTargetAtTime(0, t, 0.012);
        }
        const gg = g;
        g = null; ctx = null;
        const fin = () => {
          if (own) c.close().catch(() => {});
          else {
            if (gg) { for (const s of gg.srcs) { try { s.stop(); } catch { /* 이미 */ } } try { gg.master.disconnect(); } catch { /* 이미 */ } }
            if (woke) { woke = false; c.suspend().catch(() => {}); }
          }
        };
        if (wasOn) setTimeout(fin, 80); else fin();
      }
    };
  }

  // ── 미리 준비 (숨은 휴식 창이 읽힐 때 — 보이기 10초 전) ──
  // 그림 풀기와 소리 장치 열기(0.4~0.9초)를 보여 주기 전에 끝낸다. 루프는 돌리지 않는다.
  let pre = null;
  function preload(o) {
    o = o || {};
    const b = o.base || DEFAULT_BASE;
    if (pre && pre.base === b) return pre.all;
    release();
    const all = Promise.all([o.rig ? Promise.resolve(o.rig) : loadJson(b + 'rig.json'), decoded(b + 'base.webp'), decoded(b + 'eyes.webp')]);
    all.catch(() => { /* mount 가 다시 시도한다 */ });
    pre = { base: b, all, purr: o.audio ? makePurr(window, o.audioContext || null, o.volume) : null };
    if (pre.purr) pre.purr.warm();
    return all;
  }
  /** 이 화면에는 고양이가 안 뜬다 — 미리 연 소리 장치를 닫는다 */
  function release() {
    if (pre && pre.purr) pre.purr.close();
    pre = null;
  }

  // ── 붙이기 ─────────────────────────────────────────────
  function mount(host, opts) {
    opts = opts || {};
    const doc = host.ownerDocument || document;
    const win = doc.defaultView || window;
    const base = opts.base || DEFAULT_BASE;
    const tex = opts.textures || {};
    const align = opts.align || [0.5, 1];
    const isStatic = !!opts.static;
    const debug = !!opts.debug;
    let sound = !!opts.sound;
    let dead = false, paused = false, running = false;
    let rig = null, W = null, el = null, canvas = null, gl = null, isGL2 = false, P = null, Pfold = null;
    let nIdx = 0, ro = null, mode = 'loading', listening = false;
    let bw = 1, bh = 1, epsTex = 0.3;          // 캔버스 실제 픽셀, 안 그려도 되는 변화(텍스처 px)
    let rl = 0, rt = 0, rw = 1, rh = 1, rectT = -9; // 캔버스 화면 자리 (getBoundingClientRect 는 크기가 바뀔 때만)

    // 미리 준비해 둔 것(preload)이 이 폴더 것이면 그대로 쓴다
    const usePre = !!(pre && pre.base === base && !opts.rig && !tex.base && !tex.eyes);
    const preP = usePre ? pre.all : null;
    let purr = null;
    if (!isStatic) {
      if (opts.audioContext) purr = makePurr(win, opts.audioContext, opts.volume);
      else if (usePre && pre.purr) { purr = pre.purr; purr.setVolume(opts.volume); }
      else purr = makePurr(win, null, opts.volume);
    }
    if (usePre) {
      if (pre.purr && pre.purr !== purr) pre.purr.close();
      pre = null;   // 이 mount 가 넘겨받았다 — release() 가 닫지 않게
    }

    // ── 상태 (전부 숫자 — 프레임마다 아무것도 새로 만들지 않는다) ──
    // 스프링: [값, 속도] 쌍
    const S = new Float64Array(30);
    const YAW = 0, PITCH = 2, ROLL = 4, LEAN = 6, LIFT = 8, GX = 10, GY = 12, EARL = 14, EARR = 16, FLAT = 18;
    // FLAT 은 왼귀 눕힘, BACKR 은 손 밑 등 혹 높이. TAILA(꼬리 굽힘)는 붙들기(시험)로만 — 짜증 꼬리는 끝을 톡톡(TAILB)
    const FLATR = 20, RUMP = 22, BACKR = 24, TAILA = 26, TAILB = 28;
    const C = new Float32Array(22), L = new Float32Array(22); // 이번 자세 / 마지막으로 그린 자세
    L.fill(1e9);
    let px = 0, py = 0, pSeq = 0, seenSeq = 0, dX = 0, dY = 0, dSeq = 0, seenDown = 0;
    let cwx = 0, cwy = 0, hasPtr = false, lastMoveT = -99;
    // 손가락 (pointerType touch) — 떼는 순간 «톡»인지 «쓸기»인지 본다
    let tDown = 0, tDownT = 0, tDownX = 0, tDownY = 0, tEnd = 0, seenTEnd = 0;
    // 쓰다듬기 — 한 번 쓴 길이·방향이 바뀐 횟수
    let stAX = 0, stAY = 0, stD = 0, stEX = 0, stEY = 0, stIn = 0, strokes = 0, lastStrokeT = -99;
    let lastPetT = -99, petting = false, petCount = 0, strokeDir = 0, content = 0;
    let blinkT0 = -1, blinkDur = 0.3, blinkAmp = 1, nextBlink = 0, nextTwitch = 0, nextDrift = 0;
    let tw2T = -1, tw2Which = 0, tw2Deg = 0;   // 귀를 두 번 털 때 두 번째
    let dYaw = 0, dPitch = 0, dRoll = 0, dGx = 0, dGy = 0;
    // 숨: 이번 숨의 자리(0~1)·길이(초)·깊이·한숨인가, 단계 길이(들숨·꼭대기 멈춤·날숨 — 나머지는 바닥에서 쉼)
    // 첫 숨은 바닥에서 쉬는 몫 어딘가에서 — 첫 장이 쉬는 자세(= static 그림)와 같아 바꿔 끼워도 튀지 않는다
    let breathPh = BREATH_IN + BREATH_OUT + Math.random() * (1 - BREATH_IN - BREATH_OUT);
    // nextSigh < 0 이면 다음 tick 에서 지금부터 25~60초 뒤로 잡는다 (처음, 그리고 오래 쉬다 다시 움직일 때)
    let breathPer = BREATH_PER, breathAmp = 1, breathSigh = 0, nextSigh = -1;
    let bIn = BREATH_IN, bHold = 0, bOut = BREATH_OUT, bK = BREATH_K;
    let breath = 0, sigh = 0, bDepth = 1, purrK = -1, lid = 0, paceBreath = false;
    let lastT = -1, lastTs = -1, woken = false, level = 0, idleIv = IDLE_MS, raf = 0, tmr = 0, tmrShort = false, force = true, showFold = false;
    let settling = false, settleT0 = 0, settleDur = 0.4, settleRes = null, settleTmr = 0;
    let idleCb = 0;
    // 부위 — 쓰다듬은 길이(부위 갈래마다, 1초 남짓에 잊는다)와 그 몫(반응을 섞는 비). 갈래: 0 이마, 1 턱·볼, 2 등,
    // 3 엉덩이, 4 그 밖의 몸(꼬리 포함). 처음엔 이마 — 예전 쓰다듬기와 같다
    const ZA = new Float64Array(5), ZM = new Float64Array(5);
    ZM[0] = 1;
    let zone = 0, chinSide = 0, irk = 0;
    // 귀: 문지른 길이, 마지막으로 반응한 때, 젖힘(0~1)
    // 문지르기는 쓸기처럼 «오갔나» 로 센다 — 귀에 들어선 때, 이번 한쪽 쓸기의 시작·끝·길이
    let rubL = 0, rubR = 0, earIn = 0, eAX = 0, eAY = 0, eD = 0, eEX = 0, eEY = 0, earTL = -99, earTR = -99, ebL = 0, ebR = 0;
    // 꼬리 — 이번 tick 에 걸 털기(스프링을 돌린 뒤에 건다), 탁 치기 시작 때(-1 없음)
    let pendFlick = 0, pendThump = false, thumpT = -1, pendKick = 0;   // pendKick: 홱 돌리기 순간 속도(다음 tick 부터)
    let bumpX = 0;   // 손 밑 등 혹 자리 (손을 따라간다)
    // 부위 판정용 (불러온 뒤 한 번) — 메시 칸 채움(고양이 위인가), 턱 경계, 귀·등·엉덩이·꼬리 모양
    let occ = null, gCols = 1, gRows = 1, gSX = 1, gSY = 1;
    const ZG = new Float64Array(35);
    // 기분 — 상태, 들어선 때, 앱에 알린 이름, 참을성(쓰다듬은 초)·문턱, 경고 길이·남은 몫, 외면 끝, 마지막으로 만진 때,
    // 경고·화남 몫(0~1, 몸짓을 섞는 비 — 매끄럽게 따라간다), 외면하는 쪽(-1 왼쪽·1 오른쪽), 다음 꼬리 털기, 피부 떨림
    let mood = M_CALM, moodT0 = 0, moodOut = 'calm', tol = 0, tolMax = 20, warnDur = 1, warnLeft = 0, coolEnd = 0, madT0 = -99;
    let handT = -99, wk = 0, ak = 0, away = -1, nextFlickT = 0, touchT = -99, restLid = 0, crossT = -1;
    let rippleT0 = -9, rippleAt = -1, ripX = 0, ripA = 0, ripPh = 0, ripX0 = 0, ripX1 = 1, ripU = -1;
    // 멈춘(pause·가려짐·settle 끝) 때 — 다시 움직일 때 그동안 흐른 시간만큼 참을성·짜증·화난 몸짓을 한 번에 푼다(-1 안 멈춤)
    let offT = -1;
    const tolR = Math.random();   // 이번 세션의 문턱 자리 (친밀도로 범위만 옮긴다)
    // 친밀도 — 앱이 준 값에서 시작해 쓰다듬을 때마다 조금씩. 오늘 앞서 쓰다듬은 횟수(앱이 센다)만큼 하루 몫이 준다
    let aff = unit(opts.affinity, AFF_DEF), affSent = aff, today = Math.max(0, Number(opts.todayStrokes) || 0);
    // 세션(쓰다듬기 한 판) — 시작 때, 센 쓸기, 아직 안 센 쓸기(쓰다듬기로 잡히기 전 두 번), 모두 센 횟수
    let petStartT = -99, sessT0 = -1, sessStrokes = 0, sessCred = 0, pend = 0, nSess = 0, nStrokes = 0, nMad = 0, nGreet = 0;
    const SZ = new Float64Array(5), ZC = new Float64Array(6);   // 이번 판 갈래별 쓸어 준 길이 / 갈래별 쓰다듬은 횟수(+ 귀)
    // 눈인사 — 커서가 머문 자리·때, 머물러야 할 시간, 다음에 해도 되는 때, 이 자리에서 이미 봤나, 지금 하는 중,
    // 나타난 커서에 먼저 건넬 때. 깜박임 모양(감기·멈춤 비 — 눈인사만 다르다)
    let gAX = -1e4, gAY = -1e4, gT0 = 0, gNeed = 2, gNext = 0, gDone = true, gOn = false, spontT = -1, appearT = -1, bC = 0.38, bH = 0.1;
    // 시험용 바꿔 끼우기(debug.moodCfg) — NaN 이면 안 바꾼다
    let dbgMood = -1;
    const MC = { tolMax: NaN, warn: NaN, cool: NaN, greetP: NaN, spontP: NaN, greetCool: NaN, rippleP: NaN };
    const mc = (v, d) => (Number.isNaN(v) ? d : v);
    function setTolMax() {
      const lo = TOL_LO[0] + (TOL_LO[1] - TOL_LO[0]) * tolR, hi = TOL_HI[0] + (TOL_HI[1] - TOL_HI[0]) * tolR;
      tolMax = mc(MC.tolMax, lo + (hi - lo) * Math.min(1, Math.max(0, (aff - 0.1) / 0.8)));
    }
    setTolMax();
    // 시험용 붙들기(debug.hold) — NaN 이면 안 붙든다
    const H = new Float64Array(22).fill(NaN);
    const HY = 0, HP = 1, HR = 2, HLEAN = 3, HLIFT = 4, HGX = 5, HGY = 6, HEL = 7, HER = 8, HFL = 9, HLID = 10, HBR = 11, HSI = 12;
    const HRU = 13, HBK = 14, HTA = 15, HTB = 16, HFR = 17, HRX = 18, HRA = 19, HRP = 20, HBX = 21;
    const st = { ticks: 0, draws: 0, jsMs: 0, jsMax: 0, purrMs: 0, warmMs: 0, skips: 0, pokes: 0, ears: 0, snubs: 0, imm: 0, lv: [0, 0, 0], why: [0, 0] };

    // 랜드마크에서 나온 상수 (불러온 뒤 한 번)
    let FACE_X = 0, EYE_Y = 0, HC_X = 0, HC_Y = 0, HIRX = 1, HIRY = 1;
    let EL_X = 0, ER_X = 0, MID_X = 0;
    // 고양이마다 (rig.json — 불러온 뒤 한 번): 거울, 움직임 배율, 부위·숨 설정, 이 배율로 굳힌 정점 셰이더, 켠 부위,
    // 귀 털기 폭, 꼬리 배율(위쪽 부호 포함), 얼굴 앞 타원(가운데·y 비킴·반지름), 보통 숨 길이
    let mirror = false, kM = 1, Zc = null, Bc = null, VSk = '';
    let chinOn = true, backOn = true, rumpOn = true, rumpLiftOn = true, tailOn = true, rippleOn = true, backBump = true;
    let EAR_KL = 1, EAR_KR = 1, TG_B = 1, TG_C = 1;
    let NF_X = 0, NF_Y = 0, NF_DY = 40, NF_RX = 150, NF_RY = 115, bPer = BREATH_PER;
    // 귀 눕힘 한계(ears.flatMax), 반사 거둠 꺼풀 범위(lids.dimCatch — 같으면 안 거둔다)
    let FLAT_LIM = 0.2, DC_A = 0, DC_B = 0;
    // 알파 판정(zones.hit) — 사진 알파를 4px 칸으로 줄여 손 여유만큼 넓힌 지도. null 이면 메시 칸만 본다
    let hitM = null, hitCols = 0, hitRows = 0;
    const HIT_CELL = 4;
    // 눈에 띄게 바뀌었나 (텍스처 px 어림). 숨 1 에 가장 많이 가는 곳이 5.2px(등선 5 + 옆구리 옆밀림), 한숨 어깨 1 은 BREATH_SIGH
    // 13 오른귀 눕힘, 14·15 엉덩이·등 혹 px, 16·17 꼬리 굽힘·말기 (끝까지 거리 460·230px), 19 피부 떨림 높이.
    // 18·20·21 (피부 떨림 자리·위상, 등 혹 자리)은 높이가 있을 때만 움직임으로 친다 — 자리 Δx 는 혹 기울기(높이/σ × 0.6)만큼,
    // 위상 Δφ 는 높이만큼 털이 간다. 고양이마다 다른 몫(숨 px, 귀·꼬리 끝 거리, scale)은 rigSetup 에서 고쳐 넣는다
    const CW = [400, 1, 1, 1, 1, BREATH_LIFT + 0.3, 120, 120, 100, 1, 1, 30, BREATH_SIGH, 100, 1, 1, 460, 230, 0, 1];

    const rand = (a, b) => a + Math.random() * (b - a);
    const soft = (x) => x / Math.sqrt(1 + x * x);
    const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
    // 부드러운 한계 — 딱딱하게 자르면 귀가 벽에 부딪힌 듯 2~3프레임 멈췄다
    const soft2 = (x, lo, hi) => (x >= 0 ? hi * Math.tanh(x / hi) : lo * Math.tanh(x / lo));

    function spring(i, T, w, z, dt) {
      let x = S[i], v = S[i + 1];
      // 다 가라앉았으면 돌리지 않는다 — 가만히 있을 때 스프링 열댓 개를 tick 마다 적분하지 않게
      if (v === 0 && x === T) return;
      const n = Math.ceil(dt / 0.008), h = dt / n;
      for (let k = 0; k < n; k++) { v += (w * w * (T - x) - 2 * z * w * v) * h; x += v * h; }
      if (Math.abs(v) < 1e-5 && Math.abs(T - x) < 1e-5) { x = T; v = 0; }
      S[i] = x; S[i + 1] = v;
    }

    // ── 자리 잡기 ──
    function fit() {
      const hw = host.clientWidth, hh = host.clientHeight;
      if (!hw || !hh || !el) return false;
      const s = Math.min(hw / W.w, hh / W.h);
      const w = W.w * s, h = W.h * s;
      const x = (hw - w) * align[0], y = (hh - h) * align[1];
      if (canvas) {
        el.style.left = x + 'px'; el.style.top = y + 'px';
        el.style.width = w + 'px'; el.style.height = h + 'px';
        // 텍스처보다 촘촘한 캔버스는 메모리·채우기만 늘린다
        const k = Math.min(Math.min(win.devicePixelRatio || 1, 2), W.w / w);
        const nw = Math.max(1, Math.round(w * k)), nh = Math.max(1, Math.round(h * k));
        if (canvas.width !== nw || canvas.height !== nh) { canvas.width = nw; canvas.height = nh; }
        bw = nw; bh = nh;
        // 화면 0.35px 보다 덜 움직였으면 안 그린다 — 구석 1080p 에선 0.6, 주인공 HiDPI 에선 0.35 텍스처 px
        epsTex = EPS_DEV * W.w / bw;
        if (gl) gl.viewport(0, 0, nw, nh);
      } else {
        // 그림 한 장: 세계 상자 안에 텍스처를 여백만큼 비켜 놓는다 (리그의 쉬는 자세와 같은 자리)
        el.style.left = x + 'px'; el.style.top = y + 'px';
        el.style.width = w + 'px'; el.style.height = h + 'px';
        const im = el.firstChild;
        im.style.left = (-W.x0 * s) + 'px'; im.style.top = (-W.y0 * s) + 'px';
        im.style.width = (rig.size.w * s) + 'px'; im.style.height = (rig.size.h * s) + 'px';
      }
      return true;
    }
    function refreshRect(now) {
      if (!el) return;
      const r = el.getBoundingClientRect();
      rl = r.left; rt = r.top; rw = r.width || 1; rh = r.height || 1;
      rectT = now;
    }
    // 루프 없이 한 장 — 멈춘 채 시작하거나 멈춘 동안 캔버스 크기가 바뀌면(버퍼가 지워진다) 여기서 그려 둔다
    function drawOnce() { if (gl && !dead && mode === 'webgl') { pose(); draw(); force = false; if (debug) st.draws++; } }
    function onResize() {
      if (dead) return;
      fit();
      refreshRect(lastT);
      if (!running) drawOnce();
      else { force = true; wake(); }
    }

    // ── 입력 — 숫자만 적어 두고 그리기 루프를 깨운다 ──
    // 외면하는 동안엔 커서를 따라보지 않는다 — 움직일 때마다 깨우면 tick 이 초당 50번 가까이 돌았다. 다음 tick(10~20fps)이
    // 읽는다(쓰다듬기·누르기는 그대로 잡힌다 — 누르기는 onDown 이 깨운다)
    function onMove(e) { px = e.clientX; py = e.clientY; pSeq++; if (mood < M_MAD) wake(); }
    function onDown(e) {
      if (e.pointerType === 'touch') {
        // 손가락은 떼는 순간 «톡»인지 본다. 이전 손가락 자리에서 뛴 걸음으로 세지 않게 끊는다
        hasPtr = false; tDown = 1; tDownT = e.timeStamp; tDownX = e.clientX; tDownY = e.clientY;
        return;
      }
      dX = e.clientX; dY = e.clientY; dSeq++; tmrShort = false; wake();   // 누르면 바로 (귀 털기는 빠르다)
    }
    function onUp(e) {
      if (e.pointerType !== 'touch' || !tDown) return;
      tDown = 0;
      const mv = Math.hypot(e.clientX - tDownX, e.clientY - tDownY);
      if (e.type === 'pointerup' && mv < 10 && e.timeStamp - tDownT < 300) { dX = e.clientX; dY = e.clientY; dSeq++; tmrShort = false; }   // 톡 — 귀 털기
      else tEnd++;   // 손가락은 같은 쪽으로 여러 번 쓴다 — 뗄 때 이번 쓸기를 한 번으로 센다(update 에서)
      wake();
    }
    // 창 밖으로 나가면 끊는다 — 다른 모니터에서 돌아온 첫 move 가 크게 뛴 한 걸음으로 잡히지 않게.
    // 손가락은 뗄 때마다 relatedTarget 없는 pointerout 이 온다 — 그것까지 끊으면 tick 이 아직 못 읽은 마지막 move 가 «다시 들어옴» 으로
    // 잡혀 그 쓸기가 0 이 됐다(떼며 쓰는 쓰다듬기가 거의 안 셌다). 손가락은 대는 때(onDown)와 뗀 뒤(tEnd)에 끊는다
    function onOut(e) { if (!e.relatedTarget && e.pointerType !== 'touch') hasPtr = false; }
    function onVis() {
      if (doc.hidden) {
        // 안 보이면 그르렁도 그친다 — 루프가 멈추면 update 가 못 끈다
        stopLoop();
        if (purr) purr.stop();
        endSession();
        petting = false; strokes = 0;
        offStart();
      } else {
        // 가려진 동안에도 시계는 흘렀다 — 한숨 때를 다시 잡지 않으면 오래 가려졌다 보일 때마다 첫 숨이 한숨이다
        if (!paused) offEnd();
        lastT = -1; nextSigh = -1; wake();
      }
    }

    // ── 루프 ──
    function wake() {
      // 따라보기(30fps) 타이머가 걸려 있으면 그대로 둔다 — 커서가 움직일 때마다 60fps 로 튀어 오르지 않게
      if (!running || raf || doc.hidden || (tmr && tmrShort)) return;
      if (tmr) { clearTimeout(tmr); tmr = 0; }
      raf = win.requestAnimationFrame(tick);
      woken = true;   // 손짓으로 깨운 tick 은 간격을 따지지 않는다 — 바로 반응하게
      if (debug) st.why[0]++;
    }
    function onTimer() { tmr = 0; if (running && !raf && !doc.hidden) { raf = win.requestAnimationFrame(tick); if (debug) st.why[1]++; } }
    function stopLoop() {
      if (raf) { win.cancelAnimationFrame(raf); raf = 0; }
      if (tmr) { clearTimeout(tmr); tmr = 0; }
    }
    // 다음 tick — 마지막 tick 시각에서 목표 간격만큼. 타이머로 기다린 뒤 다음 화면 갱신(rAF)에 그린다.
    // 다음 vsync 를 기다리는 몫(~3ms)을 빼 준다 — 60Hz 에서 33ms 단계가 50ms 로 밀리지 않게
    function schedule(lv, ts) {
      if (lv === 2) { raf = win.requestAnimationFrame(tick); return; }
      const wait = (lv === 1 ? FOLLOW_MS : idleIv) - (win.performance.now() - ts) - 3;
      tmrShort = lv === 1;
      if (wait <= 0) { raf = win.requestAnimationFrame(tick); if (debug) st.imm++; }
      else tmr = setTimeout(onTimer, wait);
    }

    function tick(ts) {
      raf = 0;
      if (!running || doc.hidden) return;
      // 목표 간격보다 일찍 온 갱신은 건너뛴다 — 고주사율 화면(144Hz 에서 60fps 단계가 144fps 로 돌지 않게, 120Hz 는 60,
      // 144Hz 는 48fps), 그리고 rAF 시각이 실제보다 늦게 찍히는 환경(타이머가 한 프레임 일찍 깨운다)에서도 간격을 지킨다
      const gap = level === 2 ? 15 : (level === 1 ? FOLLOW_MS : idleIv) - 6;
      if (!woken && lastTs > 0 && ts - lastTs < gap) { raf = win.requestAnimationFrame(tick); if (debug) st.skips++; return; }
      woken = false;
      lastTs = ts;
      const t0 = debug ? win.performance.now() : 0;
      const now = ts / 1000;
      let dt = lastT < 0 ? 1 / 60 : now - lastT;
      // 오래 쉬다 깨면 한 번에 튀지 않게. 100ms 간격이 화면 갱신에 맞춰 116ms 로 오는 건 그대로 센다 — 잘라 내면 숨이 느려진다
      if (dt > 0.15) dt = 0.15;
      if (dt < 0) dt = 0;
      lastT = now;
      level = update(now, dt);
      if (debug) st.lv[level]++;
      pose();
      if (showFold) drawFold();
      else if (force || changed()) { draw(); force = false; if (debug) st.draws++; }
      // 숨만 쉬면 다음 간격은 이번에 그린 뒤의 L 에서 잰다 — 그리기 전에 재면 방금 그린 몫까지 세어 간격이 짧아졌다
      if (paceBreath) idleIv = breathIv();
      if (debug) { const ms = win.performance.now() - t0; st.ticks++; st.jsMs += ms; if (ms > st.jsMax) st.jsMax = ms; }
      // 쉬는 자세로 다 돌아갔으면(settle 끝) 움직일 게 없다 — resume() 이나 입력이 깨울 때까지 헛 tick 을 돌리지 않는다
      if (settling && !settleTmr) return;
      schedule(level, ts);
    }

    // 화면 → 세계. 거울이면 화면 왼쪽이 텍스처 오른쪽이다 — 시선·고개·부위가 화면의 진짜 커서를 따르게
    function toWX(cx) { const u = (cx - rl) / rw; return W.x0 + (mirror ? 1 - u : u) * W.w; }
    function toWY(cy) { return W.y0 + (cy - rt) / rh * W.h; }
    function inHead(x, y) { const a = (x - HC_X) * HIRX, b = (y - HC_Y) * HIRY; return a * a + b * b < 1; }
    // 털 가까이인가 — 알파 지도(zones.hit)가 있을 때만 본다(없으면 늘 참)
    function onFur(x, y) {
      if (!hitM) return true;
      const i = Math.floor(x / HIT_CELL), j = Math.floor(y / HIT_CELL);
      return i >= 0 && j >= 0 && i < hitCols && j < hitRows && hitM[j * hitCols + i] === 1;
    }
    // 고양이 위인가 — 메시 칸(rig.json grid, 20px 남짓)이 채워졌나. 앞다리·발까지 사진 윤곽 그대로.
    // 알파 지도가 있는 고양이는 털에서 손 여유 안까지만 — 칸 안의 투명 여백·바닥 흐림 띠는 고양이 위가 아니다
    function onCat(x, y) {
      const i = Math.floor(x * gSX), j = Math.floor(y * gSY);
      return i >= 0 && j >= 0 && i < gCols && j < gRows && occ[j * gCols + i] === 1 && onFur(x, y);
    }
    // 귀 위인가 — 밑동에서 끝으로 가는 축의 t 범위, 끝으로 갈수록 좁아지는 폭 (셰이더 earD 와 같은 모양)
    function earHit(o, x, y) {
      const dx = x - ZG[o], dy = y - ZG[o + 1], ux = ZG[o + 2], uy = ZG[o + 3];
      const t = (dx * ux + dy * uy) / ZG[o + 4];
      // 귀 끝 너머(t > 1)는 고양이 위일 때만 — 귀 끝 위 투명한 빈 곳을 지나는 커서까지 귀로 쳤다.
      // 알파 지도가 있으면 귀 전체가 털 가까이만 — 끝에서도 밑동 반폭의 절반이 남는 띠라 뾰족한 귀 옆 허공이 귀였다
      if (t < ZG[4] || t > ZG[5] || (t > 1 && !(occ && onCat(x, y))) || !onFur(x, y)) return false;
      return Math.abs(dx * uy - dy * ux) < ZG[o + 5] * (1 - 0.5 * clamp(t, 0, 1)) + ZG[6];
    }
    // 부위 — 0 없음, 1 이마·머리 위, 2 턱·볼, 3 왼귀, 4 오른귀, 5 등, 6 엉덩이(꼬리 밑동), 7 그 밖의 몸, 8 꼬리.
    // 끈 부위(rig.json null)는 안 본다 — 턱을 끄면 머리 타원이 다 이마, 등·엉덩이·꼬리를 끄면 그 자리는 «그 밖의 몸»
    function zoneAt(x, y) {
      if (earHit(7, x, y)) return 3;
      if (earHit(13, x, y)) return 4;
      if (!occ || !onCat(x, y)) return 0;
      if (inHead(x, y)) { if (!chinOn) return 1; const dx = x - ZG[0]; return y > Math.max(ZG[3], ZG[1] - ZG[2] * dx * dx) ? 2 : 1; }
      let a, b;
      if (rumpOn) { a = (x - ZG[23]) * ZG[25]; b = (y - ZG[24]) * ZG[26]; if (a * a + b * b < 1) return 6; }
      if (backOn) { a = (x - ZG[19]) * ZG[21]; b = (y - ZG[20]) * ZG[22]; if (a * a + b * b < 1) return 5; }
      if (!tailOn) return 7;
      // 꼬리 위(몸 쪽)는 축의 왼쪽 법선 — +x 로 뻗은 꼬리는 부호를 뒤집는다(zones.tail.upSign)
      const dx = x - ZG[27], dy = y - ZG[28];
      const al = dx * ZG[29] + dy * ZG[30], up = (ZG[29] * dy - ZG[30] * dx) * ZG[34];
      if (al > -12 * kM && al < ZG[31] + 6 * kM && up < ZG[32] + 4 * kM && -up < ZG[33] + 4 * kM) return 8;
      return 7;
    }
    // 귀를 만졌다 — 그 귀만 세게 파르르(털고 0.1초 뒤 반만큼 한 번 더) 턴 뒤, EAR_LAG 지나 잠깐 옆·뒤로 젖힌다(EAR_HOLD 뒤
    // EAR_FADE 에 걸쳐 돌아온다). 고개는 살짝 움츠린다. 그르렁은 없다. 짜증이 쌓여 있으면 꼬리 끝을 툭(많으면 탁) 턴다
    function earTouch(which, now, hard) {
      // 이미 젖혀 있으면 그대로 젖힌 채 다시 센다 — 늦추면 털기 사이에 귀가 잠깐 제자리로 돌아왔다 다시 젖혔다
      const lag = (which === 0 ? ebL : ebR) > 0.05 ? 0 : EAR_LAG;
      if (which === 0) { earTL = now + lag; rubL = 0; } else { earTR = now + lag; rubR = 0; }
      const deg = hard ? rand(9, 11) : rand(6, 8);
      twitch(which, deg);
      tw2T = now + 0.1; tw2Which = which; tw2Deg = deg * 0.5;
      S[LIFT + 1] -= 30;
      irk += IRK_EAR;
      if (irk > 0.8) pendThump = true; else if (irk > 0.45) pendFlick = Math.max(pendFlick, TAIL_FLICK);
      if (irk > 0.45) nextFlickT = now + rand(1.5, 3);
      // 참을성에도 한 덩이 — 귀를 자꾸 만지면 쓰다듬기보다 빨리 «그만» 이 온다. 외면하는 중이면 고개도 다시 돌린다(손 반대쪽으로)
      tol += TOL_EAR; handT = now; ZC[5]++;
      if (mood >= M_MAD) snubHead(now, which === 0 ? EL_X : ER_X);
      if (debug) st.ears++;
    }
    function earBackAt(s) {
      if (s < 0) return 0;
      if (s < EAR_HOLD) return 1;
      const v = Math.exp(-(s - EAR_HOLD) / EAR_FADE);
      return v < 0.005 ? 0 : v;
    }
    // 꼬리 끝 털기 — 끝 말기 스프링에 순간 속도. 정점이 a(rad)가 되게 (감쇠 0.55 에서 정점 = v/ω × 0.52).
    // 스프링을 이번 dt 만큼 돌린 뒤에만 부른다(pendFlick) — 먼저 걸면 첫 장이 정점 근처로 건너뛰었다
    function tailFlick(a) { S[TAILB + 1] += a * TAIL_W / 0.52; }

    // ── 기분·친밀도 ──
    // 얼굴 앞인가 — 눈·코·주둥이를 덮는 타원(s 배). rig.json head.face 가 있으면 그 타원
    function nearFace(x, y, s) { const a = (x - NF_X) / (NF_RX * s), b = (y - NF_Y - NF_DY) / (NF_RY * s); return a * a + b * b < 1; }
    function emit(fn, v) { if (fn) { try { fn(v); } catch { /* 부르는 쪽 오류로 리그가 멈추지 않게 */ } } }
    function setMood(m, now) {
      if (m === mood) return;
      mood = m; moodT0 = now;
      const o = MOOD_OUT[m];
      if (o !== moodOut) { moodOut = o; emit(opts.onMood, o); }
    }
    function sendAff() { if (aff !== affSent) { affSent = aff; emit(opts.onAffinity, aff); } }
    // 쓰다듬기 한 판이 끝났다 — 어디를(가장 많이 쓸어 준 갈래) 몇 번, 얼마 동안. 친밀도가 바뀌었으면 같이 알린다
    function endSession() {
      if (sessT0 < 0) return;
      let k = 0;
      for (let i = 1; i < 5; i++) if (SZ[i] > SZ[k]) k = i;
      const ms = Math.max(0, Math.round((lastPetT - sessT0) * 1000));
      sessT0 = -1;
      emit(opts.onPet, { zone: KIND_NAME[k], strokes: sessStrokes, ms, credited: sessCred });
      sendAff();
    }
    // 쓰다듬기로 센 쓸기 n 번 — 판·부위 횟수에 더하고, 기분이 좋을 때만 친밀도를 올린다(경고 중 쓸기는 정이 안 든다)
    function credit(n) {
      let k = 0;
      for (let i = 1; i < 5; i++) if (ZA[i] > ZA[k]) k = i;
      sessStrokes += n; nStrokes += n; ZC[k] += n;
      if (mood <= M_CONTENT) { aff = affGain(aff, n, today); sessCred += n; }
      today += n;
    }
    // 멈춘 동안(pause·가려짐·settle 끝)에도 시계는 흐른다 — tick 의 dt 는 0.15초로 잘려, 멈춘 동안 참을성·짜증·화난 몸짓이
    // 그대로 남았다(8초 쉬고 다시 쓰다듬으면 4초 만에 경고). 다시 움직일 때 그 몫을 한 번에 푼다
    function offStart() { if (offT < 0) offT = win.performance.now() / 1000; }
    function offEnd() {
      if (offT < 0) return;
      const t = win.performance.now() / 1000, gap = t - offT, from = offT;
      offT = -1;
      tol = Math.max(0, tol - TOL_DRAIN * gap);
      irk *= Math.exp(-gap / IRK_TAU); if (irk < 0.001) irk = 0;
      if (mood >= M_MAD && t > coolEnd) ak *= Math.exp(-(t - Math.max(coolEnd, from)) / 2.5);
      if (mood === M_WARN && gap > WARN_QUIT) wk *= Math.exp(-(gap - WARN_QUIT) / 0.9);
    }
    // 외면하는 동안 또 만졌다 — 고개를 손 반대쪽으로 다시 홱 돌리고 외면이 조금 길어진다(만질수록 끝없이 늘지는 않게 40초까지).
    // hx: 만진 자리 x (NaN 이면 그대로) — 화날 때 한 번 정한 쪽만 쓰면, 돌아본 쪽에서 만질 때 고개를 손 쪽으로 더 돌렸다
    function snubHead(now, hx) {
      if (!Number.isNaN(hx)) away = hx > FACE_X ? -1 : 1;
      touchT = now; crossT = -1;
      S[YAW + 1] += away * 2.5;
      coolEnd = Math.min(Math.max(coolEnd, now + 4), madT0 + 40);
      setMood(M_MAD, now);
      if (debug) st.snubs++;
    }
    // 몸을 만졌다 — 손 쪽 귀를 털고 꼬리 끝을 툭
    function snub(now, hx) {
      if (!Number.isNaN(hx)) away = hx > FACE_X ? -1 : 1;
      const near = away < 0 ? 1 : 0;
      twitch(near, rand(7, 9)); twitch(1 - near, rand(3, 5));
      pendFlick = Math.max(pendFlick, TAIL_FLICK);
      snubHead(now, NaN);
    }
    function toWarn(now) {
      setMood(M_WARN, now);
      warnDur = mc(MC.warn, rand(WARN_SEC[0], WARN_SEC[1]));
      warnLeft = warnDur;
      nextFlickT = now + rand(0.3, 0.7);
      // 등 피부 떨림 — 열에 일곱 번쯤, 경고 들머리에 한 번 (피부 떨림을 끈 고양이는 없다)
      rippleAt = rippleOn && Math.random() < mc(MC.rippleP, 0.7) ? now + rand(0.6, Math.max(0.7, Math.min(1.8, warnDur * 0.6))) : -1;
    }
    function toMad(now) {
      // 커서 반대쪽으로 — 커서가 없으면 지금 보던 반대로. 순간 속도를 줘 홱(첫 100ms 부터) 돌린다(스프링을 이번 dt 만큼 돌린 뒤에)
      away = hasPtr ? (cwx > FACE_X ? -1 : 1) : (S[YAW] > 0 ? -1 : 1);
      setMood(M_MAD, now);
      madT0 = now; crossT = -1;
      pendKick = away * MAD_KICK;
      coolEnd = now + mc(MC.cool, rand(COOL_SEC[0], COOL_SEC[1]));
      nMad++;
      aff = Math.max(0, aff - AFF_MAD);
      twitch(2, rand(5, 7));
      pendThump = true;
      nextFlickT = now + rand(1.5, 2.5);
      if (petting) { petting = false; strokes = 0; pend = 0; endSession(); }
      sendAff();
    }
    // 눈인사 — 천천히 감고(0.6초) 잠깐 멈췄다(0.3초) 천천히 뜬다(0.8초). 고개 숙임은 update 가 이 곡선을 따라 한다
    function greet(now) {
      blinkT0 = now; blinkAmp = 1; gOn = true; gDone = true; nGreet++;
      blinkDur = GREET_CLOSE + GREET_HOLD + GREET_OPEN; bC = GREET_CLOSE / blinkDur; bH = GREET_HOLD / blinkDur;
      gNext = now + blinkDur + mc(MC.greetCool, rand(GREET_COOL[0], GREET_COOL[1]));
    }

    function blinkCurve(u) {
      // 감기는 빠르고 뜨기는 조금 느리게 — 진짜 깜박임 모양 (보통 감기 38%·멈춤 10%, 눈인사는 greet 가 바꾼다)
      if (u < bC) { const e = u / bC; return e * e * (3 - 2 * e); }
      if (u < bC + bH) return 1;
      const e = (u - bC - bH) / (1 - bC - bH);
      return 1 - e * e * (3 - 2 * e);
    }
    function breathCurve(ph) {
      // 들숨: 천천히 시작해 천천히 끝난다. 날숨: 힘을 빼고 놓듯 앞쪽이 조금 빠르고 끝은 조금 끈다(bK).
      // 그 뒤 바닥에서 잠깐 쉰다. 꼭대기·바닥에서 속도가 0 이라 덜컥이지 않는다
      if (ph < bIn) { const e = ph / bIn; return e * e * (3 - 2 * e); }
      ph -= bIn;
      if (ph < bHold) return 1;
      ph -= bHold;
      if (ph < bOut) { const e = 1 - Math.pow(1 - ph / bOut, bK); return 1 - e * e * (3 - 2 * e); }
      return 0;
    }
    // 숨을 바닥 쉼 첫머리로 (보통 숨 길이로) — 쉬는 자세에서 다시 움직일 때 0 에서 이어지게
    function breathRest() {
      breathSigh = 0; breathAmp = 1; breathPer = bPer; bIn = BREATH_IN; bHold = 0; bOut = BREATH_OUT; bK = BREATH_K;
      breathPh = BREATH_IN + BREATH_OUT;
    }
    // h ms 뒤 숨 자리가 마지막으로 그린 자리(L)에서 화면(기기 px)으로 얼마나 멀어지나. L 에서 재므로 문턱에 걸려
    // 안 그리고 넘긴 몫도 들어간다. 숨이 바뀌는 바닥 쉼 끝 너머는 보지 않는다(들숨 첫머리는 어차피 느리다)
    function breathAhead(h) {
      const k = breathCurve(Math.min(breathPh + h / 1000 / breathPer, 0.9999));
      return (Math.abs(bDepth * k - L[5]) * CW[5] + Math.abs(breathSigh * k - L[12]) * CW[12]) * bw / W.w;
    }
    // 숨만 쉴 때 다음 tick 간격 — 한 장에 윤곽이 STEP_DEV 만큼 가게. 지난 tick 의 빠르기(뒤)만 보면 꼭대기에서
    // 날숨으로 넘어가며 빨라지는 곳을 놓쳐, 100ms 를 기다렸다 한 장에 0.9px 씩 뛰었다. 숨 곡선이 휘어 한 번 더 맞춘다
    function breathIv() {
      const hMax = IDLE_MS + VSYNC_PAD, hMin = BREATH_MS + VSYNC_PAD;
      const d = breathAhead(hMax);
      if (d <= STEP_DEV) return IDLE_MS;
      let h = clamp(hMax * STEP_DEV / d, hMin, hMax);
      const d1 = breathAhead(h);
      if (d1 > 0) h = clamp(h * STEP_DEV / d1, hMin, hMax);
      return h - VSYNC_PAD;
    }
    // 그르렁이 따라갈 숨 단계 — 0 쉼(꼭대기 멈춤 포함), 1 들숨, 2 날숨
    function breathStage() {
      if (breathPh < bIn) return 1;
      const p = breathPh - bIn - bHold;
      return p >= 0 && p < bOut ? 2 : 0;
    }
    function nextBreath(now, c) {
      // 숨마다 길이·깊이가 조금씩 다르다. 때가 되면 한숨 — 깊게, 길게 들이쉬고 꼭대기에서 잠깐 멈췄다 천천히 내쉰다
      const slow = 1 + PET_SLOW * c;
      if (now >= nextSigh && !settling) {
        // 한숨: 들숨 34%, 꼭대기 6% 멈춤, 날숨 45%(들숨보다 길게), 바닥 15% — 한숨 뒤엔 잠깐 더 멎는다
        nextSigh = now + rand(25, 60);
        breathSigh = 1; breathAmp = rand(1.6, 2);
        breathPer = bPer * rand(1.8, 2.1) * slow;
        bIn = 0.34; bHold = 0.06; bOut = 0.45; bK = 1.2;
      } else {
        breathSigh = 0; breathAmp = rand(0.85, 1.15);
        breathPer = bPer * rand(0.9, 1.1) * slow;
        bIn = BREATH_IN; bHold = 0; bOut = BREATH_OUT; bK = BREATH_K;
      }
    }
    function twitch(which, deg) {
      // 귀 털기 — 스프링에 순간 속도를 준다. 정점이 deg 가 되게 (감쇠 0.65 에서 정점 = v/ω × 0.48). 귀마다 폭(ears.*.flick)만큼
      const v = deg * (Math.PI / 180) * EAR_W / 0.48;
      if (which !== 1) S[EARL + 1] += v * EAR_KL;
      if (which !== 0) S[EARR + 1] += v * EAR_KR;
    }
    function poke(x) {
      // 누르면: 가까운 귀를 세게, 다른 귀는 살짝 털고 고개를 조금 든다
      const left = x < (EL_X + ER_X) / 2;
      if (debug) st.pokes++;
      twitch(left ? 0 : 1, rand(9, 12));
      twitch(left ? 1 : 0, rand(3, 5));
      S[LIFT + 1] += 80;
      S[PITCH + 1] -= 1.2;
    }
    function resetStroke(x, y) { stAX = x; stAY = y; stD = 0; stEX = x; stEY = y; stIn = 0; }
    function strokeDone(now) {
      // 한 번 쓸었다 — 고양이 위를 STROKE_MIN 넘게 지나간 쓸기만 센다. 친밀도·횟수는 쓰다듬기로 잡힌 뒤에 센다(pend)
      const m = STROKE_MIN * kM;
      if (stD > m && stIn > m) { strokes++; lastStrokeT = now; pend++; }
    }

    function update(now, dt) {
      if (nextBlink === 0) { nextBlink = now + rand(3, 8); nextTwitch = now + rand(4, 9); nextDrift = now; }
      if (nextSigh < 0) nextSigh = now + rand(25, 60);
      // 친밀도가 정하는 것 — 커서를 얼마나 오래 따라보나(5~9초)
      const followSec = FOLLOW_SEC[0] + (FOLLOW_SEC[1] - FOLLOW_SEC[0]) * aff;
      const sulk = mood >= M_MAD;
      // 커서
      let moved = false, mdx = 0, mdy = 0, cont = false;
      if (pSeq !== seenSeq) {
        seenSeq = pSeq;
        // 들어오는 움직임(CSS transform)이 끝나 자리가 바뀌었을 수 있다 — 1초에 한 번만 다시 잰다
        if (now - rectT > 1) refreshRect(now);
        const wx = toWX(px), wy = toWY(py);
        cont = hasPtr;
        if (hasPtr) { mdx = wx - cwx; mdy = wy - cwy; }
        // 커서가 (다시) 나타났다(처음 움직임, 창 밖에서 돌아옴, 15초 넘게 가만있다 움직임) — 친밀도가 높으면 나타나고
        // 2.5초 안에 얼굴 가까이 온 커서에 먼저 눈인사를 건넨다(한 번만 본다)
        if (!cont || now - lastMoveT > 15) appearT = now;
        if (appearT >= 0 && (now - appearT > 2.5 || sulk)) appearT = -1;
        if (appearT >= 0 && aff > 0.6 && nearFace(wx, wy, 1.6)) {
          appearT = -1;
          if (Math.random() < mc(MC.spontP, (aff - 0.6) / 0.4 * 0.8)) spontT = now + rand(0.5, 1);
        }
        cwx = wx; cwy = wy; hasPtr = true; moved = true; lastMoveT = now;
        // 눈인사 — 커서가 GREET_STILL 상자 밖으로 나가면 «가만히» 를 처음부터 센다(지나가는 커서는 머물지 않는다).
        // 친밀도가 높을수록 빨리 답한다(1.5~2.5초)
        if (Math.abs(wx - gAX) > GREET_STILL * kM || Math.abs(wy - gAY) > GREET_STILL * kM) {
          gAX = wx; gAY = wy; gT0 = now; gDone = false;
          gNeed = clamp(2.5 - aff + rand(-0.15, 0.15), 1.5, 2.5);
        }
      }
      // 누르기 — 털기는 스프링을 이번 dt 만큼 돌린 뒤에 건다. 먼저 걸면 가만히 있던 끝(dt 83ms)에 정점(~28ms)을
      // 한 번에 건너뛰어, 귀가 털린 순간이 화면에 안 나왔다
      let pokeX = NaN, pokeZ = 0;
      if (dSeq !== seenDown) {
        seenDown = dSeq;
        if (now - rectT > 1) refreshRect(now);
        const wx = toWX(dX), wy = toWY(dY);
        pokeZ = zoneAt(wx, wy);
        pokeX = wx;
      }
      // 쓰다듬기 = 고양이 위에서 왔다 갔다. 한 번 지나가는 커서·손 떨림은 안 친다. 귀 위는 쓰다듬기로 치지 않는다(예민하다).
      // 쓸기 한 번 = 시작점에서 가장 멀어진 끝까지. 끝에서 STROKE_BACK 넘게 되돌아오면 방향이 바뀐 것
      // 귀에 머문 시간은 들어선 때부터 잰다 — 들어선 tick 의 dt 를 통째로 더하면 실제보다 일찍 문턱에 닿았다
      if (moved) { const z = hasPtr ? zoneAt(cwx, cwy) : 0; if (z !== zone) { earIn = now; eAX = eEX = cwx; eAY = eEY = cwy; eD = 0; } zone = z; }
      const earDw = hasPtr && (zone === 3 || zone === 4) ? now - earIn : 0;
      const inside = hasPtr && zone > 0 && zone !== 3 && zone !== 4;
      const step = Math.sqrt(mdx * mdx + mdy * mdy);
      if (moved) {
        if (!cont || step >= 120 * kM) resetStroke(cwx, cwy);   // 끊겼다 다시 들어왔거나 크게 뛰었다 — 걸음으로 안 센다
        else if (step > 1.2 * kM) {
          // 부위마다 쓸어 준 길이 — 반응을 섞는 몫이 된다. 몸을 빠르게 가로지르는 걸음(손을 떼며 빠져나감·들어옴)은 몫에 안 넣는다 —
          // 넣으면 손을 뗀 뒤 엉덩이가 들렸다
          if (inside) { stIn += step; if (step < ZONE_VMAX * kM * dt) { ZA[ZKIND[zone]] += step; if (sessT0 >= 0) SZ[ZKIND[zone]] += step; } }
          else if (earDw > EAR_DWELL) {
            // 귀 문지르기도 쓸기처럼 «오갔나» 로 센다 — 한 방향으로 지나가는 커서·손 떨림은 안 친다
            const d = Math.hypot(cwx - eAX, cwy - eAY);
            if (d >= eD) { eD = d; eEX = cwx; eEY = cwy; }
            else if (Math.hypot(cwx - eEX, cwy - eEY) > STROKE_BACK * kM) {
              if (eD >= 8 * kM) { if (zone === 3) rubL += eD; else rubR += eD; }
              eAX = eEX; eAY = eEY; eD = Math.hypot(cwx - eAX, cwy - eAY); eEX = cwx; eEY = cwy;
            }
          }
          if (zone === 2) chinSide += (soft((cwx - ZG[0]) / (40 * kM)) - chinSide) * Math.min(1, dt * 4);
          const d = Math.hypot(cwx - stAX, cwy - stAY);
          if (d >= stD) { stD = d; stEX = cwx; stEY = cwy; }
          else if (Math.hypot(cwx - stEX, cwy - stEY) > STROKE_BACK * kM) {
            strokeDone(now);
            const ex = stEX, ey = stEY;
            resetStroke(ex, ey);
            stD = Math.hypot(cwx - ex, cwy - ey); stEX = cwx; stEY = cwy; stIn = inside ? stD : 0;
          }
          if (inside && (strokes >= 2 || petting)) {
            lastPetT = now;
            const sd = mdx > 0 ? Math.min(1, mdx / (6 * kM)) : Math.max(-1, mdx / (6 * kM));
            strokeDir += (sd - strokeDir) * Math.min(1, dt * 3);
          }
        }
      }
      if (tEnd !== seenTEnd) {
        // 손가락을 뗐다 — 손가락은 같은 쪽으로 여러 번 쓸므로 뗄 때마다 한 번으로 센다
        seenTEnd = tEnd;
        strokeDone(now);
        if (strokes >= 2 && !petting) lastPetT = now;
        resetStroke(cwx, cwy);
        hasPtr = false;
      }
      if (!petting && now - lastStrokeT > 1.2) { strokes = 0; pend = 0; }
      // 화나서 외면하는 동안엔 쓰다듬어도 받지 않는다 — 한 번 쓸 때마다 귀를 털고 고개를 다시 돌린다(손 반대쪽으로).
      // 쉬는 자세로 돌아가는 중(settle)엔 몸짓도 셈도 하지 않는다 — static 으로 바뀌기 직전에 어긋난 자세가 보이지 않게
      if (sulk && strokes > 0) { if (now - touchT > 0.9 && !settling) snub(now, cwx); strokes = 0; pend = 0; }
      const was = petting;
      petting = !settling && mood < M_MAD && (petting || strokes >= 2) && now - lastPetT < 0.8;
      if (petting && !was) {
        // 쓰다듬기 한 판 시작 — 판에서 가장 많이 쓸어 준 곳은 잡히기 전 쓸기(ZA)부터 센다
        petCount++; nSess++;
        petStartT = now; sessT0 = Math.min(now, lastPetT); sessStrokes = 0; sessCred = 0; SZ.set(ZA);
      }
      if (petting && pend) { credit(pend); pend = 0; }
      if (!petting && was) { strokes = 0; pend = 0; endSession(); }
      // 만족(눈 감기·기대기·그르렁)은 기분이 좋을 때만 — 경고에 들면 잦아들어 눈을 뜨고 몸을 거둔다.
      // 친밀도가 높을수록 빨리 녹아든다. 경고에 들면 눈을 번쩍(0.3~0.5초) 뜬다 — 손을 뗄 때처럼 1.3/s 로 잦아들면 «서서히 깸»
      // 이었고, 노려보는 눈처럼 보이는 꺼풀 중간(0.35~0.65)에 오래 머물렀다
      const pleased = petting && mood <= M_CONTENT;
      content += ((pleased ? 1 : 0) - content) * (1 - Math.exp(-dt * (pleased ? 1.2 + 1.2 * aff : mood === M_WARN ? 3.5 : 1.3)));
      if (content < 0.001 && !pleased) content = 0;
      const c = content;
      // 부위 몫 — 쓰다듬는 동안 최근 1초 남짓 쓸어 준 길이의 비를 0.4초쯤에 걸쳐 따라간다(부위를 옮기면 몸짓이 스르르 바뀐다).
      // 손을 떼면(손이 0.15초 넘게 안 쓸면 — petting 꼬리 0.8초 동안 섞이지 않게) 몫은 그대로 두고 content 만 잦아든다
      const zk = Math.exp(-dt / 0.9);
      let zs = 0;
      for (let i = 0; i < 5; i++) { ZA[i] *= zk; zs += ZA[i]; }
      if (petting && zs > 5 && now - lastPetT < 0.15) { const f = Math.min(1, dt * 2.5); for (let i = 0; i < 5; i++) ZM[i] += (ZA[i] / zs - ZM[i]) * f; }
      // 귀 — 문지른 길이는 0.5초에 잊는다. 젖힘은 만진 때부터. 짜증은 IRK_TAU 에 걸쳐 잊는다
      const rk = Math.exp(-dt / 0.5);
      rubL *= rk; rubR *= rk;
      ebL = earBackAt(now - earTL); ebR = earBackAt(now - earTR);
      irk *= Math.exp(-dt / IRK_TAU);
      if (irk < 0.001) irk = 0;

      // ── 기분 ── (숫자 몇 개 — tick 마다 새로 만드는 것 없음)
      // 시험용으로 바로 건 기분(debug.mood)도 여기서 — 진짜 길처럼 tick 안에서 바꾼다
      if (dbgMood >= 0) { if (dbgMood === M_WARN) toWarn(now); else toMad(now); dbgMood = -1; }
      // 참을성: 쓰는 손이 움직이는 동안 부위 몫만큼 차오르고(귀는 만질 때마다 한 덩이), 손을 떼면 빠진다
      if (petting && now - lastPetT < 0.35) {
        handT = now;
        tol += dt * (TOL_RATE[0] * ZM[0] + TOL_RATE[1] * ZM[1] + TOL_RATE[2] * ZM[2] + TOL_RATE[3] * ZM[3] + TOL_RATE[4] * ZM[4]);
      } else if (tol > 0 && now - handT > 0.5) tol = tol > dt * TOL_DRAIN ? tol - dt * TOL_DRAIN : 0;   // 호출 없는 식 — 드물게 타는 갈래의 호출이 update 최적화를 풀었다
      const handled = now - handT < 1;
      if (mood <= M_CONTENT) {
        // 그르렁(만족)은 쓰다듬기로 잡히고 조금 뒤 — 친밀도가 낮으면 1.2초, 높으면 0.4초
        if (tol >= tolMax && handled && !settling) toWarn(now);
        else setMood(petting && c > 0.35 && now - petStartT >= 1.2 - 0.8 * aff ? M_CONTENT : M_CALM, now);
      } else if (mood === M_WARN) {
        // 경고는 만지는 동안만 흐른다. 손을 떼면(WARN_QUIT) 화내지 않고 가라앉는다
        if (handled) warnLeft -= dt;
        // 가라앉으면 잡아 둔 피부 떨림도 거둔다 — 쉼으로 돌아간 뒤에 물결이 지나갔다
        if (settling || now - handT > WARN_QUIT) { setMood(M_CALM, now); rippleAt = -1; }
        else if (warnLeft <= 0) toMad(now);
      } else if (mood === M_MAD) {
        if (settling || now - moodT0 > TURN_SEC) setMood(M_COOL, now);
      } else if (settling || now >= coolEnd) {
        setMood(M_CALM, now);
        tol = Math.min(tol, tolMax * 0.3);
      }
      // 몸짓에 섞는 몫 — 경고는 0.5초에 들고, 화남은 홱(0.15초) 들어 천천히(2.5초) 풀린다. 쉬는 자세로 갈 땐 바로
      const wT = mood === M_WARN ? 1 : 0, aT = mood >= M_MAD ? 1 : 0;
      if (wk !== wT) {
        wk += (wT - wk) * (1 - Math.exp(-dt / (wT > wk ? 0.5 : settling ? 0.12 : 0.9)));
        if (wk < 0.01 && !wT) wk = 0;
      }
      if (ak !== aT) {
        ak += (aT - ak) * (1 - Math.exp(-dt / (aT > ak ? 0.15 : settling ? 0.12 : 2.5)));
        if (ak < 0.02 && !aT) ak = 0;   // 끝자락(꺼풀 0.007 칸)은 털어 낸다 — 0.001 까지 따라가면 20fps 가 17초 돌았다
      }
      // 꼬리 — 경고 동안 끝을 털다(처음엔 작게) 갈수록 탁 친다. 외면하는 처음 몇 초와 짜증이 쌓였을 때(0.35~)도 가끔 톡.
      // 엎드린 고양이의 짜증 꼬리는 끝을 가끔 톡톡 친다 — 천천히 계속 쓸던 때는 거의 안 보이면서 20fps 를 내내 썼다.
      // 털기는 스프링을 이번 dt 만큼 돌린 뒤에 건다(pendFlick·pendThump)
      if (!settling && now >= nextFlickT) {
        if (mood === M_WARN) {
          const pr = 1 - Math.max(0, warnLeft) / warnDur;
          if (pr > 0.6) pendThump = true; else pendFlick = Math.max(pendFlick, TAIL_FLICK * (0.6 + 0.4 * pr / 0.6));
          nextFlickT = now + rand(0.7, 1.2) * (1 - 0.3 * pr);
        } else if ((mood >= M_MAD && now < madT0 + 6) || irk > 0.35) { pendFlick = Math.max(pendFlick, TAIL_FLICK * 0.6); nextFlickT = now + rand(1.5, 3); }
      }
      // 등 피부 떨림 — 손 밑(손이 몸에 없으면 등 가운데)에서 RIPPLE_SEC 씩 두 번 파르르. 높이는 사인 봉우리라 처음·끝이 0 —
      // 튀지 않는다. 결은 초당 RIPPLE_HZ 번 흐른다
      if (rippleAt >= 0 && now >= rippleAt) {
        rippleAt = -1;
        if (!settling) { rippleT0 = now; ripX = hasPtr && ZM[2] + ZM[3] + ZM[4] > 0.3 ? clamp(cwx, ripX0 + 60 * kM, ripX1 - 60 * kM) : (ripX0 + ripX1) / 2; }
      }
      const rs = now - rippleT0, rcy = RIPPLE_SEC + RIPPLE_GAP;
      ripU = !settling && rs >= 0 && rs < RIPPLE_N * rcy - RIPPLE_GAP ? (rs % rcy) / RIPPLE_SEC : -1;
      ripA = ripU >= 0 && ripU < 1 ? RIPPLE_PX * Math.sin(Math.PI * ripU) : 0;
      ripPh = ripU >= 0 ? 2 * Math.PI * RIPPLE_HZ * rs : 0;

      // 깜박임 — 8~22초마다(고양이는 빤히 본다). 넷에 하나는 반만 감는다.
      // 눈인사(느린 깜박임)는 커서가 얼굴 앞에 가만히 머물 때만 — «눈 키스» 처럼 뜻이 있게. 쓰다듬는 중·기분이 상했을 땐
      // 안 한다. 친밀도가 높을수록 잘 받아 준다(0.1 → 열에 넷, 0.9 → 거의 늘)
      const greetOk = !settling && mood === M_CALM && wk < 0.05 && ak < 0.05 && !petting && c < 0.05 && now >= gNext && blinkT0 < 0 && hasPtr;
      if (greetOk && !gDone && now - gT0 >= gNeed && nearFace(cwx, cwy, 1)) {
        gDone = true;
        if (Math.random() < mc(MC.greetP, 0.35 + 0.65 * aff)) greet(now);
      }
      if (spontT >= 0 && now >= spontT) { spontT = -1; if (greetOk && nearFace(cwx, cwy, 1.6)) greet(now); }
      if (blinkT0 < 0 && now > nextBlink && !settling) {
        blinkT0 = now; bC = 0.38; bH = 0.1;
        blinkDur = rand(0.26, 0.34);
        blinkAmp = Math.random() < 0.25 ? rand(0.45, 0.7) : 1;
      }
      let lb = 0, gk = 0;
      if (blinkT0 >= 0) {
        const u = (now - blinkT0) / blinkDur;
        if (u >= 1) { blinkT0 = -1; gOn = false; nextBlink = now + rand(8, 22); } else { lb = blinkCurve(u) * blinkAmp; if (gOn) gk = lb; }
      }

      // 어디를 보나 — 커서가 있으면 그쪽, 없으면 혼자 천천히 두리번. 쉬는 자세로 돌아가는 중(settle)이면 정면.
      // 친밀도가 높을수록 선뜻(빠르게)·오래 따라본다
      let yT, pT, rT, gxT, gyT, w;
      if (settling) {
        yT = 0; pT = 0; rT = 0; gxT = 0; gyT = 0; w = 14;
      } else if (hasPtr && now - lastMoveT < followSec) {
        const dx = cwx - FACE_X, dy = cwy - EYE_Y;
        yT = soft(dx / (420 * kM)); pT = soft(dy / (380 * kM)) * 0.8; rT = 0;
        gxT = soft(dx / (200 * kM)); gyT = soft(dy / (200 * kM));
        w = FOLLOW_W[0] + (FOLLOW_W[1] - FOLLOW_W[0]) * aff;
        nextDrift = now + rand(1, 3);
      } else {
        if (now > nextDrift) {
          nextDrift = now + rand(3.5, 8);
          if (Math.random() < 0.35) { dYaw = 0; dPitch = 0; dRoll = 0; } else {
            dYaw = rand(-0.45, 0.45); dPitch = rand(-0.25, 0.2); dRoll = rand(-0.012, 0.012);
          }
          dGx = clamp(dYaw * 1.3 + rand(-0.2, 0.2), -1, 1); dGy = clamp(dPitch * 1.2, -1, 1);
        }
        yT = dYaw; pT = dPitch; rT = dRoll; gxT = dGx; gyT = dGy;
        w = 1.6;
      }
      // 화남·외면 — 커서를 모른 척: 고개를 커서 반대로 홱 돌리고(버틴 뒤엔 조금 풀어 외면), 눈은 더 반대로 아래로.
      // 경고 때는 위 따라보기 그대로 — 손을 빤히 쳐다본다
      if (ak > 0 && !settling) {
        // 외면 중 커서가 고양이가 돌아본 쪽으로 오면, COOL_DODGE 넘게 머물 때 반대쪽으로 천천히 다시 돌아앉는다(피한다)
        let cs = 0;
        if (mood === M_COOL && hasPtr) {
          cs = cwx > FACE_X ? 1 : -1;
          if (cs !== away) crossT = -1;
          else if (crossT < 0) crossT = now;
          else if (now - crossT > COOL_DODGE) { away = -cs; crossT = -1; }
        } else crossT = -1;
        // 홱 돌리는 동안(화남)은 고개·눈 목표를 바로 다 준다 — 몫(ak, 0.15초)을 따라 목표가 스르르 옮겨 가면 출발이 굼떴다
        const ka = mood === M_MAD ? 1 : ak;
        const ya = away * MAD_YAW * (mood === M_MAD ? 1 : MAD_EASE);
        yT += (ya - yT) * ka; pT += (MAD_PITCH - pT) * ka; rT += (away * 0.012 - rT) * ka;
        // 눈 — 외면 중엔 «지금 커서의 반대쪽» 아래. 화날 때 정한 쪽에 묶어 두면, 커서가 돌아본 쪽으로 왔을 때 가늘게 뜬 눈으로
        // 사용자를 똑바로 노려봤다
        const ga = cs ? -0.8 * cs : away;
        gxT += (ga - gxT) * ka; gyT += ((cs ? 0.5 : 0.35) - gyT) * ka;
        if (mood === M_MAD) w = MAD_W; else if (mood === M_COOL) w = 3;
      }
      // 쓰다듬는 동안 — 부위마다 다른 몸짓을 몫(ZM)만큼 섞는다. 눈은 앞을 본다.
      //   이마: 손 쪽으로 기대고 턱은 당긴 채 머리를 손에 밀어 올린다(예전 쓰다듬기).
      //   턱·볼: 턱을 들고, 손 쪽으로 기울고 기대며 얼굴을 조금 돌려 그쪽 볼을 손가락에 비빈다. 손이 움직이는 쪽으로 볼을 밀며
      //     따라간다(손 자리만 따르면 머리가 굳어 «비비기» 가 없었다).
      //   몸(등·엉덩이·그 밖): 머리는 조금만 — 몸 쪽 반응은 아래 엉덩이·등·꼬리 스프링이 한다
      const kh = ZM[0], kc = ZM[1], kb = 1 - kh - kc;
      yT = yT * (1 - c) + c * (strokeDir * (0.18 * kh + 0.08 * kb + 0.08 * kc) - chinSide * CHIN_YAW * kc);
      pT = pT * (1 - c) + c * (HEAD_PITCH * kh + CHIN_PITCH * kc);
      rT = rT * (1 - c) + c * (strokeDir * (0.025 * kh + 0.01 * kb + 0.012 * kc) + chinSide * CHIN_ROLL * kc);
      let leanT = c * (strokeDir * (LEAN_PX * (kh + 0.4 * kb) + 4 * kc) + chinSide * CHIN_LEAN * kc);
      // 눈인사 — 천천히 감는 만큼 고개를 살짝 숙인다(턱을 당기고 조금 내린다)
      pT += GREET_DIP * gk;
      let liftT = c * (LIFT_PET * kh + CHIN_LIFT * kc + BODY_LIFT * kb) - GREET_LIFT * gk;
      // 화나면 손에서 머리를 빼며 뒤로 살짝 움츠린다 — 그냥 «다른 데를 봄» 과 갈라 보이게
      if (ak > 0 && !settling) { leanT += away * MAD_LEAN * ak; liftT -= MAD_DUCK * ak; }
      gxT *= 1 - c; gyT *= 1 - c;
      spring(YAW, yT, w, mood === M_MAD && !settling ? MAD_Z : 1, dt);
      if (pendKick) { if (!settling) S[YAW + 1] += pendKick; pendKick = 0; }
      spring(PITCH, pT, w, 1, dt);
      spring(ROLL, rT, settling ? 10 : 3, 1, dt);
      spring(LEAN, leanT, settling ? 10 : mood === M_MAD ? 8 : 4, 1, dt);
      spring(LIFT, liftT, 10, 0.55, dt);
      spring(GX, gxT, 20, 0.9, dt);
      spring(GY, gyT, 20, 0.9, dt);
      // 귀: 쓰다듬으면 옆으로 조금 눕고, 만지면 그 귀만 잠깐 옆·뒤로 젖힌다(눕힘이 빨라야 젖힌 게 보인다).
      // 기분: 경고엔 옆으로(비행기 귀), 화나면 젖혀 눕힌다. 친밀도가 높으면 쉴 때도 조금 옆으로(느긋 — 0.9 에서 2°),
      // 낮으면 조금 세운다(경계). 기본 친밀도에선 예전 그대로 0
      // 경고 → 화남으로 넘어가는 1초 남짓은 두 몫(wk 가 0.9초에 걸쳐 줄고 ak 가 0.15초에 오른다)이 겹친다 — 더하면 눕힘 목표가 0.27 로
      // 한계에 붙고 귀가 시험한 자세(화남 0.3·0.15)보다 넓게 늘었다. 같은 쪽 몸짓이라 큰 쪽만 쓴다.
      // 회색 고양이도 바뀐다(의도) — 진짜 커서로 화나게 하면 눕힘 최고 0.21 → 0.15, 왼귀 최고 0.47 → 0.31~0.36rad
      const er0 = settling ? 0 : (aff - AFF_DEF) * 0.06 * (1 - wk) * (1 - ak);
      const em = Math.max(AIR_ROT * wk, MAD_ROT * ak) + er0, ef = Math.max(AIR_FLAT * wk, MAD_FLAT * ak);
      const eTL = EAR_RELAX * c + EAR_BACK * ebL + em, eTR = EAR_RELAX * c + EAR_BACK * ebR + em;
      spring(EARL, eTL, EAR_W, EAR_Z, dt);
      spring(EARR, eTR, EAR_W, EAR_Z, dt);
      spring(FLAT, 0.05 * c + EAR_BACK_FLAT * ebL + ef, 12, 1, dt);
      spring(FLATR, 0.05 * c + EAR_BACK_FLAT * ebR + ef, 12, 1, dt);
      // 엉덩이 들기는 긁는 순간 곧 오르는 반사 — content 가 1/3 만 차도 다 오르고(0.4초 남짓 스프링), 쓸기가 꼬리 밑동 쪽(오른쪽)으로 갈 때
      // 1px 더 밀어 올린다(손에 맞춰). 천천히(2.9초) 오르던 때는 움직임을 알아채기 어려웠다
      // 엉덩이 들림 장을 끈 고양이(rump.lift null)는 부위 반응(덜 감기·꼬리 끝)만 — 스프링을 돌리지 않는다
      spring(RUMP, rumpLiftOn ? ZM[3] * Math.min(1, 3 * c) * (RUMP_PX + Math.max(0, strokeDir)) : 0, 7, 0.85, dt);
      // 등 — 손 밑에서만 오르는 혹이 손을 따라간다(등 범위 안에서). 경고에 들면 거둔다(피부 떨림과 겹치지 않게)
      if (petting && zone === 5) bumpX += (clamp(cwx, ripX0, ripX1) - bumpX) * Math.min(1, dt * 20);   // 등 위에서만 — 손을 떼며 지나가는 길은 안 따른다
      spring(BACKR, mood <= M_CONTENT ? BACK_PX * c * ZM[2] : 0, 6, 1, dt);
      // 꼬리 끝 — 엉덩이를 긁으면 조금 든다. 탁 칠 땐 들기(느긋) → 내리치기(빠르게, 조금 넘쳐) → 제자리. 꼬리를 끈 고양이는 0
      let tbT = tailOn ? TAIL_LIFT * c * ZM[3] : 0, tbW = TAIL_W, tbZ = TAIL_Z;
      if (thumpT >= 0) {
        const s = now - thumpT;
        if (s < THUMP_UP) { tbT = TAIL_THUMP; tbW = 14; tbZ = 1; }
        else if (s < THUMP_UP + THUMP_DN) { tbT = THUMP_LOW; tbW = 26; tbZ = 0.45; }
        else thumpT = -1;
      }
      spring(TAILB, tbT, tbW, tbZ, dt);
      // 누르기 — 귀면 그 귀를 만진 것, 꼬리면 꼬리 끝을 툭, 그 밖의 고양이 위면 귀 털기 + 고개 들기.
      // 외면하는 동안엔 몸을 눌러도 귀를 털고 고개를 손 반대쪽으로 다시 돌린다. 쉬는 자세로 돌아가는 중(settle)엔 받지 않는다 —
      // 스프링에 속도만 주고 루프가 멈춰 어긋난 자세로 섰다
      if (!settling) {
        if (pokeZ === 3 || pokeZ === 4) earTouch(pokeZ - 3, now, true);
        else if (pokeZ === 8) { pendFlick = Math.max(pendFlick, TAIL_FLICK); irk += 0.04; if (mood >= M_MAD) snubHead(now, pokeX); if (debug) st.pokes++; }
        else if (pokeZ) { if (mood >= M_MAD) snub(now, pokeX); else poke(pokeX); }
        // 귀 위를 문질렀다 — 한 번 반응한 뒤 0.7초는 다시 안 친다(파르르 떨기만 되풀이하지 않게)
        if (rubL > EAR_RUB * kM && now - earTL > 0.7) earTouch(0, now, false);
        if (rubR > EAR_RUB * kM && now - earTR > 0.7) earTouch(1, now, false);
      }
      // 이번 tick 에 건 꼬리 털기·탁 — 스프링을 이번 dt 만큼 돌린 뒤라 첫 장이 정점 근처로 건너뛰지 않는다.
      // 꼬리를 끈 고양이는 «그만» 을 귀로 대신한다(거는 곳이 여럿이라 한 곳에서): 털기는 두 귀를 작게 파르르, 탁은 두 귀를 세게
      // 털고 등 피부를 떤다. 그냥 버렸을 땐 경고가 쉬는 모습과 거의 같아, 다음 단계인 홱 돌림이 느닷없이 왔다
      if (pendFlick > 0) {
        if (!settling) { if (tailOn) tailFlick(pendFlick); else twitch(2, 4 * pendFlick / TAIL_FLICK); }
        pendFlick = 0;
      }
      if (pendThump) {
        pendThump = false;
        if (!settling) { if (tailOn) thumpT = now; else { twitch(2, rand(7, 9)); if (rippleOn && ripU < 0) rippleAt = now; } }
      }
      if (!settling && now > nextTwitch) {
        nextTwitch = now + rand(4, 12);
        const r = Math.random(), which = r < 0.45 ? 0 : r < 0.9 ? 1 : 2, deg = rand(4, 7) * (Math.random() < 0.8 ? 1 : -1);
        twitch(which, deg);
        // 셋에 하나는 곧바로 한 번 더 짧게 — 진짜 귀 털기는 «파르르» 두 번일 때가 많다
        if (Math.random() < 0.35) { tw2T = now + rand(0.08, 0.12); tw2Which = which; tw2Deg = deg * 0.5; }
      }
      if (tw2T >= 0 && now >= tw2T) { tw2T = -1; twitch(tw2Which, tw2Deg); }
      // 지그시 감기는 중간(노려보는 눈처럼 보이는 0.35~0.65)을 빨리 지난다 — 양 끝은 느리게
      // 엉덩이를 긁을 땐 조금 덜(칸 6 — 몫만큼 섞는다. 둘 다 꺼풀 칸에 딱 맞는 값이라 가만히 있으면 칸에 붙는다).
      // 경고엔 content 가 잦아들며 눈을 뜨고, 화나면 가늘게(칸 3). 친밀도가 높으면(0.6~) 쉴 때 꺼풀이 한 칸 내려와
      // 있다(느긋) — 칸 사이에 멈추면 꺼풀 끝이 두 겹이라 0 아니면 한 칸으로만, 바뀔 땐 1초 남짓에 걸쳐
      const rl = settling || aff < 0.6 ? 0 : 0.125 * (1 - wk) * (1 - ak);
      restLid += (rl - restLid) * Math.min(1, dt * 1.5);
      if (Math.abs(rl - restLid) < 0.001) restLid = rl;
      lid = Math.max(lb, c * c * (3 - 2 * c) * (LID_CONTENT + (LID_HALF - LID_CONTENT) * ZM[3]), LID_MAD * ak, restLid);
      // 숨 — 길이는 숨이 바뀔 때(바닥에서 쉬는 끝)만 새로 정한다. 깊이의 쓰다듬기 몫은 content 를 따라 매끄럽게
      breathPh += dt / breathPer;
      if (breathPh >= 1) { breathPh -= 1; nextBreath(now, c); }
      const bk = breathCurve(breathPh);
      bDepth = breathAmp * (1 + PET_DEEP * c * (breathSigh > 0 ? SIGH_PET : 1));
      breath = bDepth * bk;
      sigh = breathSigh * bk;
      if (settling) { const k = Math.max(0, 1 - (now - settleT0) / settleDur); breath *= k; sigh *= k; }
      // 그르렁 — 만족(지그시 눈을 감을 즈음, 친밀도만큼 늦게) 동안. 쓰다듬기가 그치고 0.8초 뒤(petting 이 꺼지며)
      // 잦아든다. 경고에 들면 천천히 잦아든다(뚝 끊기면 소리를 끈 것처럼 들린다)
      if (purr) {
        if (sound && mood === M_CONTENT) {
          if (debug && !purr.on) { const a = win.performance.now(); purr.start(1); st.purrMs = Math.max(st.purrMs, win.performance.now() - a); } else purr.start(1);
          purr.kick(now);
        }
        else if (purr.on) purr.stop(mood === M_WARN ? 0.6 : 0.25);
        // 숨을 따라 크기를 바꾼다 — 단계가 바뀔 때만(숨 한 번에 세 번)
        const pk = purr.on ? breathStage() : -1;
        if (pk !== purrK) { purrK = pk; if (pk >= 0) purr.breathe(pk); }
      }
      // 얼마나 자주 그릴까 — 2: 60fps (빠른 깜박임·귀 털기 첫 순간·누르면 고개 들기), 1: 30fps (쓰다듬는 동안·느린 깜박임·
      // 커서 따라보기·눈 다시 뜨기·귀가 가라앉는 꼬리), 0: 10~20fps (숨쉬기 — 숨 빠르기를 따라), 20fps (혼자 두리번).
      // 쓰다듬기를 시작하고 그칠 때 머리가 오르내리는 건 초당 2~4px 라 30fps 면 한 장에 0.15px — 60fps 몫이 아니다
      // (전에는 손을 뗀 뒤 2초를 이 «뒤처짐» 때문에 60fps 로 돌았다)
      const earV = Math.abs(S[EARL + 1]) + Math.abs(S[EARR + 1]);
      const earE = earV + Math.abs(S[EARL] - eTL) + Math.abs(S[EARR] - eTR) + Math.abs(S[FLAT + 1]) + Math.abs(S[FLATR + 1]);
      // 30fps 는 화면에서 보이게 움직일 때만 — 한 귀 끝(≈120px)·부위(꼬리는 끝에서)가 초당 10px 넘게 갈 때. 귀 «속도 합 0.01» 을
      // 문턱으로 두었을 땐 화남이 2.5초 시정수로 풀리는 동안(귀 끝 초당 5px — 한 장에 0.17px) 30fps 가 8초 돌았다
      // (텍스처 px 어림 — 귀 끝·꼬리 끝 거리는 CW 에 고양이 크기로 들어 있다. 꼬리를 끈 고양이는 꼬리 몫이 0)
      const earPx = Math.max(Math.abs(S[EARL + 1]) + Math.abs(S[FLAT + 1]), Math.abs(S[EARR + 1]) + Math.abs(S[FLATR + 1])) * CW[6];
      const zoneV = (Math.abs(S[RUMP + 1]) + Math.abs(S[BACKR + 1])) * kM + Math.abs(S[TAILB + 1]) * CW[17];
      // 60fps: 꼬리 털기 첫 순간·탁 내리치기, 등 피부 떨림(0.8초), 고개를 홱 돌리는 순간. 화남이 천천히 풀리는 동안(꺼풀·귀)은 20fps.
      // 외면하는 동안엔 커서가 움직여도 따라보지 않으니 따라보기 빠르기로 올리지 않는다(돌아앉는 동안만 30fps)
      paceBreath = false;
      if ((blinkT0 >= 0 && blinkDur < 0.5) || earV > 0.6 || zoneV > 40 || ripU >= 0 || (thumpT >= 0 && now - thumpT > THUMP_UP - 0.04) || (mood === M_MAD && Math.abs(S[YAW + 1]) > 0.8) || Math.abs(S[LIFT + 1]) * kM > 8 || Math.abs(S[LIFT] - liftT) * kM > 0.6) return 2;
      if (settling) {
        // 다 돌아갔으면 숨도 멈춰 있다 — 그릴 게 없다. 숨 빠르기로 고른 짧은 간격이 남아 헛 tick 이 돌지 않게
        idleIv = IDLE_MS;
        return now - settleT0 < settleDur + 0.3 ? 1 : 0;
      }
      if (blinkT0 >= 0 || earPx > 10 || zoneV > 10 || tw2T >= 0 || petting || Math.abs(S[YAW + 1]) > 0.6 || (c > 0.01 && c < 0.99) || (now - lastMoveT < ACTIVE_AFTER_MOVE && ak < 0.5)) return 1;
      if (Math.abs(S[YAW + 1]) + Math.abs(S[PITCH + 1]) > 0.3 || earE > 0.01 || zoneV > 0.3 || (ak > 0 && ak < 0.999) || restLid !== rl) idleIv = DRIFT_MS;
      // 숨만 쉰다: 간격은 그린 뒤 tick 에서 앞을 내다보고 고른다(breathIv). 바닥 쉼·꼭대기에선 100ms 에 안 그리고,
      // 가장 빠른 곳에서도 20fps 를 넘지 않는다
      else paceBreath = true;
      return 0;
    }

    // 붙든 값이 있으면 그것 (NaN 이면 안 붙들었다)
    function hv(k, v) { return Number.isNaN(H[k]) ? v : H[k]; }
    // 이번 자세를 C 에 (붙들기 반영, 한계로 묶기). 스프링·붙든 값의 px 는 회색 고양이 크기 — 여기서 rig.json scale(kM)을 곱한다
    function pose() {
      const yaw = clamp(hv(HY, S[YAW]), -1, 1), pitch = clamp(hv(HP, S[PITCH]), -1, 1);
      C[0] = clamp(hv(HR, S[ROLL]), -ROLL_MAX, ROLL_MAX);
      C[1] = (clamp(hv(HLEAN, S[LEAN]), -LEAN_PX, LEAN_PX) + yaw * YAW_RIGID) * kM;
      C[2] = (-clamp(hv(HLIFT, S[LIFT]), -4, 8) + pitch * PITCH_RIGID) * kM;
      // 숨은 머리까지 셰이더 한 곳에서 (머리는 몸 들림의 앞쪽 몫만큼 통째로 따라 오른다)
      C[3] = yaw * YAW_PX * kM; C[4] = pitch * PITCH_PX * kM; C[5] = hv(HBR, breath); C[12] = hv(HSI, sigh);
      // 귀는 부드러운 한계로 (붙든 값은 시험용이라 그대로 자른다)
      C[6] = -(Number.isNaN(H[HEL]) ? soft2(S[EARL], EAR_IN, EAR_MAX) : clamp(H[HEL], -EAR_IN, EAR_MAX));   // 왼귀는 바깥이 시계 반대 방향
      C[7] = Number.isNaN(H[HER]) ? soft2(S[EARR], EAR_IN, EAR_MAX) : clamp(H[HER], -EAR_IN, EAR_MAX);
      // 귀 눕힘 (왼, 오른) — 쓰다듬기 0.05, 만졌을 때 젖힘 0.07, 경고 0.12, 화남 0.15 (+ 젖힘) 까지, 한계는 고양이마다(ears.flatMax).
      // 붙든 flat 은 두 귀에, flatR 은 오른귀만
      C[8] = clamp(hv(HFL, S[FLAT]), 0, FLAT_LIM);
      C[13] = clamp(hv(HFR, hv(HFL, S[FLATR])), 0, FLAT_LIM);
      // 부위 반응 — 엉덩이 들림·손 밑 등 혹(px), 꼬리 굽힘·끝 말기(rad — 고양이 꼬리 배율은 draw 에서). 한계는 사진이 버티는 만큼
      // (debug.fold 로 잰다). 끈 부위는 붙든 값도 0 — 그 장이 없으니 그리면 엉뚱한 곳(숨 장)이 움직인다
      C[14] = rumpLiftOn ? clamp(hv(HRU, S[RUMP]), -1, 7) * kM : 0;
      C[15] = backBump ? clamp(hv(HBK, S[BACKR]), -1, 4) * kM : 0;
      C[16] = clamp(hv(HTA, S[TAILA]), -0.012, 0.012);
      C[17] = clamp(hv(HTB, S[TAILB]), -0.012, 0.04);
      // 등 피부 떨림 — 가운데 x, 높이(px), 위상(rad). 손 밑 등 혹 — 가운데 x (높이는 C[15])
      C[18] = hv(HRX, ripX);
      C[19] = rippleOn ? clamp(hv(HRA, ripA), 0, 3) * kM : 0;
      C[20] = hv(HRP, ripPh);
      C[21] = hv(HBX, bumpX);
      // 눈동자는 꺼풀과 상관없이 시선만큼 — 꺼풀이 제자리에 얹히는 층이라 감는 동안 눈동자를 거둘 까닭이 없다
      C[9] = clamp(hv(HGX, S[GX]), -1, 1) * GAZE_X * kM;
      C[10] = clamp(hv(HGY, S[GY]), -1, 1) * GAZE_Y * kM;
      C[11] = clamp(hv(HLID, lid), 0, 1);
    }
    // 눈에 띄게 바뀌었나 — 자리마다 텍스처 px 어림(CW, 위 상태 묶음)을 곱해 문턱과 견준다
    function changed() {
      let m = 0;
      for (let i = 0; i < 20; i++) { const d = Math.abs(C[i] - L[i]) * CW[i]; if (d > m) m = d; }
      const ra = Math.max(C[19], L[19]), ba = Math.max(Math.abs(C[15]), Math.abs(L[15]));
      const d = ra * (Math.abs(C[18] - L[18]) * 0.6 / (RIPPLE_W * kM) + Math.abs(C[20] - L[20])) + ba * Math.abs(C[21] - L[21]) * 0.6 / (BACK_W * kM);
      if (d > m) m = d;
      return m > (paceBreath ? epsTex * EPS_BREATH : epsTex);
    }

    function draw(prog) {
      const p = prog || P;
      const u = p.u;
      gl.uniform4f(u.uHead, C[0], C[1], C[2], 0);
      gl.uniform4f(u.uPar, C[3], C[4], C[5], C[12]);
      gl.uniform4f(u.uEar, C[6], C[7], C[8], C[13]);
      // 꼬리 각도 × 고양이 꼬리 배율(끝 px 를 회색 꼬리와 맞춘 몫, 위쪽 부호 포함 — 꼬리를 끄면 0)
      gl.uniform4f(u.uZone, C[14], C[15], C[16] * TG_B, C[17] * TG_C);
      gl.uniform4f(u.uMood, C[18], C[19], C[20], C[21]);
      if (p === P) {
        gl.uniform4f(u.uGaze, C[9], C[10], MID_X, 0);
        const lv = C[11];
        const T = rig.lids.tiles, nT = T.length;
        let k = lv * nT;
        // 가만히 있는 꺼풀은 칸에 붙인다 — 두 칸을 섞은 채 멈추면 꺼풀 끝이 두 겹으로 비친다
        if (blinkT0 < 0) { const r = Math.round(k); if (Math.abs(k - r) < 0.12) k = r; }
        if (k > 0.001) {
          // 꺼풀: k 가 놓인 1/8 칸의 양 끝 두 장을 섞는다 (0 칸은 빈 층)
          let i = Math.floor(k), f = k - i;
          if (i >= nT) { i = nT - 1; f = 1; }
          const a = i > 0 ? T[i - 1] : T[0], b = T[i];
          // 반사 거둠 — lids.dimCatch [a, b] 사이에서 0 → 1 (없으면 0: 반사는 꺼풀과 상관없다)
          const dc = DC_A < DC_B ? clamp((lv - DC_A) / (DC_B - DC_A), 0, 1) : 0;
          gl.uniform4f(u.uLid, f, i > 0 ? 0 : 1, 1, dc * dc * (3 - 2 * dc));
          gl.uniform4f(u.uTile, a[0], a[1], b[0], b[1]);
        } else {
          gl.uniform4f(u.uLid, 0, 1, 0, 0);
        }
      }
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawElements(gl.TRIANGLES, nIdx, gl.UNSIGNED_SHORT, 0);
      if (!prog) L.set(C);
    }
    function drawFold() {
      // 시험용(debug.foldShow) — 늘어남을 색으로
      gl.useProgram(Pfold.pr);
      gl.uniform4f(Pfold.u.uRest, -(W.w / bw) * (W.h / bh), 1, 0, 0);
      gl.disable(gl.BLEND);
      draw(Pfold);
      gl.enable(gl.BLEND);
      gl.useProgram(P.pr);
    }

    // ── WebGL 준비 (한 번) ──
    function compile(type, srcText) {
      const s = gl.createShader(type);
      gl.shaderSource(s, srcText);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('셰이더: ' + gl.getShaderInfoLog(s));
      return s;
    }
    function program(fsText, vsText) {
      const pr = gl.createProgram();
      gl.attachShader(pr, compile(gl.VERTEX_SHADER, vsText || VSk));
      gl.attachShader(pr, compile(gl.FRAGMENT_SHADER, fsText));
      gl.bindAttribLocation(pr, 0, 'aP');
      gl.linkProgram(pr);
      if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error('셰이더 잇기: ' + gl.getProgramInfoLog(pr));
      const u = {};
      const n = gl.getProgramParameter(pr, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) { const a = gl.getActiveUniform(pr, i); u[a.name] = gl.getUniformLocation(pr, a.name); }
      const out = { pr, u };
      gl.useProgram(pr);
      setStatic(out);
      return out;
    }
    function foldProgram() {
      if (isGL2) return program(es3(FS_FOLD, true), es3(VSk, false));
      if (!gl.getExtension('OES_standard_derivatives')) return null;
      return program(FS_FOLD);
    }
    function setStatic(p) {
      const u = p.u, R = rig;
      const set4 = (k, a, b, c, d) => { if (u[k]) gl.uniform4f(u[k], a, b, c, d); };
      set4('uView', 2 / W.w, -2 / W.h, -1 - (W.x0 * 2) / W.w, 1 + (W.y0 * 2) / W.h);
      const hd = R.head, k = kM;
      // 머리 통째 움직임이 미치는 장 — head.weight 가 있으면 그것(머리 타원과 따로: 몸이 머리 왼쪽·같은 높이에도 있는 고양이),
      // 없으면 예전 띠(몸이 머리 오른쪽·아래). 안 준 쪽은 먼 자리 — smoothstep 이 딱 1 이라 곱해도 그대로다
      const hw = hd.weight;
      let hx = [-FAR, 1 - FAR, FAR, FAR + 1], hy = [FAR, FAR + 1], hr = [FAR, FAR + 1], he = null;
      if (hw) {
        if (hw.x && hw.x.length >= 4) hx = hw.x;
        else if (hw.x && hw.x.length >= 2) hx = [-FAR, 1 - FAR, hw.x[0], hw.x[1]];
        if (hw.y && hw.y.length >= 2) hy = hw.y;
        if (hw.ellipse) { he = hw.ellipse; const f = he.falloff || [1, 1.5]; hr = [f[0] * f[0], f[1] * f[1]]; }
      } else {
        hx = [-FAR, 1 - FAR, hd.center[0] + hd.rx * 0.9, hd.center[0] + hd.rx * 1.6];
        hy = [R.chin[1] - 12 * k, R.neck[1] + 30 * k];
      }
      set4('uHW', hx[2], hx[3], hy[0], hy[1]);
      set4('uHL', hx[0], hx[1], hr[0], hr[1]);
      set4('uHE', he ? he.center[0] : 0, he ? he.center[1] : 0, he ? 1 / he.rx : 0, he ? 1 / he.ry : 0);
      set4('uPiv', R.neck[0], R.chin[1] + 25 * k, 0, 0);
      set4('uFace', hd.faceCenter[0], hd.faceCenter[1], 1 / (hd.rx * 0.88), 1 / (hd.ry * 0.9));
      const sg = hd.radius * 0.24;
      set4('uNose', R.nose.center[0], R.nose.center[1], 1 / (2 * sg * sg), 0.55);
      const ear = (e, k1, k2) => {
        const dx = e.tip[0] - e.base[0], dy = e.tip[1] - e.base[1], len = Math.sqrt(dx * dx + dy * dy);
        const hw = Math.hypot(e.baseInner[0] - e.baseOuter[0], e.baseInner[1] - e.baseOuter[1]) / 2;
        set4(k1, e.base[0], e.base[1], dx / len, dy / len);
        set4(k2, len, hw, 0, 0);
      };
      ear(R.ears.left, 'uEL', 'uELs');
      ear(R.ears.right, 'uER', 'uERs');
      // 숨 자리 — rig.json 에 없거나 일부만 있으면(옛 굽기) 빠진 항목은 기본값으로(breathCfg). 하나만 빠져도 예외로
      // 정지 그림에 물러나거나, 통째로 없으면 숨(머리 따라 오르기까지)이 멈췄다. 끈 항목은 미는 몫 0 — 들림을 끄면 y 띠를 먼 자리로(hy = 0)
      const B = Bc, lf = B.lift, sh = B.shoulder;
      if (lf) {
        set4('uBl', lf.y[0], lf.y[1], B.liftPx, B.sighPx);
        set4('uBx', lf.x[0], lf.x[1], lf.x[2], lf.x[3]);
        set4('uBw', lf.keep[0], lf.keep[1], 0, 0);
      } else {
        set4('uBl', -FAR, 1 - FAR, 0, 0);
        set4('uBx', 0, 1, 2, 3);
        set4('uBw', 0, 0, 0, 0);
      }
      // 한숨 어깨 띠 — 2값이면 왼쪽 끝은 먼 자리(예전 «x0 까지 다»), 4값이면 양쪽에서 줄어든다. 끄면 몫(sighPx)이 0 이라 띠는 아무래도 된다
      const sb = !sh ? [-FAR, 1 - FAR, 0, 1] : sh.length >= 4 ? sh : [-FAR, 1 - FAR, sh[0], sh[1]];
      set4('uBs', sb[0], sb[1], sb[2], sb[3]);
      const ell = (key, e) => (e ? set4(key, e.center[0], e.center[1], 1 / e.rx, 1 / e.ry) : set4(key, 0, 0, 1, 1));
      ell('uBf', B.ribs); ell('uBc', B.chest); ell('uBg', B.ribs2);
      set4('uBd', B.ribsPush[0], B.ribsPush[1], B.chestPush[0], B.chestPush[1]);
      set4('uBe', B.head, B.ribs2Push[0], B.ribs2Push[1], 0);
      // 부위 반응 자리 — 꼬리 축·반폭·사라지는 폭·끝 말기 축, 앞발 붙듦, 엉덩이 들림 장, 등 혹·피부 떨림 장.
      // 끈 부위는 장을 먼 자리로 둔다(움직임 몫도 0 — 꼬리 배율 TG_B·TG_C, 엉덩이 들림 C[14])
      const tl = Zc.tail, rp = Zc.rump, rl = rp && rp.lift, rq = Zc.ripple;
      if (tl) {
        const tdx = tl.tip[0] - tl.base[0], tdy = tl.tip[1] - tl.base[1], tlen = Math.hypot(tdx, tdy);
        set4('uTl', tl.base[0], tl.base[1], tdx / tlen, tdy / tlen);
        set4('uTs', tlen, tl.halfWidth[0], tl.fade, tl.curl);
      } else {
        set4('uTl', 0, 0, 1, 0);
        set4('uTs', 1, 1, 1, 0.5);
      }
      const hold = tl && tl.hold ? tl.hold : [-FAR, 1 - FAR];
      const lx = rl ? rl.x : [FAR, FAR + 1], ly = rl ? rl.y : [0, 1];
      set4('uTh', hold[0], hold[1], ly[0], ly[1]);
      // 등 혹·피부 떨림이 아래로 사라지는 띠 — 피부 떨림을 끄면 띠도 없다(등 혹은 아래로 안 사라진다)
      set4('uRl', lx[0], lx[1], rq ? rq.y : FAR, rq ? (rq.fade != null ? rq.fade : 190 * k) : 1);
      set4('uRm', lx.length >= 4 ? lx[2] : FAR, lx.length >= 4 ? lx[3] : FAR + 1, tl && tl.upSign < 0 ? -1 : 1, tl && tl.below > 0 ? tl.below : FAR);
      // 등 혹·피부 떨림의 제 장 (back.weight·ripple.weight) — 없으면 켬 0: 숨 들림 장 그대로
      const wgt = (w, kx, ky) => {
        const x = !w || !w.x ? [-FAR, 1 - FAR, FAR, FAR + 1] : w.x.length >= 4 ? w.x : [w.x[0], w.x[1], FAR, FAR + 1];
        const y = w && w.y && w.y.length >= 2 ? w.y : [-FAR, 1 - FAR];
        set4(kx, x[0], x[1], x[2], x[3]);
        set4(ky, y[0], y[1], w ? 1 : 0, 0);
      };
      wgt(Zc.back && Zc.back.weight, 'uKx', 'uKy');
      wgt(rq && rq.weight, 'uQx', 'uQy');
      const eL = R.eyes.left, eR = R.eyes.right;
      set4('uInv', 1 / R.size.w, 1 / R.size.h, eL.mask.feather / Math.min(eL.mask.rx, eL.mask.ry), eR.mask.feather / Math.min(eR.mask.rx, eR.mask.ry));
      const el_ = (k, e) => set4(k, e.center[0], e.center[1], 1 / e.rx, 1 / e.ry);
      el_('uIrL', eL.irisMask); el_('uIrR', eR.irisMask);
      el_('uMkL', eL.mask); el_('uMkR', eR.mask);
      const aL = eL.mask.angle * Math.PI / 180, aR = eR.mask.angle * Math.PI / 180;
      set4('uRot', Math.cos(aL), Math.sin(aL), Math.cos(aR), Math.sin(aR));
      const lids = R.lids;
      set4('uAtl', lids.origin[0], lids.origin[1], 1 / lids.atlas[0], 1 / lids.atlas[1]);
      // 반사 상자 — rig.json 에 없으면(옛 굽기) 상자를 비워 둔다
      const hl = (e, kb, ko) => {
        const c = e.catch;
        if (!c || !c.box) { set4(kb, -9, -9, -1, -1); set4(ko, 0, 0, 0, 0); return; }
        const b = c.box;
        set4(kb, b[0], b[1], b[2], b[3]);
        set4(ko, c.bg[0] - b[0], c.bg[1] - b[1], c.exc[0] - b[0], c.exc[1] - b[1]);
      };
      hl(eL, 'uHbL', 'uHoL'); hl(eR, 'uHbR', 'uHoR');
      if (u.uBase) gl.uniform1i(u.uBase, 0);
      if (u.uEyes) gl.uniform1i(u.uEyes, 1);
    }
    function texture(unit, img, maxLevel) {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      // 알파를 곱해서 올린다 — 투명한 가장자리를 선형 보간해도 검은 테가 안 생긴다
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (isGL2) {
        // 밉맵 — 한 번만 만든다(프레임마다 비용 없음, GPU 메모리 +1/3). 아틀라스는 칸 사이 틈이 4px 라 1단까지만
        if (maxLevel != null) gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, maxLevel);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      } else {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      }
    }
    function mesh() {
      // 고른 격자. 완전히 투명한 칸(rig.json grid.cells)은 삼각형을 안 만든다 — 그려봐야 빈칸이다
      const G = rig.grid, cols = G.cols, rows = G.rows, sw = rig.size.w, sh = rig.size.h;
      const v = new Float32Array((cols + 1) * (rows + 1) * 2);
      for (let j = 0, o = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) { v[o++] = i * sw / cols; v[o++] = j * sh / rows; }
      const idx = [];
      for (let j = 0; j < rows; j++) {
        const row = G.cells[j];
        for (let i = 0; i < cols; i++) {
          if (!((parseInt(row[i >> 2], 16) >> (3 - (i & 3))) & 1)) continue;
          const a = j * (cols + 1) + i, b = a + 1, c = a + cols + 1, d = c + 1;
          idx.push(a, c, b, b, c, d);
        }
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, v, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
      nIdx = idx.length;
    }

    function initGL(imgBase, imgEyes) {
      canvas = doc.createElement('canvas');
      canvas.setAttribute('aria-hidden', 'true');
      const o = {
        alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
        preserveDrawingBuffer: false, powerPreference: 'low-power', failIfMajorPerformanceCaveat: true
      };
      // WebGL2 가 되면 밉맵을 쓸 수 있다(NPOT 텍스처). 셰이더는 GLSL 100 그대로 돈다
      gl = opts.webgl1 ? null : canvas.getContext('webgl2', o);
      isGL2 = !!gl;
      if (!gl) gl = canvas.getContext('webgl', o);
      if (!gl) { canvas = null; return false; }
      el = canvas;
      el.style.position = 'absolute';
      el.style.display = 'block';
      flip(el);
      if (opts.className) el.className = opts.className;
      mesh();
      texture(0, imgBase);
      texture(1, imgEyes, 1);
      P = program(FS);
      gl.disable(gl.DEPTH_TEST);
      gl.clearColor(0, 0, 0, 0);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);   // 곱한 알파
      const baseSrc = imgBase.src;   // 디코딩된 그림(수 MB)을 붙잡아 두지 않게 주소만 남긴다
      canvas.addEventListener('webglcontextlost', (e) => {
        // GPU 가 재설정되면 — 가만히 있는 사진으로 물러난다 (휴식 창은 길어야 몇 분)
        e.preventDefault();
        if (dead) return;
        stopLoop();
        running = false;
        unlisten();
        endSession(); petting = false;
        dropIdle();               // 첫 그림 뒤 소리 장치를 열려고 기다리던 것도 — 정지 그림은 그르렁대지 않는다
        if (purr) purr.close();
        canvas.remove();
        canvas = null; gl = null;
        toImage(baseSrc, true);   // 바로 보이게 — 0.6초 페이드를 다시 돌면 고양이가 깜박 사라졌다 나타났다
      });
      return true;
    }

    // 거울(display.mirror) — 그림 요소를 제자리에서 좌우로 뒤집는다. transform 이 아니라 scale 속성이라 className 이 거는
    // transform(들어오는 움직임)을 덮어쓰지 않고 그 위에 겹친다. 캔버스와 정지 그림이 같은 상자째 뒤집혀 바꿔 끼워도 튀지 않는다
    function flip(e) { if (mirror) e.style.scale = '-1 1'; }
    function toImage(src, instant) {
      // 정지 그림: 세계 상자(overflow 숨김) 안에 텍스처를 쉬는 자세 자리에 놓는다
      const box = doc.createElement('div');
      box.setAttribute('aria-hidden', 'true');
      box.style.position = 'absolute';
      box.style.overflow = 'hidden';
      flip(box);
      if (opts.className) box.className = opts.className;
      const im = doc.createElement('img');
      im.alt = '';
      im.decoding = 'async';
      im.draggable = false;
      im.style.position = 'absolute';
      im.style.maxWidth = 'none';
      im.src = src;
      box.append(im);
      el = box;
      mode = 'image';
      if (instant) { box.style.transition = 'none'; box.classList.add('in'); }
      fit();
      host.append(el);
      if (!instant) win.requestAnimationFrame(() => { if (!dead && el) el.classList.add('in'); });
    }

    // 부위 판정에 쓸 숫자를 한 번 풀어 둔다 — 메시 칸 채움, 턱 경계, 귀·등·엉덩이·꼬리 모양 (ZG 자리는 zoneAt 이 읽는 순서).
    // 끈 부위는 비워 둔다(zoneAt 이 chinOn·backOn·rumpOn·tailOn 으로 건너뛴다)
    function zonesSetup(img) {
      const G = rig.grid;
      gCols = G.cols; gRows = G.rows; gSX = gCols / rig.size.w; gSY = gRows / rig.size.h;
      occ = new Uint8Array(gCols * gRows);
      for (let j = 0; j < gRows; j++) for (let i = 0; i < gCols; i++) occ[j * gCols + i] = (parseInt(G.cells[j][i >> 2], 16) >> (3 - (i & 3))) & 1;
      const ch = Zc.chin, er = Zc.ear, bk = Zc.back, rp = Zc.rump, tl = Zc.tail;
      if (ch) { ZG[0] = ch.x; ZG[1] = ch.y; ZG[2] = ch.k; ZG[3] = ch.min; }
      ZG[4] = er.t[0]; ZG[5] = er.t[1]; ZG[6] = er.pad;
      const ear = (o, e) => {
        const dx = e.tip[0] - e.base[0], dy = e.tip[1] - e.base[1], len = Math.hypot(dx, dy);
        ZG[o] = e.base[0]; ZG[o + 1] = e.base[1]; ZG[o + 2] = dx / len; ZG[o + 3] = dy / len; ZG[o + 4] = len;
        ZG[o + 5] = Math.hypot(e.baseInner[0] - e.baseOuter[0], e.baseInner[1] - e.baseOuter[1]) / 2;
      };
      ear(7, rig.ears.left); ear(13, rig.ears.right);
      if (bk) { ZG[19] = bk.center[0]; ZG[20] = bk.center[1]; ZG[21] = 1 / bk.rx; ZG[22] = 1 / bk.ry; }
      if (rp) { ZG[23] = rp.center[0]; ZG[24] = rp.center[1]; ZG[25] = 1 / rp.rx; ZG[26] = 1 / rp.ry; }
      if (tl) {
        const tdx = tl.tip[0] - tl.base[0], tdy = tl.tip[1] - tl.base[1], tlen = Math.hypot(tdx, tdy);
        ZG[27] = tl.base[0]; ZG[28] = tl.base[1]; ZG[29] = tdx / tlen; ZG[30] = tdy / tlen; ZG[31] = tlen;
        ZG[32] = tl.halfWidth[0]; ZG[33] = tl.halfWidth[1]; ZG[34] = tl.upSign < 0 ? -1 : 1;
      }
      // 피부 떨림·등 혹이 놓이는 x 범위 — 어느 쪽부터 적어도 된다. 피부 떨림을 끈 고양이는 등 타원 폭, 그것도 없으면 텍스처 폭
      const rq = Zc.ripple;
      const xr = rq ? rq.x : bk ? [bk.center[0] - bk.rx, bk.center[0] + bk.rx] : [0, rig.size.w];
      ripX0 = Math.min(xr[0], xr[1]); ripX1 = Math.max(xr[0], xr[1]); ripX = bumpX = (ripX0 + ripX1) / 2;
      hitSetup(img);
    }
    // 알파 지도 (zones.hit) — 사진을 4px 칸으로 줄여 그려(한 번, 작은 캔버스) 알파가 문턱을 넘는 칸을 고르고, 손 여유(pad)만큼
    // 둘레로 넓힌다. 줄여 그린 칸 알파는 평균이라 옅은 털끝 칸은 문턱 아래로 빠질 수 있다 — 여유가 그만큼을 덮는다.
    // 캔버스를 못 읽으면(그림이 다른 출처라 막히면) 메시 칸만 쓴다. 지도는 텍스처 방향 그대로(거울은 toWX 가 푼다)
    function hitSetup(img) {
      hitM = null;
      const hz = Zc.hit;
      if (!hz || !img) return;
      const cols = Math.ceil(rig.size.w / HIT_CELL), rows = Math.ceil(rig.size.h / HIT_CELL), n = cols * rows;
      let px_;
      try {
        const cv = doc.createElement('canvas');
        cv.width = cols; cv.height = rows;
        const g = cv.getContext('2d', { willReadFrequently: true });
        g.imageSmoothingQuality = 'high';
        g.drawImage(img, 0, 0, rig.size.w / HIT_CELL, rig.size.h / HIT_CELL);
        px_ = g.getImageData(0, 0, cols, rows).data;
      } catch (err) { if (debug) console.warn('catrig: 알파 지도를 못 만들었다', err); return; }
      const thr = hz.alpha != null ? hz.alpha : 32, r = Math.max(0, Math.round((hz.pad != null ? hz.pad : 6 * kM) / HIT_CELL));
      const m = new Uint8Array(n), t = new Uint8Array(n);
      for (let i = 0; i < n; i++) m[i] = px_[i * 4 + 3] > thr ? 1 : 0;
      // 가로로 넓히고(t), 그것을 세로로 넓힌다(m) — 네모 여유
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          let v = 0;
          for (let d = Math.max(0, i - r), e = Math.min(cols - 1, i + r); d <= e && !v; d++) v = m[j * cols + d];
          t[j * cols + i] = v;
        }
      }
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          let v = 0;
          for (let d = Math.max(0, j - r), e = Math.min(rows - 1, j + r); d <= e && !v; d++) v = t[d * cols + i];
          m[j * cols + i] = v;
        }
      }
      hitM = m; hitCols = cols; hitRows = rows;
    }
    // 고양이마다 다른 것 (rig.json, 한 번) — 움직임 배율, 부위·숨 설정, 켠 부위, 귀 털기 폭, 꼬리 배율, 얼굴 앞 타원, 숨 길이,
    // 그리기 문턱(CW)의 고양이 몫. 회색 고양이(scale 없음·꼬리 = DEF_ZONES.tail)는 셈이 딱 예전 값이 나온다
    function rigSetup() {
      const R = rig;
      kM = R.scale > 0 ? R.scale : 1;
      Zc = zoneCfg(R); Bc = breathCfg(R, kM);
      VSk = vsSrc(kM);
      chinOn = !!Zc.chin; backOn = !!Zc.back; rumpOn = !!Zc.rump; rumpLiftOn = !!(Zc.rump && Zc.rump.lift); tailOn = !!Zc.tail; rippleOn = !!Zc.ripple;
      // 손 밑 등 혹·피부 떨림은 제 장(weight)이 없으면 숨 들림 장을 쓴다 — 들림을 끄면 화면에서 0 이라 같이 끈 것으로 본다
      // (안 그러면 아무것도 안 바뀌는 그림을 60fps 로 다시 그렸다). 등 부위 판정은 남는다 — 손 밑 혹만 없다
      backBump = backOn && !!(Bc.lift || Zc.back.weight);
      if (rippleOn && !Bc.lift && !Zc.ripple.weight) rippleOn = false;
      // 꼬리·귀 길이가 0 이거나 끝 말기가 1 이면 셰이더가 0 으로 나눠 NaN — 고양이가 통째로 사라지는데 mode 는 webgl 이라
      // 앱이 영상으로 물러나지 못한다. 여기서 예외를 내 정지 그림으로 물러나게 한다(start 의 catch)
      const span = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (!(span(R.ears.left.tip, R.ears.left.base) >= 1 && span(R.ears.right.tip, R.ears.right.base) >= 1)) throw new Error('rig.json 귀 길이 0');
      if (Zc.tail && !(span(Zc.tail.tip, Zc.tail.base) >= 1 && Zc.tail.curl >= 0 && Zc.tail.curl < 1)) throw new Error('rig.json 꼬리 길이 0·끝 말기 1');
      const fk = (e) => (e && e.flick != null ? e.flick : 1);
      EAR_KL = fk(R.ears.left); EAR_KR = fk(R.ears.right);
      FLAT_LIM = R.ears.flatMax > 0 ? Math.min(R.ears.flatMax, 0.2) : 0.2;
      const dcr = R.lids && R.lids.dimCatch;
      if (Array.isArray(dcr) && dcr[1] > dcr[0]) { DC_A = dcr[0]; DC_B = dcr[1]; } else { DC_A = 0; DC_B = 0; }
      // 꼬리 — 끝이 회색 꼬리 끝과 같은 px(× scale)만큼 가게 굽힘은 꼬리 길이로, 끝 말기는 말기 축에서 끝까지로 나눈다
      // (짧게 보이는 꼬리도 털기가 보인다). gain 을 주면 그것. 위쪽 부호(upSign)는 각도에 곱한다(셰이더 up 판정은 uRm.z)
      const tl = Zc.tail;
      if (tl) {
        const D = DEF_ZONES.tail, ref = Math.hypot(D.tip[0] - D.base[0], D.tip[1] - D.base[1]), refC = ref * (1 - D.curl);
        const len = Math.hypot(tl.tip[0] - tl.base[0], tl.tip[1] - tl.base[1]), lenC = Math.max(1, len * (1 - tl.curl));
        const g = tl.gain, sg = tl.upSign < 0 ? -1 : 1;
        const gb = g != null ? (Array.isArray(g) ? g[0] : g) : kM * ref / len;
        const gc = g != null ? (Array.isArray(g) ? g[1] : g) : kM * refC / lenC;
        TG_B = gb * sg; TG_C = gc * sg;
        CW[16] = 460 * ((len * Math.abs(gb)) / ref); CW[17] = 230 * ((lenC * Math.abs(gc)) / refC);   // 끝까지 거리 — 꼬리 끝이 가는 px
      } else { TG_B = 0; TG_C = 0; CW[16] = 0; CW[17] = 0; }
      // 문턱의 px 몫 — 갸웃(머리 끝까지 400), 귀 끝(120), 귀 눕힘(100), 꺼풀(30)은 고양이 크기로. 숨은 등선 들림 + 옆구리 옆밀림
      // (회색 0.3px — 미는 크기에 비례), 한숨 어깨 px
      CW[0] = 400 * kM; CW[6] = CW[7] = 120 * kM; CW[8] = CW[13] = 100 * kM; CW[11] = 30 * kM;
      const pk = Math.max(Math.hypot(Bc.ribsPush[0], Bc.ribsPush[1]), Math.hypot(Bc.chestPush[0], Bc.chestPush[1]), Math.hypot(Bc.ribs2Push[0], Bc.ribs2Push[1]));
      CW[5] = Bc.liftPx + 0.3 * (pk / Math.hypot(FLANK_X, FLANK_Y)); CW[12] = Bc.sighPx;
      const hf = R.head.face;
      if (hf) { NF_X = hf.center[0]; NF_Y = hf.center[1]; NF_DY = 0; NF_RX = hf.rx; NF_RY = hf.ry; }
      else { NF_X = FACE_X; NF_Y = EYE_Y; NF_DY = 40 * kM; NF_RX = 150 * kM; NF_RY = 115 * kM; }
      bPer = Bc.period; breathPer = bPer;
    }
    function start(res) {
      if (dead) return;
      const [rg, imgBase, imgEyes] = res;
      rig = rg;
      W = worldOf(rig);
      mirror = !!(rig.display && rig.display.mirror);
      // WORLD 는 싣고 다니는 회색 고양이 값 — 그 폴더를 읽을 때만 맞춰 본다(다른 고양이는 세계 크기가 원래 다르다)
      if (debug && base === DEFAULT_BASE && !opts.rig && (W.w !== WORLD.width || W.h !== WORLD.height)) console.warn('catrig: WORLD 상수가 rig.json 과 다르다', W, WORLD);
      const e = rig.eyes;
      FACE_X = rig.head.faceCenter[0];
      EYE_Y = (e.left.center[1] + e.right.center[1]) / 2;
      MID_X = (e.left.center[0] + e.right.center[0]) / 2;
      EL_X = rig.ears.left.base[0];
      ER_X = rig.ears.right.base[0];
      // 이마·턱 판정 타원 — head.zone 이 있으면 그것(얼굴 시차 타원과 따로), 없으면 머리 타원을 세로로 조금 늘여
      const hz = rig.head.zone;
      if (hz && hz.center && hz.rx > 0 && hz.ry > 0) { HC_X = hz.center[0]; HC_Y = hz.center[1]; HIRX = 1 / hz.rx; HIRY = 1 / hz.ry; }
      else { HC_X = rig.head.center[0]; HC_Y = rig.head.center[1]; HIRX = 1 / rig.head.rx; HIRY = 1 / (rig.head.ry * 1.05); }
      if (isStatic) { toImage(imgBase.src); listen(); return; }
      // rig.json 이 부위 판정에 모자라도(grid·귀 밑동 없음) 예외로 아무것도 안 뜨지 않게 — 그림 한 장으로 물러난다
      let ok = false;
      try { rigSetup(); zonesSetup(imgBase); ok = initGL(imgBase, imgEyes); } catch (err) { ok = false; if (debug) console.warn('catrig', err); canvas = null; gl = null; }
      if (!ok) { if (purr) purr.close(); toImage(imgBase.src); listen(); return; }
      mode = 'webgl';
      fit();
      host.append(el);
      refreshRect(-9);
      listen();
      running = !paused;
      // 멈춘 채 시작해도 쉬는 자세 한 장은 그려 둔다 (빈 캔버스가 페이드인되지 않게)
      pose(); draw(); force = false;
      if (debug) st.draws++;
      wake();
      win.requestAnimationFrame(() => { if (!dead && el) el.classList.add('in'); });
      // 소리 장치 — 남이 연 것도, 미리 연 것도 없으면 첫 그림 뒤 한가할 때 연다(0.4~0.9초 멈칫이 첫 그림을 늦추지 않게)
      if (sound && purr && !purr.shared && purr.state === 'none') {
        const go = () => {
          idleCb = 0;
          if (dead || !sound || !purr || mode !== 'webgl') return;
          const a = debug ? win.performance.now() : 0;
          purr.warm();
          if (debug) st.warmMs = win.performance.now() - a;
        };
        idleCb = win.requestIdleCallback ? win.requestIdleCallback(go, { timeout: 2000 }) : win.setTimeout(go, 300);
      }
    }
    // 첫 그림 뒤 한가할 때 소리 장치를 열려던 것을 거둔다
    function dropIdle() {
      if (!idleCb) return;
      if (win.cancelIdleCallback) win.cancelIdleCallback(idleCb); else clearTimeout(idleCb);
      idleCb = 0;
    }
    function listen() {
      // 크기가 바뀔 때만 자리를 다시 잰다 — 커서가 움직일 때마다 getBoundingClientRect 를 부르지 않게.
      // 정지 그림도 이것만 단다 — host 가 아직 크기가 없을 때 붙여도 나중에 자리를 잡게
      ro = new win.ResizeObserver(onResize);
      ro.observe(host);
      if (mode !== 'webgl') return;
      listening = true;
      win.addEventListener('resize', onResize);
      win.addEventListener('pointermove', onMove, { passive: true });
      win.addEventListener('pointerdown', onDown, { passive: true });
      win.addEventListener('pointerup', onUp, { passive: true });
      win.addEventListener('pointercancel', onUp, { passive: true });
      win.addEventListener('pointerout', onOut, { passive: true });
      doc.addEventListener('visibilitychange', onVis);
      el.addEventListener('transitionend', onResize);
    }
    function unlisten() {
      if (!listening) return;
      listening = false;
      win.removeEventListener('resize', onResize);
      win.removeEventListener('pointermove', onMove);
      win.removeEventListener('pointerdown', onDown);
      win.removeEventListener('pointerup', onUp);
      win.removeEventListener('pointercancel', onUp);
      win.removeEventListener('pointerout', onOut);
      doc.removeEventListener('visibilitychange', onVis);
      if (el) el.removeEventListener('transitionend', onResize);
    }

    const ready = (preP || Promise.all([
      opts.rig ? Promise.resolve(opts.rig) : loadJson(base + 'rig.json'),
      decoded(tex.base || base + 'base.webp'),
      isStatic ? Promise.resolve(null) : decoded(tex.eyes || base + 'eyes.webp')
    ])).then(start).then(() => (W && !dead ? { mode, width: W.w, height: W.h, mirror } : { mode: 'destroyed', width: 0, height: 0, mirror: false }));
    ready.catch(() => { /* 못 열면 아무것도 안 띄운다 — 휴식 화면은 그대로 뜬다 */ });

    function endSettle() {
      clearTimeout(settleTmr); settleTmr = 0;
      const r = settleRes; settleRes = null;
      if (r) r();
    }

    const handle = {
      ready,
      get mode() { return mode; },
      pause() {
        paused = true;
        running = false;
        stopLoop();
        if (purr) purr.stop();
        // 쓰다듬던 판은 여기서 끝 — 앱이 횟수·친밀도를 바로 받게
        endSession(); petting = false; strokes = 0; pend = 0;
        offStart();
      },
      resume() {
        paused = false;
        offEnd();
        if (settling) {
          // 돌아가는 도중(타이머가 아직)이면 지금 줄어든 크기 그대로 이번 숨을 이어 간다 — 바닥 쉼으로 되돌리면 한 장에
          // 3~4px 떨어졌다. 다 돌아간 뒤(숨 0)에만 바닥 쉼에서 다시 — 숨 중간으로 «툭» 튀지 않게
          if (settleTmr) { const k = Math.max(0, 1 - (lastT - settleT0) / settleDur); breathAmp *= k; breathSigh *= k; }
          else breathRest();
        }
        // 멈춘·쉬던 동안에도 시계는 흘렀다 — 한숨 때를 다시 잡지 않으면 깨어날 때마다 첫 숨이 한숨이다
        nextSigh = -1;
        settling = false;
        endSettle();
        if (dead || mode !== 'webgl') return;
        running = true;
        lastT = -1;
        wake();
      },
      /**
       * 쉬는 자세(= static 그림·영상 첫 장과 같은 자리)로 돌아간 뒤 풀린다. 라이브 ↔ static 을 바꾸기 직전에 부른다 —
       * 혼자 두리번·숨 때문에 화면에서 몇 px(한숨 끝이면 7px 남짓) 튀던 것이 0 이 된다. resume() 하면 숨 바닥에서 다시 움직인다.
       */
      settle(ms) {
        const dur = ms == null ? 400 : ms;
        if (dead || mode !== 'webgl') return Promise.resolve();
        settling = true;
        settleT0 = lastT >= 0 ? lastT : win.performance.now() / 1000;
        settleDur = Math.max(0.05, dur / 1000);
        endSession();
        petting = false; strokes = 0; pend = 0;
        if (purr) purr.stop();
        force = true;
        wake();
        endSettle();
        return new Promise((res) => {
          settleRes = res;
          settleTmr = setTimeout(() => {
            // 끝 — 스프링 꼬리를 털어 정확히 쉬는 자세로 한 장 그린다
            S.fill(0);
            breath = 0; sigh = 0; lid = 0; content = 0; blinkT0 = -1;
            earTL = earTR = -99; ebL = ebR = 0; rubL = rubR = 0; ZA.fill(0); thumpT = -1; pendFlick = 0; pendThump = false; tw2T = -1;
            // 기분은 쉼으로 — 쉬는 자세엔 화난 몸짓이 없다. 경고·화남이었으면 참을성은 외면이 끝날 때처럼 덜어 둔다(아니면 resume 뒤
            // 첫 쓰다듬기에서 그르렁 없이 곧장 경고가 왔다). 쉬는 동안 흐른 시간은 resume 때 offEnd 가 푼다
            if (mood >= M_WARN) tol = Math.min(tol, tolMax * 0.3);
            setMood(M_CALM, lastT); wk = 0; ak = 0; restLid = 0; gOn = false; bC = 0.38; bH = 0.1; spontT = -1;
            rippleT0 = -9; rippleAt = -1; ripU = -1; ripA = 0; ripPh = 0;
            breathRest();
            offStart();
            if (gl && !dead) { pose(); draw(); force = false; }
            endSettle();
          }, dur);
        });
      },
      setSound(on, volume) {
        sound = !!on;
        if (dead || !purr || mode !== 'webgl') return;
        if (volume != null) purr.setVolume(volume);
        if (!sound) purr.stop();
        else { purr.warm(); wake(); }   // 소리를 켠 손짓(클릭) 순간에 만들어 둔다 — 쓰다듬을 때 멈칫하지 않게
      },
      /** 친밀도 (0~1) — 앱이 저장할 값. 쓰다듬는 동안에도 조금씩 오른다 */
      getAffinity() { return aff; },
      /**
       * 앱(또는 미리보기)이 친밀도를 바꿨다 — onAffinity 로 되돌려 알리지 않는다.
       * todayStrokes(선택): 다른 화면에서 같은 고양이를 쓰다듬어 오늘 친밀도에 든 횟수 — 더 크면 그것으로 하루 몫을 이어 간다
       * (안 그러면 이 창이 하루 몫을 처음부터 다시 받아, 여러 화면에서 쓰다듬은 날의 상승이 설계보다 커졌다)
       */
      setAffinity(v, todayStrokes) {
        aff = unit(v, aff); affSent = aff;
        const n = Number(todayStrokes);
        if (Number.isFinite(n) && n > today) today = n;
        setTolMax(); wake();
      },
      /** 이번 창에서 — 기분, 친밀도, 쓰다듬은 판·횟수(부위별, 귀는 만진 횟수), 화낸 횟수, 눈인사 */
      stats() {
        return {
          mood: moodOut, affinity: aff, todayStrokes: today, sessions: nSess, strokes: nStrokes,
          zones: { head: ZC[0], chin: ZC[1], back: ZC[2], rump: ZC[3], body: ZC[4], ears: ZC[5] },
          annoyed: nMad, greetings: nGreet
        };
      },
      destroy() {
        if (dead) return;
        endSession();
        dead = true;
        running = false;
        stopLoop();
        endSettle();
        dropIdle();
        if (ro) ro.disconnect();
        unlisten();
        if (purr) purr.close();
        if (gl) {
          // GPU 메모리를 바로 돌려준다 (창이 닫히길 기다리지 않고)
          const lose = gl.getExtension('WEBGL_lose_context');
          if (lose) lose.loseContext();
        }
        gl = null;
        if (el) el.remove();
        el = null; canvas = null;
      }
    };

    if (debug) {
      const KEYS = { yaw: HY, pitch: HP, roll: HR, lean: HLEAN, lift: HLIFT, gazeX: HGX, gazeY: HGY, earL: HEL, earR: HER, flat: HFL, lid: HLID, breath: HBR, sigh: HSI, rump: HRU, back: HBK, tailA: HTA, tailB: HTB, flatR: HFR, ripple: HRA, rippleX: HRX, ripplePh: HRP, backX: HBX };
      const ZNAME = ['none', 'head', 'chin', 'earL', 'earR', 'back', 'rump', 'body', 'tail'];
      handle.debug = {
        S, C, L,
        stats() { return { mode, gl2: isGL2, ticks: st.ticks, draws: st.draws, skips: st.skips, pokes: st.pokes, imm: st.imm, lv: st.lv.slice(), why: st.why.slice(), jsMs: st.jsMs, jsMax: st.jsMax, canvas: canvas ? [canvas.width, canvas.height] : null, epsTex, level, running, raf: !!raf, timer: !!tmr, audio: purr ? purr.state : 'none', purring: purr ? purr.on : false, content, petting, strokes, lid, petCount, earL: S[EARL], earR: S[EARR], lift: S[LIFT], purrMs: st.purrMs, warmMs: st.warmMs, settling, breath, sigh, breathPer, breathAmp, breathSigh, idleIv, purrK,
          zone: ZNAME[zone], zmix: Array.from(ZM, (v) => Math.round(v * 100) / 100), chinSide, irk, ears: st.ears, earBack: [ebL, ebR], flatR: S[FLATR], rump: S[RUMP], back: S[BACKR], tailA: S[TAILA], tailB: S[TAILB], thump: thumpT >= 0, backX: bumpX,
          mood: MOOD_NAME[mood], moodOut, tol, tolMax, wk, ak, aff, today, warnLeft, coolLeft: mood >= M_MAD ? coolEnd - lastT : 0, away, snubs: st.snubs,
          greetings: nGreet, greeting: gOn, gNeed, ripA, ripX, restLid, flat: S[FLAT], yaw: S[YAW], pitch: S[PITCH], gazeX: S[GX], sessStrokes, nStrokes, nSess, followSec: FOLLOW_SEC[0] + (FOLLOW_SEC[1] - FOLLOW_SEC[0]) * aff,
          gazeY: S[GY], mirror, scale: kM }; },
        /** 이 고양이에 맞춰 푼 rig.json — 켠 부위, 꼬리 배율(부호 포함), 귀 털기 폭, 얼굴 앞 타원, 숨, 세계 (시험·하네스용) */
        cfg() {
          return {
            mirror, scale: kM, world: W, on: { chin: chinOn, back: backOn, backBump, rump: rumpOn, rumpLift: rumpLiftOn, tail: tailOn, ripple: rippleOn, hit: !!hitM },
            tailGain: [TG_B, TG_C], earFlick: [EAR_KL, EAR_KR], face: [NF_X, NF_Y + NF_DY, NF_RX, NF_RY], breathPeriod: bPer,
            flatMax: FLAT_LIM, dimCatch: [DC_A, DC_B], headZone: [HC_X, HC_Y, 1 / HIRX, 1 / HIRY], tailBelow: Zc && Zc.tail && Zc.tail.below > 0 ? Zc.tail.below : null,
            breath: Bc && { liftPx: Bc.liftPx, sighPx: Bc.sighPx, ribsPush: Bc.ribsPush, chestPush: Bc.chestPush, ribs2Push: Bc.ribs2Push, head: Bc.head, on: { lift: !!Bc.lift, shoulder: !!Bc.shoulder, ribs: !!Bc.ribs, ribs2: !!Bc.ribs2, chest: !!Bc.chest } },
            ripX: [ripX0, ripX1], cw: CW.slice()
          };
        },
        /** 기분 시험 — 문턱(tolMax 초)·경고(warn 초)·외면(cool 초)·눈인사 받을 확률(greetP)·먼저 건넬 확률(spontP)·눈인사 쉼(greetCool 초)·피부 떨림 확률(rippleP) 바꿔 끼우기.
         *  값 null 은 원래대로 */
        moodCfg(o) { for (const k of Object.keys(o || {})) if (k in MC) MC[k] = o[k] == null ? NaN : o[k]; setTolMax(); wake(); return { tolMax, MC: Object.assign({}, MC) }; },
        /** 기분을 바로 — 'warning' | 'annoyed' (시험·그림용) */
        mood(m) { dbgMood = m === 'warning' ? M_WARN : m === 'annoyed' ? M_MAD : -1; wake(); return MOOD_NAME[mood]; },
        tol(v) { if (v != null) tol = v; wake(); return tol; },
        greet() { greet(lastT); wake(); },
        ripple() { if (rippleOn) rippleAt = lastT; wake(); },
        reset() { st.ticks = 0; st.draws = 0; st.jsMs = 0; st.jsMax = 0; st.skips = 0; st.imm = 0; st.lv.fill(0); st.why.fill(0); },
        /** 텍스처 px 자리의 부위 이름 */
        zone(x, y) { return ZNAME[zoneAt(x, y)]; },
        /** 귀를 만진 것처럼 (0 왼귀, 1 오른귀) / 꼬리 끝 털기 (a rad, 기본 TAIL_FLICK) / 짜증 값 바꾸기 — 시험용 */
        earTouch(which) { earTouch(which ? 1 : 0, lastT, true); wake(); },
        tailFlick(a) { pendFlick = Math.max(pendFlick, a == null ? TAIL_FLICK : a); wake(); },
        /** 꼬리 끝 탁 (들기 → 내리치기) */
        tailThump() { pendThump = true; wake(); },
        irk(v) { if (v != null) irk = v; wake(); return irk; },
        /** 다음 숨을 한숨으로 (시험용 — 25~60초를 기다리지 않게) */
        sigh() { nextSigh = 0; },
        /** 자세를 붙든다 (px 는 회색 고양이 크기 — 화면엔 rig.json scale 배. 꼬리 rad 도 회색 꼬리 기준 — 끝 px 가 회색과 같다)
         *  (yaw·pitch·gazeX·gazeY 는 -1~1, roll·earL·earR 는 rad, lean·lift 는 px, lid 0~1,
         *  breath 는 보통 들숨 끝 = 1(한숨은 2 가까이), sigh 0~1, flat(두 귀)·flatR(오른귀만) 0~0.12,
         *  rump·back(손 밑 등 혹 높이) 은 px, backX 는 혹 자리 x, tailA(굽힘)·tailB(끝 말기) 는 rad, ripple(피부 떨림 높이 px)·rippleX·
         *  ripplePh(위상 rad)). null 이면 풀기, 값 null 은 그 항목만 풀기 */
        hold(o) {
          if (!o) H.fill(NaN); else for (const k of Object.keys(o)) if (k in KEYS) H[KEYS[k]] = o[k] == null ? NaN : o[k];
          force = true;
          if (running) wake(); else drawOnce();
        },
        blink(slow) { blinkT0 = lastT; blinkDur = slow ? 1.4 : 0.3; blinkAmp = 1; bC = 0.38; bH = 0.1; gOn = false; wake(); },
        /** 랜드마크의 화면(client) 자리 — 시험이 커서를 어디로 보낼지 */
        where(x, y) { refreshRect(lastT); const u = (x - W.x0) / W.w; return [rl + (mirror ? 1 - u : u) * rw, rt + (y - W.y0) / W.h * rh]; },
        rig() { return rig; },
        /** 지금 붙든 자세로 «늘어난 정도» 를 잰다: 넓이 비(1 = 그대로) 최소·최대, 뒤집힌 픽셀 수 */
        fold() {
          if (!gl) return null;
          if (!Pfold) { Pfold = foldProgram(); if (!Pfold) return null; }
          gl.useProgram(Pfold.pr);
          gl.uniform4f(Pfold.u.uRest, -(W.w / bw) * (W.h / bh), 0, 0, 0);
          pose();
          gl.disable(gl.BLEND);
          draw(Pfold);
          const px_ = new Uint8Array(bw * bh * 4);
          gl.readPixels(0, 0, bw, bh, gl.RGBA, gl.UNSIGNED_BYTE, px_);
          gl.enable(gl.BLEND);
          gl.useProgram(P.pr);
          let mn = 9, mx = 0, folded = 0, n = 0;
          for (let i = 0; i < px_.length; i += 4) {
            if (px_[i + 3] < 255) continue;
            n++;
            const r = px_[i] / 255 * 4;
            if (px_[i + 1] > 127) folded++;
            else { if (r < mn) mn = r; if (r > mx) mx = r; }
          }
          force = true; wake();
          return { min: mn, max: mx, folded, px: n };
        },
        /** 늘어남을 색으로 그려 둔다 (다시 부를 때까지) — 어디가 눌리고 늘었나 눈으로 */
        foldShow(on) {
          if (!gl) return false;
          if (!Pfold) { Pfold = foldProgram(); if (!Pfold) return false; gl.useProgram(P.pr); }
          showFold = !!on;
          force = true; wake();
          return true;
        },
        /** 그르렁 소리 크기 — OfflineAudioContext 로 sec 초 만들어 RMS·최대값(dBFS) */
        purrLevel(sec) {
          const OAC = win.OfflineAudioContext;
          const sr = 22050, ctx = new OAC(1, Math.round(sr * sec), sr);
          const m = purrGraph(ctx, ctx.destination).master;
          m.gain.value = PURR_VOL;
          return ctx.startRendering().then((b) => {
            const d = b.getChannelData(0);
            let s = 0, pk = 0;
            for (let i = 0; i < d.length; i++) { s += d[i] * d[i]; pk = Math.max(pk, Math.abs(d[i])); }
            const db = (v) => Math.round(20 * Math.log10(v + 1e-9) * 10) / 10;
            return { rmsDb: db(Math.sqrt(s / d.length)), peakDb: db(pk) };
          });
        }
      };
    }
    return handle;
  }

  window.nunsCatRig = { mount, preload, release, worldOf, affinityAfter, WORLD, DEFAULT_BASE };
})();
