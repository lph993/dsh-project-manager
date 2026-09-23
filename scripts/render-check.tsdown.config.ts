/**
 * 面板渲染自检的构建配置（`pnpm run render-check`）。
 *
 * 为什么要单独构建：`scripts/render-check.tsx` 里用了 JSX，而 `node --test` 不能直跑 .tsx。
 * 这里把自检本身打成一个 node 可执行的 ESM 包，react / react-dom 保持外部依赖。
 */
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['render-check.tsx'],
  format: ['esm'],
  platform: 'node',
  outDir: '../.render-check',
  deps: { neverBundle: ['react', 'react-dom', 'react-dom/server'] },
  clean: true,
});
