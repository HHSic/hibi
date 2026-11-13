'use strict';
// 가짜 IMAP 서버 — imapflow 의 ImapFlow 와 같은 모양의 클라이언트를 준다. 진짜 서버에는 붙지 않는다.
//
// 서버 정리(src/mailtidy.js) 시험용이다. 진짜 imapflow 가 하는 일 중 정리가 기대는 것만 흉내 낸다:
//   · UID는 1000부터 띄엄띄엄 매긴다 — 차례 번호(1..n)와 절대 겹치지 않게 (seq/UID를 섞으면 바로 드러난다)
//   · search·fetch·messageMove 는 { uid: true } 없이 부르면 던진다
//   · fetch 를 도는 동안 다른 명령을 보내면 던진다 (imapflow 는 그 자리에서 멈춘다)
//   · MOVE가 없으면 imapflow 처럼 this.messageCopy → this.messageDelete 로 대신한다 (연결 객체의 메서드를 부른다)
//   · 지우기·복사·플래그·폴더 닫기 같은 «쓰면 안 되는» 공개 메서드는 log 에 남기고 던진다
//   · 옮기기 도우미(src/mailmove.js)가 쓰는 하위 명령 run('COPY'·'STORE'), exec('EXPUNGE'·'UID EXPUNGE'), status() 는
//     흉내 낸다 — 그 밖의 exec 는 금지로 남긴다. 고장 손잡이는 makeServer 설명에 있다
//   · 연결·로그인 거절은 imapflow 처럼 message 'Command failed' 에 responseText·serverResponseCode 를 달아 던진다
// 가짜 계정의 서버 주소는 모두 *.invalid 이고, 비밀번호 칸은 아예 없다.

let hasCapability = null;
try { ({ hasCapability } = require('imapflow/lib/tools.js')); } catch { /* 아래 대체 판단 */ }

const FORBIDDEN = ['messageDelete', 'messageCopy', 'messageFlagsAdd', 'messageFlagsSet', 'messageFlagsRemove',
  'mailboxClose', 'mailboxDelete', 'mailboxRename'];

/** imapflow 의 tagged NO 와 같은 모양 — message 는 늘 'Command failed', 서버 글은 responseText·serverResponseCode 에만 있다 */
function refusal(text, code, extra = {}) {
  const e = new Error('Command failed');
  e.responseStatus = 'NO';
  if (text) e.responseText = text;
  if (code) e.serverResponseCode = code;
  return Object.assign(e, extra);
}

const utcDay = (d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

/** '1000,1003:1007,*' · [1000, 1003] · 1000 → Set<uid> */
function parseSet(v, box) {
  const out = new Set();
  const top = box.msgs.reduce((m, x) => Math.max(m, x.uid), 0);
  const add = (s) => {
    const t = String(s).trim();
    if (!t) return;
    const [a, b] = t.split(':');
    const num = (x) => (x === '*' ? top : Number(x));
    if (b === undefined) { out.add(num(a)); return; }
    const lo = Math.min(num(a), num(b));
    const hi = Math.max(num(a), num(b));
    for (const m of box.msgs) if (m.uid >= lo && m.uid <= hi) out.add(m.uid);
  };
  if (Array.isArray(v)) v.forEach((x) => add(x));
  else String(v).split(',').forEach(add);
  return out;
}

/** 원문 헤더에서 요청한 이름의 줄만 — HEADER.FIELDS 응답 모양 (줄들 + 빈 줄) */
function pickHeaders(raw, names) {
  const want = new Set(names.map((n) => String(n).toLowerCase()));
  const s = String(raw);
  const cut = s.search(/\r?\n\r?\n/);
  const head = cut >= 0 ? s.slice(0, cut) : s;
  const lines = head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)
    .filter((l) => want.has(l.slice(0, l.indexOf(':')).trim().toLowerCase()));
  return `${lines.join('\r\n')}${lines.length ? '\r\n' : ''}\r\n`;
}

