import Foundation
import Darwin
import CryptoKit
import CoreFoundation

// One fixed, descriptor-relative operation. The caller owns authorization and
// the prepared/applied journal; this helper does not schedule or replay work.
umask(0o077)
let maximumRequestBytes = 16_384
let maximumFileBytes: Int64 = 9_000_000
let maximumResultBytes = 512_000
let maximumReadResultBytes = 12_100_000
let maximumDepth = 24
let chunkBytes = 65_536
let owner = getppid()
let started = ProcessInfo.processInfo.systemUptime
var interrupted: sig_atomic_t = 0

struct GuardianError: Error {
    let code: String
    init(_ code: String) { self.code = code }
}

final class Watchdog: @unchecked Sendable {
    private let lock = NSLock()
    private var reason: String?
    private var canceledAt: TimeInterval?
    private var finished = false

    func cancel(_ code: String) {
        lock.lock(); defer { lock.unlock() }
        if reason == nil { reason = code; canceledAt = ProcessInfo.processInfo.systemUptime }
    }
    func check() throws {
        if interrupted != 0 { cancel("FILE_CANCELED") }
        if getppid() != owner || owner <= 1 { cancel("FILE_OWNER_LOST") }
        if ProcessInfo.processInfo.systemUptime - started >= 30 { cancel("FILE_TIMEOUT") }
        lock.lock(); let value = reason; lock.unlock()
        if let value { throw GuardianError(value) }
    }
    func finish() { lock.lock(); finished = true; lock.unlock() }
    func start() {
        DispatchQueue.global().async { [self] in
            while true {
                lock.lock(); let done = finished; lock.unlock()
                if done { return }
                if interrupted != 0 { cancel("FILE_CANCELED") }
                if getppid() != owner || owner <= 1 { cancel("FILE_OWNER_LOST") }
                if ProcessInfo.processInfo.systemUptime - started >= 30 { cancel("FILE_TIMEOUT") }
                var item = pollfd(fd: STDIN_FILENO, events: Int16(POLLIN | POLLHUP), revents: 0)
                if Darwin.poll(&item, 1, 0) > 0 && item.revents & Int16(POLLHUP | POLLERR | POLLNVAL) != 0 {
                    cancel("FILE_CANCELED")
                }
                lock.lock(); let since = canceledAt; let ended = finished; lock.unlock()
                // A stuck fsync/read must not survive owner loss or the deadline.
                // No successful receipt is manufactured for an interrupted call.
                if !ended, let since, ProcessInfo.processInfo.systemUptime - since >= 0.5 { Darwin._exit(74) }
                usleep(20_000)
            }
        }
    }
}
let watchdog = Watchdog()
signal(SIGPIPE, SIG_IGN)
signal(SIGTERM) { _ in interrupted = 1 }
signal(SIGINT) { _ in interrupted = 1 }

func check() throws {
    try watchdog.check()
    var buffer = [UInt8](repeating: 0, count: 1024)
    while true {
        let count = Darwin.read(STDIN_FILENO, &buffer, buffer.count)
        if count > 0 {
            guard buffer.prefix(count).allSatisfy({ [9, 10, 13, 32].contains($0) }) else {
                throw GuardianError("FILE_REQUEST_INVALID")
            }
        } else if count == 0 {
            watchdog.cancel("FILE_CANCELED"); try watchdog.check()
        } else if errno == EAGAIN || errno == EWOULDBLOCK { break }
        else if errno != EINTR { throw GuardianError("FILE_REQUEST_INVALID") }
        try watchdog.check()
    }
}

