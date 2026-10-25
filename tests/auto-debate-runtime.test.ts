import assert from "node:assert/strict"
import { test } from "node:test"
import {
  latestTranscriptOutcome,
  runAutomaticDebateNativeAcceptance,
  runAutomaticDebateNativeFixRegressions,
} from "./fixtures/auto-debate-full-plugin.ts"
import {
  isReviewedNativeVersion,
  REVIEWED_NATIVE_VERSIONS,
  runAutoDebateRuntimeProbe,
} from "./fixtures/auto-debate-runtime.ts"

const enabled = process.env.OPENCODE_DEBATE_RUNTIME_TEST === "1"
const fullPluginEnabled = process.env.OPENCODE_DEBATE_FULL_PLUGIN_TEST === "1"

test("native acceptance allows only the exact reviewed OpenCode builds", () => {
  assert.deepEqual([...REVIEWED_NATIVE_VERSIONS], ["1.18.35", "1.19.4"])
  assert.equal(isReviewedNativeVersion("1.18.35"), true)
  assert.equal(isReviewedNativeVersion("1.19.4"), true)
  assert.equal(isReviewedNativeVersion("1.19.5"), false)
  assert.equal(isReviewedNativeVersion("1.18.3"), false)
})

test("latest transcript outcome is read from the final appended frame", () => {
  const cycleOneAwaiting = [
    "## Current outcome",
    "**Status:** awaiting-evaluation",
    "**Current cycle:** 1",
  ].join("\n")
  const cycleTwoRunning = [
    "## Current outcome",
    "**Status:** running",
    "**Current cycle:** 2",
  ].join("\n")
  assert.deepEqual(latestTranscriptOutcome(`${cycleOneAwaiting}\n\n${cycleTwoRunning}`),
    { status: "running", cycle: 2 },
    "an earlier awaiting-evaluation outcome must not satisfy a cycle-two wait")
  assert.deepEqual(latestTranscriptOutcome(`${cycleOneAwaiting}\n\n${cycleTwoRunning}\n\n${[
    "## Current outcome",
    "**Status:** awaiting-evaluation",
    "**Current cycle:** 2",
  ].join("\n")}`), { status: "awaiting-evaluation", cycle: 2 })
  assert.equal(latestTranscriptOutcome("no outcome frames"), undefined)
})