class FakeClient {
  constructor(server, account, spec) {
    this.server = server;
    this.account = account;
    this.spec = spec || { failConnect: true };
    this.capabilities = new Map((this.spec.caps || ['IMAP4rev1', 'MOVE', 'UIDPLUS', 'NAMESPACE']).map((c) => [c, true]));
    this.enabled = new Set(this.spec.enabled || []);
    // noNamespace: NAMESPACE 를 말하지 않는 서버 (imapflow 는 namespaces 를 비워 둔다)
    if (this.spec.noNamespace) this.namespaces = undefined;
    else if (this.spec.namespaces === undefined) this.namespaces = { personal: [{ prefix: '', delimiter: '/' }], other: false, shared: false };
    else this.namespaces = this.spec.namespaces;
    this.mailbox = false;
    this.usable = false;
    this.closed = false;
    this.loggedOut = false;
    this.inFetch = false;
    this.waits = new Set();
    server.clients.push(this);
  }

  get acc() { return this.account && this.account.id; }

  _cmd(name, data = {}) {
    if (this.closed) throw new Error('Connection not available');
    if (this.inFetch) throw new Error(`fake: ${name} while fetch is running (imapflow would deadlock)`);
    this.server.log.push({ acc: this.acc, cmd: name, ...data });
    if (data.opts !== undefined && ['search', 'fetch', 'messageMove'].includes(name)) {
      this.server.log.opts.push({ cmd: name, opts: data.opts });
    }
  }

