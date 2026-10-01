import AppKit
import Foundation

// Compile the production Swift callbacks, replacing only AppKit display ports.
// No GUI, Bridge config, pairing, Core, network or filesystem selection is used.
final class PickerFixtureApplication {
    var mainMenu: NSMenu?
    func activate(ignoringOtherApps: Bool) {}
    func terminate(_ sender: Any?) {}
    func reply(toApplicationShouldTerminate: Bool) {}
}
let NSApp = PickerFixtureApplication()

final class PickerFixturePanel {
    static var panels: [PickerFixturePanel] = []
    var canChooseFiles = false
    var canChooseDirectories = false
    var allowsMultipleSelection = false
    var directoryURL: URL?
    var url: URL?
    var prompt = ""
    var message = ""
    var cancelCalls = 0
    var cancelCompletesSynchronously = true
    private var completion: ((NSApplication.ModalResponse) -> Void)?
    init() { Self.panels.append(self) }
    func begin(completionHandler: @escaping (NSApplication.ModalResponse) -> Void) {
        completion = completionHandler
    }
    func cancel(_ sender: Any?) {
        cancelCalls += 1
        if cancelCompletesSynchronously { complete(.cancel) }
    }
    func complete(_ response: NSApplication.ModalResponse) {
        completion?(response)
    }
}
typealias NSOpenPanel = PickerFixturePanel

// PRODUCTION_APP_INSERT

enum PickerFixtureError: Error { case failed(String) }
private func require(_ value: @autoclosure () -> Bool, _ reason: String) throws {
    if !value() { throw PickerFixtureError.failed(reason) }
}

extension RiceBridgeApp {
    func verifyPickerOwnership() throws {
        // send() must retain its real child/readiness guard. A bounded, owned
        // sleep process supplies only isRunning; requests stay in the test Pipe.
        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/bin/sleep")
        child.arguments = ["30"]
        child.standardInput = FileHandle.nullDevice
        child.standardOutput = FileHandle.nullDevice
        child.standardError = FileHandle.nullDevice
        try child.run()
        process = child
        coreReady = true
        defer {
            child.terminate()
            child.waitUntilExit()
        }

        chooseFile(pickerId: "server-sync", root: "/private/synthetic")
        let synchronous = PickerFixturePanel.panels.last!
        consume(["type": "pickerCancel", "pickerId": "server-sync"])
        try require(synchronous.cancelCalls == 1, "server cancel must close the owned panel")
        try require(filePicker == nil, "server cancel must release panel ownership")
        try require(callbacks.isEmpty, "server cancel completion must not send a stale picker request")

        chooseFile(pickerId: "server-delayed", root: "/private/synthetic")
        let delayed = PickerFixturePanel.panels.last!
        delayed.cancelCompletesSynchronously = false
        consume(["type": "pickerCancel", "pickerId": "server-delayed"])
        try require(filePicker == nil, "ownership must clear before the delayed callback")
        chooseFile(pickerId: "next-picker", root: "/private/synthetic")
        let next = PickerFixturePanel.panels.last!
        delayed.complete(.cancel)
        delayed.url = URL(fileURLWithPath: "/private/synthetic/stale.xlsx")
        delayed.complete(.OK)
        consume(["type": "pickerCancel", "pickerId": "server-delayed"])
        try require(filePicker?.id == "next-picker", "stale completion must not clear a newer panel")
        try require(next.cancelCalls == 0, "stale cancel must not close a newer panel")
        try require(callbacks.isEmpty, "stale completion must not emit IPC")

        next.complete(.cancel)
        try require(filePicker == nil && callbacks.count == 1, "user cancel must emit one owned response")
        let canceled = try JSONSerialization.jsonObject(with: input.fileHandleForReading.availableData) as! [String: Any]
        try require(canceled["type"] as? String == "picker" && canceled["pickerId"] as? String == "next-picker" && canceled["path"] is NSNull, "user cancel must send picker path null")
        consume(["type": "response", "id": canceled["id"]!, "ok": true])
        next.complete(.cancel)
        try require(callbacks.isEmpty, "a completed callback must not emit twice")

        chooseFile(pickerId: "confirmed-picker", root: "/private/synthetic")
        let confirmed = PickerFixturePanel.panels.last!
        confirmed.url = URL(fileURLWithPath: "/private/synthetic/中文 空格.xlsx")
        confirmed.complete(.OK)
        try require(filePicker == nil && callbacks.count == 1, "confirmed selection must emit one owned response")
        let selected = try JSONSerialization.jsonObject(with: input.fileHandleForReading.availableData) as! [String: Any]
        try require(selected["pickerId"] as? String == "confirmed-picker" && selected["path"] as? String == confirmed.url!.path, "confirmed selection must preserve the actual selected path")
        consume(["type": "response", "id": selected["id"]!, "ok": true])
        confirmed.complete(.OK)
        try require(callbacks.isEmpty, "duplicate confirmed callback must not emit IPC")
    }
}

do {
    try RiceBridgeApp().verifyPickerOwnership()
    print("native Swift picker ownership passed")
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(1)
}
