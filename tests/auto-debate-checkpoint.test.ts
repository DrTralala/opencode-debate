import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { createRuntime } from "../src/auto-debate/opencode.ts"
import { checkpointClient } from "./fixtures/checkpoint-client.ts"
import type { ConversationState } from "../src/auto-debate/types.ts"

type RecordValue = Record<string, unknown>
const initial: ConversationState = { version: 1, discussions: [], outbox: [] }
function onlyStore(fixture: ReturnType<typeof checkpointClient>) {
  return [...fixture.sessions.values()].find((session) => session.parentID === fixture.owner.sessionID
    && session.metadata && Object.hasOwn(session.metadata as RecordValue, "opencode-debate-checkpoint-store"))!
}
function record(message: RecordValue) {
  const text = ((message.parts as RecordValue[])[0].text as string)
  const wrapper = JSON.parse(text.slice(text.indexOf("\n") + 1)) as { payload: string; digest: string }
  return JSON.parse(wrapper.payload) as RecordValue
}
function rewrite(message: RecordValue, change: (payload: RecordValue) => void) {
  const part = (message.parts as RecordValue[])[0]
  const text = part.text as string
  const value = record(message)
  change(value)
  const payload = JSON.stringify(value)
  part.text = text.slice(0, text.indexOf("\n") + 1)
    + JSON.stringify({ payload, digest: createHash("sha256").update(payload).digest("hex") })
}

test("checkpoint saves never replace owner metadata or append owner history, even during outsider writes", async () => {
  const f = checkpointClient()
  const runtime = createRuntime(f.input)
  const prompt = f.session.prompt
  f.session.prompt = async (request) => {
    f.sessions.set(f.owner.sessionID, { ...f.sessions.get(f.owner.sessionID), metadata: { outsider: { fresh: true } } })
    return prompt(request)
  }
  await runtime.save(f.owner, initial)
  assert.deepEqual(f.sessions.get(f.owner.sessionID)?.metadata, { outsider: { fresh: true } })
  assert.equal(f.calls.some((call) => call.method === "update"), false)
  assert.equal(f.calls.some((call) => call.method === "prompt" && call.id === f.owner.sessionID), false)
  assert.deepEqual(await runtime.load(f.owner), initial)
})

test("storage is owner-bound, all-deny, noReply and non-running while the owner is busy", async () => {
  const f = checkpointClient()
  f.statuses[f.owner.sessionID] = { type: "busy" }
  await createRuntime(f.input).save(f.owner, initial)
  const child = onlyStore(f)
  assert.equal(child.parentID, f.owner.sessionID)
  assert.deepEqual(child.permission, [{ permission: "*", pattern: "*", action: "deny" }])
  assert.equal(f.modelCalls(), 0)
  assert.ok(f.calls.filter((call) => call.method === "prompt").every((call) => call.body?.noReply === true))
})

test("multiple checkpoints recover by logical chain after a new runtime, not history/timestamp order", async () => {
  const f = checkpointClient()
  const runtime = createRuntime(f.input)
  await runtime.save(f.owner, initial)
  const next = { ...initial, override: true }
  await runtime.save(f.owner, next)
  const messages = f.histories.get(onlyStore(f).id as string)!
  assert.equal(messages.length, 2)
  const first = record(messages[0]); const second = record(messages[1])
  assert.equal(first.revision, 1)
  assert.equal(second.revision, 2)
  assert.equal(second.previous, (messages[0].info as RecordValue).id)
  messages.reverse()
  assert.deepEqual(await createRuntime(f.input).load(f.owner), next)
})

test("concurrent saves in one retained runtime capture snapshots and serialize logical writes", async () => {
  const f = checkpointClient()
  const runtime = createRuntime(f.input)
  const first = structuredClone(initial)
  const one = runtime.save(f.owner, first)
  first.override = true
  const two = runtime.save(f.owner, { ...initial, override: false })
  await Promise.all([one, two])
  const messages = f.histories.get(onlyStore(f).id as string)!
  assert.equal(messages.length, 2)
  assert.deepEqual(record(messages[0]).state, initial)
  assert.deepEqual(await runtime.load(f.owner), { ...initial, override: false })
})

