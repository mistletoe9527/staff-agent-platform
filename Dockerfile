# 单阶段镜像：平台用 tsx 直接运行 TypeScript，私有化交付不需要额外构建产物。
FROM node:24-slim

# SQLite 走 Node 内置 node:sqlite，无需编译原生模块
RUN npm install -g pnpm@11.7.0 \
    && pnpm config set store-dir /root/.pnpm-store

WORKDIR /app

# 先复制依赖清单，命中缓存后再复制源码
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/platform/package.json apps/platform/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/bridge/package.json packages/bridge/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @staff-agent/web build

ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    DATA_DIR=/data

EXPOSE 8787
VOLUME ["/data"]

# 健康检查不依赖 curl
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["pnpm", "--filter", "@staff-agent/platform", "start"]
