import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Upload this file beside package.json and atlas-managed-funds-release.json.
// Restore only missing files or exact versions recorded when the release was made.
// Unrecognized edits to this release's required persistence files stop the build for review.
const root = await realpath(path.dirname(fileURLToPath(import.meta.url)))
const checkOnly = process.argv.includes('--check')
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const gitBlob = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
const normalize = bytes => Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'))

async function inspectTarget(relative) {
  if (typeof relative !== 'string' || !/^(?:server\.mjs|(?:src|server|migrations|docs)\/[A-Za-z0-9_./-]+)$/.test(relative)
    || relative.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Invalid release path: ${relative}`)
  }
  const target = path.resolve(root, relative)
  if (!target.startsWith(root + path.sep)) throw new Error(`Path outside repository: ${relative}`)
  const parts = relative.split('/')
  for (let index = 0; index < parts.length; index++) {
    const candidate = path.join(root, ...parts.slice(0, index + 1))
    let stat
    try { stat = await lstat(candidate) } catch (error) { if (error.code === 'ENOENT') break; throw error }
    if (stat.isSymbolicLink()) throw new Error(`Release path contains a symbolic link: ${relative}`)
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error(`Parent is not a directory: ${relative}`)
    if (index === parts.length - 1 && !stat.isFile()) throw new Error(`Target is not a file: ${relative}`)
  }
  return target
}

try {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const release = JSON.parse(await readFile(path.join(root, 'atlas-managed-funds-release.json'), 'utf8'))
  if (pkg.name !== 'cronos-procurement-app' || release.formatVersion !== 1
    || release.application !== pkg.name || !Array.isArray(release.files) || !release.files.length) {
    throw new Error('This release must be installed in the existing Atlas application repository.')
  }

  // Validate every payload and destination before writing any source files.
  const seen = new Set()
  const plans = []
  for (const entry of release.files) {
    const target = await inspectTarget(entry.path)
    const key = entry.path.toLowerCase()
    if (seen.has(key)) throw new Error(`Duplicate release path: ${entry.path}`)
    seen.add(key)
    if (typeof entry.content !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)
      || !Array.isArray(entry.replaces) || entry.replaces.some(value => !/^[a-f0-9]{40}$/.test(value))) {
      throw new Error(`Invalid release metadata: ${entry.path}`)
    }
    const bytes = Buffer.from(entry.content, 'utf8')
    if (sha256(bytes) !== entry.sha256) throw new Error(`Release checksum failed: ${entry.path}`)
    let existing
    try { existing = await readFile(target) } catch (error) { if (error.code !== 'ENOENT') throw error }
    let action = 'install'
    if (existing) {
      if (normalize(existing).equals(normalize(bytes))) action = 'unchanged'
      else if (!entry.replaces.includes(gitBlob(existing)) && !entry.replaces.includes(gitBlob(normalize(existing)))) action = 'preserve'
    }
    plans.push({ path: entry.path, target, bytes, action })
  }

  const pending = plans.filter(plan => plan.action === 'install')
  const preserved = plans.filter(plan => plan.action === 'preserve')
  const conflicts = preserved.filter(plan => release.strictPaths?.includes(plan.path))
  if (conflicts.length) throw new Error('Conflicting source files require reconciliation with this database release: ' + conflicts.map(p=>p.path).join(', '))
  for (const plan of preserved) console.log(`[Atlas release] Keeping later source edit: ${plan.path}`)
  if (checkOnly) {
    console.log(`[Atlas release] ${pending.length} file(s) require installation; ${preserved.length} later edit(s) preserved.`)
    process.exitCode = pending.length ? 1 : 0
  } else {
    for (const plan of pending) {
      await mkdir(path.dirname(plan.target), { recursive: true })
      await writeFile(plan.target, plan.bytes)
    }
    console.log(`[Atlas release] Installed ${pending.length} file(s); ${plans.length - pending.length - preserved.length} already current; ${preserved.length} later edit(s) preserved.`)
  }
} catch (error) {
  console.error(`[Atlas release] ${error.message}`)
  process.exitCode = 1
}
