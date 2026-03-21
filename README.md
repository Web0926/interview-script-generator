# 面试逐字稿生成器

这是一个带最小后端的收费版 MVP：

- 小红书下单后，用户通过固定兑换链接进入站内
- 输入 `订单号 + 手机号后四位` 领取 1 次使用会话
- 只有最终逐字稿成功生成，才会消耗这次机会

## 本地启动

1. 在项目根目录配置 `.env`
2. 启动开发环境

```bash
npm run dev
```

前端默认在 `http://localhost:5173`，后端默认在 `http://localhost:3001`。

## 必填环境变量

```bash
OPENROUTER_API_KEY=sk-or-v1-xxxxxxxx
OPENROUTER_MODEL=anthropic/claude-opus-4.6
PORT=3001
```

## 本地添加一个可兑换订单

```bash
npm run add-order -- --orderNo=XHS202603180001 --phoneLast4=1234
```

写入后，用户就可以在兑换页输入这组信息领取使用会话。

订单和会话数据会保存在：

- `server/data/orders.json`
- `server/data/sessions.json`
