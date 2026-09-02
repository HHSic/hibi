// 거르기 규칙 — 설정 화면과 위젯 오른쪽 클릭이 규칙을 넣고 빼는 곳.
//
// 규칙을 «어떻게 맞추나»는 mailrules.js(순수 함수)가 안다. 여기는 그 위에서
// 저장하고, 스팸 규칙은 한 번 물어보고(okToSpam), 바뀌면 목록을 바로 다시 읽게 한다.
//
// 바깥에는 okToSpam 만 내준다 — 오른쪽 클릭 메뉴가 «물어보는 일은 한 곳에서만»
// 하기 위해 여기 것을 부른다.

const { BrowserWindow, ipcMain } = require('electron');
const store = require('./store');
const mailrules = require('./mailrules');
const { askUser } = require('./popup');

// 목록·다시 읽기·«이미 처리함» 지우기는 main.js 가 들고 있다.
let host = {
  mailState: { messages: [], folders: [], groups: [], filtered: 0 },
  refreshMail: async () => {},
  forgetRuleWork: () => {}
};
function init(h) { host = { ...host, ...h }; }

/** 메일 필터 — 설정 화면과 위젯의 오른쪽 클릭이 함께 쓴다 */
function rulesPayload() {
  return {
    rules: store.mailRules,
    actions: mailrules.ACTION_NAMES,
    filtered: host.mailState.filtered,
    groups: host.mailState.groups.map((g) => ({ name: g.name, count: g.items.length }))
  };
}

/** 지금 받아둔 것 중 이 조건에 걸리는 메일 — 규칙을 만들기 전에 보여준다 */
function wouldHit(rule) {
  const all = [
    ...host.mailState.messages,
    ...host.mailState.groups.flatMap((g) => g.items),
    ...host.mailState.folders.filter((f) => f.id === 'hidden').flatMap((f) => f.items)
  ];
  return all.filter((m) => mailrules.hits({ ...rule, on: true }, m));
}

/**
 * «스팸으로»는 서버에서 메일을 옮긴다 — 웹메일에서도 사라진다.
 * 그래서 규칙이 어디서 만들어지든 이 문을 지나야 한다. 확인을 화면 쪽에 두면
 * 입구가 늘 때마다 빠뜨리게 된다 — 실제로 설정 화면 쪽이 그렇게 빠져 있었다.
 *
 * 조건이 얼마나 넓은지도 여기서 같이 보여준다. «제목에 안내»처럼 무심코 적은 한 마디가
 * 사내 공지까지 쓸어가는데, 숫자를 보기 전에는 그걸 알 방법이 없다.
 */
/**
 * 휴지통으로 옮긴다.
 *
 * 물어보고 옮긴다 — 목록에서 오른쪽 클릭 한 번으로 메일이 사라지면, 잘못 눌렀을 때
 * «방금 뭐가 없어졌지»가 된다. 다만 겁주지는 않는다: 휴지통에 남으므로 되찾을 수 있다.
 * 그 사실을 대화상자에 적어 둔다.
 */
async function okToSpam(rule, parent) {
  if (!rule || rule.action !== 'spam' || rule.on === false) return true;
  const caught = wouldHit(rule);
  const sample = caught.slice(0, 3).map((m) => ' · ' + String(m.subject || '(제목 없음)').slice(0, 46));
  const r = await askUser(parent, {
    buttons: ['스팸으로', '그만두기'],
    defaultId: 0,
    danger: true,
    title: '스팸으로 보내기',
    message: caught.length
      ? `지금 받아둔 메일 중 ${caught.length}통이 이 조건에 걸립니다.`
      : '지금 받아둔 메일 중에는 걸리는 것이 없습니다.',
    detail: (sample.length ? sample.join('\n') + '\n\n' : '')
      + `조건: ${mailrules.describe(rule)}\n\n`
      + '화면에서만 숨기는 것이 아니라 서버의 스팸 폴더로 옮깁니다.\n'
      + '지금 있는 것과 앞으로 오는 것 모두 옮겨지고, 웹메일에서도 사라집니다.'
  });
  return r === 0;
}

ipcMain.handle('mail:rules', () => rulesPayload());
ipcMain.handle('mail:rule-add', async (e, rule) => {
  if (!await okToSpam(rule, BrowserWindow.fromWebContents(e.sender))) return rulesPayload();
  store.addMailRule(rule || {});
  host.forgetRuleWork();
  // 방금 만든 규칙이 지금 목록에 바로 먹히게 한다 — 다음 주기(몇 분)를 기다리면 «안 됐네» 싶다
  await host.refreshMail({ force: true });
  return rulesPayload();
});
ipcMain.handle('mail:rule-update', async (e, { id, patch } = {}) => {
  // 꺼둔 스팸 규칙을 다시 켜는 것도 «지금부터 옮긴다»와 같은 일이다
  const now = store.mailRules.find((r) => r.id === id);
  const after = { ...(now || {}), ...(patch || {}) };
  const wakingUp = after.action === 'spam' && after.on !== false && (!now || now.on === false);
  if (wakingUp && !await okToSpam(after, BrowserWindow.fromWebContents(e.sender))) {
    return rulesPayload();
  }
  store.updateMailRule(id, patch || {});
  host.forgetRuleWork();
  await host.refreshMail({ force: true });
  return rulesPayload();
});
ipcMain.handle('mail:rule-remove', async (_e, id) => {
  store.removeMailRule(id);
  host.forgetRuleWork();
  await host.refreshMail({ force: true });
  return rulesPayload();
});

module.exports = { init, okToSpam };