func readRequest() throws -> [String: Any] {
    guard owner > 1, CommandLine.arguments.count == 1 else { throw GuardianError("FILE_REQUEST_INVALID") }
    var data = Data()
    while true {
        try watchdog.check()
        var item = pollfd(fd: STDIN_FILENO, events: Int16(POLLIN | POLLHUP), revents: 0)
        let available = Darwin.poll(&item, 1, 100)
        if available < 0 && errno == EINTR { continue }
        if available < 0 { throw GuardianError("FILE_REQUEST_INVALID") }
        if available == 0 { continue }
        var byte: UInt8 = 0
        let count = Darwin.read(STDIN_FILENO, &byte, 1)
        if count == 0 { throw GuardianError("FILE_CANCELED") }
        if count < 0 && errno == EINTR { continue }
        guard count == 1 else { throw GuardianError("FILE_REQUEST_INVALID") }
        if byte == 10 { break }
        guard data.count < maximumRequestBytes else { throw GuardianError("FILE_REQUEST_TOO_LARGE") }
        data.append(byte)
    }
    guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
        throw GuardianError("FILE_REQUEST_INVALID")
    }
    let flags = fcntl(STDIN_FILENO, F_GETFL)
    guard flags >= 0, fcntl(STDIN_FILENO, F_SETFL, flags | O_NONBLOCK) == 0 else { throw GuardianError("FILE_REQUEST_INVALID") }
    watchdog.start()
    try check()
    return object
}

let blockedNames: Set<String> = [
    ".git", ".ssh", ".aws", ".gnupg", ".codex", ".kube", ".azure",
    ".docker", ".config", ".cache", ".npm", ".yarn", ".pnpm-store", "cache", "caches", "node_modules",
    ".next", "dist", "build", "__pycache__", ".venv", "venv", ".secrets", "secrets", "secret"
]
func forbidden(_ name: String) -> Bool {
    let lower = name.lowercased()
    return blockedNames.contains(lower) || lower == ".env" || lower.hasPrefix(".env.")
      || lower.hasPrefix(".allrice-file-") || [".npmrc", ".netrc", "id_rsa", "id_ed25519", "credentials", "credentials.json"].contains(lower)
      || lower.hasSuffix(".pem") || lower.hasSuffix(".key") || lower.hasSuffix(".p12")
}
func validComponent(_ name: String) -> Bool {
    return !name.isEmpty && name != "." && name != ".." && name.utf8.count <= 255
      && !name.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 })
}
func relativeComponents(_ value: String, allowRoot: Bool = false, allowInternalSurvey: Bool = false) throws -> [String] {
    if allowRoot && (value == "." || value.isEmpty) { return [] }
    guard !value.hasPrefix("/"), value.utf8.count <= 4096 else { throw GuardianError("FILE_PATH_INVALID") }
    let parts = value.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    guard !parts.isEmpty, parts.count <= maximumDepth, parts.allSatisfy(validComponent) else { throw GuardianError("FILE_PATH_INVALID") }
    // Broad discovery excludes pending private files. An explicit read-only
    // survey may inspect a caller-journal recovery path after an unknown result.
    guard !parts.contains(where: { forbidden($0) && !(allowInternalSurvey && $0.lowercased().hasPrefix(".allrice-file-")) }) else { throw GuardianError("FILE_PATH_DENIED") }
    return parts
}
func integer(_ value: Any?, _ maximum: Int) throws -> Int {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
          number.doubleValue.isFinite, number.doubleValue.rounded() == number.doubleValue,
          number.doubleValue >= 0, number.doubleValue <= Double(maximum) else { throw GuardianError("FILE_REQUEST_INVALID") }
    return number.intValue
}
func validDigest(_ value: String) -> Bool {
    return value.hasPrefix("sha256:") && value.count == 71 && value.dropFirst(7).allSatisfy({ $0.isASCII && ("0123456789abcdef".contains($0)) })
}
func systemError(_ code: String) -> GuardianError {
    if errno == ENOENT { return GuardianError("FILE_NOT_FOUND") }
    if errno == ELOOP { return GuardianError("FILE_SYMLINK") }
    if errno == EACCES || errno == EPERM { return GuardianError("FILE_ACCESS_DENIED") }
    if errno == EEXIST { return GuardianError("FILE_DESTINATION_EXISTS") }
    return GuardianError(code)
}
func statAt(_ fd: Int32, _ name: String) throws -> stat {
    var value = stat()
    guard name.withCString({ fstatat(fd, $0, &value, AT_SYMLINK_NOFOLLOW) }) == 0 else { throw systemError("FILE_STAT_FAILED") }
    return value
}
func statFD(_ fd: Int32) throws -> stat {
    var value = stat()
    guard fstat(fd, &value) == 0 else { throw systemError("FILE_STAT_FAILED") }
    return value
}
func sameDirectory(_ a: stat, _ b: stat) -> Bool {
    return (b.st_mode & S_IFMT) == S_IFDIR && a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_mode == b.st_mode
}
func sameFile(_ a: stat, _ b: stat, compareChangeTime: Bool = true) -> Bool {
    return (b.st_mode & S_IFMT) == S_IFREG && a.st_dev == b.st_dev && a.st_ino == b.st_ino
      && a.st_size == b.st_size && a.st_mode == b.st_mode && a.st_uid == b.st_uid && a.st_gid == b.st_gid
      && a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec && a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec
      && (!compareChangeTime || (a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec && a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec))
}

