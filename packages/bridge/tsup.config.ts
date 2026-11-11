import { defineConfig } from 'tsup';

/**
 * 网关 CLI 构建配置。
 * 把 workspace 内的 @staff-agent/shared 一起打进产物，保证全局安装后不依赖内部包。
 */
export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  splitting: false,
  sourcemap: true,
  noExternal: ['@staff-agent/shared'],
});