  _wait(ms) {
    if (!ms) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const w = { reject };
      const t = setTimeout(() => { this.waits.delete(w); resolve(); }, ms);
      w.reject = (e) => { clearTimeout(t); reject(e); };
      this.waits.add(w);
    });
  }

  _box() {
    if (!this.mailbox) throw new Error('fake: no mailbox selected');
    return this.server.box(this.acc, this.mailbox.path);
  }

  async connect() {
    this._cmd('connect');
    await this._wait(this.spec.delay && this.spec.delay.connect);
    // failConnect: 비밀번호 거절 — Gmail 이 실제로 주는 모양 (NO [AUTHENTICATIONFAILED] Invalid credentials (Failure))
    if (this.spec.failConnect) throw refusal('Invalid credentials (Failure)', 'AUTHENTICATIONFAILED', { authenticationFailed: true });
    // authFail: 서버가 로그인을 거절한다 — imapflow 처럼 표시와 응답 코드(AUTHENTICATIONFAILED·UNAVAILABLE 등)를 달아 던진다.
    // authText 가 없으면 그 코드에 흔한 글을 단다
    if (this.spec.authFail) {
      const code = this.spec.authFail;
      const text = this.spec.authText || (code === 'AUTHENTICATIONFAILED' ? 'Invalid credentials (Failure)' : 'Temporary System Error');
      throw refusal(text, code, { authenticationFailed: true });
    }
    this.usable = true;
  }

  async list() {
    this._cmd('list');
    return this.spec.boxes.map((b) => {
      const delimiter = b.delimiter || '/';
      return {
        path: b.path, name: b.name || b.path.split(delimiter).pop(), delimiter,
        // imapflow 처럼 서버가 준 용도 표시(\Drafts 등)는 flags 에도 들어 있다. useGuessed 는 서버가 표시를 안 줘
        // imapflow 가 이름으로 짐작한 것 — specialUse 에만 있다. 둘 중 하나만 보는 판정이 드러나게
        flags: new Set([...(b.flags || []), ...(b.specialUse && !b.useGuessed ? [b.specialUse] : [])]), specialUse: b.specialUse
      };
    });
  }

  async mailboxOpen(path, opts) {
    this._cmd('mailboxOpen', { path, readOnly: !!(opts && opts.readOnly) });
    const box = this.server.box(this.acc, path);
    if (!box) throw new Error(`fake: mailbox ${path} does not exist`);
    this.mailbox = {
      path: box.path, uidValidity: box.uidValidity,
      readOnly: !!(opts && opts.readOnly) || !!box.readOnlyOnly,
      exists: box.msgs.length
    };
    // noUidValidity: 답에 UIDVALIDITY 가 없다 — 한 번 빠진 답으로 세대가 오르면 안 되는 것을 시험한다
    if (box.noUidValidity) delete this.mailbox.uidValidity;
    // noDeletedFlag: PERMANENTFLAGS 에 \Deleted 가 없다 — imapflow store.js 는 STORE 를 보내지도 않고 false
    if (box.noDeletedFlag) this.mailbox.permanentFlags = new Set(['\\Seen', '\\Flagged']);
    // uidNext: 'auto' 면 진짜 UIDNEXT 처럼 줄지 않는 값 (맨 위 메일을 지워도 내려가지 않는다), 숫자면 그 값.
    // 없으면 키를 넣지 않는다 — UIDNEXT 를 안 주는 서버 (옛 시험과 같은 결과)
    if (box.uidNext === 'auto') {
      box.hiUid = Math.max(box.hiUid || 0, box.msgs.reduce((m, x) => Math.max(m, x.uid), 0));
      this.mailbox.uidNext = box.hiUid + 1;
    } else if (typeof box.uidNext === 'number') {
      this.mailbox.uidNext = box.uidNext;
    }
    return this.mailbox;
  }

  /**
   * dropAt: 'status' | 'search' — 그 명령의 dropAtN 번째(기본 1)에서 서버가 답 전에 끊는다. imapflow 의 status·search 는
   * 명령 중에 끊기면 던지지 않고 false 를 준다 (commands/status.js·search.js 의 catch) — 그 모양 그대로
   */
  _dropsOn(cmd) {
    if (this.spec.dropAt !== cmd) return false;
    this.counts = this.counts || {};
    this.counts[cmd] = (this.counts[cmd] || 0) + 1;
    if (this.counts[cmd] !== (this.spec.dropAtN || 1)) return false;
    this._drop();
    return true;
  }

  async search(q, opts) {
    this._cmd('search', { path: this.mailbox && this.mailbox.path, q, opts });
    if (!opts || opts.uid !== true) throw new Error('fake: search without { uid: true }');
    const box = this._box();
    if (this._dropsOn('search')) return false;
    if (box.searchReturns === false || this.spec.searchReturns === false) return false;
    await this._wait(this.spec.delay && this.spec.delay.search);
    let list = box.msgs.slice();
    for (const [k, v] of Object.entries(q || {})) {
      if (k === 'before') {
        // searchIgnoresBefore: 날짜 조건을 엉성하게 보는 서버 (BEFORE 를 서버 시간대로 보거나 무시) — 받은 뒤 다시 보는 판정을 시험한다
        if (this.spec.searchIgnoresBefore) continue;
        const lim = utcDay(v);
        list = list.filter((m) => utcDay(m.date) < lim);
      }
      else if (k === 'seen') {
        // searchIgnoresSeen: 읽음 조건을 흘려듣는 서버 — «바로»가 받아 온 플래그로 다시 보는지 시험한다
        if (this.spec.searchIgnoresSeen) continue;
        list = list.filter((m) => m.flags.has('\\Seen') === v);
      }
      // SINCE — 날짜(UTC 자정) 단위로 그날 이후 (자동 전달이 «켠 뒤 첫 UID»를 찾을 때)
      else if (k === 'since') list = list.filter((m) => utcDay(m.date) >= utcDay(v));
      else if (k === 'flagged') list = list.filter((m) => m.flags.has('\\Flagged') === v);
      else if (k === 'deleted') list = list.filter((m) => m.flags.has('\\Deleted') === v);
      else if (k === 'uid') { const set = parseSet(v, box); list = list.filter((m) => set.has(m.uid)); }
      else if (k === 'all') { /* 전부 */ }
      else throw new Error(`fake: unknown search key ${k}`);
    }
    const sorted = list.map((m) => m.uid).sort((a, b) => a - b);
    // searchShort: SEARCH ALL 이 앞 n개만 답하는 서버 — 받은 답을 «이게 전부»로 믿으면 안 되는 것을 시험한다
    const result = q && q.all && Number.isInteger(box.searchShort) ? sorted.slice(0, box.searchShort) : sorted;
    const h = this.spec.hooks && this.spec.hooks.afterSearch;
    if (h) await h({ client: this, box, q, result });
    return result;
  }

  async *fetch(range, query, opts) {
    this._cmd('fetch', { path: this.mailbox && this.mailbox.path, range, query, opts });
    if (!opts || opts.uid !== true) throw new Error('fake: fetch without { uid: true }');
    const box = this._box();
    this.inFetch = true;
    try {
      await this._wait(this.spec.delay && this.spec.delay.fetch);
      const set = parseSet(range, box);
      const list = box.msgs.filter((m) => set.has(m.uid)).sort((a, b) => a.uid - b.uid);
      // fetchNo: 원문을 달라는 FETCH 에 그 메일이 끼면 서버가 명령째 거절한다 (Exchange «Message cannot be fetched») —
      // imapflow 처럼 tagged NO 로 던진다. 연결은 살아 있다
      // headNo: 같은 거절이 머리(봉투)를 달라는 FETCH 에서 난다 — fetchNo 는 원문에서만 던진다
      // fetchRefuse: 계정 전체의 거절 (Gmail 하루 한도 «[ALERT] Account exceeded command or bandwidth limits» 등) — 원문·머리 FETCH 를 모두 거절
      const fr = this.spec.fetchRefuse;
      if (fr && (query.source || query.envelope)) throw refusal(fr.responseText, fr.serverResponseCode);
      if ((query.source && list.some((m) => m.fetchNo)) || (!query.source && query.envelope && list.some((m) => m.headNo))) {
        const err = new Error('Command failed');
        err.responseStatus = 'NO';
        err.responseText = 'Message cannot be fetched';
        throw err;
      }
      let rows = 0;
      for (const m of list) {
        // noRow: 서버가 오류 없이 그 메일 줄만 빼고 답한다
        if (m.noRow) continue;
        const out = { uid: m.uid };
        if (query.size) out.size = Buffer.byteLength(m.raw, 'latin1');
        if (query.envelope) {
          out.envelope = { messageId: m.messageId || undefined, subject: m.subject,
            ...(m.from ? { from: m.from } : {}), ...(m.to ? { to: m.to } : {}) };
        }
        // badDate: 못 읽는 INTERNALDATE — imapflow 는 그때 Date 가 아니라 받은 문자열을 그대로 둔다 (tools.js)
        if (query.internalDate) out.internalDate = m.badDate ? (typeof m.badDate === 'string' ? m.badDate : 'not-a-date') : m.date;
        if (query.flags) out.flags = new Set(m.flags);
        if (query.labels && this.capabilities.has('X-GM-EXT-1')) out.labels = new Set(m.labels);
        if (query.headers) out.headers = Buffer.from(pickHeaders(m.raw, query.headers), 'latin1');
        // 원문 — noSource 면 서버가 원문을 주지 않는 메일
        if (query.source && !m.noSource) out.source = Buffer.from(m.raw, 'latin1');
        yield out;
        if (this.closed) throw new Error('Connection not available');
        // notify: FETCH 도중 서버가 먼저 보내는 알림 줄 — imapflow 는 UID 없이 차례 번호만 든 줄로 내준다
        if (this.spec.notify && ++rows === 1) yield { uid: undefined, seq: 9 };
      }
    } finally {
      this.inFetch = false;
    }
    const h = this.spec.hooks && this.spec.hooks.afterFetch;
    // query 도 넘긴다 — 고르는 받아 오기(봉투)와 플래그만 다시 받는 것을 가를 수 있게
    if (h) await h({ client: this, box, range, query });
  }

  _hasMove() {
    if (hasCapability) return hasCapability(this, 'MOVE');
    return this.capabilities.has('MOVE') || this.enabled.has('IMAP4REV2');
  }

  async messageMove(range, destination, opts) {
    this._cmd('messageMove', { path: this.mailbox && this.mailbox.path, range, destination, opts });
    if (!opts || opts.uid !== true) throw new Error('fake: messageMove without { uid: true }');
    const box = this._box();
    if (this.mailbox.readOnly) throw new Error('fake: messageMove in a read-only mailbox');
    if (this.spec.moveReturns === false) return false;
    // moveNo: 서버가 MOVE 를 거절한다 — imapflow move.js 는 오류를 삼키고 false. 서버 글은 log.warn 으로만 간다 (mail.connect 가 lastWarn 에 붙인다)
    if (this.spec.moveNo && this._hasMove()) {
      this.lastWarn = refusal(this.spec.moveNo.responseText, this.spec.moveNo.serverResponseCode);
      return false;
    }
    if (!this._hasMove()) {
      // imapflow commands/move.js 와 같은 대체 경로 — 연결 객체의 메서드를 부른다
      const result = await this.messageCopy(range, destination, opts);
      await this.messageDelete(range, Object.assign({ silent: true }, opts));
      return result;
    }
    const target = this.server.box(this.acc, destination);
    if (!target) return false;
    const set = parseSet(range, box);
    const uidMap = new Map();
    for (const m of box.msgs.filter((x) => set.has(x.uid))) {
      const nu = target.nextUid;
      target.nextUid += 3;
      target.msgs.push({ ...m, uid: nu, flags: new Set(m.flags), labels: new Set(m.labels) });
      uidMap.set(m.uid, nu);
    }
    box.msgs = box.msgs.filter((x) => !set.has(x.uid));
    this.server.log.push({ acc: this.acc, cmd: 'moved', from: box.path, destination, uids: [...uidMap.keys()] });
    // delay.move: 서버는 옮겼는데 답이 늦다 — 그 사이 끊으면 imapflow 처럼 false 를 준다 (move.js 가 오류를 삼킨다)
    try {
      await this._wait(this.spec.delay && this.spec.delay.move);
    } catch {
      return false;
    }
    const r = { path: box.path, destination };
    // partialUidMap: imapflow 는 COPYUID 줄이 여러 번 오면 마지막 줄로 덮어쓴다 — 마지막 한 통만 남긴다
    if (!this.spec.noUidPlus) {
      r.uidMap = this.spec.emptyUidMap ? new Map()
        : this.spec.partialUidMap ? new Map([...uidMap].slice(-1))
          : uidMap;
    }
    return r;
  }

  /** 서버는 명령을 해 놓고 답 전에 끊는다 (dropAt) */
  _drop() {
    this.server.log.push({ acc: this.acc, cmd: 'drop' });
    this.close();
  }

  /** imapflow run() — 옮기기 도우미가 쓰는 COPY·STORE 만 흉내 낸다 */
  async run(command, ...args) {
    const cmd = String(command).toUpperCase();
    if (cmd === 'COPY') return this._copy(...args);
    if (cmd === 'STORE') return this._store(...args);
    throw new Error(`fake: run(${cmd}) is not modeled`);
  }

  // imapflow copy.js 처럼 거절이면 false (던지지 않는다). UIDPLUS 면 COPYUID(uidMap)를 준다
  async _copy(range, destination, opts) {
    this._cmd('COPY', { path: this.mailbox && this.mailbox.path, range, destination, opts });
    if (!opts || opts.uid !== true) throw new Error('fake: COPY without { uid: true }');
    if (typeof range !== 'string') throw new Error('fake: run(COPY) wants a packed sequence string');
    const box = this._box();
    if (this.spec.copyNo) {
      this.lastWarn = refusal(this.spec.copyNo.responseText || 'Copy refused', this.spec.copyNo.serverResponseCode);
      return false;
    }
    const target = this.server.box(this.acc, destination);
    if (!target) { this.lastWarn = refusal('Mailbox does not exist', 'TRYCREATE'); return false; }
    const set = parseSet(range, box);
    const uidMap = new Map();
    for (const m of box.msgs.filter((x) => set.has(x.uid)).sort((a, b) => a.uid - b.uid)) {
      const nu = target.nextUid;
      // copyLies: OK 라고 답하지만 아무것도 안 생긴다
      if (!this.spec.copyLies) {
        target.nextUid += 3;
        target.msgs.push({ ...m, uid: nu, flags: new Set(m.flags), labels: new Set(m.labels), copyOf: `${box.path}:${m.uid}` });
      }
      uidMap.set(m.uid, nu);
    }
    this.server.log.push({ acc: this.acc, cmd: 'copied', from: box.path, destination, uids: this.spec.copyLies ? [] : [...uidMap.keys()] });
    const h = this.spec.hooks && this.spec.hooks.afterCopy;
    if (h) await h({ client: this, box });
    if (this.spec.dropAt === 'copy') { this._drop(); return false; }
    const r = { path: box.path, destination };
    if (this.capabilities.has('UIDPLUS') && !this.spec.copyuidMissing) {
      r.uidValidity = BigInt(String(target.uidValidity || 1));
      // copyuidPartial: COPYUID 가 첫 UID 를 빼고 답한다
      r.uidMap = this.spec.copyuidPartial ? new Map([...uidMap].slice(1)) : uidMap;
    }
    return r;
  }

  // imapflow store.js 처럼 PERMANENTFLAGS 에 없는 플래그는 보내지도 않고 false (빼기는 늘 보낸다)
  async _store(range, flags, opts) {
    this._cmd('STORE', { path: this.mailbox && this.mailbox.path, range, flags, opts });
    if (!opts || opts.uid !== true) throw new Error('fake: STORE without { uid: true }');
    if (typeof range !== 'string') throw new Error('fake: run(STORE) wants a packed sequence string');
    const box = this._box();
    const op = String(opts.operation || 'add').toLowerCase();
    const list = [].concat(flags);
    const perm = this.mailbox.permanentFlags;
    if (op !== 'remove' && perm && !perm.has('\\*') && !list.every((f) => perm.has(f))) return false;
    if (this.spec.storeNo) return false;
    const set = parseSet(range, box);
    for (const m of box.msgs) {
      if (!set.has(m.uid)) continue;
      for (const f of list) { if (op === 'remove') m.flags.delete(f); else m.flags.add(f); }
    }
    this.server.log.push({ acc: this.acc, cmd: 'stored', op, flags: list, uids: [...set] });
    if (this.spec.dropAt === 'store') { this._drop(); return false; }
    return true;
  }

  /** IMAP 명령 보내기 — EXPUNGE·UID EXPUNGE 만 흉내 낸다. 그 밖은 금지로 남기고 던진다 */
  async exec(command, attributes) {
    const cmd = String(command).toUpperCase();
    if (cmd !== 'EXPUNGE' && cmd !== 'UID EXPUNGE') {
      this.server.log.push({ acc: this.acc, cmd: 'FORBIDDEN', name: `exec ${cmd}` });
      throw new Error(`fake: forbidden exec ${cmd}`);
    }
    this._cmd(cmd, { path: this.mailbox && this.mailbox.path, attributes });
    const box = this._box();
    if (this.mailbox.readOnly) throw refusal('Mailbox is read-only');
    const uidplus = hasCapability ? hasCapability(this, 'UIDPLUS') : this.capabilities.has('UIDPLUS');
    if (cmd === 'UID EXPUNGE' && !uidplus) throw Object.assign(refusal('Unknown command'), { responseStatus: 'BAD' });
    const h = this.spec.hooks && this.spec.hooks.beforeExpunge;
    if (h) await h({ client: this, box });
    if (this.spec.expungeNo) throw refusal('Expunge refused');
    // uidExpungeAll: UIDPLUS 를 말하지만 UID 지우기를 폴더 전체 지우기처럼 하는 고장 난 서버
    const only = cmd === 'UID EXPUNGE' && !this.spec.uidExpungeAll ? parseSet(attributes[0].value, box) : null;
    const gone = box.msgs.filter((m) => m.flags.has('\\Deleted') && (!only || only.has(m.uid))).map((m) => m.uid);
    box.msgs = box.msgs.filter((m) => !gone.includes(m.uid));
    this.server.log.push({ acc: this.acc, cmd: 'expunged', path: box.path, uids: gone });
    if (this.spec.dropAt === 'expunge') { this._drop(); throw new Error('Connection not available'); }
    return { response: { attributes: [] }, next: () => {} };
  }

  // statusNoUidNext: 답에 UIDNEXT 가 없다    statusStale: 늘 처음 값을 준다 (캐시하는 서버)
  async status(p, q) {
    this._cmd('status', { path: p, q });
    const target = this.server.box(this.acc, p);
    if (!target) throw refusal(`Mailbox doesn't exist: ${p}`, 'NONEXISTENT');
    if (this._dropsOn('status')) return false;
    if (this.spec.statusStale && target.staleNext === undefined) target.staleNext = target.nextUid;
    const out = { path: p };
    if (q && q.messages) out.messages = target.msgs.length;
    if (q && q.uidNext && !this.spec.statusNoUidNext) out.uidNext = this.spec.statusStale ? target.staleNext : target.nextUid;
    return out;
  }

  async logout() {
    this.server.log.push({ acc: this.acc, cmd: 'logout' });
    this.loggedOut = true;
    this.usable = false;
    this.mailbox = false;
  }

  close() {
    this.server.log.push({ acc: this.acc, cmd: 'close' });
    this.closed = true;
    this.usable = false;
    for (const w of this.waits) w.reject(new Error('Connection not available'));
    this.waits.clear();
  }
}