final class Directory {
    let fd: Int32
    let identity: stat
    let parent: Directory?
    let name: String?
    init(fd: Int32, parent: Directory? = nil, name: String? = nil) throws {
        self.fd = fd; self.parent = parent; self.name = name
        do { identity = try statFD(fd) } catch { close(fd); throw error }
        guard (identity.st_mode & S_IFMT) == S_IFDIR else { close(fd); throw GuardianError("FILE_DIRECTORY_REQUIRED") }
    }
    deinit { close(fd) }
    func validate() throws {
        try check()
        guard sameDirectory(identity, try statFD(fd)) else { throw GuardianError("FILE_PARENT_CHANGED") }
        if let parent, let name {
            try parent.validate()
            guard sameDirectory(identity, try statAt(parent.fd, name)) else { throw GuardianError("FILE_PARENT_CHANGED") }
        }
    }
    func child(_ name: String) throws -> Directory {
        try validate()
        let before = try statAt(fd, name)
        guard (before.st_mode & S_IFMT) == S_IFDIR else { throw GuardianError((before.st_mode & S_IFMT) == S_IFLNK ? "FILE_SYMLINK" : "FILE_DIRECTORY_REQUIRED") }
        let next = name.withCString { openat(fd, $0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK) }
        guard next >= 0 else { throw systemError("FILE_DIRECTORY_OPEN_FAILED") }
        let result = try Directory(fd: next, parent: self, name: name)
        guard sameDirectory(before, result.identity) else { throw GuardianError("FILE_PARENT_CHANGED") }
        try result.validate()
        return result
    }
}
func authorizedRoot(_ path: String) throws -> Directory {
    guard path.hasPrefix("/"), path != "/", path.utf8.count <= 4096 else { throw GuardianError("FILE_ROOT_INVALID") }
    let components = path.dropFirst().split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    guard components.count <= 64, components.allSatisfy(validComponent), !components.contains(where: forbidden) else { throw GuardianError("FILE_ROOT_INVALID") }
    let fd = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard fd >= 0 else { throw GuardianError("FILE_ROOT_INVALID") }
    var directory = try Directory(fd: fd)
    // Open every absolute ancestor too. O_NOFOLLOW on only the final root is
    // insufficient when an authorized parent's pathname is replaced.
    for name in components { directory = try directory.child(name) }
    try directory.validate()
    return directory
}
func parentDirectory(_ root: Directory, _ components: [String]) throws -> Directory {
    var directory = root
    for name in components.dropLast() { directory = try directory.child(name) }
    return directory
}

