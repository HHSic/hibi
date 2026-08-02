// 알림 종류 글리프 (이모지 대신 벡터). 24x24 viewBox, stroke 기반.
window.NUNS_ICONS = {
  eye: ['M1.5 12S5.5 5.5 12 5.5 22.5 12 22.5 12 18.5 18.5 12 18.5 1.5 12 1.5 12Z', 'M15.1 12a3.1 3.1 0 1 1-6.2 0 3.1 3.1 0 0 1 6.2 0Z'],
  drop: ['M12 2.8s6 6.7 6 10.7a6 6 0 0 1-12 0c0-4 6-10.7 6-10.7Z'],
  posture: ['M14.3 4.6a2.3 2.3 0 1 1-4.6 0 2.3 2.3 0 0 1 4.6 0Z', 'M12 7v6m0 0-3.2 7m3.2-7 3.2 7M7.4 10.4h9.2'],
  water: ['M6.4 4h11.2l-1.3 15.2a1.6 1.6 0 0 1-1.6 1.5H9.3a1.6 1.6 0 0 1-1.6-1.5Z', 'M7 10.6h10'],
  stretch: ['M14.2 4.4a2.2 2.2 0 1 1-4.4 0 2.2 2.2 0 0 1 4.4 0Z', 'M12 6.8v7m0 0-2.8 6.6m2.8-6.6 2.8 6.6M3.6 8.6 12 11l8.4-2.4'],
  stand: ['M12 3.2v11m0 0-3 6.6m3-6.6 3 6.6M8 7l4-3.8L16 7'],
  wrist: ['M8 20.6V13a2 2 0 0 1 4 0V8.4a2 2 0 0 1 4 0V13', 'M16 13a4.6 4.6 0 0 1-4.6 4.6'],
  breath: ['M12 4v7', 'M12 11c0 4-3 5.4-5 5.4S4 15 4 13.4 5.6 11 7 11m5 0c0 4 3 5.4 5 5.4S20 15 20 13.4 18.4 11 17 11'],
  custom: ['M12 3.4l2.5 5.3 5.8.8-4.2 4.1 1 5.8L12 16.7l-5.1 2.7 1-5.8-4.2-4.1 5.8-.8Z'],
  pause: ['M9.2 5v14', 'M14.8 5v14'],
  play: ['M8.5 5.4v13.2L19 12Z'],
  gear: ['M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z', 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z'],
  minus: ['M5 12h14'],
  calendar: ['M4.5 6.5h15v13h-15Z', 'M4.5 10.5h15', 'M8.5 4v4', 'M15.5 4v4'],
  check: ['M4.5 12.5 9.5 17.5 19.5 6.5'],
  chevron: ['M9 5l7 7-7 7'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  download: ['M12 3.5v11', 'M7.5 10.5 12 15l4.5-4.5', 'M4.5 19.5h15'],
  plus: ['M12 5v14', 'M5 12h14'],
  sleep: ['M20.2 14.2A8.4 8.4 0 1 1 9.8 3.8a6.6 6.6 0 0 0 10.4 10.4Z']
};

/** 지정한 글리프의 <svg> 엘리먼트를 만든다 */
window.nunsIcon = function nunsIcon(name, cls) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  if (cls) svg.setAttribute('class', cls);
  for (const d of (window.NUNS_ICONS[name] || window.NUNS_ICONS.custom)) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
};

/**
 * 알림 표시 마크. 이모지가 있으면 이모지 텍스트를, 없으면 벡터 글리프를 만든다.
 * @param {object|string} m  meta 객체({emoji, glyph}) 또는 글리프 이름
 */
window.nunsMark = function nunsMark(m, cls) {
  const emoji = m && typeof m === 'object' ? m.emoji : null;
  const glyph = m && typeof m === 'object' ? (m.glyph || 'custom') : m;
  if (emoji) {
    const s = document.createElement('span');
    s.className = 'emoji' + (cls ? ' ' + cls : '');
    s.textContent = emoji;
    return s;
  }
  return window.nunsIcon(glyph, cls);
};

// 사용자 지정 알림에 고를 수 있는 이모지 (휴식·건강·습관 관련)
window.NUNS_EMOJI = [
  '💧', '👁️', '🧘', '💪', '🚶', '🫁', '💊', '👀',
  '☕', '🍵', '🥤', '🍎', '🌿', '😴', '🙆', '🤸',
  '✋', '🦵', '👣', '🧠', '🎯', '⏰', '🔔', '🌙',
  '☀️', '🧴', '📵', '💤', '🪥', '🚰', '🧊', '🎧'
];

/** 채워진(fill) 글리프 — 재생 버튼 등 */
window.nunsIconFilled = function nunsIconFilled(name, cls) {
  const svg = window.nunsIcon(name, cls);
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('stroke', 'none');
  return svg;
};
