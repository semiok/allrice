import AppKit
import Foundation

// Presentation and child ownership only. Auth, policy, transport and execution
// remain in RiceBridgeCore. No loopback control server and no shell execution.
final class RiceBridgeApp: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem?
    private var process: Process?
    private let input = Pipe()
    private let output = Pipe()
    private let errors = Pipe()
    private var buffer = Data()
    private let readQueue = DispatchQueue(label: "xyz.bplabs.rice-bridge.protocol")
    private var state: [String: Any] = [:]
    private var sequence = -1
    private var callbacks: [String: ([String: Any]) -> Void] = [:]
    private var window: NSWindow?
    private var detail: NSTextView?
    private var quitting = false
    private var protocolFailed = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let bundle = Bundle.main.bundleIdentifier,
           let existing = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }) {
            existing.activate(options: [.activateIgnoringOtherApps])
            NSApp.terminate(nil)
            return
        }
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem?.button?.title = "Rice"
        refreshMenu()
        do { try startCore() } catch { fail("BRIDGE_START_FAILED") }
        showStatus()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showStatus()
        return false
    }

    private func startCore() throws {
        guard let resource = Bundle.main.resourceURL else { throw NSError(domain: "Bridge", code: 1) }
        let binary = resource.appendingPathComponent("RiceBridgeCore")
        let child = Process()
        child.executableURL = binary
        child.arguments = ["desktop"]
        child.currentDirectoryURL = resource
        var environment: [String: String] = [:]
        for key in ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG"] {
            environment[key] = ProcessInfo.processInfo.environment[key]
        }
        environment["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin"
        // A deliberately explicit acceptance mode for synthetic identities only.
        // Normal app launch never imports pairing secrets or feature flags.
        if CommandLine.arguments.contains("--acceptance") {
            for key in ["ALLRICE_BRIDGE_CONFIG_PATH", "ALLRICE_BRIDGE_DEVICE_TOKEN", "ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED", "ALLRICE_BRIDGE_WSS_ENABLED"] {
                environment[key] = ProcessInfo.processInfo.environment[key]
            }
        }
        child.environment = environment
        child.standardInput = input
        child.standardOutput = output
        child.standardError = errors
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let bytes = handle.availableData
            guard !bytes.isEmpty else { handle.readabilityHandler = nil; return }
            self?.readQueue.async { self?.receive(bytes) }
        }
        // Legacy stderr may contain remote error text. Drain but never display,
        // persist or include it in diagnostics. Core emits allowlisted codes.
        errors.fileHandleForReading.readabilityHandler = { handle in
            if handle.availableData.isEmpty { handle.readabilityHandler = nil }
        }
        child.terminationHandler = { [weak self] terminated in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.process = nil
                self.callbacks.removeAll()
                if self.quitting {
                    if terminated.terminationReason == .exit && terminated.terminationStatus == 0 {
                        NSApp.reply(toApplicationShouldTerminate: true)
                    } else {
                        self.quitting = false
                        self.fail("DESKTOP_STOP_UNCONFIRMED")
                        NSApp.reply(toApplicationShouldTerminate: false)
                        self.showError("DESKTOP_STOP_UNCONFIRMED")
                    }
                }
                else { self.fail("BRIDGE_STOPPED"); self.refreshMenu() }
            }
        }
        process = child
        try child.run()
    }

    private func receive(_ bytes: Data) {
        guard !protocolFailed else { return }
        buffer.append(bytes)
        if buffer.count > 131_072 { protocolFailure(); return }
        while let newline = buffer.firstIndex(of: 10) {
            let line = buffer[..<newline]
            buffer.removeSubrange(...newline)
            guard line.count <= 32_768,
                  let object = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any],
                  object["v"] as? Int == 1,
                  let type = object["type"] as? String,
                  ["state", "response", "picker", "fatal", "protocolError"].contains(type) else {
                protocolFailure(); return
            }
            DispatchQueue.main.async { self.consume(object) }
        }
        if buffer.count > 32_768 { protocolFailure() }
    }

    private func protocolFailure() {
        protocolFailed = true
        DispatchQueue.main.async {
            self.fail("BRIDGE_PROTOCOL_INVALID")
            // Closing the private input makes core stop through its normal path.
            try? self.input.fileHandleForWriting.close()
        }
    }

    private func consume(_ object: [String: Any]) {
        switch object["type"] as? String {
        case "state":
            guard let nextSequence = object["sequence"] as? Int, nextSequence > sequence,
                  let next = object["state"] as? [String: Any] else { return }
            sequence = nextSequence
            state = next
            refreshMenu()
        case "response":
            guard let id = object["id"] as? String else { return }
            let callback = callbacks.removeValue(forKey: id)
            callback?(object)
        case "picker":
            guard let id = object["pickerId"] as? String, id.count <= 80 else { return }
            chooseFolder(pickerId: id)
        case "fatal", "protocolError":
            fail(safeCode(object["code"]))
        default: break
        }
    }

    private func send(_ type: String, fields: [String: Any] = [:], completion: (([String: Any]) -> Void)? = nil) {
        guard process?.isRunning == true, callbacks.count < 32 else { fail("BRIDGE_NOT_RUNNING"); return }
        let id = UUID().uuidString
        var object = fields
        object["v"] = 1; object["id"] = id; object["type"] = type
        do {
            let bytes = try JSONSerialization.data(withJSONObject: object)
            guard bytes.count <= 16_384 else { throw NSError(domain: "Bridge", code: 2) }
            if let completion = completion { callbacks[id] = completion }
            try input.fileHandleForWriting.write(contentsOf: bytes + Data([10]))
        } catch { callbacks.removeValue(forKey: id); fail("BRIDGE_PIPE_UNAVAILABLE") }
    }

    private func action(_ type: String, fields: [String: Any] = [:]) {
        send(type, fields: fields) { response in
            if response["ok"] as? Bool != true { self.showError(self.safeCode(response["code"])) }
        }
    }

    private func safeCode(_ value: Any?) -> String {
        guard let code = value as? String, code.count <= 80,
              code.range(of: "^[A-Z0-9_]+$", options: .regularExpression) != nil else { return "BRIDGE_ACTION_FAILED" }
        return code
    }

    private func label(_ value: Any?, fallback: String) -> String {
        guard let text = value as? String else { return fallback }
        return String(text.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }.prefix(120))
    }

    private var title: String {
        switch state["mode"] as? String {
        case "unpaired": return "尚未配对"
        case "paused": return "已暂停 · 本地任务已停止"
        case "pausing": return "正在暂停并停止本地任务…"
        case "stopping": return "正在安全退出…"
        case "error": return "需要检查"
        default:
            switch state["connection"] as? String {
            case "online": return "Bridge 在线"
            case "offline": return "Bridge 离线 · 正在重连"
            default: return "正在连接…"
            }
        }
    }

    private func refreshMenu() {
        let menu = NSMenu()
        let status = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        menu.addItem(status)
        add(menu, "查看状态…", #selector(showStatus))
        menu.addItem(.separator())
        let paired = state["deviceId"] as? String != nil
        let busy = ["pausing", "stopping"].contains(state["mode"] as? String ?? "")
        add(menu, "配对设备…", #selector(pairDevice), enabled: !paired && !busy)
        add(menu, "选择工作区…", #selector(selectWorkspace), enabled: paired && !busy)
        if state["mode"] as? String == "paused" {
            add(menu, "恢复连接", #selector(resume), enabled: paired && !busy)
        } else { add(menu, "暂停并停止本地任务", #selector(pause), enabled: paired && !busy) }
        menu.addItem(.separator())
        add(menu, "诊断与日志…", #selector(diagnostics))
        add(menu, "撤销设备配对…", #selector(revokeDevice), enabled: paired && !busy)
        menu.addItem(.separator())
        add(menu, "退出 Rice Bridge", #selector(quit), enabled: !quitting)
        statusItem?.menu = menu
        statusItem?.button?.toolTip = title
        detail?.string = statusText()
    }

    private func add(_ menu: NSMenu, _ title: String, _ selector: Selector, enabled: Bool = true) {
        let item = NSMenuItem(title: title, action: selector, keyEquivalent: "")
        item.target = self; item.isEnabled = enabled
        menu.autoenablesItems = false
        menu.addItem(item)
    }

    private func statusText() -> String {
        let workspace = (state["workspaceLabels"] as? [String])?.last.map { label($0, fallback: "") } ?? "未选择工作区"
        let mode = state["mode"] as? String ?? ""
        let count = { (key: String) -> Int in max(0, min(1_000_000, self.state[key] as? Int ?? 0)) }
        let credential: String
        switch state["credentialStorage"] as? String {
        case "keychain": credential = "凭证保存：macOS Keychain"
        case "private-file": credential = state["credentialFileSecure"] as? Bool == true
            ? "Keychain 不可用，使用本机 0600 私有凭证文件（未加密）"
            : "Keychain 不可用，本机凭证文件权限需要检查（未加密）"
        case "environment": credential = "凭证来源：独立测试环境"
        default: credential = "凭证：尚未配对或暂不可读取"
        }
        var text = "\(title)\n\n设备：\(label(state["deviceName"], fallback: "未配对"))\n版本：\(label(state["version"], fallback: "—")) · \(label(state["architecture"], fallback: "—"))\n本地工作区：\(workspace)\n\n前台任务：\(count("activeForeground"))\n后台任务：\(count("activeServices"))\n待回传记录：\(count("pendingReceipts"))\n结果待核实：\(count("unknownOperations"))\n\n"
        text += "\(credential)\n\n在线不等于已授权命令执行；沙箱、员工权限和网页审批仍分别控制。\n暂停会停止本地任务，不会撤销已完成的文件修改。恢复不会自动重启旧服务。\n\n已有终端版请先正常退出，再使用菜单栏版；不要删除配对或执行日志。"
        let keychainReasons = [
            "interaction-not-allowed": "启动会话不允许钥匙串交互。请在 Mac 解锁后从 Finder 正常打开，再核验钥匙串权限；程序不会自动解锁或迁移凭证。",
            "item-not-found": "未找到该设备对应的钥匙串条目。现有配对仍可能使用私有文件保存；不要因此重新配对。",
            "timed-out": "钥匙串访问超时，已终止本次访问进程。现有配对和凭证文件会保留，请稍后检查。",
            "unavailable": "钥匙串访问未成功。现有配对和凭证文件会保留，请检查诊断；不要删除配置或重新配对。"
        ]
        if let reason = state["keychainUnavailableReason"] as? String, let explanation = keychainReasons[reason] {
            text += "\n\n最近凭证访问/保存记录：\(explanation)"
        }
        if state["credentialCleanupPending"] as? Bool == true {
            text += "\n\n此前解除配对已在服务端生效，但该次操作的旧凭证尚未清理完成。这不表示之后的新配对被撤销。请保留诊断记录；钥匙串与本机文件并未确认全部删除。"
        }
        if mode == "error", let error = state["errorCode"] { text += "\n\n诊断代码：\(safeCode(error))" }
        return text
    }

    @objc private func showStatus() {
        if window == nil {
            let next = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 460), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
            next.title = "Rice Bridge · 本地电脑"
            next.isReleasedWhenClosed = false
            let scroll = NSScrollView(frame: next.contentView!.bounds)
            scroll.autoresizingMask = [.width, .height]
            scroll.hasVerticalScroller = true
            let text = NSTextView(frame: scroll.bounds)
            text.isEditable = false
            text.isSelectable = true
            text.font = .systemFont(ofSize: 14)
            text.textContainerInset = NSSize(width: 20, height: 16)
            text.autoresizingMask = [.width]
            scroll.documentView = text
            next.contentView?.addSubview(scroll)
            detail = text; window = next
            next.center()
        }
        detail?.string = statusText()
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
        if CommandLine.arguments.contains("--acceptance"), let number = window?.windowNumber {
            try? FileHandle.standardOutput.write(contentsOf: Data("P13_WINDOW_ID=\(number)\n".utf8))
            // Test-only render of this app's own view. Not a desktop screenshot
            // and does not request or change Screen Recording permissions.
            if let argument = CommandLine.arguments.first(where: { $0.hasPrefix("--acceptance-render=") }),
               let content = window?.contentView {
                let path = String(argument.dropFirst("--acceptance-render=".count))
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                    guard let bitmap = content.bitmapImageRepForCachingDisplay(in: content.bounds) else { return }
                    content.cacheDisplay(in: content.bounds, to: bitmap)
                    if let bytes = bitmap.representation(using: .png, properties: [:]) {
                        try? bytes.write(to: URL(fileURLWithPath: path), options: .atomic)
                    }
                }
            }
        }
    }

    @objc private func pairDevice() {
        let alert = NSAlert()
        alert.messageText = "配对 Rice Bridge"
        alert.informativeText = "在你的 AllRice 网页生成配对码。配对会保存在此 Mac，以后无需重复输入。"
        alert.addButton(withTitle: "配对并连接"); alert.addButton(withTitle: "取消")
        let stack = NSStackView()
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 8
        let server = NSTextField(string: "https://allrice-dsh.bplabs.xyz")
        let code = NSTextField(string: "")
        code.placeholderString = "8 位配对码（有无横杠均可）"
        for (caption, field) in [("服务地址", server), ("配对码", code)] {
            stack.addArrangedSubview(NSTextField(labelWithString: caption))
            field.frame.size = NSSize(width: 350, height: 24)
            field.widthAnchor.constraint(equalToConstant: 350).isActive = true
            stack.addArrangedSubview(field)
        }
        stack.frame = NSRect(x: 0, y: 0, width: 350, height: 112)
        alert.accessoryView = stack
        NSApp.activate(ignoringOtherApps: true)
        if alert.runModal() == .alertFirstButtonReturn {
            action("pair", fields: ["server": server.stringValue.trimmingCharacters(in: .whitespacesAndNewlines), "code": code.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)])
        }
        code.stringValue = ""
    }

    @objc private func selectWorkspace() { chooseFolder(pickerId: nil) }
    private func chooseFolder(pickerId: String?) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false; panel.canChooseDirectories = true; panel.allowsMultipleSelection = false
        panel.prompt = "选择工作区"
        panel.message = "仅授权所选项目目录。切换前会停止本地任务，不会删除执行日志。"
        NSApp.activate(ignoringOtherApps: true)
        panel.begin { response in
            let path = response == .OK ? panel.url?.path : nil
            if let id = pickerId { self.action("picker", fields: ["pickerId": id, "path": path as Any? ?? NSNull()]) }
            else if let path = path { self.action("workspace", fields: ["path": path]) }
        }
    }

    @objc private func pause() { action("pause") }
    @objc private func resume() { action("resume") }
    @objc private func diagnostics() {
        send("diagnostics") { response in
            guard response["ok"] as? Bool == true, let data = response["data"] as? [String: Any],
                  let bytes = try? JSONSerialization.data(withJSONObject: data, options: [.prettyPrinted, .sortedKeys]) else { self.showError("BRIDGE_ACTION_FAILED"); return }
            let alert = NSAlert()
            alert.messageText = "Bridge 诊断与日志"
            alert.informativeText = "仅导出版本、状态、聚合计数和有限错误代码，不包含配对码、凭证、文件内容或完整本地路径。"
            alert.addButton(withTitle: "导出诊断…"); alert.addButton(withTitle: "关闭")
            let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 480, height: 260))
            scroll.hasVerticalScroller = true
            let text = NSTextView(frame: scroll.bounds)
            text.string = String(decoding: bytes, as: UTF8.self); text.isEditable = false
            text.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
            scroll.documentView = text; alert.accessoryView = scroll
            if alert.runModal() == .alertFirstButtonReturn {
                let panel = NSSavePanel(); panel.nameFieldStringValue = "RiceBridge-diagnostics.json"
                panel.begin { result in
                    guard result == .OK, let url = panel.url else { return }
                    do { try bytes.write(to: url, options: .atomic); try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path) }
                    catch { self.showError("DIAGNOSTICS_EXPORT_FAILED") }
                }
            }
        }
    }

    @objc private func revokeDevice() {
        guard let id = state["deviceId"] as? String else { return }
        let alert = NSAlert(); alert.messageText = "撤销这台设备的配对？"
        alert.informativeText = "会先停止本地任务，再向服务器撤销。服务器离线时不会假报已撤销；原执行日志始终保留。"
        alert.addButton(withTitle: "撤销配对"); alert.addButton(withTitle: "取消")
        if alert.runModal() == .alertFirstButtonReturn { action("revoke", fields: ["confirmDeviceId": id]) }
    }

    private func fail(_ code: String) {
        state["mode"] = "error"; state["errorCode"] = code
        refreshMenu()
    }
    private func showError(_ code: String) {
        let alert = NSAlert(); alert.messageText = "操作未完成"
        let explanations = [
            "DESKTOP_PAIRING_CODE_INVALID": "请输入网页生成的 8 位配对码；中间横杠可带可不带。",
            "DESKTOP_SERVER_INVALID": "请填写 HTTPS 服务地址，不包含用户名、密码或额外路径。",
            "DESKTOP_CREDENTIAL_UNAVAILABLE": "本机已有配对，但凭证暂不可读。请检查 Keychain，不要重新配对或删除配置。",
            "DESKTOP_REVOKED_CLEANUP_PENDING": "此前解除配对已在服务端生效，但旧凭证或配置尚未完全清理；不代表之后的新配对被撤销。请保留诊断记录，不要使用旧令牌重试撤销。",
            "DESKTOP_CONFIG_INVALID": "本机配置无法安全读取，请保留原文件并检查诊断。",
            "DESKTOP_STOP_UNCONFIRMED": "核心未能确认安全停止，不能显示已暂停或已完成退出。请保留配对与执行日志，检查本机沙箱和诊断后再处理。",
            "BRIDGE_ALREADY_RUNNING": "另一份 Bridge 正在使用当前配置。请先正常退出旧终端版或切回现有菜单栏应用。",
            "BRIDGE_WORKSPACE_CONTAINS_STATE": "请选择具体项目目录，不要选择包含 Bridge 配对或执行日志的上级目录。",
            "DESKTOP_ALREADY_PAIRED": "这台设备已经配对；如需更换租户，请先正常撤销当前配对。"
        ]
        alert.informativeText = "\(explanations[code] ?? "请确认网络和配对码有效；服务器未确认的操作不会显示成功。")\n\n诊断代码：\(code)\n原配对和执行证据不会通过重试或清缓存自动删除。"
        alert.runModal()
    }
    @objc private func quit() { NSApp.terminate(nil) }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard process?.isRunning == true else { return .terminateNow }
        if !quitting {
            quitting = true
            state["mode"] = "stopping"; refreshMenu()
            send("stop")
        }
        return .terminateLater
    }
}

let application = NSApplication.shared
let delegate = RiceBridgeApp()
application.delegate = delegate
application.setActivationPolicy(.accessory)
application.run()
