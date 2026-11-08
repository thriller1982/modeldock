import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

async function main() {
  const credsPath = path.join(os.homedir(), '.git-credentials')
  if (!fs.existsSync(credsPath)) {
    console.error('No .git-credentials found!')
    process.exit(1)
  }
  const lines = fs.readFileSync(credsPath, 'utf8').split('\n')
  const ghLine = lines.find((l) => l.includes('github.com'))
  if (!ghLine) {
    console.error('No github credential found in .git-credentials!')
    process.exit(1)
  }
  const credUrl = new URL(ghLine.trim())
  const token = decodeURIComponent(credUrl.password)
  const owner = 'thriller1982'
  const repo = 'modeldock'

  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
  const tag = 'v' + pkg.version
  const releaseName = `ModelDock ${tag}`

  console.log(`Checking if release ${tag} exists on ${owner}/${repo}...`)
  let releaseData = null
  const checkRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`, {
    headers: {
      Authorization: 'token ' + token,
      'User-Agent': 'ModelDock-Release-Bot'
    }
  })

  if (checkRes.status === 200) {
    console.log(`Release ${tag} already exists.`)
    releaseData = await checkRes.json()
  } else {
    console.log(`Creating release ${tag}...`)
    const bodyContent = `## ModelDock ${tag}

> 🎯 Clean, Lightweight AI Coding Assistant Switcher & Real-time Token Cost Monitor (Desktop vs CLI)

### 🌟 Key Highlights

- **Multi-Environment Auto-Detection**: Instant zero-config detection for **Google Antigravity**, **OpenAI Codex Desktop**, **WorkBuddy**, **OpenCode**, and **Claude Code**.
- **Desktop vs CLI Clean Separation**: Distinct workflows and system controls tailored for desktop IDE processes and terminal command injections.
- **Ultra-Accurate Pricing & Prompt Cache Valuation**: Real-time USD valuation with exact Prompt Cache savings calculation.
- **Activity Heatmap & Weekly Trend Analytics**: Interactive GitHub-style activity matrix, weekly grouped bar charts, and cumulative token curves.
- **Provider Hot-Switching & Backup Management**: Clean configuration injection with automated version history backup and auto-start on boot.
`
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

    if (!createRes.ok) {
      console.error('Failed to create release:', createRes.status, await createRes.text())
      process.exit(1)
    }
    releaseData = await createRes.json()
    console.log(`Created release successfully: ${releaseData.html_url}`)
  }

  // Find all .exe files in release folder or dist-package folder
  const candidateDirs = ['release', 'dist-package', 'dist']
  const exeFiles = []
  for (const d of candidateDirs) {
    if (fs.existsSync(d)) {
      for (const f of fs.readdirSync(d)) {
        if (f.endsWith('.exe')) {
          exeFiles.push(path.join(d, f))
        }
      }
    }
  }

  if (exeFiles.length === 0) {
    console.warn('No .exe files found to upload in release/dist directories.')
    console.log(`Release page: ${releaseData.html_url}`)
    return
  }

  const uploadUrlTemplate = releaseData.upload_url.split('{')[0]
  for (const exePath of exeFiles) {
    const filename = path.basename(exePath)
    const stats = fs.statSync(exePath)
    console.log(`Uploading ${filename} (${(stats.size / (1024 * 1024)).toFixed(2)} MB)...`)

    // Check if asset already exists in release
    const existingAsset = releaseData.assets?.find((a) => a.name === filename)
    if (existingAsset) {
      console.log(`Asset ${filename} already exists, deleting first...`)
      await fetch(existingAsset.url, {
        method: 'DELETE',
        headers: {
          Authorization: 'token ' + token,
          'User-Agent': 'ModelDock-Release-Bot'
        }
      })
    }

    const fileStream = fs.readFileSync(exePath)
    const uploadRes = await fetch(`${uploadUrlTemplate}?name=${encodeURIComponent(filename)}`, {
      method: 'POST',
      headers: {
        Authorization: 'token ' + token,
        'User-Agent': 'ModelDock-Release-Bot',
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(stats.size)
      },
      body: fileStream
    })

    if (uploadRes.ok) {
      const assetData = await uploadRes.json()
      console.log(`Uploaded ${filename} successfully! Download URL: ${assetData.browser_download_url}`)
    } else {
      console.error(`Failed to upload ${filename}:`, uploadRes.status, await uploadRes.text())
    }
  }

  console.log(`\n🎉 Release published: ${releaseData.html_url}`)
}

main().catch(console.error)
