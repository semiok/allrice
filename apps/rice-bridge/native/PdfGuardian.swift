import Foundation
import Darwin

@_silgen_name("proc_pidinfo")
func pidInfo(_ pid: Int32, _ flavor: Int32, _ arg: UInt64, _ buffer: UnsafeMutableRawPointer, _ size: Int32) -> Int32

// Trusted fixed supervisor, outside the document process's deny-default policy.
// Only stdin/stdout/stderr cross the child boundary. No shell or model command.
umask(0o077)
let owner = getppid()
var ownedChild: Int32 = 0
func fail() -> Never {
    if ownedChild > 1 { _ = kill(ownedChild, SIGKILL); _ = waitpid(ownedChild, nil, 0) }
    fputs("PDF_GUARDIAN_DENIED\n", stderr); exit(70)
}
guard owner > 1, CommandLine.arguments.count == 2 else { fail() }
let directory = CommandLine.arguments[1]
var directoryStat = stat()
guard directory.hasPrefix("/"), !directory.contains("\0"),
      lstat(directory, &directoryStat) == 0, (directoryStat.st_mode & S_IFMT) == S_IFDIR,
      directoryStat.st_uid == getuid(), (directoryStat.st_mode & 0o7777) == 0o700 else { fail() }
func sameDirectory() -> Bool {
    var current = stat()
    return lstat(directory, &current) == 0 && current.st_dev == directoryStat.st_dev && current.st_ino == directoryStat.st_ino
      && current.st_uid == getuid() && (current.st_mode & 0o7777) == 0o700
}
func readExact(_ count: Int) -> Data {
    var data = Data()
    while data.count < count {
        guard let next = try? FileHandle.standardInput.read(upToCount: count - data.count), !next.isEmpty else { fail() }
        data.append(next)
    }
    return data
}
var header = Data()
while header.count <= 16_384 {
    let byte = readExact(1)
    if byte.first == 10 { break }
    header.append(byte)
}
guard header.count <= 16_384,
      let config = (try? JSONSerialization.jsonObject(with: header)) as? [String: Any],
      config["version"] as? Int == 1,
      let nonce = config["nonce"] as? String, UUID(uuidString: nonce) != nil,
      let digest = config["payloadDigest"] as? String, digest.hasPrefix("sha256:"), digest.count == 71,
      let core = config["core"] as? String,
      let resources = config["resources"] as? String, resources == core + ".pdf-runtime",
      let inputBytes = config["inputBytes"] as? Int, inputBytes >= 0, inputBytes <= 20 * 1024 * 1024,
      let childHeader = config["reader"] as? [String: Any],
      let mode = childHeader["mode"] as? String, ["read", "isolation_probe", "exec_probe", "stop_probe"].contains(mode),
      sameDirectory() else { fail() }
// Resolve our sibling SEA; callers cannot turn this helper into an arbitrary
// binary executor even when manually invoking it outside AllRice.
// Foundation normalizes /private/var to /var. Use libc's physical path,
// matching Node's realpath checks and retaining exact sibling identities.
func canonicalPath(_ path: String) -> String? {
    guard path.hasPrefix("/"), !path.contains("\0") else { return nil }
    return path.withCString { input in
        guard let resolved = Darwin.realpath(input, nil) else { return nil }
        defer { free(resolved) }
        return String(cString: resolved)
    }
}
guard let guardian = canonicalPath(CommandLine.arguments[0]),
      guardian == core + ".pdf-guardian", canonicalPath(core) == core,
      canonicalPath(resources) == resources else { fail() }
let cwd = directory + "/empty"
var cwdStat = stat()
guard lstat(cwd, &cwdStat) == 0, (cwdStat.st_mode & S_IFMT) == S_IFDIR,
      cwdStat.st_uid == getuid(), (cwdStat.st_mode & 0o7777) == 0o700,
      let template = try? String(contentsOfFile: resources + "/seatbelt.sb.in", encoding: .utf8),
      template.utf8.count < 4096 else { fail() }
func quote(_ path: String) -> String {
    return String(data: try! JSONSerialization.data(withJSONObject: [path], options: [.withoutEscapingSlashes]), encoding: .utf8)!.dropFirst().dropLast().description
}
var ancestors = Set<String>(["/"])
for path in [core, resources, cwd] {
    var parent = URL(fileURLWithPath: path).deletingLastPathComponent().path
    while parent != "/" { ancestors.insert(parent); parent = URL(fileURLWithPath: parent).deletingLastPathComponent().path }
}
let policy = template.replacingOccurrences(of: "@CORE@", with: quote(core))
  .replacingOccurrences(of: "@RESOURCES@", with: quote(resources))
  .replacingOccurrences(of: "@CWD@", with: quote(cwd))
  .replacingOccurrences(of: "@ANCESTORS@", with: ancestors.sorted().map { "(literal " + quote($0) + ")" }.joined(separator: " "))
