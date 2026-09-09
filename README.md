# 知行 · 家教学生管理

一个无需安装依赖的本地小应用。直接用浏览器打开 `index.html` 即可使用。

功能包括：

- 多学生档案：姓名、学校、目标学校、当前／目标分数与课程进度
- 每次考试成绩记录，自动按日期生成折线趋势图
- 下节课内容与重点倾听内容备忘
- 可随时增加、删除自定义档案栏
- 数据自动保存在当前浏览器的本地存储中

## 备份与联网同步

右上角的“本地保存／同步”入口提供两种方式：

- **导出 JSON**：下载包含全部学生档案的完整备份文件。
- **导出 Markdown／文字**：将学生资料、成绩、课程轨迹、备忘和自定义信息导出为易阅读、易编辑的 `.md` 或 `.txt` 文件。
- **导入文件**：可导入本应用导出的 JSON、Markdown 或文字文件；导入后会覆盖当前本地档案。
- **联网同步**：在“同步设置”中用邮箱和密码注册或登录 Supabase 账号。登录后，应用会先拉取该账号的云端档案，再上传当前档案；开启“修改后自动同步”时，本地改动会在约 1.2 秒的防抖后上传。也可手动“上传到云端”或“从云端拉取”。

云端数据保存在 Supabase 的 `public.tutor_profiles` 表中：每个已登录用户以自己的 `auth.users.id` 作为 `user_id`，对应一条包含完整档案的 `data` JSONB 记录。应用不再使用自定义 JSON 接口、`GET`／`PUT` 协议或 Bearer Token 配置。

### Supabase 配置与实时同步

1. 在 Supabase Dashboard 的 SQL Editor 运行 [supabase-schema.sql](./supabase-schema.sql)，创建 `tutor_profiles` 并启用行级安全策略（RLS）。
2. 再运行 [supabase-realtime.sql](./supabase-realtime.sql)，将该表加入 Realtime 发布；这样，同一账号在另一台已打开设备上的修改会自动推送到当前页面。
3. 在 Supabase Authentication 中启用 Email 登录，并按需要启用邮箱确认。注册时，应用会发送确认邮件；确认后请返回页面登录。
4. 在 Authentication 的 URL Configuration 中，将 GitHub Pages 地址 `https://hirenvladimir-bot.github.io/tutor-student-manager/` 加入 **Redirect URLs**（并将其设为 Site URL 或保留为允许的回调地址）。应用注册和重发确认邮件时会使用当前页面所在目录作为回调地址，因此生产部署地址必须在允许列表中。若本地预览，也应将实际本地地址加入允许列表。

### 安全与部署提示

- `app.js` 中的 Supabase publishable/anon key 会随静态 GitHub Pages 网站公开，这是预期行为；绝不可在前端放入 `service_role` key 或其他拥有管理权限的密钥。
- 不要删除或放宽 `supabase-schema.sql` 中按 `auth.uid() = user_id` 限制的 RLS 策略。它确保已登录用户只能读取和修改自己的档案。
- 学生资料会保留在浏览器本地存储，并在登录后同步到 Supabase。导入会覆盖当前本地档案；导入前建议先导出 JSON 备份。共享设备上应避免保持登录，并在使用完毕后清除该网站的浏览器数据。
- GitHub Pages 部署时请使用 HTTPS，并在 Supabase 的允许回调地址中同步更新仓库名、域名或自定义域名的变更。
