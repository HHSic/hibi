'use strict';
/**
 * PC 색인 — 세대 폴더마다 두는 .hibi-index.jsonl.
 *
 * .eml 이 원본이고 이 파일은 언제든 다시 만들 수 있는 사본이다. 파일 이름에는 UID 와 분 단위 시각뿐이라
 * 읽음·크기·Message-ID·«못 받음» 같은 것을 여기 적어 둔다. 뒤 받기에게는 이 파일이 곧 할 일 목록이다.
 *
 * 바깥에는 «줄 만들기(rowFromFetch·rowFromSource), 넣기(append·flush·ensureMeta), 읽기(load·readMeta),
 * 확인(fileMatches·reconcile·compact), 판정(pendingOf·terminal)»만 내준다.
 * 줄 앞의 \n, 합치기 규칙, 버퍼, 폴더별 프라미스 줄은 안쪽 일이다.
 * 왜: 쓰는 곳이 셋(새 메일·열어본 메일·뒤 받기)이다. 쓰기 꼴을 바깥이 알면 규칙이 갈라져, 잘린 끝 줄 하나가
 * 다음 줄을 망치거나 압축이 덧붙인 줄을 밟는 일이 부르는 곳마다 따로 생긴다.
 *
 * Electron·store·evlog 를 싣지 않는다. mailbackup·mailfill 이 순환 없이 부르고, 시험이 node 로 돈다.
 * 비밀번호·토큰 칸은 없다.
 */
const fs = require('fs');
const path = require('path');
const { simpleParser } = require('mailparser');
const mail = require('./mail');

const INDEX_FILE = '.hibi-index.jsonl';
const INDEX_V = 1;
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 4 * 1024;
const META_PEEK = 4 * 1024;
const FLUSH_MS = 250;
const FLUSH_LINES = 50;
const BUFFER_MAX = 5000;       // 쓰기가 계속 막힐 때 들고 있는 줄 수. 넘으면 오래된 줄부터 버린다 — 완료 판정의 다시 읽기가 찾아낸다
const LOCKED = ['EBUSY', 'EPERM', 'EACCES'];
const LOCK_WAITS = [200, 500, 1000, 2000];
const PART_MAX_MS = 60 * 60_000;
const TAIL_ROWS = 200;
// src/mailbackup.js 의 UID_IN_NAME 과 같은 규칙이다. 그쪽을 부르면 순환이라 여기 둔다 — 시험이 둘이 같은지 본다
const UID_IN_NAME = /^\d{8}_\d{4}_(\d+)(?:_.*)?\.eml$/;
const NAME_TIME = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})_/;
const PART_NAME = /^~받는중-.*\.part$/;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const breathe = () => new Promise((r) => setImmediate(r));

/** Message-ID 비교용 — src/mailtidy.js 의 normId 와 같은 식이다 (그쪽을 부르면 순환이다) */
function normId(v) {
  return String(v == null ? '' : v).replace(/\s+/g, '').replace(/^</, '').replace(/>$/, '').toLowerCase();
}

// ── 폴더별 버퍼와 프라미스 줄 ─────────────────────────────
// 쓰기·압축·읽기를 폴더마다 한 줄로 세운다. 압축이 파일을 바꾸는 동안 덧붙이면 그 줄이 사라지기 때문이다.
const slots = new Map();

function slotOf(boxDir) {
  let s = slots.get(boxDir);
  if (!s) {
    s = { buf: [], timer: null, queued: false, chain: Promise.resolve(), metaKey: null };
    slots.set(boxDir, s);
  }
  return s;
}

function inLine(s, job) {
  const p = s.chain.then(job);
  s.chain = p.catch(() => {});
  return p;
}

function trimBuffer(s) {
  if (s.buf.length > BUFFER_MAX) s.buf.splice(0, s.buf.length - BUFFER_MAX);
}

