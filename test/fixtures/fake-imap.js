'use strict';
// 가짜 IMAP 서버 — imapflow 의 ImapFlow 와 같은 모양의 클라이언트를 준다. 진짜 서버에는 붙지 않는다.
//
// 서버 정리(src/mailtidy.js) 시험용이다. 진짜 imapflow 가 하는 일 중 정리가 기대는 것만 흉내 낸다:
//   · UID는 1000부터 띄엄띄엄 매긴다 — 차례 번호(1..n)와 절대 겹치지 않게 (seq/UID를 섞으면 바로 드러난다)
//   · search·fetch·messageMove 는 { uid: true } 없이 부르면 던진다
//   · fetch 를 도는 동안 다른 명령을 보내면 던진다 (imapflow 는 그 자리에서 멈춘다)
//   · MOVE가 없으면 imapflow 처럼 this.messageCopy → this.messageDelete 로 대신한다 (연결 객체의 메서드를 부른다)
//   · 지우기·복사·플래그·폴더 닫기 같은 «쓰면 안 되는» 명령은 log 에 남기고 던진다
// 가짜 계정의 서버 주소는 모두 *.invalid 이고, 비밀번호 칸은 아예 없다.

let hasCapability = null;
try { ({ hasCapability } = require('imapflow/lib/tools.js')); } catch { /* 아래 대체 판단 */ }

const FORBIDDEN = ['messageDelete', 'messageCopy', 'messageFlagsAdd', 'messageFlagsSet', 'messageFlagsRemove',
  'mailboxClose', 'mailboxDelete', 'mailboxRename', 'exec'];

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
    if (this.spec.failConnect) throw new Error('AUTHENTICATIONFAILED Invalid credentials (Failure)');
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
    return this.mailbox;
  }

  async search(q, opts) {
    this._cmd('search', { path: this.mailbox && this.mailbox.path, q, opts });
    if (!opts || opts.uid !== true) throw new Error('fake: search without { uid: true }');
    const box = this._box();
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
      else if (k === 'flagged') list = list.filter((m) => m.flags.has('\\Flagged') === v);
      else if (k === 'deleted') list = list.filter((m) => m.flags.has('\\Deleted') === v);
      else if (k === 'uid') { const set = parseSet(v, box); list = list.filter((m) => set.has(m.uid)); }
      else if (k === 'all') { /* 전부 */ }
      else throw new Error(`fake: unknown search key ${k}`);
    }
    const result = list.map((m) => m.uid).sort((a, b) => a - b);
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
      for (const m of list) {
        const out = { uid: m.uid };
        if (query.size) out.size = Buffer.byteLength(m.raw, 'latin1');
        if (query.envelope) out.envelope = { messageId: m.messageId || undefined, subject: m.subject };
        if (query.internalDate) out.internalDate = m.date;
        if (query.flags) out.flags = new Set(m.flags);
        if (query.labels && this.capabilities.has('X-GM-EXT-1')) out.labels = new Set(m.labels);
        if (query.headers) out.headers = Buffer.from(pickHeaders(m.raw, query.headers), 'latin1');
        yield out;
        if (this.closed) throw new Error('Connection not available');
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
 * @param spec { [계정 id]: { caps, enabled, namespaces, failConnect, noUidPlus, emptyUidMap, moveReturns,
 *   searchReturns, searchIgnoresBefore, searchIgnoresSeen, delay: { connect, search, fetch, move }, hooks: { afterSearch, afterFetch },
 *   boxes: [{ path, name, delimiter, flags, specialUse, useGuessed, uidValidity, readOnlyOnly, searchReturns, msgs }] } }
 *   msgs: [{ uid, raw, date, flags, labels, messageId, subject }]
 */
function makeServer(spec) {
  const state = {};
  for (const [id, a] of Object.entries(spec)) {
    state[id] = new Map();
    for (const b of a.boxes || []) {
      const msgs = (b.msgs || []).map((m) => ({ ...m, flags: new Set(m.flags || []), labels: new Set(m.labels || []) }));
      const top = msgs.reduce((x, m) => Math.max(x, m.uid), 0);
      state[id].set(b.path, { ...b, msgs, nextUid: Math.max(5000, top + 7) });
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
