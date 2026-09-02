'use strict';
/**
 * 네이티브 <select>를 앱 마감의 «고르기 단추»로 바꾼다.
 *
 * <select>의 목록은 OS/브라우저가 그린다 — CSS로 손댈 수 없어서, 유리 마감 한가운데
 * 남의 창이 하나 튀어나온다. 물어보는 창과 오른쪽 클릭 메뉴를 앱 것으로 바꾼 뒤로는
 * 여기만 남아 있었다.
 *
 * <select> 자체는 지우지 않고 감추기만 한다. 값을 읽고 쓰는 기존 코드
 * (sel.value, sel.onchange, option 채우기)를 한 줄도 안 고치기 위해서다.
 * 고르면 select의 값을 바꾸고 change를 대신 일으켜 준다.
 */
(() => {
  const upgraded = new WeakMap();

  // 마감은 이 파일이 들고 다닌다 — 쓰는 쪽은 <script> 한 줄만 넣으면 된다.
  const css = `
    select[data-pf] { display: none !important; }
    /* 자리를 물려받은 곳에 «all: unset»을 거는 규칙이 흔하다 (.bar button, .cust-name).
       그것들과 같은 무게로 두고, 나중에 끼워 넣어 이기게 한다 — 안 그러면 display가 되돌아간다. */
    button.pickfield {
      display: inline-flex; align-items: center; gap: 6px;
      cursor: default; text-align: left; min-width: 0;
    }
    .pickfield .pf-t {
      flex: 1 1 auto; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    /* 아래를 가리키는 작은 꺾쇠 — 네이티브 화살표 자리 */
    .pickfield .pf-c {
      flex: none; width: 6px; height: 6px; border-radius: 1px;
      border-right: 1.4px solid currentColor; border-bottom: 1.4px solid currentColor;
      opacity: 0.5; transform: translateY(-2px) rotate(45deg);
    }
    .pickfield:hover .pf-c { opacity: 0.9; }
    .pickfield:disabled { opacity: 0.45; }
  `;

  function style() {
    if (document.getElementById('pf-css')) return;
    const s = document.createElement('style');
    s.id = 'pf-css';
    s.textContent = css;
    document.head.append(s);
  }

  function labelOf(sel) {
    const o = sel.options[sel.selectedIndex];
    return (o && o.textContent) || '';
  }

  function upgrade(sel) {
    if (upgraded.has(sel)) { upgraded.get(sel).sync(); return; }

    const btn = document.createElement('button');
    // 원래 select가 입던 옷을 그대로 물려받는다 (.cust-name 같은 것)
    btn.className = 'pickfield' + (sel.className ? ' ' + sel.className : '');
    btn.type = 'button';
    if (sel.title) btn.title = sel.title;
    if (sel.style.cssText) btn.style.cssText = sel.style.cssText;

    const text = document.createElement('span');
    text.className = 'pf-t';
    const caret = document.createElement('i');
    caret.className = 'pf-c';
    btn.append(text, caret);

    const sync = () => {
      text.textContent = labelOf(sel);
      // 원래 select를 감추고 보이던 코드(style.display)를 그대로 따라간다
      btn.style.display = sel.style.display === 'none' ? 'none' : '';
      btn.disabled = sel.disabled;
    };

    // 눌러도 그 자리의 커서를 뺏지 않는다 — 쓰기 창 글꼴·크기가 여기에 걸려 있다
    btn.addEventListener('pointerdown', (e) => e.preventDefault());

    let open = false;
    btn.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (open) return;                       // 두 번 눌러 두 개 뜨지 않게
      const items = [...sel.options].map((o, i) => ({
        id: String(i),
        label: o.textContent,
        // 지금 골라진 것이 무엇인지 목록만 보고 알 수 있어야 한다
        checked: i === sel.selectedIndex,
        enabled: !o.disabled
      }));
      if (!items.length) return;
      // 창이 하나 뜨면 여기 있던 커서·선택이 흐려진다. 쓰는 쪽이 챙길 틈을 준다.
      sel.dispatchEvent(new CustomEvent('pf-open', { bubbles: true }));
      open = true;
      let pick;
      try { pick = await window.nunsseom.pickMenu(items); } finally { open = false; }
      if (pick == null) return;
      const i = Number(pick);
      if (!Number.isInteger(i) || !sel.options[i]) return;
      sel.selectedIndex = i;
      sync();
      // 값이 바뀌었으면 원래 select가 그랬듯 알린다
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    };

    sel.dataset.pf = '1';
    sel.setAttribute('aria-hidden', 'true');
    sel.tabIndex = -1;
    sel.after(btn);

    // 목록이 나중에 채워지거나 값이 코드로 바뀌는 곳이 있다 (계정 고르기·거를 동작).
    // 그때마다 단추 글자를 맞춘다 — 안 그러면 빈 단추가 남는다.
    new MutationObserver(sync).observe(sel, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['selected', 'disabled', 'style']
    });
    sel.addEventListener('change', sync);

    upgraded.set(sel, { btn, sync });
    sync();
  }

  /** 페이지의 select를 전부 바꾼다. 나중에 생긴 것이 있으면 다시 부르면 된다. */
  window.nunsPickFields = (root) => {
    style();
    for (const sel of (root || document).querySelectorAll('select')) upgrade(sel);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => window.nunsPickFields());
  } else window.nunsPickFields();
})();