/** @returns 실패 사유 (성공이면 null). 잠겨 있으면 잠깐씩 기다렸다 다시 한다 — 백신·동기화 프로그램이 파일을 잡으면 실제로 EBUSY 가 난다 */
async function writeLines(boxDir, lines) {
  const text = `\n${lines.join('\n')}`;
  for (let i = 0; ; i++) {
    try {
      await fs.promises.mkdir(boxDir, { recursive: true });
      await fs.promises.appendFile(path.join(boxDir, INDEX_FILE), text);
      return null;
    } catch (e) {
      if (i >= LOCK_WAITS.length || !LOCKED.includes(e.code)) return e.message || String(e);
      await wait(LOCK_WAITS[i]);
    }
  }
}

async function writeOut(boxDir, s) {
  let error = null;
  while (s.buf.length && !error) {
    const lines = s.buf;
    s.buf = [];
    error = await writeLines(boxDir, lines);
    if (error) {
      // 줄을 버리지 않는다 — 다음 flush 가 다시 쓴다
      s.buf = lines.concat(s.buf);
      trimBuffer(s);
    }
  }
  return { unwritten: s.buf.length, error };
}

function kick(boxDir, s) {
  if (s.queued) return;
  s.queued = true;
  inLine(s, () => {
    s.queued = false;
    return writeOut(boxDir, s);
  });
}

/** 줄 하나를 넣는다. 250ms 또는 50줄마다 쓴다. 던지지 않는다 — 색인 때문에 메일 저장이 멈추면 안 된다 */
function append(boxDir, obj) {
  let line;
  try { line = JSON.stringify(obj); } catch { return; }
  const s = slotOf(boxDir);
  s.buf.push(line);
  trimBuffer(s);
  if (s.buf.length >= FLUSH_LINES) {
    kick(boxDir, s);
    return;
  }
  if (!s.timer) {
    s.timer = setTimeout(() => {
      s.timer = null;
      kick(boxDir, s);
    }, FLUSH_MS);
    s.timer.unref();
  }
}

/**
 * 버퍼를 쓰고 끝나기를 기다린다. 없는 폴더면 만든다.
 * @returns { unwritten, error } — unwritten 이 0이 아니면 그 줄은 아직 버퍼에 있다. 부르는 쪽은 완료를 적지 않는다
 */
function flush(boxDir) {
  const s = slotOf(boxDir);
  if (s.timer) {
    clearTimeout(s.timer);
    s.timer = null;
  }
  return inLine(s, () => writeOut(boxDir, s));
}

/**
 * 모든 폴더의 버퍼를 쓰고 줄이 빌 때까지 기다린다 — 백업 폴더를 옮기기 전에 (src/backup.js).
 * 버퍼가 빈 폴더는 쓰지 않는다 (없는 폴더를 다시 만들지 않는다). 던지지 않는다
 * @returns { unwritten } — 못 쓴 줄 수 (그 줄은 버퍼에 남는다. 색인은 다시 만들 수 있는 사본이다)
 */
async function flushAll() {
  let unwritten = 0;
  for (const boxDir of [...slots.keys()]) {
    try { unwritten += (await flush(boxDir)).unwritten; } catch { /* 다음 폴더 */ }
  }
  return { unwritten };
}

/**
 * 그 폴더 아래의 자리를 잊는다 — 백업 폴더를 옮긴 뒤, 남은 줄이 늦게 써져 이전 자리에 폴더가 다시 생기지 않게.
 * 줄이 빈 뒤에 부른다 (flushAll). 윈도우는 대소문자를 가리지 않는다
 */
function forget(dir) {
  const low = (x) => (process.platform === 'win32' ? path.resolve(x).toLowerCase() : path.resolve(x));
  const root = low(dir);
  const under = root.endsWith(path.sep) ? root : root + path.sep;
  for (const [k, s] of [...slots]) {
    const key = low(k);
    if (key !== root && !key.startsWith(under)) continue;
    if (s.timer) clearTimeout(s.timer);
    slots.delete(k);
  }
}