test("a title-only child is not authorised as a checkpoint store", async () => {
  const f = checkpointClient()
  await createRuntime(f.input).save(f.owner, initial)
  const child = onlyStore(f)
  child.metadata = {}
  await assert.rejects(createRuntime(f.input).load(f.owner), /binding|checkpoint|store/i)
})

test("intact checkpoint history blocks recovery and default saves after its child marker and title are removed", async () => {
  const f = checkpointClient()
  await createRuntime(f.input).save(f.owner, { ...initial, override: true })
  const child = onlyStore(f)
  await f.session.update({ path: { id: child.id as string }, body: {
    metadata: { unrelatedPlugin: { retained: true } }, title: "Renamed ordinary research",
  } })
  const sessionsBefore = structuredClone([...f.sessions.values()])
  const historyBefore = structuredClone([...f.histories.entries()])
  const runtime = createRuntime(f.input)
  await assert.rejects(runtime.load(f.owner), /checkpoint|history|remnant/i)
  await assert.rejects(runtime.save(f.owner, initial), /unconfirmed|checkpoint|history|remnant/i)
  await assert.rejects(createRuntime(f.input).save(f.owner, initial), /checkpoint|history|remnant/i)
  assert.deepEqual([...f.sessions.values()], sessionsBefore)
  assert.deepEqual([...f.histories.entries()], historyBefore)
  assert.equal(f.calls.filter((call) => call.method === "create").length, 1)
  assert.equal(f.calls.filter((call) => call.method === "prompt").length, 1)
  assert.equal(f.modelCalls(), 0)
})

test("first save rechecks history when an unmarked renamed checkpoint appears after an absent load", async () => {
  const f = checkpointClient()
  const runtime = createRuntime(f.input)
  assert.equal(await runtime.load(f.owner), undefined)
  await createRuntime(f.input).save(f.owner, { ...initial, override: true })
  const child = onlyStore(f)
  child.metadata = {}
  child.title = "Ordinary-looking title"
  await assert.rejects(runtime.save(f.owner, initial), /checkpoint|history|remnant/i)
  assert.equal(f.calls.filter((call) => call.method === "create").length, 1)
  assert.equal(f.calls.filter((call) => call.method === "prompt").length, 1)
})

test("native checkpoint message identities remain suspicious with missing or corrupt text and no child marker", async () => {
  for (const damage of ["missing-parts", "corrupt-text"]) {
    const f = checkpointClient()
    await createRuntime(f.input).save(f.owner, initial)
    const child = onlyStore(f)
    child.metadata = {}
    child.title = "Renamed ordinary research"
    const message = f.histories.get(child.id as string)![0]
    if (damage === "missing-parts") message.parts = []
    else (message.parts as RecordValue[])[0].text = "opencode-debate/checkpoint/v1\ncorrupt-json"
    await assert.rejects(createRuntime(f.input).load(f.owner), /checkpoint|history|remnant/i, damage)
    await assert.rejects(createRuntime(f.input).save(f.owner, initial), /checkpoint|history|remnant/i, damage)
    assert.equal(f.calls.filter((call) => call.method === "create").length, 1)
  }
})

test("ambiguous storage children fail closed", async () => {
  const f = checkpointClient()
  await createRuntime(f.input).save(f.owner, initial)
  const child = onlyStore(f)
  f.sessions.set("duplicate", { ...structuredClone(child), id: "duplicate" })
  await assert.rejects(createRuntime(f.input).load(f.owner), /ambiguous|multiple/i)
})

test("incomplete native checkpoint tails reject recovery instead of returning an older state", async () => {
  const f = checkpointClient()
  await createRuntime(f.input).save(f.owner, initial)
  const messages = f.histories.get(onlyStore(f).id as string)!
  const incomplete = structuredClone(messages[0])
  ;(incomplete.info as RecordValue).id += "incomplete"
  incomplete.parts = []
  messages.push(incomplete)
  await assert.rejects(createRuntime(f.input).load(f.owner), /incomplete|checkpoint|history/i)
})

