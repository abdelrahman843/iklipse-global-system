import AppKit
import ServiceManagement
import UserNotifications
import WebKit

/// Where iklipse is, and this build's number (the app compares it to find updates).
enum Config {
    static let appURL = URL(string: "https://abdelrahman843.github.io/iklipse-global-system/")!
    static let filesHost = "larhrofldblegktowhdw.supabase.co"
    static let api = URL(string: "https://larhrofldblegktowhdw.supabase.co/functions/v1/apps")!
    static let code = Int(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "") ?? 1
    static let name = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0.\(code)"
    static let background = NSColor(srgbRed: 6 / 255, green: 8 / 255, blue: 11 / 255, alpha: 1)
}

/// The page an iklipse:// link is for (nil: not one of ours).
/// iklipse://back?to=/connections?calendly=connected is the way back after
/// connecting an account in the browser (public/back.html).
func pageOf(_ link: URL) -> URL? {
    guard link.scheme == "iklipse", link.host == "back" else { return nil }
    var to = URLComponents(url: link, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "to" })?.value
    if to == nil || !to!.hasPrefix("/") || to!.hasPrefix("//") { to = "/connections" }
    return URL(string: Config.appURL.absoluteString + "#" + to!)
}

/// iklipse in a window, kept running in the menu bar. The page talks to it with
/// messages (src/lib/nativeApp.ts): "token" (for updates), "notify", "ring"
/// (comes to the front, on top, while Ikli calls), "info", "update".
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate,
    WKScriptMessageHandler, WKDownloadDelegate, UNUserNotificationCenterDelegate
{
    var window: NSWindow!
    var web: WKWebView!
    var tray: NSStatusItem!
    var updater: Updater!
    /// The signed-in person's login (the downloads are for the team only).
    var token: String?
    var ringing = false
    var attention: Int?
    var loaded = false
    var pending: URL?
    var awake: NSObjectProtocol?
    var downloads: [ObjectIdentifier: URL] = [:]

    // ------------------------------------------------------------------ start --

    func applicationDidFinishLaunching(_ note: Notification) {
        // Started at login, or again after an update: straight to the menu bar.
        let event = NSAppleEventManager.shared().currentAppleEvent
        let atLogin = event?.eventID == UInt32(kAEOpenApplication)
            && event?.paramDescriptor(forKeyword: AEKeyword(keyAEPropData))?.enumCodeValue == OSType(keyAELaunchedAsLogInItem)
        let hidden = atLogin || CommandLine.arguments.contains("--hidden")

        // Pages behind a closed window keep running: calls and notifications still arrive.
        awake = ProcessInfo.processInfo.beginActivity(options: [.userInitiatedAllowingIdleSystemSleep], reason: "Notifications and Ikli's calls")

        buildMenu()
        buildWindow()
        buildTray()
        updater = Updater(app: self)

        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in }

        // Starts at login unless they turned it off (like the Windows installer).
        if #available(macOS 13.0, *), !UserDefaults.standard.bool(forKey: "login-set") {
            UserDefaults.standard.set(true, forKey: "login-set")
            _ = setStartsAtLogin(true)
        }

        web.load(URLRequest(url: pending ?? Config.appURL))
        pending = nil
        if hidden {
            NSApp.setActivationPolicy(.accessory)
        } else {
            NSApp.setActivationPolicy(.regular)
            showMe(nil)
        }
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        guard let page = urls.lazy.compactMap(pageOf).first else { return }
        if web == nil { pending = page } else { showMe(page) }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showMe(nil)
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func buildWindow() {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()
        cfg.mediaTypesRequiringUserActionForPlayback = []
        cfg.applicationNameForUserAgent = "Version/17.0 Safari/605.1.15 iklipseApp/mac/\(Config.code)"
        cfg.preferences.javaScriptCanOpenWindowsAutomatically = true
        cfg.userContentController.add(self, name: "iklipse")
        web = WKWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.underPageBackgroundColor = Config.background
        web.allowsBackForwardNavigationGestures = false

        let area = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let w = min(1360, area.width - 80)
        let h = min(860, area.height - 80)
        window = NSWindow(
            contentRect: NSRect(x: area.minX + (area.width - w) / 2, y: area.minY + (area.height - h) / 2, width: w, height: h),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "iklipse"
        window.backgroundColor = Config.background
        window.minSize = NSSize(width: 420, height: 520)
        window.isReleasedWhenClosed = false
        window.collectionBehavior.insert(.moveToActiveSpace)
        window.delegate = self
        window.contentView = web
        window.setFrameAutosaveName("iklipse")
    }

    // ------------------------------------------------------------ menu bar --

    func buildTray() {
        tray = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let img = Bundle.main.image(forResource: "tray") {
            img.size = NSSize(width: 18, height: 18)
            img.isTemplate = true
            tray.button?.image = img
        } else {
            tray.button?.title = "iklipse"
        }
        tray.button?.toolTip = "iklipse"
        let menu = NSMenu()
        menu.addItem(item("Open iklipse", #selector(openFromTray)))
        if #available(macOS 13.0, *) {
            let atLogin = item("Start at login", #selector(toggleLogin(_:)))
            atLogin.state = SMAppService.mainApp.status == .enabled ? .on : .off
            menu.addItem(atLogin)
        }
        menu.addItem(.separator())
        menu.addItem(item("Quit iklipse", #selector(quit)))
        tray.menu = menu
    }

    func item(_ title: String, _ action: Selector, _ key: String = "") -> NSMenuItem {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
        i.target = self
        return i
    }

    @objc func openFromTray() { showMe(nil) }

    @objc func toggleLogin(_ sender: NSMenuItem) {
        guard #available(macOS 13.0, *) else { return }
        sender.state = setStartsAtLogin(sender.state != .on) ? .on : .off
    }

    @available(macOS 13.0, *)
    func setStartsAtLogin(_ on: Bool) -> Bool {
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
        } catch {
            // the system said no: show what it is now
        }
        return SMAppService.mainApp.status == .enabled
    }

    @objc func quit() { NSApp.terminate(nil) }

    @objc func reload() { web.reload() }

    /// The Mac's menus, so copy, paste and the usual keys work in the page.
    func buildMenu() {
        let bar = NSMenu()

        let appMenu = NSMenu()
        appMenu.addItem(NSMenuItem(title: "About iklipse", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: ""))
        appMenu.addItem(.separator())
        appMenu.addItem(NSMenuItem(title: "Hide iklipse", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h"))
        appMenu.addItem(.separator())
        appMenu.addItem(item("Quit iklipse", #selector(quit), "q"))

        let edit = NSMenu(title: "Edit")
        edit.addItem(NSMenuItem(title: "Undo", action: Selector(("undo:")), keyEquivalent: "z"))
        let redo = NSMenuItem(title: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(redo)
        edit.addItem(.separator())
        edit.addItem(NSMenuItem(title: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
        edit.addItem(NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
        edit.addItem(NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
        edit.addItem(NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))

        let view = NSMenu(title: "View")
        view.addItem(item("Reload", #selector(reload), "r"))

        let win = NSMenu(title: "Window")
        win.addItem(NSMenuItem(title: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m"))
        win.addItem(NSMenuItem(title: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w"))

        for (title, menu) in [("iklipse", appMenu), ("Edit", edit), ("View", view), ("Window", win)] {
            let top = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            top.submenu = menu
            bar.addItem(top)
        }
        NSApp.mainMenu = bar
        NSApp.windowsMenu = win
    }

    // ---------------------------------------------------------------- window --

    func showMe(_ url: URL?) {
        NSApp.setActivationPolicy(.regular)
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        guard let url, ours(url) else { return }
        if !loaded {
            web.load(URLRequest(url: url))
        } else if let d = try? JSONSerialization.data(withJSONObject: url.absoluteString, options: .fragmentsAllowed),
                  let s = String(data: d, encoding: .utf8)
        {
            web.evaluateJavaScript("location.href=\(s)", completionHandler: nil)
        }
    }

    /// Closing the window keeps iklipse running in the menu bar.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        window.orderOut(nil)
        NSApp.setActivationPolicy(.accessory)
        if !UserDefaults.standard.bool(forKey: "told-tray") {
            UserDefaults.standard.set(true, forKey: "told-tray")
            post(title: "iklipse is still on", body: "It keeps running in the menu bar, so notifications and Ikli's calls reach you. Quit it from the iklipse icon at the top of the screen.", info: [:])
        }
        return false
    }

    // ------------------------------------------------------------- the page --

    func ours(_ u: URL) -> Bool {
        u.scheme == "https" && u.host == Config.appURL.host
            && u.path.hasPrefix(Config.appURL.path.hasSuffix("/") ? String(Config.appURL.path.dropLast()) : Config.appURL.path)
    }

    /// iklipse's pages, and its files (they download here). Other sites open in the browser.
    func allowed(_ u: URL) -> Bool {
        if ["about", "data", "blob"].contains(u.scheme ?? "") { return true }
        return ours(u) || (u.scheme == "https" && u.host == Config.filesHost && u.path.contains("/storage/v1/object/"))
    }

    func openOutside(_ u: URL) {
        guard ["https", "http", "mailto", "tel", "whatsapp"].contains(u.scheme ?? "") else { return }
        NSWorkspace.shared.open(u)
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        if action.shouldPerformDownload { return decisionHandler(.download) }
        // Embeds inside the page are the page's business.
        if let frame = action.targetFrame, !frame.isMainFrame { return decisionHandler(.allow) }
        if allowed(url) { return decisionHandler(.allow) }
        openOutside(url)
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let disposition = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        if response.isForMainFrame && (disposition.lowercased().hasPrefix("attachment") || !response.canShowMIMEType) {
            return decisionHandler(.download)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded = true }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

    /// Links that open a new window: iklipse's open here, others in the browser.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = action.request.url else { return nil }
        if url.scheme == "https" && allowed(url) { webView.load(URLRequest(url: url)) } else { openOutside(url) }
        return nil
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.beginSheetModal(for: window) { r in completionHandler(r == .OK ? panel.urls : nil) }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert()
        a.messageText = message
        a.addButton(withTitle: "OK")
        a.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert()
        a.messageText = message
        a.addButton(withTitle: "OK")
        a.addButton(withTitle: "Cancel")
        a.beginSheetModal(for: window) { r in completionHandler(r == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(origin.host == Config.appURL.host ? .prompt : .deny)
    }

    // ------------------------------------------------------------- downloads --

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

    /// Files go to Downloads, like in a browser.
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let dir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        let name = suggestedFilename.isEmpty ? "download" : suggestedFilename
        let base = (name as NSString).deletingPathExtension
        let ext = (name as NSString).pathExtension
        var dest = dir.appendingPathComponent(name)
        var n = 1
        while FileManager.default.fileExists(atPath: dest.path) {
            n += 1
            dest = dir.appendingPathComponent(ext.isEmpty ? "\(base) (\(n))" : "\(base) (\(n)).\(ext)")
        }
        downloads[ObjectIdentifier(download)] = dest
        completionHandler(dest)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let dest = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
        // Bounces the Downloads stack in the Dock.
        DistributedNotificationCenter.default().post(name: Notification.Name("com.apple.DownloadFileFinished"), object: dest.path)
        post(title: "Downloaded", body: dest.lastPathComponent, info: ["file": dest.path])
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloads.removeValue(forKey: ObjectIdentifier(download))
    }

    // -------------------------------------------------------------- messages --

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, origin.protocol == "https", origin.host == Config.appURL.host,
              let s = message.body as? String, let d = s.data(using: .utf8),
              let m = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
        else { return }
        let id = m["id"]
        switch m["t"] as? String {
        case "info":
            reply(id, ["platform": "mac", "version": Config.name, "code": Config.code, "back": true])
        case "token":
            token = m["token"] as? String
            if token != nil { updater.soon() }
        case "ring":
            ring((m["on"] as? Bool) ?? false)
        case "notify":
            notify(title: m["title"] as? String ?? "iklipse", body: m["body"] as? String ?? "", url: m["url"] as? String)
        case "update":
            updater.checkNow()
        default:
            break
        }
    }

    func reply(_ id: Any?, _ answer: [String: Any]) {
        var a = answer
        a["id"] = id ?? NSNull()
        guard let d = try? JSONSerialization.data(withJSONObject: a), let s = String(data: d, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.dispatchEvent(new CustomEvent('iklipseapp',{detail:\(s)}))", completionHandler: nil)
    }

    /// Ikli is calling: up front and on top until it stops ringing.
    func ring(_ on: Bool) {
        guard on != ringing else { return }
        ringing = on
        if on {
            showMe(nil)
            window.level = .floating
            attention = NSApp.requestUserAttention(.criticalRequest)
        } else {
            window.level = .normal
            if let a = attention { NSApp.cancelUserAttentionRequest(a) }
            attention = nil
        }
    }

    /// A notification, unless iklipse is open in front of them.
    func notify(title: String, body: String, url: String?) {
        if NSApp.isActive && window.isVisible && window.isKeyWindow && !window.isMiniaturized { return }
        post(title: cut(title, 63), body: body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "iklipse" : cut(body, 255), info: url.map { ["url": $0] } ?? [:])
    }

    func cut(_ s: String, _ n: Int) -> String { s.count <= n ? s : String(s.prefix(n - 1)) + "…" }

    func post(title: String, body: String, info: [String: String]) {
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else {
                // Notifications are off for iklipse: the Dock icon bounces once instead.
                DispatchQueue.main.async { _ = NSApp.requestUserAttention(.informationalRequest) }
                return
            }
            let c = UNMutableNotificationContent()
            c.title = title
            c.body = body
            c.sound = .default
            c.userInfo = info
            center.add(UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil))
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        DispatchQueue.main.async {
            if let file = info["file"] as? String {
                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: file)])
            } else {
                self.showMe((info["url"] as? String).flatMap(URL.init(string:)))
            }
        }
        completionHandler()
    }
}