// ── 읽기 ────────────────────────────────────────────────
async function readRaw(boxDir) {
  try {
    return await fs.promises.readFile(path.join(boxDir, INDEX_FILE), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return '';
    throw e;
  }
}

async function parseLines(raw, sliceLines) {
  const out = { meta: null, rows: new Map(), lines: 0, bad: 0 };
  for (const text of raw.split('\n')) {
    const t = text.trim();
    if (!t) continue;
    out.lines += 1;
    if (sliceLines > 0 && out.lines % sliceLines === 0) await breathe();
    let line;
    try { line = JSON.parse(t); } catch { out.bad += 1; continue; }
    if (line && line.meta) { out.meta = line; continue; }
    // 알림 줄처럼 UID 없이 들어온 줄 — 메일이 아니다
    if (!line || !Number.isInteger(line.uid)) { out.bad += 1; continue; }
    const cur = out.rows.get(line.uid);
    const next = { ...cur, ...line };
    // 스캔 줄이 늦게 들어와도 읽음 값을 잃지 않는다
    if (cur && line.seen === null && cur.seen !== undefined) next.seen = cur.seen;
    // 마지막으로 적힌 줄이 뒤로 가게 넣는다 — «끝쪽 줄»을 볼 수 있게
    if (cur) out.rows.delete(line.uid);
    out.rows.set(line.uid, next);
  }
  return out;
}

/**
 * 디스크에 있는 줄을 읽어 UID 별로 합친다. 버퍼의 줄은 보지 않는다 — 완료 판정은 실제로 써진 것을 봐야 한다.
 * 없음과 못 읽음을 섞지 않는다: 파일이 없으면 빈 값(reconcile 이 다시 만든다), 못 읽으면 던진다(덮어쓰면 안 된다).
 * @returns { meta, rows: Map<uid, 줄>, lines, bad }
 */
async function load(boxDir, { sliceLines = 500 } = {}) {
  const raw = await inLine(slotOf(boxDir), () => readRaw(boxDir));
  return parseLines(raw, sliceLines);
}

function firstMeta(text) {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const o = JSON.parse(t);
      if (o && o.meta) return o;
    } catch { /* 잘린 줄 */ }
  }
  return null;
}

/**
 * 메타 줄. 앞 4KB에 없으면 파일 전체를 본다 — 메타가 뒤쪽에 있는 폴더(saveOne 이 먼저 쓴 폴더)에서
 * 세대를 못 올리면 UID 가 옛 파일과 겹친다.
 * @returns 메타 | null. 파일이 없으면 null, 못 읽으면 던진다
 */
