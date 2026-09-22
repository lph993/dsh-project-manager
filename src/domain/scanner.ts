/**
 * 首次扫描：零 token 骨架（FR-38 / FR-39 阶段 A）。
 *
 * 设计要点（§6.4b）：
 * - 阶段 A **完全不调 AI**：只看文件树、`package.json`、README、目录结构、已有 md；
 * - 产物是"草稿树"，立即可见（FR-39a），不等待任何模型调用；
 * - 产物节点标 `autoCreated`（FR-39d），与用户手建节点在 UI 上可区分；
 * - 只做**抽样与推断**，不保证任务清单完整（§0.1 边界声明）。
 *
 * 本模块是**纯函数**：输入已遍历好的文件清单，输出建议节点树。
 * 真正的磁盘遍历在 `src/adapter/workspace.ts`。
 */

import type { NodeKind } from '../shared/types.ts';
import {
  DEFAULT_HEURISTIC_COEFFICIENTS,
  computeHeuristicScore,
  isStructurallyDegenerate,
  scoreLeaf,
  type HeuristicCoefficients,
  type HeuristicSignals,
  type HeuristicWeightDetail,
} from '../weight/heuristic.ts';

/** 一个被扫描到的文件/目录条目。 */
export interface ScannedEntry {
  /** 工作区相对路径（`/` 分隔，目录不带尾斜杠）。 */
  path: string;
  kind: 'file' | 'dir';
  sizeBytes?: number;
  /**
   * 文本文件行数（阶段 A 统计；供零 token 启发式权重轨使用，§9.3a）。
   *
   * 读盘受限（文件过大、读取失败、读盘预算耗尽）时为**估算值**，并由
   * `lineCountEstimated` 如实标注 —— 不允许把估算当成实测。
   */
  lineCount?: number;
  /** `lineCount` 是否为估算值。 */
  lineCountEstimated?: boolean;
}

/** 扫描参数（对应设置项 FR-81）。 */
export interface ScanOptions {
  /** 目录深度上限（超过则不再下钻）。默认 3。 */
  maxDepth: number;
  /** 单个目录下最多取多少个子项（防止根目录巨大时节点爆炸）。默认 12。 */
  maxChildrenPerDir: number;
  /** 最多产出多少个节点（硬上限，超出即截断并如实标注）。默认 200。 */
  maxNodes: number;
  /** 包含 glob（空数组表示全部）。 */
  include: string[];
  /** 排除 glob。 */
  exclude: string[];
  /** 根目录名（用于建议项目名）。 */
  rootDirName?: string;
  /** `package.json` 的 name（由调用方读盘后传入，用于建议项目名）。 */
  packageName?: string;
  /**
   * 启发式权重系数（§9.3a；默认 `DEFAULT_HEURISTIC_COEFFICIENTS`）。
   *
   * 有它就等于开了**零 token 工作量口径**：叶节点会带 `weight`/`weightDetail`。
   */
  coefficients?: HeuristicCoefficients;
}

export const DEFAULT_SCAN_OPTIONS: ScanOptions = {
  maxDepth: 3,
  maxChildrenPerDir: 12,
  maxNodes: 200,
  include: [],
  exclude: [],
};

/**
 * 没有实测行数时，用字节数估算行数的**保守**比值（§9.3a 的诚实边界）。
 *
 * 40 字节/行是"代码文件平均行长"的粗估：写成估算值而不是假装实测，
 * 是为了让用户能在 `weightDetail.signals.lineCountEstimated` 里看见这一点。
 */
export const BYTES_PER_LINE_ESTIMATE = 40;

/** 建议节点（尚未落库）。 */
export interface SuggestedNode {
  /** 稳定 key：同一份工作区重复扫描应得到相同 key（便于增量与去重）。 */
  key: string;
  name: string;
  kind: NodeKind;
  /** 父节点的 key；根为 null。 */
  parentKey: string | null;
  /** 依据来源，供用户判断这是怎么来的。 */
  origin: 'root' | 'directory' | 'entry-file' | 'doc' | 'module-dir';
  /** 该节点关联的路径（落到 refs）。 */
  refs: Array<{ type: 'dir' | 'md' | 'code'; target: string }>;
  /** 详细说明（名称之外的说明放这里，FR-11）。 */
  description?: string;
  /**
   * 零 token 启发式权重（§9.3a）。**只对叶节点给值**：父节点权重 = Σ 子权重，不独立测量。
   */
  weight?: number;
  /** 权重来源（阶段 A 只有启发式轨）。 */
  weightSource?: 'heuristic';
  /** 权重依据（信号构成，供用户核对）。 */
  weightDetail?: HeuristicWeightDetail;
}