test("installed OpenCode runtime satisfies the automatic-debate boundary", { skip: !enabled, timeout: 180_000 }, async () => {
  const { observation, version } = await runAutoDebateRuntimeProbe({
    evidencePath: process.env.OPENCODE_DEBATE_RUNTIME_EVIDENCE,
  })

  assert.ok(isReviewedNativeVersion(version), `Unreviewed native runtime version: ${version}`)
  const criteria: [keyof typeof observation, boolean][] = [
    ["parentToolReturnedBeforeChildrenFinished", true],
    ["threeChildrenWereBusyTogether", true],
    ["deniedReadExecuted", false],
    ["deniedEditExecuted", false],
    ["participantSpawnedChild", false],
    ["parentAskWasAutoApproved", false],
    ["parentAskWasObserved", true],
    ["deniedReadWasObserved", true],
    ["immutableToolsWereHidden", true],
    ["resultEvaluatedAfterBusyParentBecameIdle", true],
    ["parentWasAbortedForDelivery", false],
    ["childRanAfterConfirmedCancellation", false],
    ["abortImmediatelyAfterDispatchWasChecked", true],
    ["abortAfterBusyWasChecked", true],
    ["checkpointStateSurvivedRestart", true],
    ["otherMetadataPreserved", true],
    ["abortBeforeDispatchWasChecked", true],
    ["pendingStartupAcknowledgementWasNotConfirmation", true],
    ["stoppedResultsWereRejected", true],
    ["stoppedDispatchesWereRejected", true],
    ["recoveryStopWasUnconfirmed", true],
    ["rawNativeAbortWasAcknowledgementOnly", true],
    ["stoppedReverificationWasExecuted", true],
    ["checkpointSavesMadeNoModelCalls", true],
    ["checkpointSavesDidNotChangeOwnerHistory", true],
    ["checkpointSavesPreservedBusyOwner", true],
    ["concurrentOwnerMetadataPreserved", true],
    ["multipleCheckpointRecordsSurvivedRestart", true],
    ["sameManagerCheckpointWritesSerialized", true],
    ["incompleteCheckpointTailRejected", true],
    ["corruptCheckpointRejected", true],
    ["forkedCheckpointHistoryRejected", true],
    ["ambiguousCheckpointStoresRejected", true],
    ["deletedCheckpointStoreRejected", true],
    ["transcriptOffCreatedNoFiles", true],
    ["checkpointBootstrapLifecycleWorked", true],
    ["missingStateParticipantRemnantsRejected", true],
    ["unrelatedExistingChildAllowsBootstrap", true],
    ["corruptAutomaticParticipantMarkerRejected", true],
    ["erasedStateAutomaticMembersRejected", true],
    ["unmarkedRenamedCheckpointHistoryRejected", true],
    ["heldDeliveryForkReconciledWithoutRedispatch", true],
    ["lostDeliveryResponseReconciledAfterWriterRestart", true],
    ["pausedPanelContinuedAfterWriterRestart", true],
    ["pausedPanelContinuedAfterNativeRestart", true],
    ["unknownStartupStayedUnconfirmedAfterRecovery", true],
    ["receiptPrefixesSurvivedManagerSaves", true],
    ["changedReceiptPrefixRejected", true],
    ["receiptWritesPreservedOwnerPrivacy", true],
  ]
  const failures: unknown[] = []
  for (const [name, expected] of criteria) {
    try {
      assert.equal(observation[name], expected, name)
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length) throw new AggregateError(failures, `${failures.length} native boundary criteria failed`)
})

test("installed OpenCode runs the full automatic-debate plugin acceptance scenario", {
  skip: !fullPluginEnabled,
  timeout: 240_000,
}, async () => {
  const { observation, version } = await runAutomaticDebateNativeAcceptance({
    evidencePath: process.env.OPENCODE_DEBATE_TASK6_EVIDENCE,
    includeFixes: process.env.OPENCODE_DEBATE_FINAL_FIX_TEST === "1",
  })

  assert.ok(isReviewedNativeVersion(version), `Unreviewed native runtime version: ${version}`)
  assert.equal(observation.fullPluginWasLoaded, true)
  assert.equal(observation.enabledByConversationCommand, true)
  assert.equal(observation.twoDiscussionsWereIndependent, true)
  assert.equal(observation.noCrossDiscussionMixup, true)
  assert.equal(observation.unanimousStopWasNotConsensus, true)
  assert.equal(observation.parentCompletedIndependentWorkWhileBothPanelsWereBusy, true)
  assert.equal(observation.offAllowedBothExistingCyclesToFinish, true)
  assert.equal(observation.resumedPanelRetainedAllSessionIDsAndFocusedFeedback, true)
  assert.equal(observation.cancelledOtherDiscussionWithoutAffectingResume, true)
  assert.equal(observation.mainAgentEvaluatedBothCycles, true)
  assert.equal(observation.transcriptLinksWereReturnedAndRecordsWereSaved, true)
  assert.equal(observation.resetRestoredConfiguredDefault, true)
  assert.equal(observation.panelPromptCount, 15)
  assert.equal(observation.uniqueParticipantSessions, 6)
  assert.equal(observation.transcriptPaths.length, 2)
})

test("installed OpenCode satisfies the focused corrective refusal and active batch-stop interactions", {
  skip: process.env.OPENCODE_DEBATE_CORRECTIVE_TEST !== "1", timeout: 180_000,
}, async () => {
  const result = await runAutomaticDebateNativeFixRegressions({ corrective: true,
    evidencePath: process.env.OPENCODE_DEBATE_CORRECTIVE_EVIDENCE })
  assert.ok(isReviewedNativeVersion(result.version), `Unreviewed native runtime version: ${result.version}`)
  assert.equal(result.corrective?.refusalThenApproved, true)
  assert.equal(result.corrective?.batches.length, 2)
  assert.ok(result.corrective!.batches.every((batch) => batch.allFencedBeforeCessation === true
    && batch.noNextRoundAfterTerminalAnswers === true && batch.stopRemainedPending === true && batch.otherOwnerUntouched === true))
  assert.equal(result.cleanup.nativeProcessesExited, true)
  assert.equal(result.cleanup.isolatedWorkspaceRemoved, true)
})
