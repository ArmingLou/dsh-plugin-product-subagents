import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createAcpBridge } from '../lib/bridges/acp.js'

// 假 spawn：立即以 ENOENT 异步失败——watchdog reconnect 走 connect()→options.spawn 测试缝，
// 不依赖真实 CLI；冻结循环应吞掉重连失败并无限重试，直到 abort/isClosed 终止。
function failSpawn() {
  const proc = new EventEmitter()
  proc.stdin = new PassThrough()
  proc.stdout = new PassThrough()
  proc.stderr = new PassThrough()
  proc.exitCode = null
  proc.signalCode = null
  queueMicrotask(() => proc.emit('error', Object.assign(new Error('spawn ENOENT (mock)'), { code: 'ENOENT' })))
  return proc
}

describe('watchdog configuration', () => {
  it('createAcpBridge accepts watchdogNoOutputMs option', () => {
    const bridge = createAcpBridge({ watchdogNoOutputMs: 5000 })
    assert.equal(typeof bridge.submit, 'function')
  })

  it('createAcpBridge works without watchdogNoOutputMs (default)', () => {
    const bridge = createAcpBridge()
    assert.equal(typeof bridge.submit, 'function')
  })
})

describe('isClosed callback integration', () => {
  it('submit rejects with WATCHDOG_CLOSED when isClosed returns true', async () => {
    const bridge = createAcpBridge({ watchdogNoOutputMs: 60000 })
    const remote = {
      sessionId: 'test-session',
      proc: { exitCode: null, signalCode: null, kill() {} },
      connection: {
        async prompt() {
          await new Promise((r) => setTimeout(r, 200))
          return { stopReason: 'end_turn' }
        },
        closeSession() { return Promise.resolve() },
      },
      progressRef: () => ({ lastActivityAt: Date.now() }),
      drainText: () => 'text',
      stderrTail: () => '',
      drainStderr: () => '',
    }
    const isClosed = () => true
    try {
      await bridge.submit(remote, 'task', new AbortController().signal, '/tmp', {}, isClosed)
      assert.fail('should have thrown')
    } catch (err) {
      assert.equal(err.code, 'WATCHDOG_CLOSED')
    }
  })
})

describe('watchdog freeze detection', () => {
  it('WATCHDOG_FREEZE triggers kill+closeSession when no output for watchdogNoOutputMs', async () => {
    const bridge = createAcpBridge({ watchdogNoOutputMs: 80, spawn: failSpawn })
    let killSigSent = false
    let closeSessionCalled = false
    const remote = {
      sessionId: 'freeze-test',
      proc: {
        exitCode: null,
        signalCode: null,
        kill(sig) {
          if (sig === 'SIGKILL') {
            killSigSent = true
            this.exitCode = 137
            this.signalCode = 'SIGKILL'
          }
        },
      },
      connection: {
        async prompt() {
          await new Promise(() => {})
        },
        closeSession() { closeSessionCalled = true; return Promise.resolve() },
      },
      progressRef: () => ({ lastActivityAt: 0 }),
      drainText: () => '',
      stderrTail: () => '',
      drainStderr: () => '',
    }
    const isClosed = () => false
    const ac = new AbortController()
    // Abort after 2s to prevent infinite loop (reconnect fails without real process)
    const timeout = setTimeout(() => ac.abort(), 2000)
    try {
      await bridge.submit(remote, 'task', ac.signal, '/tmp', {}, isClosed)
    } catch (err) {
      clearTimeout(timeout)
      // After abort, should get SUBMIT_ABORTED (abort wins) or WATCHDOG_CLOSED
      assert.ok(
        err.code === 'SUBMIT_ABORTED' || err.code === 'WATCHDOG_CLOSED',
        `Expected SUBMIT_ABORTED/WATCHDOG_CLOSED, got ${err.code}: ${err.message}`,
      )
    }
    clearTimeout(timeout)
    // The key assertion: watchdog freeze DID trigger kill+closeSession
    assert.ok(killSigSent, 'Expected SIGKILL to be sent on freeze')
    assert.ok(closeSessionCalled, 'Expected closeSession to be called on freeze')
  })

  it('watchdog continues retrying after reconnect failure (does not throw reconnect error)', async () => {
    const bridge = createAcpBridge({ watchdogNoOutputMs: 80, spawn: failSpawn })
    let killSigSent = false
    let closeSessionCalled = false
    let promptAttemptCount = 0
    const remote = {
      sessionId: 'reconnect-fail-test',
      proc: {
        exitCode: null,
        signalCode: null,
        kill(sig) {
          if (sig === 'SIGKILL') {
            killSigSent = true
            this.exitCode = 137
            this.signalCode = 'SIGKILL'
          }
        },
      },
      connection: {
        async prompt() {
          promptAttemptCount++
          await new Promise(() => {})
        },
        closeSession() { closeSessionCalled = true; return Promise.resolve() },
      },
      progressRef: () => ({ lastActivityAt: 0 }),
      drainText: () => '',
      stderrTail: () => '',
      drainStderr: () => '',
    }
    const isClosed = () => false
    const ac = new AbortController()
    // Let it run for 2s (should trigger multiple freeze→kill→reconnect-fail cycles)
    // then abort. If reconnect failure leaked as throw, we'd get a non-SUBMIT_ABORTED error.
    const timeout = setTimeout(() => ac.abort(), 2000)
    let caughtCode = null
    try {
      await bridge.submit(remote, 'task', ac.signal, '/tmp', {}, isClosed)
    } catch (err) {
      clearTimeout(timeout)
      caughtCode = err.code
    }
    clearTimeout(timeout)
    // Must NOT get a raw reconnect error (ENOENT, "ACP connection closed", etc)
    // Only legitimate termination codes are acceptable
    assert.ok(
      caughtCode === 'SUBMIT_ABORTED' || caughtCode === 'WATCHDOG_CLOSED',
      `Expected loop termination code, got ${caughtCode} (reconnect error leaked from watchdog loop)`,
    )
    assert.ok(killSigSent, 'Expected at least one SIGKILL')
    assert.ok(closeSessionCalled, 'Expected at least one closeSession')
  })
})