test("corrupt checkpoint bytes fail validation", async () => {
  const f = checkpointClient()
  await createRuntime(f.input).save(f.owner, initial)
  const message = f.histories.get(onlyStore(f).id as string)![0]
  ;(message.parts as RecordValue[])[0].text += "corrupt"
  await assert.rejects(createRuntime(f.input).load(f.owner), /corrupt|checkpoint|invalid/i)
})

test("a checksum-valid but schema-invalid checkpoint never becomes loaded state", async () => {
  const f = checkpointClient()
  await createRuntime(f.input).save(f.owner, initial)
  rewrite(f.histories.get(onlyStore(f).id as string)![0], (value) => { value.state = { version: 1, discussions: [{}], outbox: [] } })
  await assert.rejects(createRuntime(f.input).load(f.owner), /state|invalid|unsupported/i)
})

test("forked logical checkpoint revisions fail closed", async () => {
  const f = checkpointClient()
  const runtime = createRuntime(f.input)
  await runtime.save(f.owner, initial)
  await runtime.save(f.owner, { ...initial, override: true })
  const messages = f.histories.get(onlyStore(f).id as string)!
  const branch = structuredClone(messages[1])
  const id = `${(branch.info as RecordValue).id}fork`
  ;(branch.info as RecordValue).id = id
  ;(branch.parts as RecordValue[])[0].messageID = id
  rewrite(branch, (value) => { value.messageID = id; value.state = initial })
  messages.push(branch)
  await assert.rejects(createRuntime(f.input).load(f.owner), /fork|revision|conflict/i)
})

test("lost predecessor evidence and deletion of a known store never trigger silent recreation", async () => {
  const f = checkpointClient()
  const runtime = createRuntime(f.input)
  await runtime.save(f.owner, initial)
  await runtime.save(f.owner, { ...initial, override: true })
  const id = onlyStore(f).id as string
  f.histories.get(id)!.shift()
  await assert.rejects(createRuntime(f.input).load(f.owner), /missing|history|revision|checkpoint/i)
  f.sessions.delete(id)
  await assert.rejects(runtime.save(f.owner, initial), /lost|missing|deleted|store/i)
  assert.equal(f.calls.filter((call) => call.method === "create").length, 1)
})

test("recovery-first absence permits explicit initial save then intact recovery on the same runtime", async () => {
  const f = checkpointClient()
  const runtime = createRuntime(f.input)
  assert.equal(await runtime.load(f.owner), undefined) // No recovered snapshot or dispatched work.
  assert.equal(f.calls.length, 0)
  await runtime.save(f.owner, initial) // Explicit new-state initialisation, not restoration from absence.
  assert.deepEqual(await runtime.load(f.owner), initial)
  assert.deepEqual(await createRuntime(f.input).load(f.owner), initial)
  assert.equal(f.calls.filter((call) => call.method === "create").length, 1)
  assert.equal(f.modelCalls(), 0)
})

test("participant remnants without a store block both recovery and fresh save instead of losing tracking", async () => {
  const f = checkpointClient()
  await f.session.create({ body: { parentID: f.owner.sessionID, title: "Automatic debate participant: old-participant",
    agent: "old-participant", model: { providerID: "fake", id: "fake-model" }, permission: [] } })
  const runtime = createRuntime(f.input)
  await assert.rejects(runtime.load(f.owner), /remnant|missing|untracked/i)
  await assert.rejects(runtime.save(f.owner, initial), /unconfirmed|remnant|missing|untracked/i)
  await assert.rejects(createRuntime(f.input).save(f.owner, initial), /remnant|missing|untracked/i)
  assert.equal(f.calls.filter((call) => call.method === "create").length, 1)
})

test("absence is rechecked before initial save when an automatic child appears after a no-state load", async () => {
  const f = checkpointClient()
  const runtime = createRuntime(f.input)
  assert.equal(await runtime.load(f.owner), undefined)
  const member = await runtime.createParticipant(f.owner, { agent: "debate-openai", description: "automatic", model: "fake/fake-model" }, [])
  f.sessions.get(member.sessionID)!.title = "Renamed automatic child"
  await assert.rejects(runtime.save(f.owner, initial), /remnant|untracked|missing/i)
  assert.equal(f.calls.filter((call) => call.method === "create").length, 1)
})