final class RegularFile {
    let fd: Int32
    let parent: Directory
    let name: String
    let identity: stat
    init(parent: Directory, name: String) throws {
        self.parent = parent; self.name = name
        try parent.validate()
        let before = try statAt(parent.fd, name)
        guard (before.st_mode & S_IFMT) == S_IFREG else { throw GuardianError((before.st_mode & S_IFMT) == S_IFLNK ? "FILE_SYMLINK" : "FILE_TYPE_UNSUPPORTED") }
        guard before.st_size >= 0, before.st_size <= maximumFileBytes else { throw GuardianError("FILE_TOO_LARGE") }
        // A hard link can name the same inode outside the selected tree.
        guard before.st_nlink == 1 else { throw GuardianError("FILE_HARD_LINK_UNSUPPORTED") }
        let opened = name.withCString { openat(parent.fd, $0, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK) }
        guard opened >= 0 else { throw systemError("FILE_OPEN_FAILED") }
        fd = opened
        do {
            identity = try statFD(opened)
            guard sameFile(before, identity), identity.st_nlink == 1 else { throw GuardianError("FILE_CHANGED") }
        } catch { close(opened); throw error }
    }
    deinit { close(fd) }
    func validate() throws {
        try parent.validate()
        guard sameFile(identity, try statFD(fd)), sameFile(identity, try statAt(parent.fd, name)) else { throw GuardianError("FILE_CHANGED") }
    }
}
func fingerprint(path: String, identity: stat, checksum: String) -> String {
    let fields = ["allrice-native-file-v1", path, String(identity.st_dev), String(identity.st_ino), String(identity.st_size),
                  String(identity.st_mtimespec.tv_sec), String(identity.st_mtimespec.tv_nsec), String(identity.st_ctimespec.tv_sec), String(identity.st_ctimespec.tv_nsec), checksum]
    return "sha256:" + SHA256.hash(data: Data(fields.joined(separator: "\n").utf8)).map { String(format: "%02x", $0) }.joined()
}
func hashFD(_ fd: Int32, _ identity: stat, count: ((Int) -> Void)? = nil, writeTo: Int32? = nil) throws -> String {
    var hash = SHA256(), position: Int64 = 0
    var buffer = [UInt8](repeating: 0, count: chunkBytes)
    while position < identity.st_size {
        try check()
        let requested = min(buffer.count, Int(identity.st_size - position))
        let readCount = buffer.withUnsafeMutableBytes { Darwin.pread(fd, $0.baseAddress, requested, off_t(position)) }
        if readCount < 0 && errno == EINTR { continue }
        guard readCount > 0 else { throw GuardianError(readCount == 0 ? "FILE_CHANGED" : "FILE_READ_FAILED") }
        let data = Data(buffer.prefix(readCount)); hash.update(data: data); count?(readCount)
        if let writeTo {
            try data.withUnsafeBytes { bytes in
                var written = 0
                while written < readCount {
                    try check()
                    let result = Darwin.write(writeTo, bytes.baseAddress!.advanced(by: written), readCount - written)
                    if result < 0 && errno == EINTR { continue }
                    guard result > 0 else { throw systemError("FILE_WRITE_FAILED") }
                    written += result
                }
            }
        }
        position += Int64(readCount)
    }
    guard sameFile(identity, try statFD(fd)) else { throw GuardianError("FILE_CHANGED") }
    return "sha256:" + hash.finalize().map { String(format: "%02x", $0) }.joined()
}
func readFileBytes(_ root: Directory, _ parts: [String], _ expected: [String: Any]) throws -> [String: Any] {
    guard Set(expected.keys) == Set(["checksum", "sizeBytes", "version", "mediaType"]),
          let expectedChecksum = expected["checksum"] as? String, validDigest(expectedChecksum),
          let version = expected["version"] as? String, validDigest(version),
          let mediaType = expected["mediaType"] as? String, !mediaType.isEmpty, mediaType.utf8.count <= 255 else {
        throw GuardianError("FILE_REQUEST_INVALID")
    }
    let size = try integer(expected["sizeBytes"], Int(maximumFileBytes))
    let parent = try parentDirectory(root, parts)
    let file = try RegularFile(parent: parent, name: parts.last!)
    guard file.identity.st_size == Int64(size) else { throw GuardianError("FILE_CHANGED") }
    var data = Data(capacity: size), hash = SHA256(), position: Int64 = 0
    var buffer = [UInt8](repeating: 0, count: chunkBytes)
    while position < file.identity.st_size {
        try check()
        let requested = min(buffer.count, Int(file.identity.st_size - position))
        let count = buffer.withUnsafeMutableBytes { Darwin.pread(file.fd, $0.baseAddress, requested, off_t(position)) }
        if count < 0 && errno == EINTR { continue }
        guard count > 0 else { throw GuardianError(count == 0 ? "FILE_CHANGED" : "FILE_READ_FAILED") }
        guard data.count <= Int(maximumFileBytes) - count else { throw GuardianError("FILE_TOO_LARGE") }
        let chunk = Data(buffer.prefix(count)); data.append(chunk); hash.update(data: chunk)
        position += Int64(count)
    }
    let checksum = "sha256:" + hash.finalize().map { String(format: "%02x", $0) }.joined()
    guard data.count == size, checksum == expectedChecksum else { throw GuardianError("FILE_CHANGED") }
    let encoded = data.base64EncodedString()
    try file.validate()
    guard (try statFD(file.fd)).st_nlink == 1, (try statAt(parent.fd, file.name)).st_nlink == 1 else {
        throw GuardianError("FILE_HARD_LINK_UNSUPPORTED")
    }
    try check()
    // Match Node/libuv Stats millisecond arithmetic, including sub-ms precision.
    // JS computes the original PR3 JSON version from these numeric identities.
    let identity: [String: Any] = [
        "dev": Double(file.identity.st_dev), "ino": Double(file.identity.st_ino),
        "size": Double(file.identity.st_size),
        "mtimeMs": Double(file.identity.st_mtimespec.tv_sec) * 1000 + Double(file.identity.st_mtimespec.tv_nsec) / 1_000_000,
        "ctimeMs": Double(file.identity.st_ctimespec.tv_sec) * 1000 + Double(file.identity.st_ctimespec.tv_nsec) / 1_000_000
    ]
    return ["checksum": checksum, "sizeBytes": size, "identity": identity, "bytesBase64": encoded]
}
func syncFD(_ fd: Int32) throws {
    try check()
    while fsync(fd) != 0 { if errno != EINTR { throw systemError("FILE_SYNC_FAILED") }; try check() }
    try check()
}
func directorySync(_ directory: Directory) throws { try directory.validate(); try syncFD(directory.fd) }
func createOnlyRename(_ source: Directory, _ sourceName: String, _ destination: Directory, _ destinationName: String) throws {
    try source.validate(); try destination.validate(); try check()
    let result = sourceName.withCString { from in destinationName.withCString { to in renameatx_np(source.fd, from, destination.fd, to, UInt32(RENAME_EXCL)) } }
    guard result == 0 else { throw systemError("FILE_COMMIT_FAILED") }
}
func noDestination(_ directory: Directory, _ name: String) throws {
    try directory.validate()
    var value = stat()
    let result = name.withCString { fstatat(directory.fd, $0, &value, AT_SYMLINK_NOFOLLOW) }
    if result == 0 { throw GuardianError("FILE_DESTINATION_EXISTS") }
    guard errno == ENOENT else { throw systemError("FILE_STAT_FAILED") }
}
func modifiedAt(_ value: stat) -> String {
    let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: Date(timeIntervalSince1970: Double(value.st_mtimespec.tv_sec) + Double(value.st_mtimespec.tv_nsec) / 1_000_000_000))
}