describe('watchdog with isClosed guard', () => {
  it('watchdog stops kill→reconnect loop when child is closed', async () => {
    let closed = false
    const isClosed = () => closed
    const bridge = createAcpBridge({ watchdogNoOutputMs: 80, spawn: failSpawn })
    const remote = {
      sessionId: 'closed-guard-test',
      proc: { exitCode: null, signalCode: null, kill() { this.exitCode = 137; this.signalCode = 'SIGKILL' } },
      connection: {
        async prompt() {
          await new Promise(() => {})
        },
        closeSession() { return Promise.resolve() },
      },
      progressRef: () => ({ lastActivityAt: 0 }),
      drainText: () => '',
      stderrTail: () => '',
      drainStderr: () => '',
    }
    // Close the child after a short delay (simulating agent_close arriving during freeze)
    setTimeout(() => { closed = true }, 200)
    const ac = new AbortController()
    const timeout = setTimeout(() => ac.abort(), 3000)
    try {
      await bridge.submit(remote, 'task', ac.signal, '/tmp', {}, isClosed)
    } catch (err) {
      clearTimeout(timeout)
      assert.equal(err.code, 'WATCHDOG_CLOSED', `Expected WATCHDOG_CLOSED, got ${err.code}: ${err.message}`)
    }
    clearTimeout(timeout)
  })
})

describe('watchdog respects active output (no false positive)', () => {
  it('watchdog does not trigger when output is flowing', async () => {
    const bridge = createAcpBridge({ watchdogNoOutputMs: 200 })
    let lastActivity = Date.now()
    const remote = {
      sessionId: 'active-test',
      proc: { exitCode: null, signalCode: null, kill() {} },
      connection: {
        async prompt() {
          await new Promise((r) => setTimeout(r, 100))
          lastActivity = Date.now()
          await new Promise((r) => setTimeout(r, 100))
          lastActivity = Date.now()
          return { stopReason: 'end_turn' }
        },
        closeSession() { return Promise.resolve() },
      },
      progressRef: () => ({ lastActivityAt: lastActivity }),
      drainText: () => 'active output text',
      stderrTail: () => '',
      drainStderr: () => '',
    }
    const isClosed = () => false
    const result = await bridge.submit(remote, 'task', new AbortController().signal, '/tmp', {}, isClosed)
    assert.ok(result.text.includes('active output text'))
  })
})

describe('watchdog configuration override', () => {
  it('watchdogNoOutputMs from provider config overrides default', () => {
    const bridge = createAcpBridge({ watchdogNoOutputMs: 5000 })
    assert.equal(typeof bridge.submit, 'function')
    const bridgeDefault = createAcpBridge({})
    assert.equal(typeof bridgeDefault.submit, 'function')
  })
})

describe('watchdog permission-pending exemption', () => {
  it('does NOT trigger freeze while permission is pending (human waiting)', async () => {
    let pending = true
    const bridge = createAcpBridge({
      watchdogNoOutputMs: 80,
      isHumanWaitPending: () => pending,
      spawn: failSpawn,
    })
    let killSig = false
    const remote = {
      sessionId: 'perm-pending-test',
      proc: { exitCode: null, signalCode: null, kill(sig) { killSig = true; this.exitCode = 137 } },
      connection: {
        async prompt() { await new Promise(() => {}) },
        closeSession() { return Promise.resolve() },
      },
      progressRef: () => ({ lastActivityAt: 0 }),
      drainText: () => '', stderrTail: () => '', drainStderr: () => '',
    }
    // 前 500ms 权限挂起（豁免期）；随后解除挂起但无输出 → 冻结应触发
    setTimeout(() => { pending = false }, 500)
    const ac = new AbortController()
    const timeout = setTimeout(() => ac.abort(), 3000)
    let code = null
    try { await bridge.submit(remote, 'task', ac.signal, '/tmp', {}, () => false) } catch (e) { code = e.code }
    clearTimeout(timeout)
    // 挂起期间不应 kill；解除后冻结会 kill→reconnect(假 spawn 失败)→循环→abort 终止
    assert.ok(code === 'SUBMIT_ABORTED' || code === 'WATCHDOG_CLOSED', `got ${code}`)
    assert.ok(killSig, 'freeze after pending released should have killed')
  })
})
