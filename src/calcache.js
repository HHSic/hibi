'use strict';
/**
 * 캘린더 원문 캐시.
 *
 * 지금까지 받아온 일정은 메모리에만 있었다. 그래서 인터넷이 없는 채로 앱을 켜면
 * 달력이 텅 비고, "빈 시간에 휴식 배치"도 일정을 모르는 채로 돈다.
 * 켤 때마다 처음 응답이 올 때까지 잠깐 비는 것도 같은 이유였다.
 *
 * 받아온 ICS 원문을 그대로 저장해두면 오프라인에서도 마지막 상태로 동작한다.
 */
const fs = require('fs');
const path = require('path');

const FILE = 'calendar-cache.json';
const MAX_BYTES = 12 * 1024 * 1024;   // 원문이 커도 캐시가 무한정 커지지 않게

function file(dir) { return path.join(dir, FILE); }

module.exports = {
  /** 저장된 원문 → { sources, fetchedAt } (없거나 깨졌으면 null) */
  load(dir) {
    try {
      const raw = fs.readFileSync(file(dir), 'utf8');
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.sources)) return null;
      const sources = data.sources.filter((s) => s && typeof s.text === 'string');
      if (!sources.length) return null;
      return { sources, fetchedAt: Number(data.fetchedAt) || 0 };
    } catch {
      return null;   // 캐시가 없거나 깨진 건 정상적인 상황이다
    }
  },

  /**
   * 내용이 그대로면 쓰지 않는다 — 15분마다 몇 MB를 다시 쓸 이유가 없다.
   * @returns 실제로 파일에 썼으면 true
   */
  save(dir, sources, fetchedAt) {
    try {
      if (!Array.isArray(sources) || !sources.length) return false;
      const body = JSON.stringify({
        fetchedAt: fetchedAt || Date.now(),
        sources: sources.map((s) => ({ name: s.name, url: s.url, text: s.text }))
      });
      if (Buffer.byteLength(body) > MAX_BYTES) return false;

      const prev = this.load(dir);
      if (prev && prev.sources.length === sources.length
        && prev.sources.every((p, i) => p.text === sources[i].text && p.url === sources[i].url)) {
        return false;
      }
      fs.writeFileSync(file(dir), body);
      return true;
    } catch {
      return false;   // 캐시 실패로 앱이 멈추면 안 된다
    }
  },

  clear(dir) {
    try { fs.unlinkSync(file(dir)); } catch { /* 없으면 그만 */ }
  }
};