final class Survey {
    let maximumEntries: Int
    let maximumHashBytes: Int
    let hash: Bool
    var files = [[String: Any]](), skipped = [[String: String]]()
    var scannedEntries = 0, hashBytes = 0, outputBytes = 4096
    var truncated = false, complete = true, stop = false
    init(maximumEntries: Int, maximumHashBytes: Int, hash: Bool) {
        self.maximumEntries = maximumEntries; self.maximumHashBytes = maximumHashBytes; self.hash = hash
    }
    func append(_ value: [String: Any], skippedEntry: Bool = false) throws {
        let size = try JSONSerialization.data(withJSONObject: value).count + 1
        if outputBytes + size > maximumResultBytes { truncated = true; complete = false; stop = true; return }
        outputBytes += size
        if skippedEntry { skipped.append(value as! [String: String]) } else { files.append(value) }
    }
    func skip(_ path: String, _ reason: String) throws {
        complete = false
        try append(["path": path, "reason": reason], skippedEntry: true)
    }
    func file(_ parent: Directory, _ name: String, _ path: String) throws {
        let file = try RegularFile(parent: parent, name: name)
        var value: [String: Any] = ["path": path, "sizeBytes": file.identity.st_size, "modifiedAt": modifiedAt(file.identity)]
        if hash {
            if file.identity.st_size > Int64(maximumHashBytes - hashBytes) {
                truncated = true; try skip(path, "FILE_HASH_BUDGET"); return
            }
            let checksum = try hashFD(file.fd, file.identity, count: { self.hashBytes += $0 })
            try file.validate()
            value["checksum"] = checksum; value["version"] = fingerprint(path: path, identity: file.identity, checksum: checksum)
        } else { try file.validate() }
        try append(value)
    }
    func directory(_ directory: Directory, _ path: String, _ depth: Int) throws {
        if stop { return }
        try directory.validate()
        if depth >= maximumDepth { truncated = true; try skip(path, "FILE_DEPTH_LIMIT"); return }
        let duplicate = dup(directory.fd)
        guard duplicate >= 0 else { throw GuardianError("FILE_DIRECTORY_READ_FAILED") }
        guard let stream = fdopendir(duplicate) else { close(duplicate); throw systemError("FILE_DIRECTORY_READ_FAILED") }
        defer { closedir(stream) }
        var names = [String]()
        while true {
            try check(); errno = 0
            guard let item = readdir(stream) else {
                if errno != 0 { throw systemError("FILE_DIRECTORY_READ_FAILED") }; break
            }
            let name = withUnsafePointer(to: &item.pointee.d_name) { pointer in pointer.withMemoryRebound(to: CChar.self, capacity: 256) { String(validatingCString: $0) } }
            if name == "." || name == ".." { continue }
            if scannedEntries >= maximumEntries { truncated = true; complete = false; break }
            scannedEntries += 1
            guard let name else { try skip(path, "FILE_NAME_UNSUPPORTED"); if stop { return }; continue }
            names.append(name)
        }
        for name in names.sorted() {
            if stop { return }
            let relative = path.isEmpty ? name : path + "/" + name
            if !validComponent(name) || forbidden(name) { try skip(relative, "FILE_PATH_DENIED"); continue }
            do {
                let identity = try statAt(directory.fd, name)
                let type = identity.st_mode & S_IFMT
                if type == S_IFDIR { try self.directory(directory.child(name), relative, depth + 1) }
                else if type == S_IFREG { try file(directory, name, relative) }
                else { try skip(relative, type == S_IFLNK ? "FILE_SYMLINK" : "FILE_TYPE_UNSUPPORTED") }
            } catch let error as GuardianError {
                if ["FILE_CANCELED", "FILE_OWNER_LOST", "FILE_TIMEOUT", "FILE_REQUEST_INVALID"].contains(error.code) { throw error }
                try skip(relative, error.code)
                if ["FILE_CHANGED", "FILE_PARENT_CHANGED", "FILE_NOT_FOUND"].contains(error.code) { stop = true }
            }
        }
        try directory.validate()
    }
    func result() -> [String: Any] {
        return ["files": files, "scannedEntries": scannedEntries, "hashBytes": hashBytes, "skipped": skipped, "truncated": truncated, "complete": complete && !truncated]
    }
}

