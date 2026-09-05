// 테두리·머리를 끌어 창을 옮기고 키우는 판을 한 곳에서 연다.
//
// 왜 따로 두는가: 창마다 같은 코드를 적었다가 같은 버그를 네 벌 갖게 됐다.
//
// 그 버그: 끌기를 시작하려면 창의 지금 크기를 알아야 하는데, 그건 메인에 물어봐야 한다
// (IPC). 그래서 처리기가 이렇게 생겼었다.
//
//     el.addEventListener('pointerdown', async (e) => {
//       const b = await 크기물어보기();      // ← 여기서 잠깐 쉰다
//       window.addEventListener('pointermove', move);
//       window.addEventListener('pointerup', up);   // ← 뗄 때를 듣는 건 이제부터
//     });
//
// 답이 오기 «전에» 손을 떼면, 뗀 것을 들을 처리기가 아직 없다. 그래서 up 이 안 돌고,
// move 는 걸린 채로 영영 남는다. 남은 move 는 단추를 눌렀는지 보지도 않으므로,
// 그 뒤로는 창 위에서 마우스를 움직이기만 해도 크기가 튄다.
// 그립을 «톡» 누르고 떼는 것만으로 이 상태가 된다 — 실측으로 다섯 번에 한 번 남았고,
// 그 뒤 마우스만 움직였더니 창이 1732x260 에서 1732x760 으로 뛰었다.
//
// 여기서는 순서를 뒤집는다: 처리기를 «먼저» 걸고, 크기는 그 뒤에 채운다.
// 답이 오기 전에 떼었으면 아무 일도 안 일어난다.

(() => {
  'use strict';

  /**
   * @param {Element} el      누르기 시작할 곳
   * @param {(e: PointerEvent) => (Promise<Function|null>|Function|null)} begin
   *        시작할 때 할 일. 끌 때마다 부를 함수를 돌려준다 (안 끌 거면 아무거나).
   *        여기서 await 를 해도 된다 — 그 사이에 떼면 그냥 없던 일이 된다.
   */
  window.nunsDrag = (el, begin) => {
    if (!el) return;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      let step = null;
      let over = false;

      const end = () => {
        if (over) return;
        over = true;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
        window.removeEventListener('blur', end);
      };
      function move(ev) {
        // 단추를 안 누른 채 오는 움직임은 이미 끝난 것이다.
        // 혹시 up 을 놓쳤더라도 여기서 끊긴다 — 두 겹으로 막는다.
        if (!(ev.buttons & 1)) { end(); return; }
        if (step) step(ev);
      }

      // 먼저 건다. begin 이 기다리는 동안에도 «뗌»을 놓치지 않는다.
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
      window.addEventListener('blur', end);

      Promise.resolve()
        .then(() => begin(e))
        .then((fn) => {
          if (over || typeof fn !== 'function') return;   // 벌써 뗐으면 없던 일로
          step = fn;
        })
        .catch(() => end());
    });
  };
})();
