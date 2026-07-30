#!/usr/bin/env node
/**
 * 릴리스 한 방에 올리기.
 *
 *   npm run ship                  빌드 → 업로드 → 자산 검증 → 초안 발행 → 최종 확인
 *   npm run ship -- --check       현재 버전 릴리스 상태만 확인 (빌드·발행 안 함)
 *   npm run ship -- --keep-draft  업로드·검증만 하고 발행은 사람이 하도록 남겨둠
 *
 * 왜 스크립트인가: electron-builder는 릴리스를 '초안'으로 만들고, 업로드가 중간에
 * 끊기면 latest.yml 없이 반쪽 릴리스가 남는다. 그 상태로 발행하면 자동 업데이트가
 * 조용히 실패한다. 그래서 필수 자산과 해시를 확인한 뒤에만 발행한다.
 *
 * 외부 명령은 모두 execFileSync + 인자 배열로 호출한다 (셸을 거치지 않음).
 */
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const TAG = `v${VERSION}`;
const target = pkg.build.publish[0];
const REPO = `${target.owner}/${target.repo}`;
const DIST = path.join(ROOT, 'dist');
const GH = process.platform === 'win32' ? 'gh.exe' : 'gh';

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check');
const KEEP_DRAFT = args.includes('--keep-draft');

const log = (...a) => console.log(...a);
const die = (msg) => { console.error(`\n✗ ${msg}`); process.exit(1); };

function gh(argv) {
  try {
    return execFileSync(GH, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    throw new Error(`${e.stdout || ''}${e.stderr || ''}`.trim() || e.message);
  }
}

/** 인증된 gh 토큰을 electron-builder에 넘긴다 — GH_TOKEN을 따로 세팅하지 않아도 되게 */
function ensureToken() {
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return;
  try {
    const t = gh(['auth', 'token']).trim();
    if (!t) throw new Error('빈 토큰');
    process.env.GH_TOKEN = t;
  } catch (e) {
    die(`GitHub 토큰을 얻지 못했습니다. 'gh auth login' 후 다시 시도하세요.\n  ${e.message}`);
  }
}

function releaseInfo() {
  try {
    return JSON.parse(gh([
      'release', 'view', TAG, '--repo', REPO,
      '--json', 'assets,isDraft,isPrerelease,tagName,url'
    ]));
  } catch {
    return null;
  }
}

/** electron-builder를 셸 없이 실행한다 (.cmd 래퍼를 거치지 않도록 JS 진입점을 직접 호출) */
function runBuilder() {
  const ebDir = path.join(ROOT, 'node_modules', 'electron-builder');
  const ebPkg = JSON.parse(fs.readFileSync(path.join(ebDir, 'package.json'), 'utf8'));
  const rel = typeof ebPkg.bin === 'string' ? ebPkg.bin : ebPkg.bin['electron-builder'];
  const entry = path.join(ebDir, rel);
  if (!fs.existsSync(entry)) die(`electron-builder 진입점을 찾지 못했습니다: ${entry}`);
  execFileSync(process.execPath, [entry, '--win', '-p', 'always'], {
    cwd: ROOT, stdio: 'inherit', env: process.env
  });
}

/** latest.yml에 적힌 해시가 실제 설치 파일과 맞는지 — 틀리면 업데이터가 설치를 거부한다 */
function verifyHash() {
  const ymlPath = path.join(DIST, 'latest.yml');
  if (!fs.existsSync(ymlPath)) die('dist/latest.yml 이 없습니다. 빌드가 끝나지 않았습니다.');
  const yml = fs.readFileSync(ymlPath, 'utf8');

  const ver = (yml.match(/^version:\s*(\S+)/m) || [])[1];
  if (ver !== VERSION) die(`latest.yml 버전이 다릅니다: ${ver} (package.json은 ${VERSION})`);

  const file = (yml.match(/^path:\s*(\S+)/m) || [])[1];
  const sha = (yml.match(/^sha512:\s*(\S+)/m) || [])[1];
  if (!file || !sha) die('latest.yml 에서 path/sha512 를 읽지 못했습니다.');

  const exe = path.join(DIST, file);
  if (!fs.existsSync(exe)) die(`설치 파일이 없습니다: ${file}`);
  const actual = crypto.createHash('sha512').update(fs.readFileSync(exe)).digest('base64');
  if (actual !== sha) die(`sha512 불일치 — 업데이터가 설치를 거부합니다.\n  ${file}`);

  log(`  ✓ latest.yml ↔ ${file} 해시 일치`);
}

function verifyAssets(info) {
  const names = (info.assets || []).map((a) => a.name);
  const missing = [];
  if (!names.includes('latest.yml')) missing.push('latest.yml');
  if (!names.some((n) => /-x64\.exe$/.test(n))) missing.push('설치 파일(-x64.exe)');
  if (!names.some((n) => /-x64\.exe\.blockmap$/.test(n))) missing.push('blockmap');
  if (missing.length) die(`릴리스에 빠진 자산: ${missing.join(', ')}\n  ${info.url}`);
  for (const a of info.assets) log(`  ✓ ${a.name}  ${(a.size / 1048576).toFixed(2)}MB`);
}

/** 로그인하지 않은 사용자가 보는 경로 — 업데이터가 실제로 쓰는 URL */
function fetchPublicYml(url, redirects = 0) {
  return new Promise((resolve) => {
    if (redirects > 5) return resolve({ code: 0, body: '' });
    const req = https.get(url, { timeout: 20000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchPublicYml(res.headers.location, redirects + 1));
      }
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ code: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ code: 0, body: '' }); });
    req.on('error', () => resolve({ code: 0, body: '' }));
  });
}