function readMeta(boxDir) {
  return inLine(slotOf(boxDir), async () => {
    let fh;
    try {
      fh = await fs.promises.open(path.join(boxDir, INDEX_FILE), 'r');
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
    let peeked;
    let size;
    try {
      const st = await fh.stat();
      // 윈도우에서는 폴더도 열린다. 읽을 수 없는 것을 «메타 없음»으로 보면 세대를 잘못 고른다
      if (!st.isFile()) throw Object.assign(new Error('색인 자리가 파일이 아닙니다'), { code: 'EISDIR' });
      size = st.size;
      const buf = Buffer.alloc(Math.min(size, META_PEEK));
      await fh.read(buf, 0, buf.length, 0);
      peeked = buf.toString('utf8');
    } finally {
      await fh.close().catch(() => {});
    }
    const meta = firstMeta(peeked);
    if (meta || size <= META_PEEK) return meta;
    return firstMeta(await readRaw(boxDir));
  });
}

/**
 * 이번 실행에서 처음이고 지금 메타와 다르면 메타 줄을 덧붙인다. 넘기지 않은 칸은 비교하지 않는다 — saveOne 은 폴더 역할을 모른다.
 * @returns 덧붙였으면 true
 */
async function ensureMeta(boxDir, meta) {
  const line = { meta: 1, v: INDEX_V, ...meta, uidValidity: String(meta.uidValidity) };   // imapflow 는 BigInt 로 준다
  const key = JSON.stringify(line);
  const s = slotOf(boxDir);
  if (s.metaKey === key) return false;
  s.metaKey = key;
  let cur = null;
  try { cur = await readMeta(boxDir); } catch { /* 못 읽으면 줄 하나 더 쓰는 쪽이 낫다 */ }
  if (cur && Object.keys(line).every((k) => line[k] === undefined || String(cur[k]) === String(line[k]))) return false;
  append(boxDir, line);
  return true;
}

// ── 줄 만들기 ───────────────────────────────────────────
/** FETCH 한 줄 → 색인 줄. 목록과 같은 값을 쓴다 — 규칙이 잘린 값을 보기 때문이다 (mail.rowOf) */
function rowFromFetch(msg, via) {
  const envelope = msg.envelope || {};
  return {
    ...mail.rowOf(msg),
    to: ((envelope.to || [])[0] || {}).address || '',
    size: Number(msg.size) || 0,
    mid: envelope.messageId || '',
    file: null,
    st: 'head',
    via
  };
}

/** 원문의 앞 64KB → 색인 줄. 서버 없이 줄을 만드는 길이다 (열어본 메일, 옛 파일 스캔) */
async function rowFromSource(source, { uid, at, seen = null, via = 'scan', file = null, bytes } = {}) {
  const buf = Buffer.isBuffer(source) ? source : Buffer.from(String(source));
  const parsed = await simpleParser(buf.subarray(0, HEAD_BYTES), {
    skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true, skipTextLinks: true
  });
  const first = (parsed.from && parsed.from.value && parsed.from.value[0]) || null;
  const to = (parsed.to && !Array.isArray(parsed.to) && parsed.to.value && parsed.to.value[0]) || {};
  const dated = parsed.date instanceof Date && Number.isFinite(parsed.date.getTime()) ? parsed.date.getTime() : 0;
  return {
    uid,
    subject: String(parsed.subject || '(제목 없음)').slice(0, 120),
    // parsed.from.text 를 쓰지 않는다 — 따옴표와 주소가 붙어 목록의 값과 달라진다
    from: first ? mail.senderOf({ from: [first] }) : '',
    fromAddress: (first && first.address) || '',
    fromName: (first && first.name) || '',
    at: Number(at) || dated || Date.now(),
    seen,
    to: to.address || '',
    size: Number(bytes) || 0,
    mid: parsed.messageId || '',
    file,
    ...(file ? { bytes } : {}),
    st: file ? 'file' : 'head',
    via
  };
}

// ── 파일 확인 ───────────────────────────────────────────
/** 파일의 앞 64KB와 끝 4KB를 읽어 본다. 전원이 나가 0으로 찬 파일은 이름이 멀쩡해도 내용이 없다 (src/mailtidy.js checkFile 과 같은 판정) */
async function sniff(file) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size <= 0) return { size: st.size || 0, head: Buffer.alloc(0), header: '', damaged: true };
    const head = Buffer.alloc(Math.min(st.size, HEAD_BYTES));
    await fh.read(head, 0, head.length, 0);
    const tail = Buffer.alloc(Math.min(st.size, TAIL_BYTES));
    await fh.read(tail, 0, tail.length, st.size - tail.length);
    const text = head.toString('latin1');
    const cut = text.search(/\r?\n\r?\n/);
    const header = cut >= 0 ? text.slice(0, cut) : text;
    return { size: st.size, head, header, damaged: header.includes('\0') || tail.every((x) => x === 0) };
  } finally {
    await fh.close().catch(() => {});
  }
}

function messageIdIn(header) {
  for (const line of header.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    if (/^message-id\s*:/i.test(line)) return line.slice(line.indexOf(':') + 1).trim();
  }
  return '';
}

/**
 * 이 파일이 그 메일인가. 상태 파일을 잃은 폴더에서는 UID 가 옛 파일과 겹칠 수 있어 번호만 믿지 않는다.
 * mid 가 없으면 파일에도 Message-ID 가 없어야 같다고 본다. 열지 못하면 같다고 하지 않는다.
 * 서버가 ENVELOPE 에 Message-ID 를 안 주면 mid 는 비어도 파일에는 있다 — 다르다고 하면 받아 둔 메일을 전부 다시 받으므로, 크기를 알면 크기로 본다.
 * @param size 서버가 말한 크기 (RFC822.SIZE). 0 이면 쓰지 않는다
 * @returns { same, damaged }
 */
