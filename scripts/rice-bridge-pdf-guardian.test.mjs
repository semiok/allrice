import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';

it.skipIf(process.platform !== 'darwin')(
  'resolves only the RSS exit-zero race using the actual Swift completion function and native stop evidence',
  async () => {
    const source = await readFile(
      new URL('../apps/rice-bridge/native/PdfGuardian.swift', import.meta.url),
      'utf8',
    );
    const completion = source.match(
      /func pdfCompletionReason\([\s\S]*?\n}\n/,
    )?.[0];
    expect(completion).toBeTruthy();
    // Compile the exact production function. These fixed child fixtures do
    // not start Core, PDF parsing, a Bridge session or any network operation.
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), 'allrice-pdf-completion-')),
    );
    try {
      const fixture = join(directory, 'Completion.swift');
      const binary = join(directory, 'Completion');
      await writeFile(
        fixture,
        `import Foundation\nimport Darwin\n${completion}\n
var ownedChildren = [Process]()
func assertTrue(_ value: Bool) {
    if !value {
        for process in ownedChildren where process.isRunning {
            _ = kill(process.processIdentifier, SIGKILL)
            process.waitUntilExit()
        }
        fputs("NATIVE_COMPLETION_FIXTURE_FAILED\\n", stderr); exit(1)
    }
}
func gone(_ pid: Int32) -> Bool { return kill(pid, 0) != 0 && errno == ESRCH }
func child(_ executable: String, _ arguments: [String]) -> Process {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.environment = ["PATH": "/usr/bin:/bin"]
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try! process.run()
    ownedChildren.append(process)
    return process
}
var results = [String: String]()
let fast = child("/usr/bin/true", [])
fast.waitUntilExit()
let fastStopped = gone(fast.processIdentifier)
assertTrue(fastStopped && fast.terminationReason == .exit && fast.terminationStatus == 0)
results["naturalExitZero"] = pdfCompletionReason(reason: "process_unknown", rssSampleFailed: true, stopped: fastStopped, terminationReason: fast.terminationReason, terminationStatus: fast.terminationStatus)
results["noRssFailure"] = pdfCompletionReason(reason: "process_unknown", rssSampleFailed: false, stopped: fastStopped, terminationReason: fast.terminationReason, terminationStatus: fast.terminationStatus)
results["noStopProof"] = pdfCompletionReason(reason: "process_unknown", rssSampleFailed: true, stopped: false, terminationReason: fast.terminationReason, terminationStatus: fast.terminationStatus)
for reason in ["canceled", "timeout", "memory_limit", "output_limit", "input_invalid", "parse_failed"] {
    results[reason] = pdfCompletionReason(reason: reason, rssSampleFailed: true, stopped: fastStopped, terminationReason: fast.terminationReason, terminationStatus: fast.terminationStatus)
}
let failed = child("/usr/bin/false", [])
failed.waitUntilExit()
assertTrue(gone(failed.processIdentifier) && failed.terminationReason == .exit && failed.terminationStatus != 0)
results["naturalNonzero"] = pdfCompletionReason(reason: "process_unknown", rssSampleFailed: true, stopped: true, terminationReason: failed.terminationReason, terminationStatus: failed.terminationStatus)
let live = child("/bin/sleep", ["30"])
assertTrue(live.isRunning && !gone(live.processIdentifier))
results["liveWithoutStop"] = pdfCompletionReason(reason: "process_unknown", rssSampleFailed: true, stopped: false, terminationReason: .exit, terminationStatus: 0)
assertTrue(kill(live.processIdentifier, SIGKILL) == 0)
live.waitUntilExit()
assertTrue(gone(live.processIdentifier) && live.terminationReason == .uncaughtSignal)
results["unobservableKilled"] = pdfCompletionReason(reason: "process_unknown", rssSampleFailed: true, stopped: true, terminationReason: live.terminationReason, terminationStatus: live.terminationStatus)
let cancel = child("/bin/sleep", ["30"])
assertTrue(cancel.isRunning && kill(cancel.processIdentifier, SIGTERM) == 0)
cancel.waitUntilExit()
assertTrue(gone(cancel.processIdentifier))
results["actualCancel"] = pdfCompletionReason(reason: "canceled", rssSampleFailed: true, stopped: true, terminationReason: cancel.terminationReason, terminationStatus: cancel.terminationStatus)
let bytes = try! JSONSerialization.data(withJSONObject: results, options: [.sortedKeys])
try! FileHandle.standardOutput.write(contentsOf: bytes)
`,
        { mode: 0o600 },
      );
      execFileSync(
        '/usr/bin/xcrun',
        [
          'swiftc',
          '-target',
          `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx13.0`,
          fixture,
          '-o',
          binary,
        ],
        { timeout: 30_000, maxBuffer: 65_536 },
      );
      const result = JSON.parse(
        execFileSync(binary, [], {
          timeout: 5_000,
          encoding: 'utf8',
          maxBuffer: 16_384,
        }),
      );
      expect(result).toEqual({
        naturalExitZero: 'completed',
        noRssFailure: 'process_unknown',
        noStopProof: 'process_unknown',
        naturalNonzero: 'process_unknown',
        liveWithoutStop: 'process_unknown',
        unobservableKilled: 'process_unknown',
        actualCancel: 'canceled',
        canceled: 'canceled',
        timeout: 'timeout',
        memory_limit: 'memory_limit',
        output_limit: 'output_limit',
        input_invalid: 'input_invalid',
        parse_failed: 'parse_failed',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  40_000,
);

// A killed reader closes stdin before the supervisor has necessarily finished
// its bounded document write. Exercise the actual Darwin broken-pipe behavior.
it.skipIf(process.platform !== 'darwin')(
  'keeps the supervisor alive when cancellation closes the document input pipe',
  async () => {
    const source = await readFile(
      new URL('../apps/rice-bridge/native/PdfGuardian.swift', import.meta.url),
      'utf8',
    );
    const setup = source.match(/^signal\(SIGPIPE, SIG_IGN\)$/m)?.[0];
    expect(setup).toBeTruthy();
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), 'allrice-pdf-cancel-pipe-')),
    );
    try {
      const fixture = join(directory, 'CancelPipe.swift');
      const binary = join(directory, 'CancelPipe');
      await writeFile(
        fixture,
        `import Foundation\nimport Darwin\n${setup}\n
let process = Process(), input = Pipe()
process.executableURL = URL(fileURLWithPath: "/bin/sleep")
process.arguments = ["30"]
process.standardInput = input
process.standardOutput = FileHandle.nullDevice
process.standardError = FileHandle.nullDevice
try process.run()
try input.fileHandleForReading.close()
_ = kill(process.processIdentifier, SIGKILL)
process.waitUntilExit()
var brokenPipe = false
do {
    try input.fileHandleForWriting.write(contentsOf: Data(repeating: 65, count: 3 * 1024 * 1024))
} catch { brokenPipe = true }
try input.fileHandleForWriting.close()
let stopped = kill(process.processIdentifier, 0) != 0 && errno == ESRCH
let receipt = try JSONSerialization.data(withJSONObject: ["stopped": stopped, "brokenPipe": brokenPipe])
try FileHandle.standardOutput.write(contentsOf: receipt)
`,
        { mode: 0o600 },
      );
      execFileSync('/usr/bin/xcrun', ['swiftc', fixture, '-o', binary], {
        timeout: 30_000,
        maxBuffer: 65_536,
      });
      const result = JSON.parse(
        execFileSync(binary, [], {
          timeout: 5_000,
          encoding: 'utf8',
          maxBuffer: 16_384,
        }),
      );
      expect(result).toEqual({ stopped: true, brokenPipe: true });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  40_000,
);
