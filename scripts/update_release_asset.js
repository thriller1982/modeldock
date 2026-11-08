import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execSync } from 'node:child_process'

async function main() {
  const credsPath = path.join(os.homedir(), '.git-credentials')
  const lines = fs.readFileSync(credsPath, 'utf8').split('\n')
  const ghLine = lines.find((l) => l.includes('github.com'))
  const credUrl = new URL(ghLine.trim())
  const token = decodeURIComponent(credUrl.password)
  const owner = 'thriller1982'
  const repo = 'modeldock'
  const tag = process.argv[2] || 'v1.0.3'

  const proxy = 'http://127.0.0.1:7897'

  console.log(`Checking release ${tag}...`)
  let rel = null
  const relRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`, {
    headers: { Authorization: 'token ' + token, 'User-Agent': 'ModelDock' }
  })
  if (relRes.ok) {
    rel = await relRes.json()
    console.log(`Existing Release ID: ${rel.id}`)
  } else {
    console.log(`Release ${tag} not found, creating new release...`)
    const createRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases`, {
      method: 'POST',
      headers: {
        Authorization: 'token ' + token,
        'User-Agent': 'ModelDock',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        tag_name: tag,
        target_commitish: 'main',
        name: `ModelDock ${tag}`,
        body: `## ModelDock ${tag} 更新说明\n\n### 🚀 新特性与体验改进\n- **系统托盘与常驻后台支持 (System Tray & Background Persistence)**：\n  - 点击主窗口右上角关闭按钮 (✕) 时，自动最小化到 Windows 系统托盘常驻后台，不中断通用 Skill 实时同步与用量统计。\n  - 托盘右键菜单提供快捷操作：显示主窗口、切换开机自启动、切换关闭时最小化行为、快速打开 Skills/备份目录、一键完全退出。\n  - 左键单击托盘图标快速呼出/隐藏主窗口，双击直接激活置顶。\n- **防止重复启动 (Single Instance)**：二次双击程序时自动唤醒并激活托盘中的已有窗口。\n- **独立配置开关**：在「常规设置」中新增「关闭时最小化到系统托盘」开关，可自由选择隐藏到托盘或直接退出。\n- **精致定制图标**：为程序和托盘注入全新高对比度现代几何 Dock 标识，在浅色与深色任务栏均能清晰显示。\n\n### 📦 运行方式\n- 下载 \`ModelDock-${tag}-win-x64.exe\` 即可直接双击运行（绿色免安装单文件版）。`,
        draft: false,
        prerelease: false
      })
    })
    rel = await createRes.json()
    console.log(`Created release ID: ${rel.id}`)
  }

  const assetName = `ModelDock-${tag}-win-x64.exe`
  const existing = rel.assets?.find((a) => a.name === assetName)
  if (existing) {
    console.log(`Deleting old asset ${existing.id}...`)
    await fetch(existing.url, {
      method: 'DELETE',
      headers: { Authorization: 'token ' + token, 'User-Agent': 'ModelDock' }
    })
    console.log(`Deleted.`)
  }

  const exePath = path.join('release', assetName)
  const stats = fs.statSync(exePath)
  console.log(`Uploading ${exePath} (${(stats.size / (1024 * 1024)).toFixed(2)} MB) via curl.exe...`)

  const uploadUrl = `https://uploads.github.com/repos/${owner}/${repo}/releases/${rel.id}/assets?name=${assetName}`

  const cmd = `curl.exe -x "${proxy}" -X POST -H "Authorization: token ${token}" -H "Content-Type: application/octet-stream" -H "User-Agent: ModelDock" --data-binary "@${exePath}" "${uploadUrl}"`
  const out = execSync(cmd, { maxBuffer: 10 * 1024 * 1024, encoding: 'utf8' })
  const resObj = JSON.parse(out)
  console.log(`✅ Upload successful! Asset URL: ${resObj.browser_download_url}`)
}

main().catch(console.error)
