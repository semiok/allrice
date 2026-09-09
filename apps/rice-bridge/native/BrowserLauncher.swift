import Foundation
import Darwin
import Security

// Fixed P22 native launcher. It owns the real Chrome PID/process group; the
// model, remote API and page never choose an executable, shell, profile or port.
let engine = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
let originalParent = getppid()
let arguments = Array(CommandLine.arguments.dropFirst())
let rootArguments = arguments.filter { $0.hasPrefix("--allrice-browser-watchdog=") }
func fail() -> Never { fputs("LOCAL_BROWSER_LAUNCHER_DENIED\n", stderr); exit(70) }
guard originalParent > 1, rootArguments.count == 1 else { fail() }
let root = String(rootArguments[0].dropFirst("--allrice-browser-watchdog=".count))
// Foundation standardization rewrites an existing /private/var path to /var
// on macOS. Validate lexical components instead; lstat+inode below verify the
// actual owned directory and retain that exact identity throughout execution.
let rootComponents = root.split(separator: "/", omittingEmptySubsequences: false)
guard root.hasPrefix("/"), rootComponents.count > 2,
      rootComponents.dropFirst().allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }),
      rootComponents.last?.hasPrefix("allrice-browser-") == true,
      !root.contains("\0") else { fail() }
var rootStat = stat()
guard lstat(root, &rootStat) == 0, (rootStat.st_mode & S_IFMT) == S_IFDIR,
      rootStat.st_uid == getuid(), (rootStat.st_mode & 0o7777) == 0o700 else { fail() }
