/**
 * 画布图例的**唯一来源**（用户反馈："不用在 tooltip 上展示每个图标或者 `自` 介绍，
 * 可以写到专门的地方"）。
 *
 * 为什么要有这个文件而不是把说明散在各处：
 * ① 角标/连线/数字口径的**含义**必须与实际画出来的**符号**同源 —— 改了符号忘了改说明，
 *    用户就会看到"图例里没有这个符号"；所以符号本身也在这里定义（`AUTO_BADGE` 等），
 *    画布与图例 import 同一份常量；
 * ② 悬停卡不该承担"逐个解释图标"的职责（那是图例的活）：悬停只回答"这个节点是什么"，
 *    图例回答"这些符号是什么意思"。
 *
 * 单测（`tests/client/legend.test.ts`）会钉住：每个计算状态都有条目、符号不重复、
 * 且画布用的符号常量确实出现在图例里。
 */

import { DERIVED_STATE_LABEL } from './api.ts';

/** 角标/标记符号（画布与图例共用同一份常量，避免"改了符号忘了改说明"）。 */
export const FOCUS_BADGE = '◆';
export const MIDWAY_BADGE = '+';
/** 自动生成（扫描或 AI 建树创建）。用户反馈"自换成图标吧，合适点" → 用齿轮表示"机器生成"。 */
export const AUTO_BADGE = '⚙';
export const ROLLBACK_BADGE = '↺';
/** 进行中的转圈图标（画布里是 SMIL 动画，图例里用同一个字符表示）。 */
export const RUNNING_SPINNER = '◌';
/** 未完成的任务点（叶节点右下角的空心方点）。 */
export const PENDING_LEAF_MARK = '□';

export interface LegendEntry {
  /** 画布上真的画出来的那个符号（空字符串表示"没有符号，只有线条/底色"）。 */
  glyph: string;
  meaning: string;
}

export interface LegendSection {
  title: string;
  /** 一句话说明这一层是干什么的（避免图例变成符号表）。 */
  note?: string;
  entries: LegendEntry[];
}

/** 状态层：填充 / 角标 / 外发光（§11.2 第二层）。 */
export function stateLegend(): LegendEntry[] {
  // 顺序固定：与"从常见到少见"的阅读顺序一致；状态名取自同一份 `DERIVED_STATE_LABEL`
  const order: Array<keyof typeof DERIVED_STATE_LABEL> = [
    'running',
    'done',
    'error',
    'paused',
    'held',
    'pending',
  ];
  return order.map((state) => ({
    glyph: GLYPH_OF_STATE[state] ?? '',
    meaning: STATE_MEANING[state] ?? DERIVED_STATE_LABEL[state] ?? state,
  }));
}

const GLYPH_OF_STATE: Record<string, string> = {
  running: RUNNING_SPINNER,
  done: '✓',
  error: '!',
  paused: 'Ⅱ',
  held: '⛔',
  pending: '',
};

const STATE_MEANING: Record<string, string> = {
  running: '进行中：右上角转圈（有会话/子代理正在做）；节点底色偏蓝',
  done: '已完成：绿边框 + 勾 + 满格进度条',
  error: '异常：红色填充 + ! 角标（需要人看）',
  paused: '已暂停：琥珀色填充 + Ⅱ（门控 paused，可继续）',
  held: '已拦停：深红填充 + ⛔（整枝停止，重新评审后放行）',
  pending: '待开始：无填充（未完成但还没人动）',
};

/** 完整图例（弹窗按顺序渲染）。 */
export function legendSections(): LegendSection[] {
  return [
    {
      title: '完成态（边框线型 + 边框色，第一层）',
      note: '这一层只回答"这枝/这个点还有没有没干完的"，与具体状态分开编码，互不覆盖。',
      entries: [
        { glyph: '┄┄', meaning: '枝还没完成（虚线边框）' },
        { glyph: '──', meaning: '枝已完成（绿色实线 + 勾）' },
        { glyph: PENDING_LEAF_MARK, meaning: '叶节点未完成（右下角空心方点 = 一个待办单元）' },
      ],
    },
    {
      title: '状态（填充 / 角标 / 外发光，第二层）',
      note: '所有状态都同时有符号，不只靠颜色（无障碍要求）。',
      entries: stateLegend(),
    },
    {
      title: '标记（与状态正交的旗标，可叠加）',
      entries: [
        { glyph: FOCUS_BADGE, meaning: '已关注：这一枝进「关注枝」统计（画布上还有蓝色外发光）' },
        {
          glyph: AUTO_BADGE,
          meaning: '自动生成：由扫描或 AI 建树创建（不是人手写的）；改名/改描述后照常用',
        },
        { glyph: MIDWAY_BADGE, meaning: '中途新增：不是最初建树时就有的' },
        { glyph: ROLLBACK_BADGE, meaning: '回滚过：此处需要重做' },
      ],
    },
    {
      title: '节点上的数字（以进度为主口径）',
      note: '同一个数字出现在画布、悬停提示、属性栏、右栏与看板指标行，口径同源。',
      entries: [
        { glyph: '33 / 21', meaning: '枝：**总任务点数 / 已完成数**（纯数字，不含"未完成"字样）' },
        { glyph: '45%', meaning: '叶：自身进度百分比（单个任务点没有"总数"可言）' },
        { glyph: '▓▓▓░░', meaning: '进度条：长度 = 进度，颜色 = 状态（完成=绿）' },
      ],
    },
    {
      title: '父子连线（颜色跟枝色走，强弱跟聚焦关系走）',
      note: '连线在主枝节点**下层**绘制，永不遮挡节点；非焦点连线的颜色 = 子节点的**枝色**（与节点左侧色条同色），所以"这条线属于哪条枝"一眼可辨。',
      entries: [
        { glyph: '━━', meaning: '连到**被选中**的节点（主题前景色，最清楚）' },
        { glyph: '┅┅→', meaning: '**运行链路**：子节点正在进行中 → 运行蓝 + **流动虚线**（能看出"活在哪条链路上跑"）；减少动效时改实线' },
        { glyph: '━━', meaning: '连到**悬停**的节点（主题前景色加粗，鼠标移开即恢复）' },
        { glyph: '──', meaning: '关注枝内部（枝色实线，比旁枝更亮更粗）' },
        { glyph: '──', meaning: '通往被关注节点的链路（枝色实线，轻提示）' },
        { glyph: '┄┄', meaning: '旁枝（枝色虚线 + 降透明，按 FR-45 与主枝区分）' },
      ],
    },
    {
      title: '操作入口（画布上能点的地方）',
      entries: [
        { glyph: '⌄', meaning: '节点底部**圆圈按钮**：折叠/展开这条枝（Shift = 从最下游逐层折 / 折到底后全展开）；双击节点同效' },
        { glyph: '+N', meaning: '折起来之后按钮变成胶囊：N = 这枝里被藏起来的节点数' },
        { glyph: '右键', meaning: '节点菜单（关注/改名/加子节点/暂停/拦停/回滚/删除…）' },
        { glyph: '滚轮', meaning: '缩放；拖动空白处平移；右下角缩略图点击即跳转' },
      ],
    },
  ];
}
