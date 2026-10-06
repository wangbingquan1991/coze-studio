# dsh-coze-studio

This branch adapts wangbingquan1991/coze-studio as an installable DeepSeek Harness (DSH) bundle.

The adapter deliberately keeps Coze Studio itself in its official Docker Compose architecture. DSH acts as the control plane: it can install, start, stop, restart, inspect, and troubleshoot Coze Studio without requiring the user to type Docker commands for normal day-to-day use.

## Install into DSH

One-time installation:

~~~bash
dsh plugin --profile web add "github:wangbingquan1991/coze-studio#dsh-plugin"
~~~

Restart DSH Web after installation. To verify the bundle is active:

~~~bash
dsh --profile web --dump-config
~~~

After that, normal operations can be requested directly in DSH, for example:

- 检查 Coze Studio 环境
- 启动 Coze Studio
- 停止 Coze Studio
- 重启 Coze Studio
- 查看 Coze Studio 状态
- 查看 coze-server 最近 200 行日志
- 给我 Coze Studio 登录地址

## Registered DSH tools

| Tool | Purpose |
| --- | --- |
| coze_studio_doctor | Check Git, Docker, Docker Compose, checkout, containers, and Web UI |
| coze_studio_install | Prepare the checkout and docker/.env, optionally pull images |
| coze_studio_start | Install if necessary, then start the full stack in background |
| coze_studio_stop | Stop containers without deleting persistent data |
| coze_studio_restart | Restart the existing stack |
| coze_studio_logs | Read all or per-service Docker Compose logs |
| coze_studio_status | Return container state, URL, and Web reachability |
| coze_studio_url | Return main, sign-in, and model-management URLs |

## Default application location

The plugin searches in this order:

1. The tool argument project_root.
2. Environment variable COZE_STUDIO_ROOT.
3. The current directory or one of its parent directories.
4. ~/.dsh/apps/coze-studio.

If the target checkout does not exist, coze_studio_install and coze_studio_start clone:

https://github.com/wangbingquan1991/coze-studio.git

The default source ref is main.

Optional environment overrides:

~~~text
COZE_STUDIO_ROOT=/custom/path/coze-studio
COZE_STUDIO_REPO=https://github.com/your/repo.git
COZE_STUDIO_REF=main
COZE_STUDIO_URL=http://127.0.0.1:8888
~~~

## Environment and safety behavior

When docker/.env is missing, the adapter copies docker/.env.example and sets the initial Web bind to:

~~~text
127.0.0.1:8888
~~~

This keeps the default Coze Studio UI local-only.

If docker/.env already exists, the adapter does not overwrite it.

The stop tool uses docker compose stop. It does not run down -v and does not intentionally delete Coze Studio persistent data.

## Architecture

~~~text
DeepSeek Harness
      |
      v
dsh-coze-studio
      |
      +--> doctor/status/url
      +--> install/start/stop/restart/logs
      |
      v
Docker Compose
      |
      +--> coze-web
      +--> coze-server
      +--> MySQL / Redis / Elasticsearch
      +--> MinIO / Milvus / etcd / NSQ
~~~

This design keeps the DSH adapter small and lets the Coze Studio fork continue tracking upstream changes with minimal merge conflicts.

## DSH compatibility

The package uses the current installable-bundle shape:

package.json -> dsh.bundle.patch -> Cordis plugin -> ctx.tools.register(...)

The adapter is pinned to @deepseek-ai/dsh-tools 0.1.7-rc.2 for the initial version.

DeepSeek Harness is still evolving quickly. After a DSH upgrade, run coze_studio_doctor first to verify compatibility.