final class Mutation {
    let path: String, target: String, expectedChecksum: String, expectedSize: Int64, expectedVersion: String
    var stage = "validated", sourceRemoved = false, temporaryPath: String?, committed = false, sourceRecovery: String?
    init(path: String, target: String, expected: [String: Any]) throws {
        guard Set(expected.keys) == Set(["checksum", "sizeBytes", "version"]),
              let checksum = expected["checksum"] as? String, validDigest(checksum),
              let version = expected["version"] as? String, validDigest(version) else { throw GuardianError("FILE_REQUEST_INVALID") }
        self.path = path; self.target = target; expectedChecksum = checksum; expectedVersion = version
        expectedSize = Int64(try integer(expected["sizeBytes"], Int(maximumFileBytes)))
    }
    func execute(_ root: Directory, _ sourceParts: [String], _ targetParts: [String], move: Bool) throws -> [String: Any] {
        guard path != target else { throw GuardianError("FILE_DESTINATION_EXISTS") }
        let sourceDirectory = try parentDirectory(root, sourceParts), targetDirectory = try parentDirectory(root, targetParts)
        let sourceName = sourceParts.last!, targetName = targetParts.last!
        let source = try RegularFile(parent: sourceDirectory, name: sourceName)
        try noDestination(targetDirectory, targetName)
        let checksum = try hashFD(source.fd, source.identity); try source.validate()
        guard source.identity.st_size == expectedSize, checksum == expectedChecksum,
              fingerprint(path: path, identity: source.identity, checksum: checksum) == expectedVersion else { throw GuardianError("FILE_CHANGED") }
        stage = "source_verified"
        try noDestination(targetDirectory, targetName)
        let temporaryName = ".allrice-file-" + UUID().uuidString.lowercased() + ".part"
        let output = temporaryName.withCString { openat(targetDirectory.fd, $0, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600) }
        guard output >= 0 else { throw systemError("FILE_CREATE_FAILED") }
        defer { close(output) }
        temporaryPath = (targetParts.dropLast() + [temporaryName]).joined(separator: "/")
        let initialOutput = try statFD(output); stage = "temporary_created"
        let copiedChecksum = try hashFD(source.fd, source.identity, writeTo: output)
        guard copiedChecksum == expectedChecksum else { throw GuardianError("FILE_CHANGED") }
        try syncFD(output); try source.validate(); try targetDirectory.validate()
        let copied = try statFD(output)
        guard copied.st_dev == initialOutput.st_dev, copied.st_ino == initialOutput.st_ino,
              copied.st_size == expectedSize, sameFile(copied, try statAt(targetDirectory.fd, temporaryName)) else { throw GuardianError("FILE_CHANGED") }
        stage = "temporary_synced"
        try createOnlyRename(targetDirectory, temporaryName, targetDirectory, targetName)
        committed = true; stage = "destination_committed"; temporaryPath = nil
        try directorySync(targetDirectory)
        let destination = try statFD(output)
        guard sameFile(destination, try statAt(targetDirectory.fd, targetName)), destination.st_size == expectedSize else { throw GuardianError("FILE_DESTINATION_CHANGED") }
        let destinationChecksum = try hashFD(output, destination)
        guard destinationChecksum == expectedChecksum else { throw GuardianError("FILE_DESTINATION_CHANGED") }
        try source.validate()
        if move {
            // Detach under a private unpredictable name before deletion. If the
            // source name changed at rename, retain that file and report unknown;
            // never delete a replacement or remove the committed destination.
            let quarantine = ".allrice-file-" + UUID().uuidString.lowercased() + ".move"
            try createOnlyRename(sourceDirectory, sourceName, sourceDirectory, quarantine)
            sourceRecovery = (sourceParts.dropLast() + [quarantine]).joined(separator: "/")
            stage = "source_detached"
            let detached = try statAt(sourceDirectory.fd, quarantine)
            guard sameFile(source.identity, detached, compareChangeTime: false), detached.st_nlink == 1,
                  sameFile(detached, try statFD(source.fd)) else { throw GuardianError("FILE_SOURCE_CHANGED") }
            guard try hashFD(source.fd, detached) == expectedChecksum else { throw GuardianError("FILE_SOURCE_CHANGED") }
            try sourceDirectory.validate(); try targetDirectory.validate()
            guard sameFile(detached, try statAt(sourceDirectory.fd, quarantine)),
                  sameFile(destination, try statFD(output)), sameFile(destination, try statAt(targetDirectory.fd, targetName)) else { throw GuardianError("FILE_CHANGED") }
            try check()
            var newSource = stat()
            let sourcePresent = sourceName.withCString { fstatat(sourceDirectory.fd, $0, &newSource, AT_SYMLINK_NOFOLLOW) }
            guard sourcePresent != 0, errno == ENOENT else { throw GuardianError("FILE_SOURCE_CHANGED") }
            guard quarantine.withCString({ unlinkat(sourceDirectory.fd, $0, 0) }) == 0 else { throw systemError("FILE_SOURCE_REMOVE_FAILED") }
            sourceRemoved = true; sourceRecovery = nil; stage = "source_removed"
            try directorySync(sourceDirectory)
            var current = stat()
            let present = sourceName.withCString { fstatat(sourceDirectory.fd, $0, &current, AT_SYMLINK_NOFOLLOW) }
            guard present != 0, errno == ENOENT else { throw GuardianError("FILE_SOURCE_CHANGED") }
        }
        try targetDirectory.validate()
        let final = try statFD(output)
        guard sameFile(destination, final), sameFile(final, try statAt(targetDirectory.fd, targetName)) else { throw GuardianError("FILE_DESTINATION_CHANGED") }
        try check()
        stage = "complete"
        return ["path": path, "target": target, "status": move ? "moved" : "copied",
                "file": ["checksum": expectedChecksum, "sizeBytes": expectedSize, "version": fingerprint(path: target, identity: final, checksum: expectedChecksum)],
                "sourceRemoved": sourceRemoved, "recovery": ["path": target, "checksum": expectedChecksum]]
    }
    func failure(_ code: String) -> [String: Any] {
        var result: [String: Any] = ["path": path, "target": target, "status": temporaryPath != nil || committed || sourceRecovery != nil ? "unknown" : "failed", "stage": stage, "sourceRemoved": sourceRemoved, "error": ["code": code]]
        if committed { result["recovery"] = ["path": target] }
        else if let temporaryPath { result["recovery"] = ["path": temporaryPath] }
        if let sourceRecovery { result["sourceRecovery"] = ["path": sourceRecovery] }
        // Uncertain copies and detached sources are retained for the existing
        // caller's reconciliation. This helper never retries or rolls back.
        return result
    }
}

