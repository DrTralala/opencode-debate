import assert from 'node:assert/strict'
import test from 'node:test'
import {
  runCrashChecks,
  runFormatChecks,
  runPlatformChecks,
} from './fixtures/private-storage-probe/suite.mjs'

test('single-writer checkpoint format and restart', async () => {
  await runFormatChecks()
})

test('checkpoint publication crash boundaries', runCrashChecks)

test('platform capabilities and static redirection', async () => {
  const report = await runPlatformChecks()

  console.log(JSON.stringify({ check: 'platform-capabilities', report }))

  assert.equal(report.platform, process.platform)
  assert.equal(typeof report.node, 'string')
  assert.ok(
    report.bun === null || typeof report.bun === 'string',
    'the Bun version must be reported explicitly or as null',
  )

  for (const field of [
    'fileSync',
    'directorySync',
    'permissions',
    'redirectedPaths',
    'directorySyncAcknowledgement',
  ]) {
    assert.ok(
      ['PASS', 'FAIL', 'BLOCKED'].includes(report[field]),
      `${field} must be PASS, FAIL or BLOCKED`,
    )
  }

  assert.ok(Array.isArray(report.limitations))
  assert.equal(report.pathCheckScope, 'STATIC_ONLY')
  assert.ok(
    report.limitations.some((limitation) => /substitution/i.test(limitation)),
    'static path checks must record the check-to-use substitution limit',
  )
  assert.ok(
    report.limitations.some((limitation) => /administrator/i.test(limitation)),
    'the threat boundary must exclude ordinary users but not administrators',
  )
  assert.ok(
    report.limitations.some((limitation) => /reparse-point|no-follow/i.test(limitation)),
    'the report must not claim equivalent no-follow/reparse-point handle semantics',
  )

  if (
    report.fileSync === 'PASS' &&
    ['PASS', 'FAIL'].includes(report.directorySync)
  ) {
    assert.equal(
      report.directorySyncAcknowledgement,
      'PASS',
      'a failed directory sync must never be acknowledged',
    )
    assert.equal(
      report.probes.directorySyncAcknowledgement.errorCategory,
      'directory-sync',
    )
  }

  if (process.platform === 'linux') {
    const detail = JSON.stringify(report.probes)
    assert.equal(report.fileSync, 'PASS', `file sync probe failed: ${detail}`)
    assert.equal(
      report.directorySync,
      'PASS',
      `directory sync probe failed: ${detail}`,
    )
    assert.equal(
      report.permissions,
      'PASS',
      `permissions probe failed: ${detail}`,
    )
    assert.equal(
      report.redirectedPaths,
      'PASS',
      `static redirection probe failed: ${detail}`,
    )
    assert.equal(
      report.directorySyncAcknowledgement,
      'PASS',
      `directory-sync acknowledgement probe failed: ${detail}`,
    )
    assert.equal(report.probes.permissions.umask, '0000')
    assert.equal(report.probes.permissions.candidate.directoryMode, '0700')
    assert.equal(report.probes.permissions.candidate.fileMode, '0600')
    assert.equal(
      report.probes.permissions.candidate.directoryUid,
      process.getuid(),
    )
    assert.equal(report.probes.permissions.candidate.fileUid, process.getuid())
    assert.equal(report.probes.permissions.independent.directoryMode, '0700')
    assert.equal(report.probes.permissions.independent.fileMode, '0600')
    assert.equal(report.probes.redirectedPaths.fixture, 'symlink')
    assert.equal(report.probes.redirectedPaths.sentinelUnchanged, true)
    assert.equal(report.probes.redirectedPaths.targetEntriesUnchanged, true)
    assert.equal(
      report.probes.directorySyncAcknowledgement.mode,
      'injected-path-failure',
    )
  } else if (process.platform === 'win32') {
    assert.equal(
      report.permissions,
      'BLOCKED',
      'Node mode bits are not evidence of Windows ACL privacy',
    )
    assert.equal(report.probes.permissions.aclPrivacy, 'UNVERIFIED')
    assert.equal(report.probes.permissions.modeCheck, 'NOT_AN_ACL_TEST')
    assert.ok(
      ['PASS', 'FAIL'].includes(report.fileSync),
      'the independent file-sync probe must run on Windows',
    )
    assert.ok(
      ['PASS', 'FAIL'].includes(report.directorySync),
      'the independent directory-sync probe must run on Windows',
    )
    assert.ok(
      ['PASS', 'BLOCKED'].includes(report.redirectedPaths),
      'Windows redirection must pass or be blocked by fixture permissions',
    )
    assert.ok(
      ['PASS', 'FAIL', 'BLOCKED'].includes(
        report.directorySyncAcknowledgement,
      ),
      'the acknowledgement result must remain explicit on Windows',
    )
    if (report.probes.redirectedPaths.result === 'PASS') {
      assert.equal(report.probes.redirectedPaths.fixture, 'directory-junction')
      assert.equal(report.probes.redirectedPaths.sentinelUnchanged, true)
      assert.equal(report.probes.redirectedPaths.targetEntriesUnchanged, true)
    }
    if (report.directorySync === 'FAIL') {
      assert.equal(
        report.probes.directorySyncAcknowledgement.mode,
        'os-directory-sync-failure',
      )
    }
  }
})