/** 扫描结果。 */
export interface ScanResult {
  /** 项目名建议（来自 package.json 的 name 或根目录名）。 */
  projectName: string;
  nodes: SuggestedNode[];
  /** 被扫到的条目数。 */
  scanned: number;
  /** 被排除/跳过的条目数（诚实交代）。 */
  skipped: number;
  /** 是否因上限被截断。 */
  truncated: boolean;
  /** 截断或跳过的原因说明（给用户看）。 */
  notes: string[];
}

/** 入口文件 / 关键文件的识别表（阶段 A 的"只读入口文件"，§9.5 T4）。 */const ENTRY_FILE_PATTERNS: Array<{ pattern: RegExp; label: string; origin: SuggestedNode['origin'] }> = [
  { pattern: /^package\.json$/, label: '依赖与脚本清单', origin: 'entry-file' },
  { pattern: /^pnpm-workspace\.yaml$/, label: '工作区定义', origin: 'entry-file' },
  { pattern: /^tsconfig.*\.json$/, label: 'TS 编译配置', origin: 'entry-file' },
  { pattern: /^README\.md$/i, label: '项目说明', origin: 'doc' },
  { pattern: /^CHANGELOG\.md$/i, label: '变更记录', origin: 'doc' },
  { pattern: /^docs?$/i, label: '文档目录', origin: 'doc' },
  { pattern: /^src$/i, label: '源码目录', origin: 'module-dir' },
  { pattern: /^packages$/i, label: '多包目录', origin: 'module-dir' },
  { pattern: /^apps$/i, label: '应用目录', origin: 'module-dir' },
  { pattern: /^test(s)?$/i, label: '测试目录', origin: 'module-dir' },
  { pattern: /^scripts$/i, label: '脚本目录', origin: 'module-dir' },
];

/** 目录名 → 人类可读节点名（避免把 `src` 直接当节点名）。 */
const DIR_LABELS: Record<string, string> = {
  src: '源码',
  source: '源码',
  lib: '库代码',
  packages: '子包',
  apps: '应用',
  docs: '文档',
  doc: '文档',
  test: '测试',
  tests: '测试',
  spec: '测试',
  specs: '测试',
  scripts: '脚本',
  tools: '工具',
  config: '配置',
  configs: '配置',
  assets: '资源',
  public: '静态资源',
  static: '静态资源',
  styles: '样式',
  types: '类型定义',
  utils: '工具函数',
  components: '组件',
  server: '服务端',
  client: '客户端',
  api: '接口层',
  db: '数据层',
  domain: '领域层',
  core: '内核',
  infra: '基础设施',
  ui: '界面',
  hooks: 'Hooks',
  store: '状态管理',
  router: '路由',
  pages: '页面',
  views: '视图',
  locales: '国际化',
  i18n: '国际化',
};

/** glob 的最小匹配（只支持 `*`、`**` 与路径前缀，够用且可测）。 */
export function matchesGlob(path: string, glob: string): boolean {
  if (glob === '') return false;
  const normalized = glob.replace(/\\/g, '/').replace(/\/+$/, '');

  // `**` 单独出现：匹配任意层级下的该名字
  if (normalized === '**') return true;
  if (normalized.startsWith('**/')) {
    const tail = normalized.slice(3);
    return path === tail || path.endsWith(`/${tail}`) || path.includes(`/${tail}/`) || matchesGlob(path, tail);
  }
  // `dir/**`：该目录及其下全部
  if (normalized.endsWith('/**')) {
    const prefix = normalized.slice(0, -3);
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  // `**.ts` 这类后缀写法
  if (normalized.startsWith('**')) {
    const suffix = normalized.slice(2);
    return path.endsWith(suffix);
  }
  if (normalized.includes('*')) {
    const pattern = normalized
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^/]*');
    return new RegExp(`^${pattern}$`).test(path);
  }
  return path === normalized || path.startsWith(`${normalized}/`);
}

/** 是否被 include/exclude 规则选中。 */
export function isSelected(path: string, options: ScanOptions): boolean {
  for (const glob of options.exclude) {
    if (matchesGlob(path, glob)) return false;
  }
  if (options.include.length === 0) return true;
  return options.include.some((glob) => matchesGlob(path, glob));
}