var mutation: Mutation?
var response: [String: Any]
var exitStatus: Int32 = 0
var resultByteLimit = maximumResultBytes
do {
    let input = try readRequest()
    guard let mode = input["mode"] as? String, ["survey", "read", "copy", "move"].contains(mode),
          let rootPath = input["root"] as? String, let path = input["path"] as? String else { throw GuardianError("FILE_REQUEST_INVALID") }
    if mode == "read" {
        resultByteLimit = maximumReadResultBytes
        guard Set(input.keys) == Set(["mode", "root", "path", "expected"]),
              let expected = input["expected"] as? [String: Any] else { throw GuardianError("FILE_REQUEST_INVALID") }
        let parts = try relativeComponents(path)
        response = try readFileBytes(authorizedRoot(rootPath), parts, expected)
    } else if mode == "survey" {
        guard Set(input.keys) == Set(["mode", "root", "path", "maximumEntries", "maximumHashBytes", "hash"]),
              let hash = input["hash"] as? NSNumber, CFGetTypeID(hash) == CFBooleanGetTypeID() else { throw GuardianError("FILE_REQUEST_INVALID") }
        let entries = try integer(input["maximumEntries"], 2000); guard entries > 0 else { throw GuardianError("FILE_REQUEST_INVALID") }
        let survey = Survey(maximumEntries: entries, maximumHashBytes: try integer(input["maximumHashBytes"], 128_000_000), hash: hash.boolValue)
        let parts = try relativeComponents(path, allowRoot: true, allowInternalSurvey: true), root = try authorizedRoot(rootPath)
        if parts.isEmpty { try survey.directory(root, "", 0) }
        else {
            let parent = try parentDirectory(root, parts), name = parts.last!, identity = try statAt(parent.fd, name)
            if identity.st_mode & S_IFMT == S_IFDIR { try survey.directory(parent.child(name), parts.joined(separator: "/"), parts.count) }
            else { survey.scannedEntries = 1; try survey.file(parent, name, parts.joined(separator: "/")) }
        }
        response = survey.result()
    } else {
        guard Set(input.keys) == Set(["mode", "root", "path", "target", "expected", "expectedDestination"]),
              let target = input["target"] as? String, let expected = input["expected"] as? [String: Any], input["expectedDestination"] is NSNull else { throw GuardianError("FILE_REQUEST_INVALID") }
        let sourceParts = try relativeComponents(path), targetParts = try relativeComponents(target)
        let operation = try Mutation(path: sourceParts.joined(separator: "/"), target: targetParts.joined(separator: "/"), expected: expected)
        mutation = operation
        response = try operation.execute(authorizedRoot(rootPath), sourceParts, targetParts, move: mode == "move")
    }
} catch let error as GuardianError {
    response = mutation?.failure(error.code) ?? ["status": "failed", "error": ["code": error.code]]
    exitStatus = 65
} catch {
    response = mutation?.failure("FILE_IO_UNKNOWN") ?? ["status": "failed", "error": ["code": "FILE_IO_UNKNOWN"]]
    exitStatus = 70
}
do {
    var bytes = try JSONSerialization.data(withJSONObject: response, options: [.sortedKeys, .withoutEscapingSlashes])
    guard bytes.count <= resultByteLimit else { throw GuardianError("FILE_OUTPUT_TOO_LARGE") }
    bytes.append(10)
    try FileHandle.standardOutput.write(contentsOf: bytes)
} catch { watchdog.finish(); exit(70) }
watchdog.finish()
exit(exitStatus)
