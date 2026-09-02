#!/usr/bin/env node
'use strict';
/**
 * 시험 돌리개.
 *
 * 여기 시험들은 보통 단위 시험이 아니다. 진짜 앱을 띄우고, 진짜 창에 대고,
 * 진짜 키·마우스를 넣어 확인한다. 그래서 하나하나가 제 Electron 을 새로 띄운다 —
 * 한 프로세스에서 이어 돌리면 앞 시험이 바꾼 설정과 열어둔 창이 뒤로 새어 든다.
 * («지우기»를 확인한 시험 뒤에 목록이 필요한 시험이 오면 빈 목록으로 돌아간다.)
 *
 * 그 대신 데이터 폴더는 시험마다 임시로 새로 잡으므로, 실제 설정은 건드리지 않는다.
 *
 *   npm test                 다 돌린다
 *   npm test alarm stock     이름에 그 말이 든 것만
 *   npm test -- --jobs 2     둘씩 같이 (창이 겹칠 수 있으니 기본은 하나씩)
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'test');
const ELECTRON = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
// fast2 는 2분짜리 알림이 두 번 오기를 기다린다 — 4분으로는 아슬아슬하다
const LIMIT_MS = Number(process.env.HIBI_TEST_TIMEOUT || 420000);

const argv = process.argv.slice(2);
const jobsAt = argv.indexOf('--jobs');
const JOBS = jobsAt >= 0 ? Math.max(1, Number(argv[jobsAt + 1]) || 1) : 1;
// --jobs 가 없으면 jobsAt 이 -1 이라 jobsAt+1 이 0 이 된다 — 그냥 두면 첫 이름을
// 개수 인자로 오해해 버린다 (실제로 «npm test slider entreal»에서 slider 가 빠졌다).
const filters = argv.filter((a, i) => !a.startsWith('--') && !(jobsAt >= 0 && i === jobsAt + 1));

const all = fs.readdirSync(DIR).filter((f) => f.endsWith('.test.js')).sort();
const picked = filters.length
  ? all.filter((f) => filters.some((q) => f.includes(q)))
  : all;

if (!picked.length) {
  console.error(filters.length ? `«${filters.join(' ')}»에 맞는 시험이 없습니다.` : '시험이 없습니다.');
  console.error('있는 것:', all.map((f) => f.replace('.test.js', '')).join(' '));
  process.exit(1);
}

/** 한 시험을 돌리고 결과를 준다. 죽지 않는 시험이 전체를 붙잡지 않도록 시간을 끊는다. */
function run(file) {
  return new Promise((done) => {
    const t0 = Date.now();
    const p = spawn(ELECTRON, [path.join(DIR, file)], { cwd: ROOT, shell: process.platform === 'win32' });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    let timedOut = false;
    const kill = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, LIMIT_MS);
    p.on('close', (code) => {
      clearTimeout(kill);
      // Electron 이 스스로 끝나기 전에 GPU 프로세스가 먼저 죽는 일이 있어,
      // 종료 코드만으로는 못 가른다. 시험이 찍은 판정을 같이 본다.
      const lines = out.split(/\r?\n/);
      const fails = lines.filter((l) => l.includes('실패 ') || /^\s*\d+개 실패/.test(l));
      const said = lines.some((l) => /모두 통과|^통과|통과 —/.test(l.trim()));
      const ok = !timedOut && code === 0 && (said || !fails.length);
      done({ file, ok, code, timedOut, ms: Date.now() - t0, fails, out });
    });
  });
}

(async () => {
  console.log(`시험 ${picked.length}개${JOBS > 1 ? ` · ${JOBS}개씩` : ''}\n`);
  const results = [];
  const queue = [...picked];
  const workers = Array.from({ length: Math.min(JOBS, queue.length) }, async () => {
    while (queue.length) {
      const f = queue.shift();
      const r = await run(f);
      results.push(r);
      const name = f.replace('.test.js', '');
      const secs = (r.ms / 1000).toFixed(0);
      if (r.ok) console.log(`  통과  ${name.padEnd(12)} ${secs}초`);
      else {
        console.log(`  실패  ${name.padEnd(12)} ${secs}초${r.timedOut ? ' (시간 초과)' : ''}`);
        for (const l of r.fails.slice(0, 4)) console.log(`        ${l.trim()}`);
      }
    }
  });
  await Promise.all(workers);

  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} 통과`);
  if (bad.length) {
    console.log('\n실패한 것을 다시 보려면:');
    for (const r of bad) console.log(`  npm test ${r.file.replace('.test.js', '')}`);
  }
  process.exit(bad.length ? 1 : 0);
})();
