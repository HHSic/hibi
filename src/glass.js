// 위젯/설정 창의 유리 마감 정책.
//
// 실험으로 확인한 사실 (scratchpad/glasstest·roundlab 하네스, Win11 26200 / Electron 33):
//   · frame:false + backgroundColor:'#00000000' + backgroundMaterial:'acrylic'
//       → 진짜 데스크톱 블러 O. 단 코너 반경은 DWM이 주는 8px(ROUND)/4px(ROUNDSMALL)뿐.
//   · 여기에 transparent:true 를 더하면 창이 레이어드 윈도우가 되어 아크릴이 죽는다.
//   · DwmSetWindowAttribute(DWMWA_SYSTEMBACKDROP_TYPE) / ACCENT_ENABLE_BLURBEHIND
//       → 최신 Win11에서 창이 새까맣게 렌더된다. 사용 불가.
//   · SetWindowRgn(CreateRoundRectRgn) 으로 큰 반경을 만들면
//       → GDI 리전은 1비트 마스크라 안티에일리어싱이 불가능하고 코너가 계단으로 잘린다.
//
// 결론: "큰 라운드 + 매끈한 코너"와 "실시간 블러"는 동시에 가질 수 없다.
// 이 프로젝트는 라운드 품질을 택했다 → 투명 창 + CSS border-radius.
// 유리감은 렌더러에서 틴트(scrim) + 내부 하이라이트 + 외부 그림자로 만든다.
//
// 창 바깥으로 그림자를 드리우려면 창 안쪽에 투명 여백이 필요하다.
// 렌더러의 카드가 이 여백만큼 안으로 들어가므로, 창 크기 = 카드 크기 + INSET*2.
const INSET = 12;

// 호버 컨트롤이 카드 내용을 덮지 않도록, 카드 아래에 전용 띠를 예약한다.
// 창 높이 = 카드 높이 + INSET*2 + CONTROLS
const CONTROLS = 36;

/** 투명 유리 창 옵션 */
function windowOptions() {
  return {
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false // 네이티브 그림자는 사각으로 그려진다 — CSS 그림자를 쓴다
  };
}

module.exports = { windowOptions, INSET, CONTROLS };
