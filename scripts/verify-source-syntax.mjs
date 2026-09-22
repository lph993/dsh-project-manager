/**
 * 源码自检：Node 的 TS **strip-only** 模式不支持的语法。
 *
 * 为什么需要它：本仓的测试直接 `node --test` 跑 TypeScript 源码（不额外加一层构建），
 * Node 只用"擦除类型"的方式执行 TS，因此有些合法 TS 语法它**不认**。
 * 踩过的坑：
 * - 构造函数**参数属性**（`constructor(private readonly x: T) {}`）
 *   → `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`，而且报错发生在 import 阶段，
 *     表现为"测试文件整体加载失败"，很容易被误读成测试超时/环境问题。
 * - `const enum`、`namespace`、装饰器参数属性同理（装饰器本仓不用）。
 *
 * 与其每次踩了再查，不如在构建阶段一次性扫出来。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SCAN_DIRS = ['src', 'tests'];

/** 每条规则：名字 + 正则 + 为什么不行。 */
const RULES = [
  {
    name: 'constructor-parameter-property',
    // 构造函数签名里出现 public/private/protected/readonly 修饰的参数（同一行内）
    pattern: /\(\s*(?:public|private|protected|readonly)\s+[A-Za-z_$]/,
    // 只查构造函数附近，避免误伤普通方法参数
    requires: /constructor\s*\(/,
    reason: 'Node 的 TS strip-only 模式不支持构造函数参数属性（ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX）',
  },
  {
    name: 'const-enum',
    pattern: /\bconst\s+enum\b/,
    reason: '`const enum` 会被擦除，strip-only 模式下行为不确定；改用普通对象 + as const',
  },
  {
    name: 'namespace',
    pattern: /^\s*(?:export\s+)?namespace\s+[A-Za-z_$]/m,
    reason: '`namespace` 不是纯类型语法，strip-only 模式不支持',
  },
];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules') continue;
      yield* walk(full);
    } else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
      yield full;
    }
  }
}

/**
 * 剥掉注释，只留代码。
 *
 * 为什么不能只用正则：块注释的续行常常不以 `*` 开头（本仓的注释就是），
 * 用 `/^\s*\*.*$/` 会漏掉它们，于是"注释里解释某语法为什么不能用"会自我命中（真踩过）。
 * 用一个小状态机处理 `//`、`/* *\/`、以及字符串里的 `//`。
 */
function stripComments(text) {
  let out = '';
  let inBlock = false;
  let inLine = false;
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (ch === '\n') {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (quote !== null) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLine = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      continue;
    }
    out += ch;
  }
  return out;
}

const problems = [];
for (const dir of SCAN_DIRS) {
  const absolute = join(ROOT, dir);
  for (const file of walk(absolute)) {
    const raw = readFileSync(file, 'utf8');
    const text = stripComments(raw);
    const lines = text.split(/\r?\n/);
    for (const rule of RULES) {
      lines.forEach((line, index) => {
        if (line.trim() === '') return;
        if (!rule.pattern.test(line)) return;
        // 有些规则只在特定上下文里成立（降低误报）
        if (rule.requires) {
          const window = lines.slice(Math.max(0, index - 3), index + 1).join('\n');
          if (!rule.requires.test(window)) return;
        }
        problems.push({
          file: relative(ROOT, file).replace(/\\/g, '/'),
          line: index + 1,
          rule: rule.name,
          reason: rule.reason,
          text: raw.split(/\r?\n/)[index]?.trim() ?? line.trim(),
        });
      });
    }
  }
}

if (problems.length > 0) {
  console.error('源码自检失败：出现 Node TS strip-only 不支持的语法：');
  for (const problem of problems) {
    console.error(`  - ${problem.file}:${problem.line} [${problem.rule}] ${problem.reason}`);
    console.error(`      ${problem.text}`);
  }
  process.exit(1);
}
console.log('源码自检通过：没有 Node TS strip-only 不支持的语法。');