let bytes = readExact(inputBytes)
let process = Process(), childInput = Pipe(), childOutput = Pipe(), childError = Pipe()
process.executableURL = URL(fileURLWithPath: "/usr/bin/sandbox-exec")
process.arguments = ["-p", policy, core, "--pdf-reader"]
process.currentDirectoryURL = URL(fileURLWithPath: cwd)
process.environment = ["PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8", "DISABLE_SYSTEM_FONTS_LOAD": "1"]
process.standardInput = childInput; process.standardOutput = childOutput; process.standardError = childError
let lock = NSLock()
var output = Data(), diagnostics = Data(), outputLimit = false, eof = false, lastPulse = Date()
childOutput.fileHandleForReading.readabilityHandler = { handle in
    let next = handle.availableData
    lock.lock(); defer { lock.unlock() }
    if output.count + next.count > 410_000 { outputLimit = true }
    else { output.append(next) }
}
// Private bounded diagnostic checkpoint only; never an operation/model result.
childError.fileHandleForReading.readabilityHandler = { handle in
    let bytes = handle.availableData
    lock.lock(); diagnostics.append(bytes.prefix(max(0, 16_384 - diagnostics.count))); lock.unlock()
}
do { try process.run() } catch { fail() }
let pid = process.processIdentifier
ownedChild = pid
func persist(_ object: [String: Any], _ name: String) {
    guard sameDirectory(), let bytes = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), bytes.count <= 512_000 else { fail() }
    let path = directory + "/" + name
    do {
        try bytes.write(to: URL(fileURLWithPath: path), options: [.atomic])
        guard chmod(path, 0o600) == 0 else { fail() }
        let fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { fail() }; _ = fsync(fd); close(fd)
    } catch { fail() }
}
persist(["version": 1, "nonce": nonce, "payloadDigest": digest, "guardianPid": getpid(), "parentPid": owner, "readerPid": pid, "stopped": false], "process.json")
DispatchQueue.global().async {
    while true {
        let next = FileHandle.standardInput.availableData
        lock.lock()
        if next.isEmpty { eof = true; lock.unlock(); break }
        lastPulse = Date(); lock.unlock()
    }
}
DispatchQueue.global().async {
    do {
        var message = try JSONSerialization.data(withJSONObject: childHeader)
        message.append(10)
        try childInput.fileHandleForWriting.write(contentsOf: message)
        try childInput.fileHandleForWriting.write(contentsOf: bytes)
        try childInput.fileHandleForWriting.close()
    } catch { lock.lock(); eof = true; lock.unlock() }
}
let started = Date()
var reason = "completed", peak: UInt64 = 0
while process.isRunning {
    lock.lock(); let lost = eof || Date().timeIntervalSince(lastPulse) > 6 || outputLimit; let oversized = outputLimit; lock.unlock()
    var task = [UInt64](repeating: 0, count: 16)
    let count = task.withUnsafeMutableBytes { pidInfo(pid, 4, 0, $0.baseAddress!, Int32($0.count)) }
    if count >= 16 { peak = max(peak, task[1]) }
    if oversized { reason = "output_limit" }
    else if lost || getppid() != owner || kill(owner, 0) != 0 { reason = "canceled" }
    else if Date().timeIntervalSince(started) >= 30 { reason = "timeout" }
    else if peak > 512 * 1024 * 1024 { reason = "memory_limit" }
    else if count < 16 && process.isRunning { reason = "process_unknown" }
    if reason != "completed" { _ = kill(pid, SIGKILL); break }
    usleep(10_000)
}
process.waitUntilExit()
ownedChild = 0
childOutput.fileHandleForReading.readabilityHandler = nil
childError.fileHandleForReading.readabilityHandler = nil
let remaining = childOutput.fileHandleForReading.readDataToEndOfFile()
let remainingError = childError.fileHandleForReading.readDataToEndOfFile()
lock.lock(); if output.count + remaining.count <= 410_000 { output.append(remaining) } else { outputLimit = true }; let finalOutput = output; lock.unlock()
lock.lock(); diagnostics.append(remainingError.prefix(max(0, 16_384 - diagnostics.count))); let finalDiagnostics = diagnostics; lock.unlock()
let stopped = kill(pid, 0) != 0 && errno == ESRCH
if !stopped { reason = "process_unknown" }
if reason == "completed" && outputLimit { reason = "output_limit" }
let status: Any = process.terminationReason == .exit ? Int(process.terminationStatus) : NSNull()
let result: Any = (try? JSONSerialization.jsonObject(with: finalOutput)) ?? NSNull()
let record: [String: Any] = ["version": 1, "nonce": nonce, "payloadDigest": digest, "guardianPid": getpid(), "parentPid": owner, "readerPid": pid, "stopped": stopped, "exitCode": status, "reason": reason, "observedPeakRssBytes": peak, "reader": result]
persist(record, "result.json")
persist(["version": 1, "nonce": nonce, "stderr": String(decoding: finalDiagnostics, as: UTF8.self)], "diagnostic.json")
persist(["version": 1, "nonce": nonce, "payloadDigest": digest, "guardianPid": getpid(), "parentPid": owner, "readerPid": pid, "stopped": stopped], "process.json")
guard let resultBytes = try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]) else { fail() }
try FileHandle.standardOutput.write(contentsOf: resultBytes)
try FileHandle.standardOutput.write(contentsOf: Data([10]))