func sameRoot() -> Bool {
    var current = stat()
    return lstat(root, &current) == 0 && current.st_dev == rootStat.st_dev && current.st_ino == rootStat.st_ino
      && (current.st_mode & S_IFMT) == S_IFDIR && current.st_uid == getuid() && (current.st_mode & 0o7777) == 0o700
}
func privateObject(_ filename: String) -> [String: Any]? {
    guard sameRoot() else { return nil }
    let fd = open(root + "/" + filename, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
    guard fd >= 0 else { return nil }
    defer { close(fd) }
    var before = stat()
    guard fstat(fd, &before) == 0, (before.st_mode & S_IFMT) == S_IFREG,
          before.st_uid == getuid(), (before.st_mode & 0o7777) == 0o600,
          before.st_nlink == 1, before.st_size > 0, before.st_size <= 4096 else { return nil }
    var bytes = [UInt8](repeating: 0, count: 4097)
    let count = read(fd, &bytes, bytes.count)
    var after = stat()
    guard count == before.st_size, fstat(fd, &after) == 0,
          before.st_ino == after.st_ino, before.st_dev == after.st_dev,
          before.st_size == after.st_size,
          before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec,
          before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec, sameRoot() else { return nil }
    return (try? JSONSerialization.jsonObject(with: Data(bytes.prefix(count)))) as? [String: Any]
}
let nowMs: () -> Double = { Date().timeIntervalSince1970 * 1000 }
guard let initial = privateObject("lease.json"),
      initial["version"] as? Int == 1,
      initial["parentPid"] as? Int == Int(originalParent),
      let nonce = initial["nonce"] as? String, UUID(uuidString: nonce) != nil,
      let proxyPort = initial["proxyPort"] as? Int, proxyPort > 1023, proxyPort <= 65535 else { fail() }
func validLease() -> Bool {
    guard getppid() == originalParent, kill(originalParent, 0) == 0,
          let value = privateObject("lease.json"), value["version"] as? Int == 1,
          value["parentPid"] as? Int == Int(originalParent), value["nonce"] as? String == nonce,
          value["proxyPort"] as? Int == proxyPort, value["stop"] as? Bool == false,
          let expiry = value["expiresAt"] as? Double,
          Set(value.keys) == Set(["version", "parentPid", "nonce", "proxyPort", "stop", "expiresAt"]),
          expiry > nowMs(), expiry <= nowMs() + 5500 else { return false }
    return true
}
guard validLease(), fcntl(3, F_GETFD) >= 0, fcntl(4, F_GETFD) >= 0 else { fail() }

let fixedFlags = Set([
    "--disable-field-trial-config", "--disable-background-networking", "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows", "--disable-back-forward-cache", "--disable-breakpad",
    "--disable-client-side-phishing-detection", "--disable-component-extensions-with-background-pages",
    "--disable-component-update", "--no-default-browser-check", "--disable-default-apps", "--disable-dev-shm-usage",
    "--disable-edgeupdater", "--disable-extensions", "--allow-pre-commit-input", "--disable-hang-monitor",
    "--disable-ipc-flooding-protection", "--disable-popup-blocking", "--disable-prompt-on-repost",
    "--disable-renderer-backgrounding", "--disable-updater-scheduler", "--force-color-profile=srgb",
    "--metrics-recording-only", "--no-first-run", "--password-store=basic", "--use-mock-keychain",
    "--no-service-autorun", "--export-tagged-pdf", "--disable-search-engine-choice-screen",
    "--unsafely-disable-devtools-self-xss-warnings", "--edge-skip-compat-layer-relaunch", "--disable-infobars",
    "--disable-sync", "--enable-unsafe-swiftshader", "--headless", "--hide-scrollbars", "--mute-audio",
    "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
    "--enable-features=CDPScreenshotNewSurface", "--disable-quic",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", "--proxy-bypass-list=<-loopback>",
    "--remote-debugging-pipe", "--no-startup-window", "about:blank"
])
let disabledFeatures = Set([
    "AvoidUnnecessaryBeforeUnloadCheckSync", "BoundaryEventDispatchTracksNodeRemoval", "DestroyProfileOnBrowserClose",
    "DialMediaRouteProvider", "GlobalMediaControls", "HttpsUpgrades", "LensOverlay", "MediaRouter", "PaintHolding",
    "ThirdPartyStoragePartitioning", "BlockOriginHeaderModificationOnRedirect", "Translate", "AutoDeElevate",
    "OptimizationHints", "msForceBrowserSignIn", "msEdgeUpdateLaunchServicesPreferredVersion", "DnsOverHttps",
    "AutofillServerCommunication"
])
let chromeArguments = arguments.filter { !$0.hasPrefix("--allrice-browser-watchdog=") }
guard chromeArguments.count < 100, chromeArguments.allSatisfy({ argument in
    if argument.utf8.count > 4096 || argument.contains("\0") { return false }
    if fixedFlags.contains(argument) { return true }
    if argument == "--user-data-dir=" + root + "/profile" { return true }
    if argument == "--proxy-server=http://127.0.0.1:" + String(proxyPort) { return true }
    if argument.hasPrefix("--disable-features=") {
        let features = String(argument.dropFirst("--disable-features=".count)).split(separator: ",").map(String.init)
        return !features.isEmpty && features.allSatisfy { disabledFeatures.contains($0) }
    }
    return false
}), chromeArguments.filter({ $0.hasPrefix("--user-data-dir=") }).count == 1,
    chromeArguments.filter({ $0.hasPrefix("--proxy-server=") }).count == 1,
    chromeArguments.contains("--remote-debugging-pipe"), chromeArguments.contains("--disable-quic"),
    chromeArguments.contains("--proxy-bypass-list=<-loopback>"),
    chromeArguments.contains("--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1") else { fail() }

// Validate executable code identity. Finder metadata/resources are intentionally
// excluded; this is not a claim of whole-bundle resource verification.
var code: SecStaticCode?
var requirement: SecRequirement?
guard SecStaticCodeCreateWithPath(URL(fileURLWithPath: engine) as CFURL, SecCSFlags(), &code) == errSecSuccess,
      SecRequirementCreateWithString("anchor apple generic and identifier \"com.google.Chrome\" and certificate leaf[subject.OU] = \"EQHXZ8M8AV\"" as CFString, SecCSFlags(), &requirement) == errSecSuccess,
      let actualCode = code, let actualRequirement = requirement,
      SecStaticCodeCheckValidity(actualCode, SecCSFlags(rawValue: kSecCSDoNotValidateResources), actualRequirement) == errSecSuccess,
      validLease() else { fail() }
var engineStat = stat()
guard lstat(engine, &engineStat) == 0, (engineStat.st_mode & S_IFMT) == S_IFREG,
      (engineStat.st_mode & 0o002) == 0 else { fail() }

func writeStatus(_ value: [String: Any]) -> Bool {
    guard sameRoot(), let bytes = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return false }
    let temporary = root + "/.status-" + UUID().uuidString
    let fd = open(temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard fd >= 0 else { return false }
    let written = bytes.withUnsafeBytes { write(fd, $0.baseAddress, bytes.count) }
    let synced = fsync(fd) == 0
    close(fd)
    guard written == bytes.count, synced, sameRoot() else { unlink(temporary); return false }
    var previous = stat()
    let target = root + "/process.json"
    if lstat(target, &previous) == 0 && ((previous.st_mode & S_IFMT) != S_IFREG || previous.st_uid != getuid() || (previous.st_mode & 0o7777) != 0o600 || previous.st_nlink != 1) {
        unlink(temporary); return false
    }
    return rename(temporary, target) == 0
}
var attr: posix_spawnattr_t?
var actions: posix_spawn_file_actions_t?
guard posix_spawnattr_init(&attr) == 0, posix_spawn_file_actions_init(&actions) == 0 else { fail() }
defer { posix_spawnattr_destroy(&attr); posix_spawn_file_actions_destroy(&actions) }
posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETPGROUP))
posix_spawnattr_setpgroup(&attr, 0)
posix_spawn_file_actions_adddup2(&actions, 3, 3)
posix_spawn_file_actions_adddup2(&actions, 4, 4)
let argv = ([engine] + chromeArguments).map { strdup($0) } + [nil]
defer { for value in argv { free(value) } }
let environment = ProcessInfo.processInfo.environment
let allowedEnvironment = ["HOME", "TMPDIR", "PATH", "LANG"]
guard environment["HOME"] == root, environment["TMPDIR"] == root,
      environment["PATH"] == "/usr/bin:/bin:/usr/sbin:/sbin" else { fail() }
