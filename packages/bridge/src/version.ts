import { createRequire } from 'node:module';

/**
 * 网关版本，直接从 package.json 读。
 *
 * 以前这个字符串手写在 poller.ts 和 login.ts 两处，打包发版时容易只改一处，
 * 导致 `sa --version` 上报的版本和 tgz 版本不一致。这里只留一个来源。
 *
 * 路径 /import.meta.url/ 两种运行方式都成立：
 * - 开发：src/version.ts → ../package.json = packages/bridge/package.json
 * - 安装后：dist/cli.js → ../package.json = 包根的 package.json
 */
const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version?: string };

export const BRIDGE_VERSION = pkg.version ?? '0.0.0';
