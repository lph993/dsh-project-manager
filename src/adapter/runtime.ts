/**
 * 运行时端口实现（Host 面）：时钟与随机源。
 *
 * 领域层只依赖 `Clock` / `RandomSource` 这两个**端口接口**（`src/domain/mutate.ts`），
 * 不直接 import Node/DOM 的 crypto —— 这样同一份领域代码能被 Host 与 Client 两侧编译。
 */

import { randomUUID } from '@deepseek-ai/dsh-util-crypto';

import type { Clock, RandomSource } from '../domain/mutate.ts';

/** 系统时钟：ISO 8601 字符串（UTC）。 */
export const systemClock: Clock = {
  now(): string {
    return new Date().toISOString();
  },
};

/** 浏览器安全 UUID（§5.2：必须走 `dsh-util-crypto`，禁止直接用 `crypto.randomUUID`）。 */
export const dshRandom: RandomSource = {
  uuid(): string {
    return randomUUID();
  },
};
