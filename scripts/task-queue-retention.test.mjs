import assert from 'node:assert/strict'
import test from 'node:test'
import { GenerationTaskQueue, RETAINED_TERMINAL_TASKS } from '../src/task-queue.ts'

const ok = { images: [{ b64: 'x', mime: 'image/png' }] }
const requestOf = prompt => ({ mode: 'text', model: 'm', prompt, size: '', quality: '', detail: '', n: 1 })

/** Poll until the predicate holds or the budget runs out. */
async function waitFor(predicate, budgetMs = 5000) {
  const deadline = Date.now() + budgetMs
  for (;;) {
    if (predicate()) return
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('terminal tasks beyond the retention window are dropped from the queue', async () => {
  const queue = new GenerationTaskQueue(async () => ok, 4)
  const total = RETAINED_TERMINAL_TASKS + 10
  const ids = []
  for (let index = 0; index < total; index++) {
    ids.push(queue.submit(requestOf(String(index))).id)
  }
  await waitFor(() => queue.list().every(task => task.status === 'completed'))
  const listed = queue.list()
  assert.equal(listed.length, RETAINED_TERMINAL_TASKS)
  assert.equal(queue.get(ids[0]), undefined, 'the oldest terminal task is dropped')
  assert.notEqual(queue.get(ids[total - 1]), undefined, 'the newest terminal task is retained')
  const completed = queue.summaries().filter(task => task.status === 'completed')
  assert.equal(completed.length, RETAINED_TERMINAL_TASKS)
})

test('active tasks survive pruning while terminal tasks overflow the window', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const queue = new GenerationTaskQueue(async request => {
    // Only the 'gated' task waits; the rest finish immediately.
    if (request.prompt === 'gated') await gate
    return ok
  }, 2)
  const gated = queue.submit(requestOf('gated'))
  for (let index = 0; index < RETAINED_TERMINAL_TASKS; index++) {
    queue.submit(requestOf(String(index)))
  }
  await waitFor(() => queue.list().filter(task => task.status === 'completed').length === RETAINED_TERMINAL_TASKS)
  assert.equal(queue.get(gated.id)?.status, 'running', 'the active task is never pruned')
  assert.ok(queue.summaries().some(task => task.id === gated.id), 'the poll feed still surfaces the active task')

  release()
  await waitFor(() => queue.get(gated.id)?.status === 'completed')
  assert.notEqual(queue.get(gated.id), undefined, 'the newest terminal task is retained after it finishes')
  assert.equal(queue.list().filter(task => task.status === 'completed').length, RETAINED_TERMINAL_TASKS)
})

test('a dropped terminal task can no longer be retried by id', async () => {
  const queue = new GenerationTaskQueue(async () => ok, 4)
  const total = RETAINED_TERMINAL_TASKS + 1
  const ids = []
  for (let index = 0; index < total; index++) {
    ids.push(queue.submit(requestOf(String(index))).id)
  }
  await waitFor(() => queue.list().every(task => task.status === 'completed'))
  assert.equal(queue.retry(ids[0]), undefined, 'the oldest task is gone')
  assert.notEqual(queue.retry(ids[total - 1]), undefined, 'the newest task still retries')
  await waitFor(() => queue.list().filter(task => task.status === 'completed').length === RETAINED_TERMINAL_TASKS)
})
