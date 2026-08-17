'use strict';
/**
 * 코드 검사 규칙.
 *
 * 목적은 «깔끔한 코드»가 아니라 «이 앱을 실제로 죽인 실수»를 커밋 전에 잡는 것이다.
 * 지금까지 겪은 것:
 *   - 선언보다 먼저 쓴 변수 → 위젯 전체가 죽음 (lastMailBox)
 *   - 같은 실수 → 설정 화면이 통째로 멈춤 (sigSrcOn)
 *   - 오타 난 함수 이름 → 눌러도 아무 일이 없음
 * 그래서 no-use-before-define과 no-undef가 이 설정의 핵심이다. 나머지는 곁다리다.
 *
 * 화면 코드(renderer/*.html)도 반드시 본다 — 위의 사고가 전부 거기서 났다.
 */
const globals = require('globals');
const html = require('eslint-plugin-html');

/** 두 곳 모두에 적용할 «진짜 사고를 막는» 규칙 */
const catchesRealBugs = {
  // 선언보다 먼저 쓰면 그 순간 스크립트가 통째로 멈춘다 (TDZ)
  'no-use-before-define': ['error', { functions: false, classes: true, variables: true }],
  // 없는 이름을 부르는 것 — 오타 난 함수/변수
  'no-undef': 'error',
  // 같은 이름을 두 번 선언
  'no-redeclare': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-dupe-else-if': 'error',
  'no-duplicate-case': 'error',
  // 도달할 수 없는 코드 = 대개 return 위치를 잘못 잡은 것
  'no-unreachable': 'error',
  // await를 빠뜨린 자리
  'require-atomic-updates': 'off',
  'no-async-promise-executor': 'error',
  // 실수로 만든 전역 (const/let 빠뜨림)
  'no-implicit-globals': 'off',
  'no-cond-assign': 'error',
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-unsafe-negation': 'error',
  'no-unsafe-optional-chaining': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
  // 안 쓰는 변수는 대개 «고치다 만 자리»다. 인자는 뺀다 — 콜백 서명 때문에 어쩔 수 없다.
  'no-unused-vars': ['warn', {
    args: 'none',
    varsIgnorePattern: '^_',
    caughtErrors: 'none'
  }]
};

module.exports = [
  {
    // 검사하지 않을 곳
    ignores: ['node_modules/**', 'dist/**', 'build/**', 'assets/**']
  },
  {
    // ── 메인 프로세스 · 스크립트 (Node) ──────────────
    files: ['src/**/*.js', 'scripts/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node }
    },
    rules: catchesRealBugs
  },
  {
    // ── 화면 ─────────────────────────────────────────
    // 여기가 사고가 나던 곳이다. 반드시 검사한다.
    // 큰 화면(설정·위젯·쓰기)의 코드는 .js로 빼두었고, 작은 것은 아직 HTML 안에 있다.
    files: ['renderer/**/*.js', 'renderer/**/*.html'],
    plugins: { html },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        // preload가 붙여주는 다리와, 별도 <script>로 먼저 실려오는 것들
        nunsseom: 'readonly',
        nunsIcon: 'readonly',
        nunsSound: 'readonly'
      }
    },
    rules: catchesRealBugs
  }
];
