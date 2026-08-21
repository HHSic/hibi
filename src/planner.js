'use strict';
/**
 * 일정 사이 빈 시간에 휴식을 배치하기 위한 계산 (순수 함수).
 *
 * 지금까지는 "일정 중이면 미룬다"가 전부였다. 그래서 두 가지가 어색했다.
 *  - 회의 1분 전에 휴식이 떠서, 쉬다 말고 회의에 들어가야 했다.
 *  - 회의와 회의 사이 2분짜리 틈에 끼어들었다.
 *
 * 여기서는 붙어 있는 일정을 한 덩어리로 보고, 그 덩어리 앞에 휴식이 온전히
 * 들어갈 자리가 없으면 아예 띄우지 않는다. 미룬 알림은 덩어리가 끝나는 즉시 이어진다.
 */

const LEAD_MS = 5 * 60_000;    // 일정 시작 이만큼 전부터는 새 휴식을 띄우지 않는다
const JOIN_MS = 10 * 60_000;   // 일정 사이가 이보다 짧으면 이어진 하나로 본다

/** 겹치거나 붙어 있는 일정을 한 덩어리로 합친다 */
function mergeBusy(occurrences, joinMs = JOIN_MS) {
  const list = (occurrences || [])
    .filter((e) => e && Number.isFinite(e.start) && Number.isFinite(e.end) && e.end > e.start)
    .sort((a, b) => a.start - b.start);

  const out = [];
  for (const e of list) {
    const last = out[out.length - 1];
    const name = e.summary || '일정';
    if (last && e.start - last.end <= joinMs) {
      if (e.end > last.end) last.end = e.end;
      if (!last.parts.includes(name)) last.parts.push(name);
    } else {
      out.push({ start: e.start, end: e.end, parts: [name] });
    }
  }
  return out;
}

/** at 시점이 속한 덩어리 */
function blockAt(busy, at) {
  return busy.find((b) => at >= b.start && at < b.end) || null;
}

/** at 이후 시작하는 첫 덩어리 */
function nextBlock(busy, at) {
  return busy.find((b) => b.start > at) || null;
}

function labelOf(kind, block) {
  const name = block.parts[0];
  const more = block.parts.length > 1 ? ` 외 ${block.parts.length - 1}건` : '';
  return kind === 'during' ? `일정: ${name}${more}` : `곧 일정: ${name}${more}`;
}

/**
 * 지금 휴식을 띄우면 안 되는 이유. 띄워도 되면 null.
 *
 * @param occurrences 캘린더 일정 [{ start, end, summary, allDay, free }]
 * @param at          기준 시각
 * @param needMs      휴식에 필요한 시간. 다음 일정까지 남은 틈이 이보다 좁으면 미룬다.
 * @returns null | { kind: 'during'|'before', until, summary, label }
 *          until — 이 시각이 지나면 다시 띄울 수 있다 (덩어리의 끝)
 */
function check(occurrences, at, needMs = 0, opts = {}) {
  const leadMs = Number.isFinite(opts.leadMs) ? opts.leadMs : LEAD_MS;
  // 달력에 «보이는 것»과 «바쁨으로 치는 것»은 다르다.
  //  - «한가함»으로 표시된 일정은 보이되 휴식을 막지 않는다.
  //  - 종일 일정은 설정(종일 일정도 바쁨으로)을 켰을 때만 막는다.
  // 예전엔 이 둘을 목록에서 아예 빼버려서, 달력 화면에서도 같이 사라졌다.
  const blocking = (occurrences || [])
    .filter((e) => e && !e.free && (opts.allDayBusy || !e.allDay));
  const busy = mergeBusy(blocking, Number.isFinite(opts.joinMs) ? opts.joinMs : JOIN_MS);

  const cur = blockAt(busy, at);
  if (cur) {
    return { kind: 'during', until: cur.end, summary: cur.parts[0], label: labelOf('during', cur) };
  }

  const nx = nextBlock(busy, at);
  if (!nx) return null;

  // 휴식이 끝나고도 여유(leadMs)가 남아야 비로소 "들어갈 자리"가 있는 것이다
  if (nx.start - at < needMs + leadMs) {
    return { kind: 'before', until: nx.end, summary: nx.parts[0], label: labelOf('before', nx) };
  }
  return null;
}

/** 오늘(로컬 기준) 일정만 시간순으로 — 위젯 시트에 보여줄 목록 */
function today(occurrences, at = Date.now()) {
  const d = new Date(at);
  const from = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const to = from + 86_400_000;
  return (occurrences || [])
    .filter((e) => e && e.start < to && e.end > from)
    .sort((a, b) => a.start - b.start)
    .map((e) => ({
      start: e.start,
      end: e.end,
      summary: e.summary || '일정',
      allDay: !!e.allDay,
      done: e.end <= at,
      now: at >= e.start && at < e.end
    }));
}

module.exports = { LEAD_MS, JOIN_MS, mergeBusy, blockAt, nextBlock, check, today };
