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
        if let argument = CommandLine.arguments.first(where: { $0.hasPrefix("--update-health-id=") }) {
            let id = String(argument.dropFirst("--update-health-id=".count))
            guard id.range(of: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$", options: .regularExpression) != nil else { throw NSError(domain: "Bridge", code: 3) }
            environment["ALLRICE_BRIDGE_UPDATE_HEALTH_ID"] = id
        }
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
        case "draining": return "正在等待已领取任务结束 · 不再领取新任务"
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
        let busy = ["pausing", "stopping", "draining"].contains(state["mode"] as? String ?? "")
        add(menu, "配对设备…", #selector(pairDevice), enabled: !paired && !busy)
        add(menu, "选择工作区…", #selector(selectWorkspace), enabled: paired && !busy)
        add(menu, state["browserEnabled"] as? Bool == true ? "关闭独立浏览器…" : "启用独立浏览器…", #selector(toggleBrowser), enabled: paired && !busy)
        add(menu, state["previewEnabled"] as? Bool == true ? "关闭项目预览…" : "启用项目预览…", #selector(togglePreview), enabled: paired && !busy)
        if state["mode"] as? String == "paused" {
            add(menu, "恢复连接", #selector(resume), enabled: paired && !busy)
        } else { add(menu, "暂停并停止本地任务", #selector(pause), enabled: paired && !busy) }
        menu.addItem(.separator())
        add(menu, "诊断与日志…", #selector(diagnostics))
        if (state["environment"] as? [String: Any])?["browser"] as? String == "unavailable" {
            add(menu, "安装或更新 Chrome…", #selector(installChrome), enabled: !busy)
        }
        add(menu, "重新检查并准备环境", #selector(prepareEnvironment), enabled: paired && !busy)
        add(menu, "检查可信更新…", #selector(updateStatus))
        add(menu, "等待任务结束并暂停…", #selector(drainTasks), enabled: paired && !busy)
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
        text += "\(credential)\n\n配对后自动准备可用能力；需要选择目录或批准具体操作时，会在当前任务中提示。\n暂停会停止本地任务，不会撤销已完成的文件修改。恢复不会自动重启旧服务。\n\n已有终端版请先正常退出，再使用菜单栏版；不要删除配对或执行日志。"
        text += "\n\n独立浏览器：\(state["browserEnabled"] as? Bool == true ? "自动准备已开启" : "已主动暂停")。使用 Chromium 自身沙箱，不是命令的 Linux VM，不读取个人 Chrome。"
        if let environment = state["environment"] as? [String: Any] {
            let labels = ["ready": "可用", "preparing": "正在准备", "paused": "已暂停", "unavailable": "暂不可用，可重新检查"]
            for (key, name) in [("browser", "独立浏览器"), ("sandbox", "本地计算"), ("preview", "项目预览")] {
                text += "\n\(name)：\(labels[environment[key] as? String ?? ""] ?? "等待检查")"
            }
            if environment["sandbox"] as? String == "unavailable" {
                text += "\n通用计算可交给云端处理。本地项目服务需要本机运行环境；文件读取与独立浏览器可继续使用。"
            }
        }
        let update = state["update"] as? [String: Any]
        let updateLabels = ["not-checked": "尚未检查", "trust-unconfigured": "发布者尚未配置，请等待管理员提供受信构建", "checking": "正在检查", "available": "发现已认证的新版本，请从菜单确认", "downloading": "正在下载并验证", "waiting-for-drain": "正在等待任务结束", "restarting": "正在正常退出并交接更新", "recovery-required": "上次更新未完成，请从检查可信更新菜单恢复", "rolled-back": "已恢复旧版本，请等待修正版", "no-newer-release": "暂无更高版本"]
        text += "\n\n可信更新：\(updateLabels[update?["state"] as? String ?? ""] ?? "尚未检查")。更新不迁移或删除凭证；必须通过发布者认证与 Apple 检查。"
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

    @objc private func updateStatus() {
        send("updateStatus") { response in
            guard response["ok"] as? Bool == true else { self.showError(self.safeCode(response["code"])); return }
            let alert = NSAlert()
            let data = response["data"] as? [String: Any]
            let available = data?["canInstall"] as? Bool == true
            let recover = data?["canRecover"] as? Bool == true
            alert.messageText = available ? "发现可信更新 \(self.label(data?["version"], fallback: ""))" : (recover ? "上次更新尚未完成" : "可信更新")
            if available {
                alert.informativeText = "更新至用户 Applications/AllRice Bridge 专用目录。将停止领取任务并等待已有任务结束，正常退出后验证与安装，再重新打开；启动失败会恢复旧版本。不会删除或迁移现有配对、凭证、工作区和执行日志。独立浏览器与预览需先明确关闭。"
                alert.addButton(withTitle: "更新并重新打开"); alert.addButton(withTitle: "稍后")
            } else if recover {
                alert.informativeText = "候选尚未确认健康，不会领取新任务。恢复会保留失败包与日志，并重新打开之前的兼容版本；不会重新配对或更改凭证。"
                alert.addButton(withTitle: "恢复上次版本"); alert.addButton(withTitle: "稍后")
            } else {
                alert.informativeText = data?["state"] as? String == "trust-unconfigured"
                    ? "此构建尚未配置受信发布者。请等待管理员提供已签名、公证并验证的正式更新；不要关闭 Gatekeeper，也不要删除配对、凭证或执行日志。现有应用继续可用。"
                    : (data?["state"] as? String == "rolled-back" ? "上次候选未通过启动健康确认，已回退并保留失败包和日志。当前没有更高版本的已认证更新；配对与凭证未迁移。请向管理员报告并等待修正版。" : "没有更高版本的已认证更新。此检查不改变当前应用、配对或权限。")
                alert.addButton(withTitle: "知道了")
            }
            NSApp.activate(ignoringOtherApps: true)
            if alert.runModal() == .alertFirstButtonReturn && (available || recover) {
                self.send(recover ? "recoverUpdate" : "installUpdate", fields: recover ? [:] : ["version": data?["version"] as? String ?? ""]) { result in
                    if result["ok"] as? Bool == true, (result["data"] as? [String: Any])?["restart"] as? Bool == true { NSApp.terminate(nil) }
                    else { self.showError(self.safeCode(result["code"])) }
                }
            }
        }
    }

    @objc private func drainTasks() {
        let alert = NSAlert()
        alert.messageText = "等待任务结束后暂停连接？"
        alert.informativeText = "停止领取新任务，等待已领取任务和后台服务自然结束，不强制取消。浏览器与项目预览会一起等待结束，无需手动关闭功能。等待期间仍可安全退出；退出会走原有停止流程。"
        alert.addButton(withTitle: "等待结束并暂停"); alert.addButton(withTitle: "取消")
        if alert.runModal() == .alertFirstButtonReturn { action("drain") }
    }
    @objc private func togglePreview() {
        let enabled = state["previewEnabled"] as? Bool != true
        let alert = NSAlert()
        alert.messageText = enabled ? "启用项目预览？" : "关闭项目预览？"
        alert.informativeText = "切换前会先停止本地任务。预览随独立浏览器与本地沙箱自动准备；运行项目服务时在当前任务内批准。预览使用独立浏览器，不开放本机端口、公共网址或主站身份。不会自动重启旧服务。"
        alert.addButton(withTitle: enabled ? "启用" : "关闭")
        alert.addButton(withTitle: "取消")
        NSApp.activate(ignoringOtherApps: true)
        if alert.runModal() == .alertFirstButtonReturn { action("preview", fields: ["enabled": enabled]) }
    }
    @objc private func toggleBrowser() {
        let enabled = state["browserEnabled"] as? Bool != true
        let alert = NSAlert()
        alert.messageText = enabled ? "启用独立浏览器？" : "关闭独立浏览器？"
        alert.informativeText = "更改前会先停止本地任务，再恢复原有连接；已结束的服务不会自动重启。\n\n独立浏览器不使用个人 Chrome 的登录或标签页，不自动安装浏览器、不开放宿主 Shell。配对后的网页使用关系自动准备，敏感动作在当前任务中批准。关闭不等于撤销已保存的站点登录资料；请在网页撤销对应授权并确认清理。"
        alert.addButton(withTitle: enabled ? "启用独立浏览器" : "关闭独立浏览器")
        alert.addButton(withTitle: "取消")
        NSApp.activate(ignoringOtherApps: true)
        if alert.runModal() == .alertFirstButtonReturn { action("browser", fields: ["enabled": enabled]) }
    }
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

    @objc private func installChrome() { NSWorkspace.shared.open(URL(string: "https://www.google.com/chrome/")!) }
    @objc private func prepareEnvironment() { action("prepare") }
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
            "UPDATE_DRAIN_BROWSER_ACTIVE": "请先从菜单明确关闭独立浏览器和项目预览，再重新检查更新。更新不会代替你强制停止浏览器任务。",
            "UPDATE_DRAIN_UNCONFIRMED": "仍有活跃任务、未知执行或无法安全读取的日志，尚不能更新。请检查任务与诊断并等待停止确认；不要清空执行日志或强制覆盖应用。",
            "UPDATE_TRUST_UNCONFIGURED": "此构建尚未配置受信发布者。请等待管理员提供经过签名与公证的构建；不要粘贴来历不明的公钥或关闭系统保护。",
            "UPDATE_CHECK_REQUIRED": "请重新从菜单检查可信更新，再确认显示的精确版本。",
            "UPDATE_RECOVERY_REQUIRED": "上次更新尚未完成。请从检查可信更新菜单查看恢复状态，保留原安装目录、失败包与执行日志。",
            "UPDATE_APPLE_VERIFICATION_FAILED": "Apple 发布者签名、公证票据或系统检查未通过，候选未获准安装。请向管理员报告诊断代码，不要关闭 Gatekeeper 或移除隔离标记。",
            "UPDATE_STORAGE_REVIEW": "已保留多次更新下载和恢复证据。请让管理员先检查专用安装目录；应用不会自动删除失败包或回退版本。",
            "UPDATE_NATIVE_APP_REQUIRED": "可信更新需要管理员提供的原生签名 App，不能从源码、环境注入凭证或任意命令包启动。现有配对不需要删除。",
            "BRIDGE_ALREADY_RUNNING": "另一份 Bridge 正在使用当前配置。请先正常退出旧终端版或切回现有菜单栏应用。",
            "BRIDGE_WORKSPACE_CONTAINS_STATE": "请选择具体项目目录，不要选择包含 Bridge 配对或执行日志的上级目录。",
            "DESKTOP_ALREADY_PAIRED": "这台设备已经配对；如需更换租户，请先正常撤销当前配对。"
        ]
        let fallback = code.hasPrefix("UPDATE_") ? "可信更新未完成或尚不能确认。请保留原应用、配对、失败包与日志，向管理员提供诊断代码；不要重新配对、强制覆盖应用或关闭系统安全保护。" : "请确认网络和配对码有效；服务器未确认的操作不会显示成功。"
        alert.informativeText = "\(explanations[code] ?? fallback)\n\n诊断代码：\(code)\n原配对和执行证据不会通过重试或清缓存自动删除。"
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
