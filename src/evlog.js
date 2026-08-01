'use strict';
/**
 * 이벤트 기록 (디버그용).
 *
 * "드래그하면 왜 저렇게 되는지" 같은 건 추측으로 좁히면 몇 번이고 빗나간다.
 * 트레이에서 켜두고 문제를 재현하면, 창 이동 / 창 크기 / UI 스케일이
 * 각각 언제 어떤 값으로 움직였는지 한 파일에서 시간순으로 보인다.
 *
 * 포인터 이동처럼 초당 수십 건 오는 것도 있어 메모리에 모았다가 주기적으로 쓴다.
 */
const fs = require('fs');
const path = require('path');

const FLUSH_MS = 400;
const MAX_BUFFER = 2000;      // 폭주해도 메모리를 먹지 않게

let file = null;
let enabled = false;
let buffer = [];
let timer = null;
let t0 = 0;

function stamp() {
  const ms = Date.now() - t0;
  return (ms / 1000).toFixed(3).padStart(8) + 's';
}

function flush() {
  if (!file || buffer.length === 0) return;
  const chunk = buffer.join('\n') + '\n';
  buffer = [];
  try { fs.appendFileSync(file, chunk); } catch { /* 기록 실패로 앱을 멈추지 않는다 */ }
}

module.exports = {
  init(userDataDir) {
    file = path.join(userDataDir, 'widget-events.log');
  },

  get file() { return file; },
  get enabled() { return enabled; },

  setEnabled(on) {
    if (on === enabled) return;
    enabled = on;
    if (enabled) {
      t0 = Date.now();
      buffer = [];
      try {
        fs.writeFileSync(file, `# Hibi 이벤트 기록 시작 ${new Date().toISOString()}\n`
          + '# 열: 시각 [출처] 내용\n');
      } catch {}
      timer = setInterval(flush, FLUSH_MS);
      if (timer.unref) timer.unref();
    } else {
      flush();
      if (timer) clearInterval(timer);
      timer = null;
    }
  },

  log(source, message) {
    if (!enabled) return;
    if (buffer.length >= MAX_BUFFER) return;
    buffer.push(`${stamp()} [${source}] ${message}`);
  },

  flush
};