let envp = allowedEnvironment.compactMap { name in environment[name].map { strdup(name + "=" + $0) } } + [nil]
defer { for value in envp { free(value) } }
var profileStat = stat()
guard lstat(root + "/profile", &profileStat) == 0,
      (profileStat.st_mode & S_IFMT) == S_IFDIR, profileStat.st_uid == getuid(),
      (profileStat.st_mode & 0o7777) == 0o700 else { fail() }
var child: pid_t = 0
// The supervisor catches termination long enough to reap its actual child. It
// never signals a PID found via global process enumeration or a user input.
var requestedStop: Int32 = 0
signal(SIGTERM) { _ in requestedStop = 1 }
signal(SIGINT) { _ in requestedStop = 1 }
signal(SIGHUP) { _ in requestedStop = 1 }
guard requestedStop == 0, validLease(),
      posix_spawn(&child, engine, &actions, &attr, argv, envp) == 0,
      child > 1 else { fail() }
let started = nowMs()
var childStatus: Int32 = 0
var reaped = false
var forced = false
if !writeStatus(["version": 1, "nonce": nonce, "helperPid": Int(getpid()), "parentPid": Int(originalParent), "childPid": Int(child), "startedAt": started, "stopped": false]) {
    kill(-child, SIGKILL)
}
while true {
    let result = waitpid(child, &childStatus, WNOHANG)
    if result == child { reaped = true; break }
    if result < 0 || requestedStop != 0 || !validLease() { break }
    usleep(50_000)
}
if !reaped {
    kill(-child, SIGTERM)
    let deadline = nowMs() + 300
    while nowMs() < deadline {
        if waitpid(child, &childStatus, WNOHANG) == child { reaped = true; break }
        usleep(25_000)
    }
}
// Even after root exit, only this spawned process group's remaining descendants
// may be signalled; we do not enumerate or touch any other Chrome instance.
if kill(-child, 0) == 0 {
    forced = true
    kill(-child, SIGKILL)
}
if !reaped {
    let deadline = nowMs() + 2000
    while nowMs() < deadline {
        if waitpid(child, &childStatus, WNOHANG) == child { reaped = true; break }
        usleep(25_000)
    }
}
let groupDeadline = nowMs() + 2000
while kill(-child, 0) == 0 && nowMs() < groupDeadline { usleep(25_000) }
let confirmed = reaped && kill(-child, 0) == -1 && errno == ESRCH
let recorded = writeStatus(["version": 1, "nonce": nonce, "helperPid": Int(getpid()), "parentPid": Int(originalParent),
    "childPid": Int(child), "startedAt": started, "stopped": confirmed, "exitStatus": Int(childStatus), "forced": forced])
exit(confirmed && recorded ? 0 : 71)