test("ordinary specialist and manual children allow load then initial save without being adopted", async () => {
  const f = checkpointClient()
  for (const [title, agent] of [["Specialist research completed", "general"], ["Manual debate participant", "debate-openai"],
    ["Unknown truly unrelated title", "custom-specialist"], ["Automatic deployment research", "general"]]) {
    await f.session.create({ body: { parentID: f.owner.sessionID, title, agent,
      model: { providerID: "fake", id: "fake-model" }, permission: [], metadata: { unrelatedPlugin: { retained: true } } } })
  }
  const before = structuredClone([...f.sessions.values()])
  const runtime = createRuntime(f.input)
  assert.equal(await runtime.load(f.owner), undefined)
  await runtime.save(f.owner, initial)
  assert.deepEqual(await runtime.load(f.owner), initial)
  assert.deepEqual(before, [...f.sessions.values()].filter((value) => value.id !== onlyStore(f).id))
  assert.equal(f.calls.filter((call) => call.method === "prompt").length, 1)
  assert.equal(f.calls.filter((call) => call.method === "prompt")[0].id, onlyStore(f).id)
  assert.equal(f.modelCalls(), 0)
})

test("ordinary child history containing checkpoint quotations is neither adopted nor rejected as native storage", async () => {
  const source = checkpointClient()
  await createRuntime(source.input).save(source.owner, initial)
  const quotedText = (source.histories.get(onlyStore(source).id as string)![0].parts as RecordValue[])[0].text as string
  const f = checkpointClient()
  const { data: child } = await f.session.create({ body: { parentID: f.owner.sessionID,
    title: "Manual checkpoint documentation research", agent: "debate-openai",
    model: { providerID: "fake", id: "fake-model" }, permission: [], metadata: { unrelatedPlugin: true } } })
  for (const [index, text] of [`Documentation quotation:\n\`\`\`text\n${quotedText}\n\`\`\``, quotedText].entries()) {
    await f.session.prompt({ path: { id: child.id }, body: { messageID: `msg_adcp_documentation_${index}`,
      agent: "debate-openai", model: { providerID: "fake", modelID: "fake-model" }, noReply: true,
      parts: [{ type: "text", text }] } })
  }
  const childBefore = structuredClone(f.sessions.get(child.id))
  const historyBefore = structuredClone(f.histories.get(child.id))
  const runtime = createRuntime(f.input)
  assert.equal(await runtime.load(f.owner), undefined)
  await runtime.save(f.owner, initial)
  assert.deepEqual(await runtime.load(f.owner), initial)
  assert.deepEqual(f.sessions.get(child.id), childBefore)
  assert.deepEqual(f.histories.get(child.id), historyBefore)
  assert.equal(f.calls.filter((call) => call.method === "prompt" && call.id === child.id).length, 2)
  assert.equal(f.modelCalls(), 0)
})

