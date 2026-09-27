/**
 * "这个节点现在**有人在跑**吗" —— 单点判据（纯函数，可单测）。
 *
 * ## 用户给过三次口径，前两次我都做偏了，这里是第三次的结论
 *
 * 1. 「没会话在跑就不用 loading 了，显示播放图标（三角那个）」
 *    → 我实现成"最近 90s 内有写入就转圈"（**时间推测**）。
 * 2. 「正在会话的没有从播放三角切换到 loading」
 *    → 我把宿主给的"会话在忙"信号直接当结论，写成 `if (sessionBusy) return true`（**一票通过**）。
 * 3. 真机截图：「**全在转，但是没有会话在跑吧**」「线路全部都有了动画，而不是正在跑的」
 *    → 一票通过的反面就是：只要用户在跟**任何一个**会话说话，**整棵树**都算在跑
 *    （所有连线流动、所有节点转圈、▶ 再也不出现）。
 *
 * ## 结论：只看"**这个节点所属的会话**是否在跑"
 *
 * ```
 * 转圈 ⇔ 该节点的 lastSessionId 在 busySessionIds 里
 * ```
 *
 * - **时间窗不再是判据**：`updatedAt` 只能说明"有人写过它"，说明不了"此刻有人在跑它" ——
 *   而"转圈"这个图标的语义就是后者（A3：不许无依据地宣称在跑）。
 *   实测反例：那 5 个 `running` 节点的 `lastSessionId` **全是空的**、`updatedAt` 是几小时前，
 *   却因为"某个会话在忙"整片转圈。
 * - **不知道就显示 ▶**：没有会话信息 ≠ 没有会话，但"转圈"是**更强的主张**，
 *   举证责任在它这一边（宁可不转，也不编）。
 */
export interface LivenessInput {
  /**
   * 这个节点**归哪个会话**（宿主记的"最后写它的会话"）。
   *
   * 注意口径：它回答的是"谁最近动过它"，不是"谁正在动它" ——
   * 所以还要与 `busySessionIds`（宿主 `agent/status` 的直接信号）求交。
   */
  lastSessionId?: string | undefined;
}

/**
 * 该节点此刻是否"有人在跑"（⇒ 转圈 / 连线流动）。
 *
 * @param node 节点的会话归属（缺失即"不知道归谁"）
 * @param busySessionIds 宿主报的"正在忙"的会话（`board.busySessionIds`）
 */
export function isLiveNode(node: LivenessInput, busySessionIds: readonly string[]): boolean {
  const own = node.lastSessionId;
  if (own === undefined || own === '') return false;
  return busySessionIds.includes(own);
}
