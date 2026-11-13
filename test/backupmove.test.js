'use strict';
// 메일 백업 옮기기 — 이전 폴더에서 Hibi 것만 골라 새 폴더로 옮긴다 (src/backupmove.js).
//
// 창도 Electron 도 쓰지 않는다. node 로도, npx electron 으로도 돈다.
// 진짜 임시 폴더(os.tmpdir() 아래 이 시험이 만든 것)만 쓴다. 휴지통은 바꿔 끼운다 — 진짜 휴지통으로 보내지 않는다.
//   [1] plan — Hibi 것만 고른다, 수·크기   [2] 같은 볼륨 — 바꿔 달기(rename)   [3] 다른 볼륨(EXDEV) — 복사·확인·시각 지키기
//   [4] 복사가 도중에 실패 — 새 폴더는 그 전 그대로, 이전 폴더는 바이트까지 그대로   [5] 크기·내용이 다른 사본을 잡는다
//   [6] Hibi 것이 아닌 항목은 남기고 이전 폴더도 남긴다   [7] 겹치면 거절 (계획 뒤에 생긴 것도 덮지 않는다)
//   [8] 안팎으로 겹친 폴더는 거절   [9] 공간이 모자라면 거절   [10] 휴지통 실패를 알린다   [11] 진행 보고
//   [12] 바꿔 달기가 도중에 실패하면 되돌리고 복사로   [13] 이름이 같은 모듈의 값과 같다
//   [14] 순서 — 계정 폴더 먼저, 상태·정리 기록은 맨 나중 (메일함 안에서는 색인이 맨 나중)   [15] 옮기기 일지
//   [16] 복사 도중에 꺼진 뒤 — 다시 고르면 이어서   [17] 바꿔 달기 도중에 꺼진 뒤 — 이어서   [18] 되돌리기가 막히면
//   [19] 사본을 디스크로 내린 뒤 확인한다 (읽기 전용 원본도)   [20] 설정에 없는 폴더는 Hibi 꼴일 때만   [21] 맞지 않는 일지
//   [22] «옮기기 멈춤»을 남기지 못하면 바꿔 달지 않는다   [23] 계획 뒤에 파일 수가 바뀌면   [24] 링크 (lstat 을 바꿔 끼운다 — 진짜 링크는 만들지 않는다)
//   [25] 메일함 하나에만 사용자 파일이 섞인 폴더   [26] 복사 함수가 시각을 지키지 않아도 원본 시각으로 맞춘다
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const bm = require(path.join(ROOT, 'src', 'backupmove.js'));