async function fileMatches(file, mid, size = 0) {
  let s;
  try { s = await sniff(file); } catch { return { same: false, damaged: false }; }
  if (s.damaged) return { same: false, damaged: true };
  const want = normId(mid);
  const have = normId(messageIdIn(s.header));
  if (!want && have && Number(size) > 0) return { same: s.size === Number(size), damaged: false };
  return { same: have === want, damaged: false };
}

function timeFromName(name) {
  const m = name.match(NAME_TIME);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() : 0;
}

/**
 * 색인과 폴더를 맞춘다. 서버를 부르지 않는다.
 * 파일 읽기는 비동기이고 한 통마다 양보한다. 줄 없는 파일과 끝쪽 200줄만 stat 한다.
 * 색인을 못 읽으면 던진다 — 그 폴더를 이번 판에 건너뛴다.
 * @returns { added, missing, damaged, parts, stopped }
 */
async function reconcile(boxDir, { shouldStop } = {}) {
  const out = { added: 0, missing: 0, damaged: 0, parts: 0, stopped: false };
  await flush(boxDir);
  const { rows } = await load(boxDir);
  let names;
  try {
    names = await fs.promises.readdir(boxDir);
  } catch (e) {
    if (e.code === 'ENOENT') return out;
    throw e;
  }

  const present = new Set(names);
  const byUid = new Map();
  const now = Date.now();
  for (const n of names) {
    if (PART_NAME.test(n)) {
      // 끝내 이름을 못 받은 임시 파일 — 메일로 세지 않는다
      try {
        const st = await fs.promises.stat(path.join(boxDir, n));
        if (now - st.mtimeMs > PART_MAX_MS) {
          await fs.promises.unlink(path.join(boxDir, n));
          out.parts += 1;
        }
      } catch { /* 다른 쪽이 잡고 있으면 다음에 지운다 */ }
      continue;
    }
    const m = n.match(UID_IN_NAME);
    if (!m) continue;
    const uid = Number(m[1]);
    if (!byUid.has(uid)) byUid.set(uid, []);
    byUid.get(uid).push(n);
  }

  // 지우지 않는다 — 망가졌어도 사용자의 파일이다. 이름만 비켜 UID 규칙에서 뺀다
  const retire = async (uid, name) => {
    try {
      await fs.promises.rename(path.join(boxDir, name), path.join(boxDir, `${name}.damaged`));
    } catch {
      return false;
    }
    append(boxDir, { uid, file: null, st: 'head' });
    out.damaged += 1;
    const row = rows.get(uid);
    if (row) row.file = null;
    return true;
  };

  // 줄은 파일을 가리키는데 파일이 없다
  let seen = 0;
  for (const [uid, row] of rows) {
    if (++seen % 500 === 0) await breathe();
    if (!row.file || present.has(row.file)) continue;
    append(boxDir, { uid, file: null, st: 'head' });
    row.file = null;
    out.missing += 1;
  }

  // 끝쪽 줄 — 마지막에 쓴 파일이 전원 차단으로 잘렸는지 본다. 서버 크기가 아니라 저장한 바이트 수와만 비교한다
  for (const row of [...rows.values()].slice(-TAIL_ROWS)) {
    if (!row.file || !Number.isInteger(row.bytes)) continue;
    let size;
    try { size = (await fs.promises.stat(path.join(boxDir, row.file))).size; } catch { continue; }
    if (size !== row.bytes) await retire(row.uid, row.file);
  }

  // 파일은 있는데 그 파일을 가리키는 줄이 없다
  scan: for (const [uid, list] of byUid) {
    for (const name of list) {
      const row = rows.get(uid);
      if (row && row.file) break;
      // 자리표는 머리를 받은 뒤 뒤 받기가 확인한다 — 여기서는 비교할 Message-ID 를 모른다
      if (row && row.mid === undefined) break;
      if (shouldStop && shouldStop()) { out.stopped = true; break scan; }
      await breathe();
      let s;
      try { s = await sniff(path.join(boxDir, name)); } catch { continue; }
      if (s.damaged) { await retire(uid, name); continue; }
      if (row) {
        // 번호만 같고 다른 메일이면 채우지 않는다 — 다시 받는다. 옛 파일은 건드리지 않는다
        if (normId(messageIdIn(s.header)) !== normId(row.mid)) continue;
        const patch = { uid, file: name, bytes: s.size, st: 'file' };
        append(boxDir, patch);
        Object.assign(row, patch);
      } else {
        let made;
        try {
          made = await rowFromSource(s.head, { uid, at: timeFromName(name), seen: null, via: 'scan', file: name, bytes: s.size });
        } catch {
          // 머리를 못 풀어도 파일이 있다는 사실은 적는다
          made = { uid, at: timeFromName(name) || now, subject: '(제목 없음)', from: '', fromAddress: '', fromName: '', seen: null,
            to: '', size: s.size, mid: '', file: name, bytes: s.size, st: 'file', via: 'scan' };
        }
        append(boxDir, made);
        rows.set(uid, made);
      }
      out.added += 1;
    }
  }

  await flush(boxDir);
  return out;
}

