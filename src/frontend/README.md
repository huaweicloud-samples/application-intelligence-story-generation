# 前端应用（NextJS SSR）

故事展示前端：读取 stories 表渲染故事页（文本 + 音频播放，音频尚未生成完成时回退为纯文本）。

- 容器环境变量：`REGION` / `TABLE_NAME` / `GEMINIDB_ENDPOINT` / `HW_ACCESS_KEY` / `HW_SECRET_KEY`
- 健康检查端点：`/api/health`
- 构建与推送：见仓库根目录部署指导（构建 Docker 镜像 → 推送 SWR → CAE 组件引用该镜像）