test("failed or malformed unrelated-child history is not checked absence and quarantines default saves", async () => {
  for (const damage of ["error-with-data", "404", "transport", "no-envelope", "no-data", "null-data", "non-array",
    "invalid-entry", "missing-info", "missing-id", "foreign-session", "invalid-role", "invalid-parts",
    "invalid-part", "foreign-part-session", "foreign-part-message", "invalid-text"]) {
    const f = checkpointClient()
    const { data: child } = await f.session.create({ body: { parentID: f.owner.sessionID, title: "Ordinary research",
      agent: "general", model: { providerID: "fake", id: "fake-model" }, permission: [] } })
    await f.session.prompt({ path: { id: child.id }, body: { messageID: "msg_manual", agent: "general",
      model: { providerID: "fake", modelID: "fake-model" }, noReply: true, parts: [{ type: "text", text: "Ordinary research" }] } })
    const message = structuredClone(f.histories.get(child.id)![0])
    const info = message.info as RecordValue
    const part = (message.parts as RecordValue[])[0]
    let result: unknown = { data: [message] }
    if (damage === "error-with-data") result = { error: { message: "lookup failed" }, data: [] }
    else if (damage === "404") result = { error: { message: "not found" }, response: new Response(null, { status: 404 }) }
    else if (damage === "no-envelope") result = undefined
    else if (damage === "no-data") result = {}
    else if (damage === "null-data") result = { data: null }
    else if (damage === "non-array") result = { data: {} }
    else if (damage === "invalid-entry") result = { data: [null] }
    else if (damage === "missing-info") delete message.info
    else if (damage === "missing-id") delete info.id
    else if (damage === "foreign-session") info.sessionID = "foreign"
    else if (damage === "invalid-role") info.role = "unknown"
    else if (damage === "invalid-parts") message.parts = {}
    else if (damage === "invalid-part") message.parts = [null]
    else if (damage === "foreign-part-session") part.sessionID = "foreign"
    else if (damage === "foreign-part-message") part.messageID = "foreign"
    else if (damage === "invalid-text") part.text = 42
    const messages = f.session.messages
    f.session.messages = async (request) => {
      if (request.path.id !== child.id) return messages(request)
      if (damage === "transport") throw new Error("child history transport unavailable")
      return result as Awaited<ReturnType<typeof messages>> // Deliberately invalid SDK-boundary responses.
    }
    const runtime = createRuntime(f.input)
    await assert.rejects(runtime.load(f.owner), /history|invalid|failed|data|unavailable/i, damage)
    await assert.rejects(createRuntime(f.input).save(f.owner, initial), /history|invalid|failed|data|unavailable/i, damage)
    f.session.messages = messages
    await assert.rejects(runtime.save(f.owner, initial), /unconfirmed|recovery/i, damage)
    assert.equal(f.calls.filter((call) => call.method === "create").length, 1, damage)
    assert.equal(f.calls.filter((call) => call.method === "prompt").length, 1, damage)
  }
})

test("actual automatic participant creation persists owner-bound provenance and a renamed remnant rejects", async () => {
  const f = checkpointClient()
  const runtime = createRuntime(f.input)
  const member = await runtime.createParticipant(f.owner, { agent: "debate-openai", description: "automatic", model: "fake/fake-model" }, [])
  const child = f.sessions.get(member.sessionID)!
  const marker = (child.metadata as RecordValue | undefined)?.["opencode-debate-automatic-participant"] as RecordValue | undefined
  assert.ok(marker, "actual createParticipant must persist its ownership marker")
  assert.equal(marker.kind, "opencode-debate-participant")
  assert.equal(marker.version, 1)
  assert.equal(marker.owner, f.owner.sessionID)
  assert.equal(marker.project, "checkpoint-project")
  assert.equal(marker.directory, f.owner.directory)
  assert.equal(marker.agent, "debate-openai")
  assert.match(String(marker.nonce), /^[a-f0-9]{32}$/)
  child.title = "Ordinary research title after rename"
  await assert.rejects(createRuntime(f.input).load(f.owner), /automatic|remnant|missing/i)
  await assert.rejects(createRuntime(f.input).save(f.owner, initial), /automatic|remnant|missing/i)
  assert.equal(f.calls.some((call) => call.method === "prompt"), false)
})

test("damaged automatic participant markers cannot be ignored as unrelated children", async () => {
  for (const damage of ["kind", "version", "owner", "project", "directory", "agent", "nonce", "null", "scalar"]) {
    const f = checkpointClient()
    const member = await createRuntime(f.input).createParticipant(f.owner, { agent: "debate-openai", description: "automatic", model: "fake/fake-model" }, [])
    const child = f.sessions.get(member.sessionID)!
    const metadata = child.metadata as RecordValue
    assert.ok(metadata?.["opencode-debate-automatic-participant"], "marker must exist before corruption")
    child.title = "Renamed to unrelated-looking title"
    if (damage === "null") metadata["opencode-debate-automatic-participant"] = null
    else if (damage === "scalar") metadata["opencode-debate-automatic-participant"] = "invalid"
    else (metadata["opencode-debate-automatic-participant"] as RecordValue)[damage] = "foreign"
    await assert.rejects(createRuntime(f.input).load(f.owner), /marker|binding|corrupt|automatic|remnant/i)
    await assert.rejects(createRuntime(f.input).save(f.owner, initial), /marker|binding|corrupt|automatic|remnant/i)
    assert.equal(f.calls.filter((call) => call.method === "create").length, 1)
  }
})

