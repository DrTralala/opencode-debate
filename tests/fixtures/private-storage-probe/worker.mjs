import { createCandidate } from './candidate.mjs'

const [root, requestedBoundary] = process.argv.slice(2)

if (typeof root !== 'string' || typeof requestedBoundary !== 'string') {
  process.stderr.write('worker requires a scratch root and boundary\n')
  process.exit(2)
}

const binding = {
  project: 'probe',
  directory: root,
  owner: 'fake-parent',
  agent: 'build',
}

async function pause(point) {
  if (point !== requestedBoundary) {
    return
  }

  process.stdout.write(`${JSON.stringify({ boundary: point })}\n`)
  await new Promise(() => {
    setInterval(() => {}, 1000)
  })
}

try {
  const candidate = await createCandidate(root, binding, { boundary: pause })
  await candidate.append(1, { marker: 'revision-two' })
  await pause('acknowledged')
  await candidate.close()
} catch (error) {
  const name = error instanceof Error ? error.name : 'Error'
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`worker failed: ${name}: ${message}\n`)
  process.exitCode = 1
}