const PUBLIC_YML = `https://github.com/${REPO}/releases/latest/download/latest.yml`;

(async () => {
  log(`\n눈쉼 ${TAG} → ${REPO}\n`);

  if (CHECK_ONLY) {
    const info = releaseInfo();
    if (!info) die(`${TAG} 릴리스가 없습니다.`);
    log(`릴리스: draft=${info.isDraft}  ${info.url}`);
    verifyAssets(info);
    if (info.isDraft) {
      log('\n초안 상태입니다 — 발행 전에는 자동 업데이트에 잡히지 않습니다.');
      log(`  npm run ship            (다시 올리고 발행)`);
      log(`  gh release edit ${TAG} --repo ${REPO} --draft=false --latest`);
      process.exit(0);
    }
    const { code, body } = await fetchPublicYml(PUBLIC_YML);
    if (code !== 200) die(`공개 latest.yml 접근 실패 (HTTP ${code})`);
    const ver = (body.match(/^version:\s*(\S+)/m) || [])[1];
    log(`  ✓ 공개 경로 HTTP 200, version: ${ver}`);
    log(ver === VERSION
      ? '\n✓ 정상 — 배포된 앱이 이 버전을 받습니다.'
      : `\n⚠ 공개 경로가 ${ver} 를 가리킵니다 (현재 ${VERSION}).`);
    process.exit(0);
  }

  const existing = releaseInfo();
  if (existing && !existing.isDraft) {
    die(`${TAG} 은 이미 발행돼 있습니다. 버전을 올리세요.\n  npm version patch\n  ${existing.url}`);
  }

  ensureToken();
  log('빌드하고 업로드합니다… (몇 분 걸립니다)\n');
  try {
    runBuilder();
  } catch {
    die('빌드/업로드가 실패했습니다.');
  }

  log('\n검증합니다.');
  verifyHash();
  const info = releaseInfo();
  if (!info) die(`업로드 후에도 ${TAG} 릴리스를 찾지 못했습니다.`);
  verifyAssets(info);

  if (KEEP_DRAFT) {
    log(`\n초안으로 남겨둡니다: ${info.url}`);
    process.exit(0);
  }

  log('\n발행합니다.');
  gh(['release', 'edit', TAG, '--repo', REPO, '--draft=false', '--latest']);

  const { code, body } = await fetchPublicYml(PUBLIC_YML);
  if (code !== 200) {
    die(`발행은 됐지만 공개 latest.yml 접근이 실패했습니다 (HTTP ${code}).\n  잠시 후 'npm run ship -- --check' 로 확인하세요.`);
  }
  const ver = (body.match(/^version:\s*(\S+)/m) || [])[1];
  if (ver !== VERSION) die(`공개 경로가 ${ver} 를 가리킵니다. 릴리스를 확인하세요.`);

  log(`  ✓ 공개 경로 HTTP 200, version: ${ver}`);
  log(`\n✓ ${TAG} 배포 완료 — 기존 사용자에게 자동으로 잡힙니다.`);
  log(`  https://github.com/${REPO}/releases/tag/${TAG}`);
})();