test("erased checkpoint storage with actual renamed automatic members still refuses fresh state", async () => {
  const f = checkpointClient()
  const runtime = createRuntime(f.input)
  await runtime.save(f.owner, initial)
  const storeID = onlyStore(f).id as string
  const member = await runtime.createParticipant(f.owner, { agent: "debate-openai", description: "automatic", model: "fake/fake-model" }, [])
  f.sessions.get(member.sessionID)!.title = "Renamed automatic member"
  f.sessions.delete(storeID) // Observable participant evidence remains after state erasure.
  const fresh = createRuntime(f.input)
  await assert.rejects(fresh.load(f.owner), /automatic|remnant|missing/i)
  await assert.rejects(fresh.save(f.owner, initial), /unconfirmed|automatic|remnant|missing/i)
  assert.equal(f.calls.filter((call) => call.method === "create").length, 2)
})

test("actual child directory and project mismatches do not grant automatic marker ownership", async () => {
  for (const damage of ["projectID", "directory"]) {
    const f = checkpointClient()
    const member = await createRuntime(f.input).createParticipant(f.owner, { agent: "debate-openai", description: "automatic", model: "fake/fake-model" }, [])
    f.sessions.get(member.sessionID)![damage] = "foreign"
    await assert.rejects(createRuntime(f.input).load(f.owner), /binding|automatic|remnant|corrupt/i)
  }
})

test("owner metadata or automatic tool history remnants cannot be converted to a bootstrap opportunity", async () => {
  for (const evidence of ["metadata", "history"]) {
    const f = checkpointClient()
    if (evidence === "metadata") f.sessions.get(f.owner.sessionID)!.metadata = { "opencode-debate": initial }
    else f.histories.set(f.owner.sessionID, [{ info: { id: "owner-tool", sessionID: f.owner.sessionID, role: "assistant" },
      parts: [{ type: "tool", tool: "auto_debate", state: { status: "completed", input: { action: "start" } } }] }])
    const runtime = createRuntime(f.input)
    await assert.rejects(runtime.load(f.owner), /evidence|missing|remnant/i)
    await assert.rejects(runtime.save(f.owner, initial), /unconfirmed|evidence|missing|remnant/i)
    assert.equal(f.calls.some((call) => call.method === "create"), false)
  }
})

test("discovery failure is not absence and a failed recovery cannot be followed by default-state creation", async () => {
  const f = checkpointClient()
  const runtime = createRuntime(f.input)
  const children = f.session.children
  f.session.children = async () => { throw new Error("discovery transport unavailable") }
  await assert.rejects(runtime.load(f.owner), /unavailable/)
  f.session.children = children
  await assert.rejects(runtime.save(f.owner, initial), /unconfirmed|recovery/i)
  assert.equal(f.calls.some((call) => call.method === "create"), false)
})

test("a known deleted store is not downgraded to undefined by recovery-first bootstrap", async () => {
  const f = checkpointClient()
  const runtime = createRuntime(f.input)
  await runtime.save(f.owner, initial)
  const recovered = createRuntime(f.input)
  assert.deepEqual(await recovered.load(f.owner), initial)
  f.sessions.delete(onlyStore(f).id as string)
  await assert.rejects(recovered.load(f.owner), /deleted|missing|lost/i)
  await assert.rejects(recovered.save(f.owner, initial), /unconfirmed|deleted|missing|lost/i)
  assert.equal(f.calls.filter((call) => call.method === "create").length, 1)
})

test("an existing but empty checkpoint child is incomplete evidence, not a new-state absence", async () => {
  const f = checkpointClient()
  await createRuntime(f.input).save(f.owner, initial)
  f.histories.set(onlyStore(f).id as string, [])
  const runtime = createRuntime(f.input)
  await assert.rejects(runtime.load(f.owner), /missing|incomplete/i)
  await assert.rejects(runtime.save(f.owner, initial), /unconfirmed|incomplete/i)
  assert.equal(f.calls.filter((call) => call.method === "prompt").length, 1)
})

