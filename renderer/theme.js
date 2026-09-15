'use strict';
/**
 * 유리 창의 테마와 유리 진하기를 문서에 입힌다.
 *
 * 숫자는 메인이 정한다 (src/win.js effScrim — 라이트 바닥 0.90, 빽빽한 창 +0.04).
 * 여기서는 받은 값을 칠하기만 한다. 처음에는 주소(?theme·?scrim)에서, 그 뒤로는 'glass' 방송에서.
 * 창마다 따로 계산하던 때는 창끼리 진하기가 어긋났고, 윈도우 테마를 바꿔도 다시 열기 전엔 안 따라왔다.
 *
 * 테마가 궁금한 스크립트는 ?theme 를 다시 읽지 말고 document.documentElement.dataset.theme 를 본다.
 * 앱 모드를 바꾸면 주소는 그대로인데 이 값만 바뀐다.
 *
 * <head> 에서 페이지 스크립트보다 먼저 실린다. 전역 이름을 남기지 않는다 —
 * 일반 <script> 끼리는 최상위 const 를 같은 자리에 두므로, 페이지에 같은 이름(q 등)이 있으면 그 페이지가 통째로 멈춘다.
 */
(() => {
  const root = document.documentElement;
  const q = new URLSearchParams(location.search);
  // 빽빽한 창(설정·주식)은 방송에서도 진한 쪽을 고른다
  const dense = q.get('dense') === '1';
  const apply = (theme, scrim) => {
    root.dataset.theme = theme === 'light' ? 'light' : 'dark';
    const a = parseFloat(scrim);
    if (!Number.isNaN(a)) root.style.setProperty('--scrim-a', String(a));
  };
  apply(q.get('theme'), q.get('scrim'));
  // 시험용 가짜 다리나 다리가 없는 페이지에서도 멈추지 않게
  const bridge = window.nunsseom;
  if (bridge && typeof bridge.onGlass === 'function') {
    bridge.onGlass((g) => { if (g) apply(g.theme, dense ? g.scrimDense : g.scrim); });
  }
})();
