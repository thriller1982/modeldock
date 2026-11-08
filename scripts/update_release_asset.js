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
  const tag = 'v1.0.2'

  console.log(`Getting release ${tag}...`)
  const relRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`, {
    headers: { Authorization: 'token ' + token, 'User-Agent': 'ModelDock' }
  })
  const rel = await relRes.json()
  console.log(`Release ID: ${rel.id}`)

  // Delete existing ModelDock-v1.0.2-win-x64.exe asset if present
  const existing = rel.assets?.find((a) => a.name === 'ModelDock-v1.0.2-win-x64.exe')
  if (existing) {
    console.log(`Deleting old asset ${existing.id}...`)
    await fetch(existing.url, {
      method: 'DELETE',
      headers: { Authorization: 'token ' + token, 'User-Agent': 'ModelDock' }
    })
    console.log(`Deleted.`)
  }

  const exePath = path.join('release', 'ModelDock-v1.0.2-win-x64.exe')
  const stats = fs.statSync(exePath)
  console.log(`Uploading new ${exePath} (${(stats.size / (1024 * 1024)).toFixed(2)} MB) via curl.exe...`)

  const uploadUrl = `https://uploads.github.com/repos/${owner}/${repo}/releases/${rel.id}/assets?name=ModelDock-v1.0.2-win-x64.exe`

  const cmd = `curl.exe -X POST -H "Authorization: token ${token}" -H "Content-Type: application/octet-stream" -H "User-Agent: ModelDock" --data-binary "@${exePath}" "${uploadUrl}"`
  const out = execSync(cmd, { maxBuffer: 10 * 1024 * 1024, encoding: 'utf8' })
  const resObj = JSON.parse(out)
  console.log(`✅ Upload successful! Asset URL: ${resObj.browser_download_url}`)
}

main().catch(console.error)