/**
 * 从已遍历的条目生成建议节点树（**零 token**）。
 *
 * 规则（阶段 A 的"骨架"语义）：
 * - 根节点 = 项目名；
 * - 顶层**目录** → `feature` 子节点（名称用 DIR_LABELS 中文化，保留原目录名于 description）；
 * - 顶层**关键文件**（package.json / README / tsconfig / 文档）→ `task` 子节点；
 * - 目录内的文件按深度下钻，每层最多 `maxChildrenPerDir` 个；
 * - 明显是"任务"的文件（测试、脚本、入口）标为 `task`，其余聚合为一个"其余文件"节点（避免节点爆炸）。
 */
export function buildSuggestedTree(entries: readonly ScannedEntry[], options: ScanOptions): ScanResult {
  const notes: string[] = [];
  let skipped = 0;
  let truncated = false;

  const selected = entries.filter((entry) => {
    if (entry.path === '') return false;
    if (!isSelected(entry.path, options)) {
      skipped += 1;
      return false;
    }
    return true;
  });

  // 深度上限的**预先统计**：一次性把"哪些层没展开"说清楚。
  // 不能依赖递归中的 push 失败来报，因为节点数上限会先命中并把说明吞掉（曾踩过）。
  const beyondDepth = new Map<number, number>();
  for (const entry of selected) {
    const depth = entry.path.split('/').length - (entry.kind === 'dir' ? 0 : 1);
    if (depth > options.maxDepth) {
      beyondDepth.set(depth, (beyondDepth.get(depth) ?? 0) + 1);
    }
  }
  if (beyondDepth.size > 0) {
    const deepest = Math.max(...beyondDepth.keys());
    const total = [...beyondDepth.values()].reduce((sum, n) => sum + n, 0);
    notes.push(
      `已达深度上限 ${options.maxDepth}：更深一层共 ${total} 个条目未纳入骨架（最深到第 ${deepest} 层）。` +
        '可用「重新扫描」调高深度上限，或手动「添加」补节点。',
    );
  }

  const rootName = suggestProjectName({
    ...(options.rootDirName !== undefined ? { rootDirName: options.rootDirName } : {}),
    ...(options.packageName !== undefined ? { packageName: options.packageName } : {}),
  });
  const nodes: SuggestedNode[] = [
    {
      key: 'root',
      name: rootName,
      kind: 'feature',
      parentKey: null,
      origin: 'root',
      refs: [],
      description: '由零 token 骨架扫描自动创建；请按实际项目语义重命名与调整。',
    },
  ];

  const push = (node: SuggestedNode): boolean => {
    if (nodes.length >= options.maxNodes) {
      truncated = true;
      return false;
    }
    nodes.push(node);
    return true;
  };

  /**
   * 每个建议节点覆盖的条目集合所对应的**结构信号**（§9.3a）。
   *
   * 由创建点显式登记（目录 = 该目录的直接文件、文件 = 自身、聚合节点 = 被聚合的那些文件），
   * 而不是事后猜 —— 聚合节点（"其余 N 个文件"）事后无法还原它到底盖了哪些文件。
   */
  const signalByKey = new Map<string, HeuristicSignals>();

  /**
   * 由"这个节点覆盖的文件集合"算出结构信号。
   *
   * 口径：`fileCount` / `lineCount` 是**直接**文件口径（与 §9.3a 信号表一致）；
   * `subtreeCount` 对叶节点恒为 1（含自身），照实填，避免"看起来有区分度其实没有"的假信号。
   */
  function signalsFromFiles(kind: NodeKind, files: readonly ScannedEntry[]): HeuristicSignals {
    let lineCount = 0;
    let estimated = false;
    for (const file of files) {
      lineCount += linesOf(file);
      // 没有实测行数（要么调用方已标估算，要么根本没给）→ 这个节点用的是估算值
      if (file.lineCountEstimated === true || typeof file.lineCount !== 'number') {
        estimated = true;
      }
    }
    return {
      fileCount: files.length,
      lineCount,
      subtreeCount: 1,
      kind,
      ...(estimated ? { lineCountEstimated: true } : {}),
    };
  }

  /** 单文件行数（缺失时按字节数保守估算，并如实标记为估算）。 */
  function linesOf(file: ScannedEntry): number {
    if (typeof file.lineCount === 'number' && Number.isFinite(file.lineCount)) {
      return Math.max(0, Math.floor(file.lineCount));
    }
    if (typeof file.sizeBytes === 'number' && Number.isFinite(file.sizeBytes)) {
      return Math.max(0, Math.round(file.sizeBytes / BYTES_PER_LINE_ESTIMATE));
    }
    return 0;
  }

  // 按路径深度分层，构建一个内存树
  interface DirNode {
    path: string;
    children: Map<string, DirNode>;
    files: ScannedEntry[];
  }
  const root: DirNode = { path: '', children: new Map(), files: [] };
  const dirIndex = new Map<string, DirNode>([['', root]]);
  const ensureDir = (path: string): DirNode => {
    const existing = dirIndex.get(path);
    if (existing) return existing;
    const segments = path.split('/');
    const parentPath = segments.slice(0, -1).join('/');
    const parent = ensureDir(parentPath);
    const node: DirNode = { path, children: new Map(), files: [] };
    parent.children.set(segments[segments.length - 1] ?? path, node);
    dirIndex.set(path, node);
    return node;
  };

  for (const entry of selected) {
    const depth = entry.path.split('/').length;
    if (depth > options.maxDepth + 1) {
      skipped += 1;
      continue;
    }
    if (entry.kind === 'dir') {
      ensureDir(entry.path);
      continue;
    }
    const parentPath = entry.path.split('/').slice(0, -1).join('/');
    ensureDir(parentPath).files.push(entry);
  }

  // 递归产出：目录深度 ≤ maxDepth
  // 递归产出：目录深度 ≤ maxDepth
  const visited: string[] = [];
  const walk = (dir: DirNode, parentKey: string, depth: number): void => {
    // 先判深度：子目录节点已建出来，但**不展开**其内容 —— 必须如实说明，
    // 否则用户会以为"这个目录下面就是空的"（§0.1 诚实边界）。
    if (depth > options.maxDepth) {
      if (dir.children.size > 0 || dir.files.length > 0) {
        notes.push(
          `已达深度上限 ${options.maxDepth}，未展开：${dir.path || '(根)'}（含 ${dir.children.size} 个子目录、${dir.files.length} 个文件）`,
        );
      }
      return;
    }
    visited.push(dir.path);

    // ① 子目录
    const childDirs = [...dir.children.values()].sort((a, b) => a.path.localeCompare(b.path));
    for (const child of childDirs.slice(0, options.maxChildrenPerDir)) {
      const name = child.path.split('/').pop() ?? child.path;
      const label = DIR_LABELS[name] ?? name;
      const key = `dir:${child.path}`;
      const created = push({
        key,
        name: label,
        kind: 'feature',
        parentKey,
        origin: 'directory',
        refs: [{ type: 'dir', target: child.path }],
        description: `目录 ${child.path}/（由骨架扫描建议；如需可拆成任务）`,
      });
      if (!created) return;
      signalByKey.set(key, signalsFromFiles('feature', child.files));
      walk(child, key, depth + 1);
    }
    if (childDirs.length > options.maxChildrenPerDir) {
      notes.push(
        `${dir.path || '(根)'} 下有 ${childDirs.length} 个子目录，只展开了前 ${options.maxChildrenPerDir} 个（可用「添加」补充）`,
      );
    }

    // ② 关键文件（package.json / README / tsconfig / 文档…）作为可执行任务点；
    //    **其余文件一律聚合**，不逐个建节点。
    //
    // 为什么改成"只认关键文件"（实测反馈）：首版是"文件不多时逐个建节点"，
    // 于是扫描本插件自己的仓库会把 `lib/index.js`、`client.js`、`.gitignore` 全变成
    // "未完成任务" —— 用户看到的是**文件清单**，不是任务清单，语义是错的。
    // 目录本身已经承载了"这堆代码"的语义（文件数/行数进了权重信号）。
    const files = [...dir.files].sort((a, b) => a.path.localeCompare(b.path));
    const named: ScannedEntry[] = [];
    const rest: ScannedEntry[] = [];
    for (const file of files) {
      const base = file.path.split('/').pop() ?? file.path;
      const known = ENTRY_FILE_PATTERNS.find((item) => item.pattern.test(base));
      if (known) named.push(file);
      else rest.push(file);
    }

    for (const file of named.slice(0, options.maxChildrenPerDir)) {
      const base = file.path.split('/').pop() ?? file.path;
      const known = ENTRY_FILE_PATTERNS.find((item) => item.pattern.test(base));
      const key = `file:${file.path}`;
      const created = push({
        key,
        name: known ? `${base}（${known.label}）` : base,
        kind: 'task',
        parentKey,
        origin: known?.origin ?? 'entry-file',
        refs: [
          base.endsWith('.md')
            ? { type: 'md', target: file.path }
            : { type: 'code', target: file.path },
        ],
        description: `${known?.label ?? '文件'}：${file.path}`,
      });
      if (!created) return;
      signalByKey.set(key, signalsFromFiles('task', [file]));
    }
    if (named.length > options.maxChildrenPerDir) {
      notes.push(
        `${dir.path || '(根)'} 下另有 ${named.length - options.maxChildrenPerDir} 个文件未建节点（避免节点爆炸）`,
      );
      skipped += named.length - options.maxChildrenPerDir;
    }
    if (rest.length > 0) {
      const created = push({
        key: `rest:${dir.path || 'root'}`,
        name:
          named.length === 0
            ? `目录内 ${rest.length} 个文件`
            : `其余 ${rest.length} 个文件`,
        kind: 'task',
        parentKey,
        origin: 'directory',
        refs: [{ type: 'dir', target: dir.path || '.' }],
        description: `未被单独建节点的文件：${rest
          .slice(0, 8)
          .map((f) => f.path)
          .join('、')}${rest.length > 8 ? ' …' : ''}`,
      });
      if (!created) return;
      signalByKey.set(`rest:${dir.path || 'root'}`, signalsFromFiles('task', rest));
      skipped += rest.length;
    }
  };

  walk(root, 'root', 0);

  // 根节点覆盖"根目录的直接文件"
  signalByKey.set('root', signalsFromFiles('feature', root.files));

  // ── 零 token 启发式权重（§9.3a）：**只给叶节点**算权重 ──────────────
  // 父节点权重 = Σ 子权重（§9.3），不独立测量；因此这里跳过非叶节点。
  const childCount = new Map<string, number>();
  for (const node of nodes) {
    if (node.parentKey !== null) {
      childCount.set(node.parentKey, (childCount.get(node.parentKey) ?? 0) + 1);
    }
  }
  const coefficients = options.coefficients ?? DEFAULT_HEURISTIC_COEFFICIENTS;
  const leaves = nodes.filter((node) => (childCount.get(node.key) ?? 0) === 0);
  const leafScores = leaves
    .map((node) => signalByKey.get(node.key))
    .filter((signals): signals is HeuristicSignals => signals !== undefined)
    .map((signals) => computeHeuristicScore(signals, coefficients));
  const degenerate = isStructurallyDegenerate(leafScores);
  if (degenerate && leaves.length > 0) {
    notes.push(
      '零 token 路径没有拿到任何结构差异（所有叶节点的结构分都触到硬下限）→ ' +
        '百分比按件数口径，看板会如实标注「按件数·无结构数据」。',
    );
  }
  for (const node of leaves) {
    const signals = signalByKey.get(node.key);
    if (!signals) continue;
    const scored = scoreLeaf({ signals, coefficients, degenerate });
    node.weight = scored.weight;
    node.weightSource = 'heuristic';
    node.weightDetail = scored.detail;
  }

  if (truncated) {
    notes.push(`节点数已达上限 ${options.maxNodes}，扫描结果已截断（可提高上限或缩小范围后重新扫描）`);
  }

  return {
    projectName: rootName,
    nodes,
    scanned: selected.length,
    skipped,
    truncated,
    notes,
  };
}

/**
 * 建议项目名。
 *
 * 优先级：显式 `rootDirName` → `package.json` 的 `name`（由调用方读盘后传入）→ 兜底。
 */
export function suggestProjectName(input: {
  rootDirName?: string;
  packageName?: string;
}): string {
  const fromDir = input.rootDirName?.trim();
  if (fromDir !== undefined && fromDir !== '') return fromDir;
  const fromPkg = input.packageName?.trim();
  if (fromPkg !== undefined && fromPkg !== '') return fromPkg;
  return '未命名项目';
}

/** 从 `package.json` 文本里取项目名（解析失败返回 undefined，不抛错）。 */
export function readPackageName(packageJsonText: string | undefined): string | undefined {
  if (packageJsonText === undefined) return undefined;
  try {
    const parsed = JSON.parse(packageJsonText) as { name?: unknown };
    return typeof parsed.name === 'string' ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}