let bad = 0;
const ok = (c, m, x) => {
  console.log((c ? '  OK   ' : '  실패 ') + m + (x === undefined ? '' : `  → ${JSON.stringify(x)}`));
  if (!c) bad++;
};
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(5);
  }
  return !!fn();
}
// 옮기기 일지 — 새 폴더에 두고, 설정을 바꾼 뒤 finish 가 지운다. 폴더 견주기(snap)에서는 뺀다
const JOURNAL = bm.JOURNAL_FILE || '.hibi-옮기는중.json';
const readJ = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, JOURNAL), 'utf8')); } catch { return {}; } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'backupmove-'));
let seq = 0;
const fresh = (name) => {
  const d = path.join(tmp, `${++seq}-${name}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const T0 = new Date('2025-01-02T03:04:05.678Z');
const mk = (root, rel, content, at = T0) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
  fs.utimesSync(f, at, at);
  return f;
};
const ACC1 = '네이버 a@x.invalid';
const ACC2 = '이카운트 b@y.invalid';
const BIG = crypto.randomBytes(1536 * 1024);   // 1MB 를 넘는 메일 하나 — 크기만 확인하는 쪽
/** Hibi 가 만든 것과 사용자가 둔 것이 섞인 이전 폴더 */
function tree(old, { unknown = true } = {}) {
  mk(old, 'backup-state.json', J({ a1: { INBOX: { uidValidity: '1', lastUid: 3, gen: 1 } } }));
  mk(old, 'backup-state.json.bak', '{"old":1}');
  mk(old, 'tidy-moved.json', J({ v: 1, keys: ['k1', 'k2'] }));
  mk(old, `${ACC1}/INBOX/20250101_0900_1_제목.eml`, 'From: a\r\n\r\nbody 1\r\n');
  mk(old, `${ACC1}/INBOX/20250101_0901_2_큰 메일.eml`, BIG);
  mk(old, `${ACC1}/INBOX/.hibi-index.jsonl`, '\n{"meta":true}\n{"uid":1}');
  mk(old, `${ACC1}/보낸편지함/20250102_1000_7.eml`, 'sent 7');
  // 설정에 없는 계정(지운 계정)의 폴더 — 색인 파일로 알아본다
  mk(old, `${ACC2}/INBOX (2)/.hibi-index.jsonl`, '\n{"uid":5}');
  mk(old, `${ACC2}/INBOX (2)/20240101_0000_5_x.eml`, 'five');
  // 받다가 끊긴 메일 조각만 있는 폴더도 Hibi 것이다
  mk(old, '옛 계정 c@z.invalid/INBOX/~받는중-9.part', 'part');
  if (unknown) {
    mk(old, 'my-notes.txt', 'mine');
    mk(old, '사진/a.jpg', 'jpg');
    mk(old, '다른 메일/foo.eml', 'not hibi');   // 이름 꼴이 Hibi 와 다르다
    mk(old, '다른 메일/sub/bar.eml', 'not hibi');
  }
}
const OWNED = ['backup-state.json', 'backup-state.json.bak', 'tidy-moved.json', ACC1, ACC2, '옛 계정 c@z.invalid'].sort();
const OWNED_FILES = 3 + 4 + 2 + 1;
/** 폴더 안 모든 파일 — 상대 경로 → { sha, size, mtime } (폴더는 '/' 로 끝난다) */
function snap(dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (d === dir && e.name === JOURNAL) continue;
      const f = path.join(d, e.name);
      const rel = path.relative(dir, f);
      if (e.isDirectory()) {
        out[`${rel}/`] = true;
        walk(f);
      } else {
        const b = fs.readFileSync(f);
        out[rel] = { sha: crypto.createHash('sha256').update(b).digest('hex'), size: b.length, mtime: Math.round(fs.statSync(f).mtimeMs) };
      }
    }
  };
  walk(dir);
  return out;
}
const pick = (s, keep) => Object.fromEntries(Object.entries(s).filter(([k]) => keep(k.split(/[\\/]/)[0])));
const err = (code) => Object.assign(new Error(`${code}: 시험`), { code });
const roomy = { freeBytes: async () => 1e15 };
/** 바꿔 끼운 휴지통 — 이 시험의 임시 폴더 안 «bin» 으로 옮긴다 */
const binOf = () => {
  const bin = fresh('bin');
  const got = [];
  return { got, trash: async (p) => { got.push(path.basename(p)); await fs.promises.rename(p, path.join(bin, `${got.length}-${path.basename(p)}`)); } };
};

(async () => {
  console.log('\n[1] plan — Hibi 것만 고른다');
  {
    const old = fresh('old');
    const to = fresh('to');
    tree(old);
    mk(old, bm.PROBE_FILE, 'ok');
    const pl = await bm.plan(old, to, { known: [ACC1.toUpperCase()], ...roomy });
    const names = pl.entries.map((e) => e.name).sort();
    ok(J(names) === J([...OWNED, bm.PROBE_FILE].sort()), '상태 파일·정리 기록·쓰기 확인 파일·계정 폴더(설정에 있는 것·색인으로 알아본 것·받는 중 조각)', names);
    ok(J(pl.unknown.slice().sort()) === J(['my-notes.txt', '사진', '다른 메일'].sort()), '사용자 파일·사진 폴더·이름 꼴이 다른 .eml 폴더는 모른 척한다', pl.unknown);
    const bytes = [J({ a1: { INBOX: { uidValidity: '1', lastUid: 3, gen: 1 } } }), '{"old":1}', J({ v: 1, keys: ['k1', 'k2'] }),
      'From: a\r\n\r\nbody 1\r\n', BIG, '\n{"meta":true}\n{"uid":1}', 'sent 7', '\n{"uid":5}', 'five', 'part', 'ok']
      .reduce((n, x) => n + Buffer.byteLength(x), 0);
    ok(pl.files === OWNED_FILES + 1 && pl.bytes === bytes, '파일 수·크기는 옮길 것만 센다', { files: pl.files, bytes: pl.bytes, want: bytes });
    ok(pl.problem === null && pl.sameVolume === true && J(pl.collide) === '[]', '같은 볼륨, 문제 없음', pl.problem);
    const acc = pl.entries.find((e) => e.name === ACC1);
    ok(acc.dir === true && acc.files === 4 && pl.entries.find((e) => e.name === 'tidy-moved.json').dir === false, '항목마다 폴더인지·파일 수', acc);
    const none = await bm.plan(path.join(tmp, '없는 폴더'), to, roomy);
    ok(none.entries.length === 0 && none.problem === null, '이전 폴더가 없으면 옮길 것이 없다');
    const onlyMine = fresh('mine');
    mk(onlyMine, 'a.txt', 'x');
    const pm = await bm.plan(onlyMine, to, roomy);
    ok(pm.entries.length === 0 && J(pm.unknown) === '["a.txt"]', '사용자 파일만 있으면 옮길 것이 없다', pm.unknown);
    const empty = fresh('empty-known');
    fs.mkdirSync(path.join(empty, ACC1));
    const pe = await bm.plan(empty, to, { known: [ACC1], ...roomy });
    ok(J(pe.entries.map((e) => e.name)) === J([ACC1]) && pe.files === 0, '설정에 있는 계정의 빈 폴더도 Hibi 것이다');
    ok(bm.sizeText(0) === '0KB' && bm.sizeText(1536) === '2KB' && bm.sizeText(5 * 1024 ** 2) === '5.0MB' && bm.sizeText(1.16 * 1024 ** 3) === '1.16GB', 'sizeText', [bm.sizeText(1536), bm.sizeText(1.16 * 1024 ** 3)]);
  }

  console.log('\n[2] 같은 볼륨 — 바꿔 달기');
  {
    const old = fresh('old');
    const to = fresh('to');
    tree(old);
    const before = snap(old);
    const pl = await bm.plan(old, to, { known: [ACC1], ...roomy });
    const seen = [];
    const r = await bm.run(pl, { onProgress: (p) => seen.push({ ...p }), ...roomy });
    ok(r.ok && r.mode === 'rename' && r.files === OWNED_FILES && r.bytes === pl.bytes, '바꿔 달았다', r);
    ok(J(snap(to)) === J(pick(before, (top) => OWNED.includes(top))), '새 폴더에 Hibi 것이 바이트·시각까지 그대로', Object.keys(snap(to)).length);
    ok(J(snap(old)) === J(pick(before, (top) => !OWNED.includes(top))), '이전 폴더에는 사용자 것만 남는다', Object.keys(snap(old)));
    ok(seen.length >= 1 && seen[seen.length - 1].done === pl.files && seen[seen.length - 1].total === pl.files, '진행 보고 — 끝에는 다 옮김', seen[seen.length - 1]);
    const b = binOf();
    const c = await bm.cleanup(pl, r, { trash: b.trash });
    ok(b.got.length === 0 && c.removed === false && J(c.trashFailed) === '[]' && fs.existsSync(old), '바꿔 달기는 휴지통에 보낼 것이 없다 — 사용자 것이 남아 이전 폴더도 남는다', c);

    const old2 = fresh('old');
    const to2 = fresh('to');
    tree(old2, { unknown: false });
    const pl2 = await bm.plan(old2, to2, { known: [ACC1], ...roomy });
    const r2 = await bm.run(pl2, roomy);
    const c2 = await bm.cleanup(pl2, r2, { trash: binOf().trash });
    ok(r2.ok && c2.removed === true && !fs.existsSync(old2), '…다 옮겨 비면 이전 폴더를 지운다 (빈 폴더만)', c2);
  }

  console.log('\n[3] 다른 볼륨 — 복사·확인·시각 지키기');
  {
    const old = fresh('old');
    const to = fresh('to');
    tree(old);
    const dirAt = new Date('2024-06-01T00:00:00.000Z');
    fs.utimesSync(path.join(old, ACC1, 'INBOX'), dirAt, dirAt);
    const before = snap(old);
    const pl = await bm.plan(old, to, { known: [ACC1], ...roomy });
    let renames = 0;
    const io = { rename: async () => { renames += 1; throw err('EXDEV'); } };
    const seen = [];
    const r = await bm.run(pl, { io, onProgress: (p) => seen.push({ ...p }), ...roomy });
    ok(r.ok && r.mode === 'copy' && r.files === OWNED_FILES && renames === 1, 'EXDEV 면 복사로 — 바꿔 달기는 한 번만 해 본다', { r, renames });
    ok(J(snap(to)) === J(pick(before, (top) => OWNED.includes(top))), '사본은 바이트·크기·수정 시각까지 같다');
    ok(J(snap(old)) === J(before), '…이전 폴더는 아직 그대로 (휴지통은 설정을 바꾼 뒤에)');
    const inboxAt = fs.statSync(path.join(to, ACC1, 'INBOX')).mtimeMs;
    ok(Math.abs(inboxAt - dirAt.getTime()) < 2, '메일함 폴더의 수정 시각도 지킨다 (옛 파일 스캔이 다시 돌지 않게)', [inboxAt, dirAt.getTime()]);
    ok(seen.filter((p) => p.phase === 'copy').length === OWNED_FILES && seen[seen.length - 1].done === OWNED_FILES, '파일마다 진행 보고', seen.length);
    const b = binOf();
    const c = await bm.cleanup(pl, r, { trash: b.trash });
    ok(J(b.got.slice().sort()) === J(OWNED) && J(c.trashFailed) === '[]' && c.removed === false, '옮긴 항목만 하나씩 휴지통으로 — 사용자 것은 남는다', b.got);
    ok(J(snap(old)) === J(pick(before, (top) => !OWNED.includes(top))), '…이전 폴더에는 사용자 것만');
  }

  console.log('\n[4] 복사가 도중에 실패');
  for (const how of ['fail', 'partial']) {
    const old = fresh('old');
    const to = fresh('to');
    tree(old);
    mk(to, '내 파일.txt', 'theirs');
    const beforeOld = snap(old);
    const beforeTo = snap(to);
    const pl = await bm.plan(old, to, { known: [ACC1], ...roomy, sameVolume: false });
    let n = 0;
    const io = {
      copyFile: async (s, d, flags) => {
        n += 1;
        if (n === 4) {
          if (how === 'partial') await fs.promises.writeFile(d, 'half');
          throw err('ENOSPC');
        }
        return fs.promises.copyFile(s, d, flags);
      }
    };
    const r = await bm.run(pl, { io, ...roomy });
    ok(!r.ok && /ENOSPC/.test(r.error) && r.left === 0, `${how === 'partial' ? '반쯤 쓴 뒤' : '넷째 파일에서'} 실패 — 실패를 돌려준다`, r);
    ok(J(snap(to)) === J(beforeTo), '…새 폴더는 그 전 그대로 (만든 파일·폴더만 지웠다)', Object.keys(snap(to)));
    ok(J(snap(old)) === J(beforeOld), '…이전 폴더는 바이트까지 그대로');
  }

  console.log('\n[5] 크기·내용이 다른 사본을 잡는다');
  for (const how of ['size', 'bytes']) {
    const old = fresh('old');
    const to = fresh('to');
    tree(old);
    const beforeOld = snap(old);
    const pl = await bm.plan(old, to, { known: [ACC1], ...roomy, sameVolume: false });
    const io = {
      copyFile: async (s, d, flags) => {
        await fs.promises.copyFile(s, d, flags);
        if (how === 'size' && path.basename(s).includes('큰 메일')) await fs.promises.truncate(d, BIG.length - 1);
        if (how === 'bytes' && path.basename(s) === 'tidy-moved.json') {
          const b = await fs.promises.readFile(d);
          b[0] ^= 1;
          await fs.promises.writeFile(d, b);
        }
      }
    };
    const r = await bm.run(pl, { io, ...roomy });
    ok(!r.ok && (how === 'size' ? /크기/.test(r.error) : /내용/.test(r.error)), how === 'size' ? '큰 메일의 크기가 다르면 실패' : '작은 파일(1MB 미만)은 바이트까지 본다', r.error);
    ok(J(snap(to)) === '{}' && J(snap(old)) === J(beforeOld), '…새 폴더는 비고 이전 폴더는 그대로');
  }

  console.log('\n[6] Hibi 것이 아닌 항목');
  {
    const old = fresh('old');
    const to = fresh('to');
    tree(old);
    const pl = await bm.plan(old, to, { known: [ACC1], ...roomy, sameVolume: false });
    const r = await bm.run(pl, roomy);
    const c = await bm.cleanup(pl, r, { trash: binOf().trash });
    ok(r.ok && pl.unknown.length === 3 && c.removed === false && J(fs.readdirSync(old).sort()) === J(pl.unknown.slice().sort()), '남긴 것은 그 자리에, 이전 폴더도 남는다', fs.readdirSync(old));
    ok(!fs.readdirSync(to).some((x) => pl.unknown.includes(x)), '…새 폴더로 가지 않는다');
  }

  console.log('\n[7] 겹치면 거절');
  {
    const old = fresh('old');
    const to = fresh('to');
    tree(old);
    mk(to, process.platform === 'win32' ? 'BACKUP-STATE.JSON' : 'backup-state.json', 'theirs');
    const beforeOld = snap(old);
    const beforeTo = snap(to);
    const pl = await bm.plan(old, to, { known: [ACC1], ...roomy });
    ok(/이미/.test(pl.problem || '') && pl.collide.length === 1, '새 폴더에 같은 이름이 있으면 문제 (윈도우는 대소문자를 안 가린다)', pl.problem);
    const r = await bm.run(pl, roomy);
    ok(!r.ok && r.error === pl.problem && J(snap(old)) === J(beforeOld) && J(snap(to)) === J(beforeTo), '…run 도 아무것도 안 한다', r);

    // 계획 뒤에 새 폴더에 생긴 것 — 바꿔 달기도 복사도 덮어쓰지 않는다
    for (const same of [true, false]) {
      const o2 = fresh('old');
      const t2 = fresh('to');
      tree(o2);
      const b2 = snap(o2);
      const p2 = await bm.plan(o2, t2, { known: [ACC1], ...roomy, sameVolume: same });
      mk(t2, 'tidy-moved.json', 'theirs');
      const r2 = await bm.run(p2, roomy);
      ok(!r2.ok && fs.readFileSync(path.join(t2, 'tidy-moved.json'), 'utf8') === 'theirs' && J(snap(o2)) === J(b2)
        && J(fs.readdirSync(t2)) === '["tidy-moved.json"]', `${same ? '바꿔 달기' : '복사'} — 계획 뒤에 생긴 같은 이름을 덮지 않고, 옮긴 것은 되돌린다`, r2.error);
    }
  }

  console.log('\n[8] 안팎으로 겹친 폴더');
  {
    const old = fresh('old');
    tree(old);
    const inner = path.join(old, '새 백업');
    fs.mkdirSync(inner);
    const p1 = await bm.plan(old, inner, { known: [ACC1], ...roomy });
    ok(/안에/.test(p1.problem || ''), '새 폴더가 이전 폴더 안 — 거절', p1.problem);
    if (process.platform === 'win32') {
      const p1b = await bm.plan(old, inner.toUpperCase(), { known: [ACC1], ...roomy });
      ok(/안에/.test(p1b.problem || ''), '…대소문자만 달라도 거절', p1b.problem);
    }
    const outer = fresh('outer');
    const o2 = path.join(outer, '옛 백업');
    tree(o2);
    const p2 = await bm.plan(o2, outer, { known: [ACC1], ...roomy });
    ok(/안에/.test(p2.problem || ''), '이전 폴더가 새 폴더 안 — 거절', p2.problem);
    ok(bm.inside('D:\\a\\b', 'D:\\') && bm.inside('C:\\X\\y', 'c:\\x') === (process.platform === 'win32') && !bm.inside('C:\\xy', 'C:\\x') && !bm.inside('C:\\x', 'C:\\x'),
      'inside — 드라이브 뿌리, 옆 폴더(xy)는 아니고 같은 폴더도 아니다');
  }

  console.log('\n[9] 공간');
  {
    const old = fresh('old');
    const to = fresh('to');
    tree(old);
    const beforeOld = snap(old);
    const pl = await bm.plan(old, to, { known: [ACC1], sameVolume: false, freeBytes: async () => 1000 });
    ok(/공간이 모자랍니다/.test(pl.problem || '') && pl.need >= pl.bytes + 256 * 1024 ** 2, '다른 볼륨인데 남은 공간 < 크기 + 여유면 거절', { problem: pl.problem, need: pl.need });
    const same = await bm.plan(old, to, { known: [ACC1], sameVolume: true, freeBytes: async () => 1000 });
    ok(same.problem === null, '같은 볼륨은 공간을 보지 않는다 (바꿔 달기)');
    let frees = 0;
    const r = await bm.run(same, { io: { rename: async () => { throw err('EPERM'); } }, freeBytes: async () => { frees += 1; return 1000; } });
    ok(!r.ok && /공간이 모자랍니다/.test(r.error) && frees === 1 && J(snap(old)) === J(beforeOld) && J(snap(to)) === '{}', '…바꿔 달기가 막혀 복사로 가려면 그때 공간을 본다', r.error);
    const unk = await bm.plan(old, to, { known: [ACC1], sameVolume: false, freeBytes: async () => { throw err('EIO'); } });
    ok(/공간/.test(unk.problem || ''), '남은 공간을 모르면 거절', unk.problem);
  }

  console.log('\n[10] 휴지통 실패');
  {
    const old = fresh('old');
    const to = fresh('to');
    tree(old, { unknown: false });
    const pl = await bm.plan(old, to, { known: [ACC1], ...roomy, sameVolume: false });
    const r = await bm.run(pl, roomy);
    const b = binOf();
    const c = await bm.cleanup(pl, r, { trash: async (p) => { if (path.basename(p) === ACC2) throw new Error('휴지통 막힘'); return b.trash(p); } });
    ok(r.ok && J(c.trashFailed) === J([ACC2]) && c.removed === false && fs.existsSync(path.join(old, ACC2)), '못 보낸 항목을 알려 주고 그 자리에 둔다', c);
    ok(J(fs.readdirSync(old)) === J([ACC2]), '…나머지는 보냈다');
  }

  console.log('\n[11] 진행 보고');
  {
    const old = fresh('old');
    const to = fresh('to');
    tree(old);
    const pl = await bm.plan(old, to, { known: [ACC1], ...roomy, sameVolume: false });
    const seen = [];
    await bm.run(pl, { onProgress: (p) => seen.push({ ...p }), ...roomy });
    await bm.finish(pl);   // 부르는 쪽처럼 마친다 — 아래에서 같은 새 폴더를 다시 쓴다 (일지가 남아 있으면 남의 조각으로 본다)
    const copy = seen.filter((p) => p.phase === 'copy');
    ok(copy.every((p, i) => i === 0 || (p.done >= copy[i - 1].done && p.bytes >= copy[i - 1].bytes)), '수와 바이트가 줄지 않는다');
    ok(copy.every((p) => p.total === pl.files && p.totalBytes === pl.bytes) && copy[copy.length - 1].bytes === pl.bytes, '전체 수·크기를 같이 준다', copy[copy.length - 1]);
    ok(seen.some((p) => p.phase === 'verify'), '확인 단계도 알린다');
    let threw = false;
    const r = await bm.run(await bm.plan(fresh('o'), to, roomy), { onProgress: () => { threw = true; throw new Error('x'); }, ...roomy });
    ok(r.ok && r.files === 0 && !threw, '옮길 것이 없으면 아무것도 안 하고 성공');
    const old3 = fresh('old');
    tree(old3, { unknown: false });
    const r3 = await bm.run(await bm.plan(old3, fresh('to'), { known: [ACC1], ...roomy }), { onProgress: () => { throw new Error('화면 오류'); }, ...roomy });
    ok(r3.ok, '진행 보고가 던져도 옮기기는 끝난다');
  }

  console.log('\n[12] 바꿔 달기가 도중에 실패');
  {
    const old = fresh('old');
    const to = fresh('to');
    tree(old);
    const before = snap(old);
    const pl = await bm.plan(old, to, { known: [ACC1], ...roomy });
    let k = 0;
    const calls = [];
    const io = { rename: async (s, d) => { k += 1; calls.push(path.basename(s)); if (k === 2) throw err('EPERM'); return fs.promises.rename(s, d); } };
    const r = await bm.run(pl, { io, ...roomy });
    ok(r.ok && r.mode === 'copy' && calls.length === 3 && calls[2] === calls[0], '둘째에서 막히면 첫째를 되돌리고 복사로', { mode: r.mode, calls });
    ok(J(snap(to)) === J(pick(before, (top) => OWNED.includes(top))) && J(snap(old)) === J(before), '…새 폴더에 다 있고 이전 폴더는 휴지통 전까지 그대로');
  }

  console.log('\n[13] 다른 모듈의 이름과 같다');
  {
    const mailbackup = require(path.join(ROOT, 'src', 'mailbackup.js'));
    const mailtidy = require(path.join(ROOT, 'src', 'mailtidy.js'));
    const mailindex = require(path.join(ROOT, 'src', 'mailindex.js'));
    ok(bm.OWN_FILES.includes(mailbackup.STATE_FILE) && bm.OWN_FILES.includes(`${mailbackup.STATE_FILE}.bak`) && bm.OWN_FILES.includes(`${mailbackup.STATE_FILE}.tmp`)
      && bm.OWN_FILES.includes(`${mailbackup.STATE_FILE}.broken`) && bm.OWN_FILES.includes(mailtidy.MOVED_FILE) && bm.OWN_FILES.includes(`${mailtidy.MOVED_FILE}.tmp`)
      && bm.OWN_FILES.includes(bm.PROBE_FILE), 'Hibi 가 폴더 맨 위에 쓰는 파일 — 상태(.bak·.tmp·.broken)·정리 기록(.tmp)·쓰기 확인', bm.OWN_FILES);
    ok(bm.INDEX_FILE === mailindex.INDEX_FILE, '색인 파일 이름이 mailindex 와 같다');
    const backupSrc = fs.readFileSync(path.join(ROOT, 'src', 'backup.js'), 'utf8');
    ok(backupSrc.includes('backupmove.PROBE_FILE') && !backupSrc.includes("'.hibi-쓰기확인'"), '쓰기 확인 파일 이름은 한 곳(backupmove)에 둔다');
  }

  console.log('\n[14] 순서 — 계정 폴더 먼저, 상태·정리 기록은 맨 나중');
  {
    const old = fresh('old');
    const to = fresh('to');
    tree(old, { unknown: false });
    const pl = await bm.plan(old, to, { known: [ACC1], ...roomy, sameVolume: false });
    const kinds = pl.entries.map((e) => e.dir);
    ok(kinds.indexOf(false) > kinds.lastIndexOf(true), '계획 — 계정 폴더 먼저, 파일은 뒤', pl.entries.map((e) => e.name));
    const order = [];
    const io = { copyFile: async (s, d, f) => { order.push(path.relative(to, d)); return fs.promises.copyFile(s, d, f); } };
    const r = await bm.run(pl, { io, ...roomy });
    const lastMail = Math.max(...order.map((x, i) => (x.split(/[\\/]/).length > 1 ? i : -1)));
    ok(r.ok && order.indexOf('backup-state.json') > lastMail && order.indexOf('tidy-moved.json') > lastMail,
      '복사 — 상태 파일·정리 기록은 계정 폴더를 다 복사한 뒤 (꺼져도 조각이 «다 받은 백업»처럼 보이지 않게)', order);
    const inBox = order.filter((x) => path.dirname(x) === path.join(ACC1, 'INBOX'));
    ok(inBox.length === 3 && path.basename(inBox[inBox.length - 1]) === bm.INDEX_FILE, '…메일함 안에서는 색인을 맨 나중에 (메일 파일 다음)', inBox);
    const old2 = fresh('old');
    const to2 = fresh('to');
    tree(old2, { unknown: false });
    const p2 = await bm.plan(old2, to2, { known: [ACC1], ...roomy, sameVolume: true });
    const ren = [];
    const r2 = await bm.run(p2, { io: { rename: async (s, d) => { if (path.dirname(s) === old2) ren.push(path.basename(s)); return fs.promises.rename(s, d); } }, ...roomy });
    const isDir = (n) => (p2.entries.find((e) => e.name === n) || {}).dir === true;
    ok(r2.ok && ren.length === p2.entries.length && ren.findIndex((n) => !isDir(n)) > ren.map(isDir).lastIndexOf(true), '바꿔 달기도 — 계정 폴더 먼저, 파일은 뒤', ren);
  }

  console.log('\n[15] 옮기기 일지');
  {
    const old = fresh('old');
    const to = fresh('to');
    tree(old, { unknown: false });
    const pl = await bm.plan(old, to, { known: [ACC1], ...roomy, sameVolume: false });
    let seen = null;
    const io = { copyFile: async (s, d, f) => { if (seen === null) seen = fs.existsSync(path.join(to, JOURNAL)); return fs.promises.copyFile(s, d, f); } };
    const r = await bm.run(pl, { io, ...roomy });
    const j = readJ(to);
    ok(r.ok && seen === true, '복사하기 전에 새 폴더에 일지를 먼저 쓴다', seen);
    ok(typeof j.from === 'string' && path.resolve(j.from) === path.resolve(old) && J((j.entries || []).slice().sort()) === J(pl.entries.map((e) => e.name).sort()),
      '…일지에는 이전 폴더와 옮기는 항목 이름', j);
    ok(fs.existsSync(path.join(to, JOURNAL)), '…옮긴 뒤에도 남는다 (설정을 바꾼 뒤 finish 가 지운다)');
    const fin = typeof bm.finish === 'function' ? await bm.finish(pl) : false;
    ok(fin === true && !fs.existsSync(path.join(to, JOURNAL)) && J(fs.readdirSync(to).sort()) === J(OWNED.slice().sort()), 'finish — 일지만 지운다', fs.readdirSync(to));
    const old2 = fresh('old');
    const to2 = fresh('to');
    tree(old2, { unknown: false });
    const p2 = await bm.plan(old2, to2, { known: [ACC1], ...roomy, sameVolume: false });
    let n = 0;
    const r2 = await bm.run(p2, { io: { copyFile: async (s, d, f) => { n += 1; if (n === 2) throw err('ENOSPC'); return fs.promises.copyFile(s, d, f); } }, ...roomy });
    ok(!r2.ok && J(fs.readdirSync(to2)) === '[]', '복사가 실패하면 일지도 지운다 — 새 폴더는 그 전 그대로', fs.readdirSync(to2));
  }

  console.log('\n[16] 복사 도중에 꺼진 뒤 — 다시 고르면 이어서');
  {
    const old = fresh('old');
    const to = fresh('to');
    tree(old);
    const before = snap(old);
    const pl = await bm.plan(old, to, { known: [ACC1], ...roomy, sameVolume: false });
    let n = 0;
    const io = { copyFile: async (s, d, f) => { n += 1; await fs.promises.copyFile(s, d, f); if (n === 3) await new Promise(() => {}); } };
    // 끝나지 않는다 — 셋째 파일에서 앱이 꺼진 셈 (실패 정리도 돌지 않는다)
    bm.run(pl, { io, ...roomy });
    await until(() => n >= 3);
    const left = fs.readdirSync(to);
    ok(!left.includes('backup-state.json') && !left.includes('tidy-moved.json'), '꺼진 자리 — 상태 파일·정리 기록은 아직 새 폴더에 없다', left);
    ok(left.includes(JOURNAL), '…일지가 남아 있다', left);
    const p2 = await bm.plan(old, to, { known: [ACC1], ...roomy, sameVolume: false });
    ok(p2.problem === null && p2.resume === true && Array.isArray(p2.stale) && p2.stale.length === 1 && J(p2.done) === '[]',
      '다시 계획 — 겹침이 아니라 «이어서»: 남은 조각은 지우고 다시 복사', { problem: p2.problem, stale: p2.stale, done: p2.done });
    const r2 = await bm.run(p2, roomy);
    ok(r2.ok && J(snap(to)) === J(pick(before, (top) => OWNED.includes(top))), '…이어서 옮겼다 — 새 폴더는 원본과 바이트·시각까지 같다', r2);
    ok(J(snap(old)) === J(before), '…이전 폴더는 그대로 (휴지통은 설정을 바꾼 뒤에)');
  }

  console.log('\n[17] 바꿔 달기 도중에 꺼진 뒤 — 다시 고르면 이어서');
  {
    const old = fresh('old');
    const to = fresh('to');
    tree(old);
    const before = snap(old);
    const pl = await bm.plan(old, to, { known: [ACC1], ...roomy });
    const holds = [];
    let k = 0;
    const io = { rename: async (s, d) => { k += 1; if (k === 2) await new Promise(() => {}); return fs.promises.rename(s, d); } };
    bm.run(pl, { io, ...roomy, hold: { on: async () => { holds.push('on'); return true; }, off: async () => { holds.push('off'); } } });
    await until(() => k >= 2);
    const first = pl.entries[0].name;
    ok(J(holds) === '["on"]', '바꿔 달기 전에 «옮기기 멈춤»을 남긴다 (hold.on)', holds);
    ok(pl.entries[0].dir === true && J(readJ(to).renamed) === J([first]) && fs.existsSync(path.join(to, first)) && !fs.existsSync(path.join(old, first)),
      '…계정 폴더부터 바꿔 달고 일지에 적는다', readJ(to));
    const p2 = await bm.plan(old, to, { known: [ACC1], ...roomy });
    ok(p2.problem === null && p2.resume === true && J(p2.done) === J([first]) && !p2.entries.some((e) => e.name === first),
      '다시 계획 — 바꿔 단 것은 «다 옮김», 나머지만 옮긴다', { problem: p2.problem, done: p2.done });
    const r2 = await bm.run(p2, roomy);
    ok(r2.ok && J(snap(to)) === J(pick(before, (top) => OWNED.includes(top))) && J(snap(old)) === J(pick(before, (top) => !OWNED.includes(top))), '…이어서 다 옮겼다', r2);
  }

  console.log('\n[18] 되돌리기가 막히면');
  {
    // (가) 잠김은 잠깐씩 다시 해 본다 — 풀리면 다 되돌리고 복사로
    const old = fresh('old');
    const to = fresh('to');
    tree(old);
    const before = snap(old);
    const pl = await bm.plan(old, to, { known: [ACC1], ...roomy });
    const holds = [];
    let fwd = 0;
    let backTries = 0;
    const io = {
      rename: async (s, d) => {
        if (path.dirname(s) === old) { fwd += 1; if (fwd === 3) throw err('EPERM'); } else if (backTries++ < 2) throw err('EBUSY');
        return fs.promises.rename(s, d);
      }
    };
    const r = await bm.run(pl, { io, ...roomy, retryMs: [1, 1, 1], hold: { on: async () => { holds.push('on'); return true; }, off: async () => { holds.push('off'); } } });
    ok(r.ok && r.mode === 'copy' && backTries >= 3, '되돌리기가 잠겨도 다시 해 봐서 다 되돌리고 복사로', { r, backTries });
    ok(J(snap(to)) === J(pick(before, (top) => OWNED.includes(top))) && J(snap(old)) === J(before), '…새 폴더에 다 있고 이전 폴더는 그대로');
    ok(J(holds) === '["on","off"]', '…다 되돌렸으니 «옮기기 멈춤»을 푼다', holds);

    // (나) 끝내 못 되돌린 항목 — 나머지는 계속 되돌리고 split 으로 알린다
    const o2 = fresh('old');
    const t2 = fresh('to');
    tree(o2);
    const b2 = snap(o2);
    const p2 = await bm.plan(o2, t2, { known: [ACC1], ...roomy });
    const n2 = p2.entries.map((e) => e.name);
    const h2 = [];
    let f2 = 0;
    const io2 = {
      rename: async (s, d) => {
        if (path.dirname(s) === o2) { f2 += 1; if (f2 === 3) throw err('EPERM'); } else if (path.basename(s) === n2[1]) throw err('EBUSY');
        return fs.promises.rename(s, d);
      }
    };
    const r2 = await bm.run(p2, { io: io2, ...roomy, retryMs: [1, 1], hold: { on: async () => { h2.push('on'); return true; }, off: async () => { h2.push('off'); } } });
    ok(!r2.ok && r2.split === true && J(r2.stuck) === J([n2[1]]), '못 되돌린 항목을 알린다', r2);
    ok(fs.existsSync(path.join(o2, n2[0])) && !fs.existsSync(path.join(t2, n2[0])), '…첫 실패 뒤에도 나머지는 되돌렸다');
    ok(J(h2) === '["on"]', '…«옮기기 멈춤»은 그대로 둔다', h2);
    ok(J(readJ(t2).renamed) === J([n2[1]]), '…일지에 새 폴더에 남은 항목', readJ(t2));
    const p3 = await bm.plan(o2, t2, { known: [ACC1], ...roomy });
    const r3 = await bm.run(p3, roomy);
    ok(p3.resume === true && J(p3.done) === J([n2[1]]) && r3.ok && J(snap(t2)) === J(pick(b2, (top) => OWNED.includes(top))), '다시 고르면 이어서 다 옮긴다', { done: p3.done, r3 });
  }

  console.log('\n[19] 사본을 디스크로 내린 뒤 확인한다');
  {
    const old = fresh('old');
    const to = fresh('to');
    tree(old, { unknown: false });
    const ro = path.join(old, ACC1, 'INBOX', '20250101_0900_1_제목.eml');
    fs.chmodSync(ro, 0o444);
    const pl = await bm.plan(old, to, { known: [ACC1], ...roomy, sameVolume: false });
    const synced = [];
    let verifyAt = -1;
    const io = {
      open: async (p, flags, mode) => {
        const fh = await fs.promises.open(p, flags, mode);
        const real = fh.sync.bind(fh);
        fh.sync = async () => { synced.push(path.relative(to, p)); return real(); };
        return fh;
      }
    };
    const r = await bm.run(pl, { io, ...roomy, onProgress: (q) => { if (q.phase === 'verify' && verifyAt < 0) verifyAt = synced.length; } });
    const files = synced.filter((x) => !x.startsWith(JOURNAL));
    ok(r.ok && new Set(files).size === OWNED_FILES, '복사한 파일마다 디스크로 내린다 (fsync)', files.length);
    ok(verifyAt >= OWNED_FILES, '…확인하기 전에', verifyAt);
    const copy = path.join(to, ACC1, 'INBOX', '20250101_0900_1_제목.eml');
    const mode = fs.existsSync(copy) ? fs.statSync(copy).mode : 0o666;
    ok(r.ok && (mode & 0o200) === 0, '읽기 전용 원본도 옮긴다 — 사본도 읽기 전용 그대로', mode.toString(8));
    fs.chmodSync(ro, 0o666);
    if (fs.existsSync(copy)) fs.chmodSync(copy, 0o666);
  }

  console.log('\n[20] 설정에 없는 폴더는 Hibi 꼴일 때만');
  {
    const old = fresh('old');
    const to = fresh('to');
    mk(old, 'backup-state.json', '{}');
    mk(old, `${ACC1}/INBOX/20250101_0900_1_x.eml`, 'one');
    mk(old, '보관/내 문서.docx', 'doc');
    mk(old, '보관/옛 메일/20230101_0900_7_y.eml', 'seven');
    mk(old, '섞인 계정 c@z.invalid/INBOX/20230101_0900_8_z.eml', 'eight');
    mk(old, '섞인 계정 c@z.invalid/INBOX/메모.txt', 'note');
    mk(old, '지운 계정 e@f.invalid/INBOX/.hibi-index.jsonl', '\n{"uid":9}');
    mk(old, '지운 계정 e@f.invalid/INBOX/20230101_0900_9_w.eml', 'nine');
    mk(old, '지운 계정 e@f.invalid/INBOX/20230101_0900_10_v.eml.damaged', 'ten');
    mk(old, '지운 계정 e@f.invalid/보낸편지함/.hibi-index.jsonl', '\n');
    const pl = await bm.plan(old, to, { known: [ACC1], ...roomy });
    const names = pl.entries.map((e) => e.name).sort();
    ok(J(names) === J([ACC1, 'backup-state.json', '지운 계정 e@f.invalid'].sort()), '설정에 없는 폴더는 메일함 폴더에 Hibi 파일만 있을 때 옮긴다', names);
    ok(J(pl.unknown.slice().sort()) === J(['보관', '섞인 계정 c@z.invalid'].sort()), '…사용자 파일이 섞인 폴더(맨 위 문서·메일함 안 메모)는 그대로 둔다', pl.unknown);
  }

  console.log('\n[21] 맞지 않는 일지');
  {
    const old = fresh('old');
    const to = fresh('to');
    tree(old, { unknown: false });
    mk(to, JOURNAL, J({ v: 1, from: path.join(tmp, '다른 폴더'), entries: ['x'], renamed: [] }));
    const pl = await bm.plan(old, to, { known: [ACC1], ...roomy });
    ok(/멈춘/.test(pl.problem || '') && pl.partial === true, '다른 폴더에서 옮기다 멈춘 조각이 있는 폴더 — 거절 (새 폴더만 쓰기도 내지 않는다)', pl.problem);
    const r = await bm.run(pl, roomy);
    ok(!r.ok && J(fs.readdirSync(to)) === J([JOURNAL]), '…run 도 아무것도 안 한다', fs.readdirSync(to));
    // 일지의 조각인데 이전 폴더에 원본이 없다 — 그것이 남은 사본일 수 있어 지우지 않는다
    const o2 = fresh('old');
    const t2 = fresh('to');
    tree(o2, { unknown: false });
    mk(t2, JOURNAL, J({ v: 1, from: o2, entries: ['사라진 계정 g@h.invalid'], renamed: [] }));
    mk(t2, '사라진 계정 g@h.invalid/INBOX/20230101_0900_3_q.eml', 'q');
    const p2 = await bm.plan(o2, t2, { known: [ACC1], ...roomy });
    ok(!!p2.problem && p2.partial === true, '원본이 없는 조각 — 거절', p2.problem);
    const r2 = await bm.run(p2, roomy);
    ok(!r2.ok && fs.existsSync(path.join(t2, '사라진 계정 g@h.invalid', 'INBOX', '20230101_0900_3_q.eml')), '…그 조각을 지우지 않는다');
  }

  console.log('\n[22] «옮기기 멈춤»을 남기지 못하면 바꿔 달지 않는다');
  for (const how of ['false', 'throw']) {
    const old = fresh('old');
    const to = fresh('to');
    tree(old);
    const before = snap(old);
    const pl = await bm.plan(old, to, { known: [ACC1], ...roomy });
    const holds = [];
    let renames = 0;
    const io = { rename: async (s, d) => { if (path.dirname(s) === old) renames += 1; return fs.promises.rename(s, d); } };
    const hold = {
      on: async () => { holds.push('on'); if (how === 'throw') throw err('EPERM'); return false; },
      off: async () => { holds.push('off'); }
    };
    const r = await bm.run(pl, { io, ...roomy, hold });
    ok(!r.ok && /설정 파일을 저장하지 못해/.test(r.error || '') && renames === 0 && holds[0] === 'on',
      `hold.on 이 ${how === 'throw' ? '던지면' : '거짓이면'} — 하나도 바꿔 달지 않는다`, { r, renames, holds });
    ok(J(snap(old)) === J(before) && J(fs.readdirSync(to)) === '[]', '…이전 폴더는 그대로, 새 폴더는 비었다 (일지도 지웠다)', fs.readdirSync(to));
  }

  console.log('\n[23] 계획 뒤에 이전 폴더의 파일 수가 바뀌면');
  for (const how of ['gone', 'added']) {
    const old = fresh('old');
    const to = fresh('to');
    tree(old, { unknown: false });
    const pl = await bm.plan(old, to, { known: [ACC1], ...roomy, sameVolume: false });
    if (how === 'gone') fs.unlinkSync(path.join(old, ACC1, '보낸편지함', '20250102_1000_7.eml'));
    else mk(old, `${ACC1}/INBOX/20250103_0900_8_새 메일.eml`, 'eight');
    const before = snap(old);
    const r = await bm.run(pl, roomy);
    ok(!r.ok && /파일 수/.test(r.error || '') && /ECOUNT/.test(r.error || ''), `${how === 'gone' ? '파일 하나가 사라졌다' : '파일 하나가 늘었다'} — 복사는 실패로 끝난다 (ECOUNT)`, r);
    ok(J(fs.readdirSync(to)) === '[]' && J(snap(old)) === J(before), '…새 폴더는 비고(만든 것·일지 지움) 이전 폴더는 그대로', fs.readdirSync(to));
  }

  console.log('\n[24] 링크 — lstat 을 바꿔 끼운다 (진짜 링크는 만들지 않는다)');
  {
    const linkAt = (target) => async (p) => {
      const st = await fs.promises.lstat(p);
      if (path.resolve(p) !== path.resolve(target)) return st;
      return { size: st.size, mode: st.mode, dev: st.dev, atime: st.atime, mtime: st.mtime, isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false };
    };
    const old = fresh('old');
    const to = fresh('to');
    tree(old, { unknown: false });
    const inner = path.join(old, ACC1, 'INBOX', '20250101_0900_1_제목.eml');
    const p1 = await bm.plan(old, to, { known: [ACC1], ...roomy, io: { lstat: linkAt(inner) } });
    ok(/링크/.test(p1.problem || ''), '계정 폴더 안에 링크가 있으면 계획이 거절한다', p1.problem);
    const r1 = await bm.run(p1, roomy);
    ok(!r1.ok && J(fs.readdirSync(to)) === '[]', '…run 도 아무것도 안 한다', r1);
    const before = snap(old);
    const p2 = await bm.plan(old, to, { known: [ACC1], ...roomy, sameVolume: false });
    const r2 = await bm.run(p2, { ...roomy, io: { lstat: linkAt(inner) } });
    ok(!r2.ok && /링크/.test(r2.error || '') && /ELINK/.test(r2.error || ''), '계획 뒤에 링크가 된 것 — 복사가 따라가지 않고 멈춘다', r2.error);
    ok(J(fs.readdirSync(to)) === '[]' && J(snap(old)) === J(before), '…새 폴더는 비고 이전 폴더는 그대로', fs.readdirSync(to));
  }

  console.log('\n[25] 메일함 하나에만 사용자 파일이 섞인 폴더');
  {
    const old = fresh('old');
    const to = fresh('to');
    const MIXED = '반쯤 섞인 h@i.invalid';
    mk(old, `${MIXED}/INBOX/20230101_0900_11_a.eml`, 'eleven');
    mk(old, `${MIXED}/INBOX/.hibi-index.jsonl`, '\n{"uid":11}');
    mk(old, `${MIXED}/보관/20230101_0900_12_b.eml`, 'twelve');
    mk(old, `${MIXED}/보관/메모.txt`, 'note');
    const pl = await bm.plan(old, to, { known: [ACC1], ...roomy });
    ok(pl.entries.length === 0 && J(pl.unknown) === J([MIXED]), '다른 메일함이 Hibi 꼴이어도, 사용자 파일이 섞인 메일함이 하나라도 있으면 그대로 둔다',
      { entries: pl.entries.map((e) => e.name), unknown: pl.unknown });
  }

  console.log('\n[26] 복사 함수가 시각을 지키지 않아도 원본 시각으로 맞춘다');
  {
    const old = fresh('old');
    const to = fresh('to');
    tree(old, { unknown: false });
    const before = snap(old);
    const pl = await bm.plan(old, to, { known: [ACC1], ...roomy, sameVolume: false });
    // 윈도우의 CopyFile 은 수정 시각을 지킨다 — 지키지 않는 복사(다른 플랫폼·파일 시스템)를 흉내 낸다. COPYFILE_EXCL 처럼 있으면 실패한다
    const io = { copyFile: async (s, d) => { await fs.promises.writeFile(d, await fs.promises.readFile(s), { flag: 'wx' }); } };
    const r = await bm.run(pl, { io, ...roomy });
    ok(r.ok && J(snap(to)) === J(pick(before, (top) => OWNED.includes(top))), '사본의 수정 시각이 원본과 같다 (utimes 로 맞춘다)', r);
  }

  console.log(bad ? `\n${bad}개 실패` : '\n모두 통과');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error((e && e.stack) || e); process.exit(1); });