// 쓰면 안 되는 명령 — 불리면 «실제로 실행됐다»고 남기고 던진다
for (const name of FORBIDDEN) {
  FakeClient.prototype[name] = async function forbidden() {
    this.server.log.push({ acc: this.acc, cmd: 'FORBIDDEN', name });
    throw new Error(`fake: forbidden command ${name}`);
  };
}

/**
 * @param spec { [계정 id]: { caps, enabled, namespaces, failConnect, authFail, notify, noUidPlus, emptyUidMap, moveReturns,
 *   searchReturns, searchIgnoresBefore, searchIgnoresSeen, delay: { connect, search, fetch, move }, hooks: { afterSearch, afterFetch },
 *   boxes: [{ path, name, delimiter, flags, specialUse, useGuessed, uidValidity, noUidValidity, uidNext, readOnlyOnly, searchReturns, searchShort, msgs }] } }
 *   msgs: [{ uid, raw, date, flags, labels, messageId, subject, from, to, noSource, fetchNo, headNo, noRow, badDate }]
 *   uidNext: 'auto'(줄지 않는 UIDNEXT) | 숫자 | 없음(UIDNEXT 를 안 주는 서버)
 *   authFail: 응답 코드 — connect 가 { authenticationFailed: true, serverResponseCode } 로 던진다
 *   notify: FETCH 도중 { uid: undefined, seq: 9 } 줄을 끼운다    searchShort: SEARCH ALL 이 앞 n개만 답한다
 *   headNo: 머리 FETCH 거절    noRow: 그 메일 줄 없이 답함    badDate: internalDate 를 문자열로 (true 면 'not-a-date')
 *   from·to: 봉투의 주소 칸 ([{ name, address }]). 없으면 지금처럼 칸을 넣지 않는다
 *   dropAt: 'copy'·'store'·'expunge'(해 놓고 끊김) · 'status'·'search'(dropAtN 번째에서 끊기고 false)   uidExpungeAll: UID 지우기가 폴더 전체를 지움
 */
function makeServer(spec) {
  const state = {};
  for (const [id, a] of Object.entries(spec)) {
    state[id] = new Map();
    for (const b of a.boxes || []) {
      const msgs = (b.msgs || []).map((m) => ({ ...m, flags: new Set(m.flags || []), labels: new Set(m.labels || []) }));
      const top = msgs.reduce((x, m) => Math.max(x, m.uid), 0);
      state[id].set(b.path, { ...b, msgs, nextUid: Math.max(5000, top + 7), ...(b.uidNext === 'auto' ? { hiUid: top } : {}) });
    }
  }
  const log = [];
  log.opts = [];
  const server = {
    log,
    clients: [],
    spec,
    box: (acc, p) => (state[acc] && state[acc].get(p)) || null,
    connect: (account) => new FakeClient(server, account, spec[account && account.id]),
    forbidden: () => log.filter((e) => e.cmd === 'FORBIDDEN')
  };
  return server;
}

module.exports = { makeServer, FakeClient, parseSet, pickHeaders, FORBIDDEN };
