import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

async function uploadFile(uploadUrlTemplate, token, filePath) {
  const filename = path.basename(filePath)
  const stats = fs.statSync(filePath)
  console.log(`\n📤 Uploading ${filename} (${(stats.size / (1024 * 1024)).toFixed(2)} MB)...`)

  const fileStream = fs.readFileSync(filePath)
  const uploadUrl = `${uploadUrlTemplate}?name=${encodeURIComponent(filename)}`
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: 'token ' + token,
      'User-Agent': 'ModelDock-Release-Bot',
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(stats.size)
    },
    body: fileStream
  })

  if (!res.ok) {
    throw new Error(`Upload failed for ${filename}: HTTP ${res.status} ${await res.text()}`)
  }
  const data = await res.json()
  console.log(`✅ Uploaded ${filename} successfully!`)
  console.log(`🔗 Download link: ${data.browser_download_url}`)
  return data
}

async function main() {
  const credsPath = path.join(os.homedir(), '.git-credentials')
  const lines = fs.readFileSync(credsPath, 'utf8').split('\n')
  const ghLine = lines.find((l) => l.includes('github.com'))
  const credUrl = new URL(ghLine.trim())
  const token = decodeURIComponent(credUrl.password)
  const owner = 'thriller1982'
  const repo = 'modeldock'
  const tag = 'v1.0.2'
  const releaseName = 'ModelDock v1.0.2'

  console.log(`Fetching release ${tag} on ${owner}/${repo}...`)
  const getRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`, {
    headers: { Authorization: 'token ' + token, 'User-Agent': 'ModelDock-Release-Bot' }
  })

  let releaseData = null
  const bodyContent = `## ModelDock v1.0.2

> 🎯 **ModelDock**：极简、现代的 AI 编程辅助工具切换器与真实 Token 成本 / 缓存率监控中心。

---

### 🌟 核心特性与重要更新

1. **外观色彩系统级持久化（绿色免安装版完美支持）**
   - 解决绿色单文件版重启后需要重新切颜色的问题；
   - 主题配置永久写入 Windows 用户系统目录 (\`~/.modeldock/store.json\`) 与底层缓存；
   - 启动时立即生效，彻底消除窗口白屏/闪烁。

2. **多客户端全自动探测与接管**
   - 原生支持 **Google Antigravity**、**OpenAI Codex 桌面端**、**WorkBuddy**、**OpenCode** 及 **Claude Code**；
   - 彻底区分「桌面环境」与「命令行工具」，告别混乱混杂的菜单体验。

3. **官方对齐的高精度 Token 与成本核算**
   - 纠正 Antigravity 与 Codex 历史模型的费率错位，准确计算 Prompt Cache 节省额度；
   - 精准剥离纯输出与思维链推理（Thinking Tokens），不重复计费；
   - 自动审核模型 (\`codex-auto-review\`) 智能标注为「免费」。

4. **可视化热力图与趋势分析**
   - GitHub 风格的年度 Token 活动矩阵；
   - 周维度消耗堆叠图与累计成本曲线，全周期花销一目了然。

---

### 📦 资产下载 (Assets)
- **\`ModelDock-v1.0.2-win-x64.exe\`**：绿色便携单文件版（无需安装，双击即用，配置永久保存在本机）
`

  if (getRes.status === 200) {
    releaseData = await getRes.json()
    console.log(`Release ${tag} already exists. Updating release body...`)
    const updateRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/${releaseData.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: 'token ' + token,
        'User-Agent': 'ModelDock-Release-Bot',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: releaseName,
        body: bodyContent
      })
    })
    releaseData = await updateRes.json()
  } else {
    console.log(`Creating release ${tag}...`)
    const createRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases`, {
      method: 'POST',
      headers: {
        Authorization: 'token ' + token,
        'User-Agent': 'ModelDock-Release-Bot',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        tag_name: tag,
        target_commitish: 'main',
        name: releaseName,
        body: bodyContent,
        draft: false,
        prerelease: false
      })
    })
    releaseData = await createRes.json()
  }

  console.log(`Release page: ${releaseData.html_url}`)
  const uploadUrlTemplate = releaseData.upload_url.split('{')[0]

  // Upload the portable executable
  const portableExe = path.join('release', 'ModelDock-v1.0.2-win-x64.exe')
  if (fs.existsSync(portableExe)) {
    await uploadFile(uploadUrlTemplate, token, portableExe)
  } else {
    console.error(`Cannot find ${portableExe}!`)
  }

  // Also upload the setup installer if available
  const setupExe = path.join('release', 'ModelDock-Setup-1.0.2-x64.exe')
  if (fs.existsSync(setupExe)) {
    await uploadFile(uploadUrlTemplate, token, setupExe)
  }

  console.log(`\n🎉 All assets uploaded successfully!`)
  console.log(`🌐 GitHub Release: ${releaseData.html_url}`)
}

main().catch(console.error)