/**
 * 합쳐 다시 쓴다. .tmp 에 쓰고 fsync 한 뒤 rename 한다. rename 이 막히면 .tmp 를 지우고 원본을 둔다 —
 * 안 해도 되는 일이라 직접 덮어쓰지 않는다. 줄 수가 «행 수×1.5+1000»을 넘을 때만 한다.
 * @returns { done, error, before, after }
 */
function compact(boxDir, { force = false } = {}) {
  return inLine(slotOf(boxDir), async () => {
    const file = path.join(boxDir, INDEX_FILE);
    const tmp = `${file}.tmp`;
    let cur;
    try {
      cur = await parseLines(await readRaw(boxDir), 500);
    } catch (e) {
      return { done: false, error: e.message, before: 0, after: 0 };
    }
    const before = cur.lines;
    const count = cur.rows.size + (cur.meta ? 1 : 0);
    if (!count || (!force && before <= cur.rows.size * 1.5 + 1000)) return { done: false, error: null, before, after: before };
    const body = `${[...(cur.meta ? [cur.meta] : []), ...cur.rows.values()].map((o) => JSON.stringify(o)).join('\n')}\n`;
    try {
      const fh = await fs.promises.open(tmp, 'w');
      try {
        await fh.writeFile(body);
        await fh.sync();
      } finally {
        await fh.close().catch(() => {});
      }
      await fs.promises.rename(tmp, file);
    } catch (e) {
      await fs.promises.unlink(tmp).catch(() => {});
      return { done: false, error: e.message, before, after: before };
    }
    return { done: true, error: null, before, after: count };
  });
}

// ── 판정 ────────────────────────────────────────────────
/**
 * 본문을 받을 UID, 내림차순. lowUid 로 자르지 않는다 — 옛 경로가 놓친 메일도 되찾는다.
 * @param retry Set 이면 그 안에 없는 st:fail 줄도 더한다 (실행마다·24시간마다 다시 시도)
 */
function pendingOf(rows, { lastUid = 0, fillHead = false, retry = null } = {}) {
  const out = [];
  for (const [uid, r] of rows) {
    if (r.srv) continue;
    if (r.st === 'head' && uid <= lastUid && (r.at != null || fillHead)) out.push(uid);
    else if (retry instanceof Set && r.st === 'fail' && !retry.has(uid)) out.push(uid);
  }
  return out.sort((a, b) => b - a);
}

/** 이 줄은 더 할 일이 없나 — confirmBox 가 쓴다 */
function terminal(row) {
  return ['file', 'fail', 'big', 'dup'].includes(row.st) || !!row.srv;
}

module.exports = {
  INDEX_FILE, rowFromFetch, rowFromSource, append, flush, flushAll, forget, load, readMeta, ensureMeta,
  fileMatches, reconcile, compact, pendingOf, terminal
};