test("storage binding corruption, permission widening and native running state are refused", async () => {
  for (const damage of ["parentID", "projectID", "directory", "permission", "busy"]) {
    const f = checkpointClient()
    await createRuntime(f.input).save(f.owner, initial)
    const child = onlyStore(f)
    if (damage === "permission") child.permission = [{ permission: "*", pattern: "*", action: "allow" }]
    else if (damage === "busy") f.statuses[child.id as string] = { type: "busy" }
    else child[damage] = "foreign"
    // Exercise the returned candidate's actual parent binding, not an invisible
    // removal from this owner's child index (covered by known-deletion tests).
    if (damage === "parentID") f.session.children = async () => ({ data: [structuredClone(child)] })
    await assert.rejects(createRuntime(f.input).load(f.owner), /checkpoint|store|binding|running|permission|missing/i)
  }
})

test("an independent manager must load provenance and cannot save over a changed checkpoint head", async () => {
  const f = checkpointClient()
  const first = createRuntime(f.input)
  await first.save(f.owner, initial)
  const second = createRuntime(f.input)
  await assert.rejects(second.save(f.owner, initial), /load|provenance|history|checkpoint/i)
  await second.load(f.owner)
  await first.save(f.owner, { ...initial, override: true })
  await assert.rejects(second.save(f.owner, initial), /changed|writer|head|conflict/i)
})

test("an altered but checksum-valid persisted payload is not acknowledged as the requested checkpoint", async () => {
  const f = checkpointClient()
  const prompt = f.session.prompt
  f.session.prompt = async (request) => {
    const result = await prompt(request)
    const stored = f.histories.get(request.path.id)!.at(-1)!
    rewrite(stored, (value) => { value.state = { ...initial, override: true } })
    return { data: structuredClone(stored) as typeof result.data }
  }
  await assert.rejects(createRuntime(f.input).save(f.owner, initial), /payload|append|persist|checkpoint/i)
})

test("interrupted appends remain unconfirmed and do not retry over incomplete evidence", async () => {
  const f = checkpointClient()
  const runtime = createRuntime(f.input)
  const prompt = f.session.prompt
  f.session.prompt = async (request) => {
    const result = await prompt(request)
    f.histories.get(request.path.id)!.at(-1)!.parts = []
    throw new Error("transport interrupted after message info")
  }
  await assert.rejects(runtime.save(f.owner, initial), /interrupted/)
  f.session.prompt = prompt
  await assert.rejects(runtime.save(f.owner, initial), /unconfirmed|incomplete|checkpoint/i)
  await assert.rejects(createRuntime(f.input).load(f.owner), /incomplete|checkpoint/i)
  assert.equal(f.calls.filter((call) => call.method === "prompt").length, 1)
})

test("an uncertain storage-creation outcome cannot be silently retried as a new store", async () => {
  const f = checkpointClient()
  const runtime = createRuntime(f.input)
  let creations = 0
  f.session.create = async () => { creations++; throw new Error("creation transport lost") }
  await assert.rejects(runtime.save(f.owner, initial), /transport lost/)
  await assert.rejects(runtime.save(f.owner, initial), /unconfirmed|missing|initial/i)
  assert.equal(creations, 1)
})

test("concurrent independent branches fail closed rather than choosing an acknowledgement or timestamp winner", async () => {
  const f = checkpointClient()
  const seed = createRuntime(f.input)
  await seed.save(f.owner, initial)
  const first = createRuntime(f.input); const second = createRuntime(f.input)
  await first.load(f.owner); await second.load(f.owner)
  const prompt = f.session.prompt
  let release!: () => void
  const both = new Promise<void>((resolve) => { release = resolve })
  let arrived = 0
  f.session.prompt = async (request) => {
    const result = await prompt(request)
    if (++arrived === 2) release()
    await both
    return result
  }
  const outcomes = await Promise.allSettled([first.save(f.owner, { ...initial, override: true }), second.save(f.owner, initial)])
  assert.ok(outcomes.every((outcome) => outcome.status === "rejected"))
  await assert.rejects(createRuntime(f.input).load(f.owner), /fork|conflict/i)
})
