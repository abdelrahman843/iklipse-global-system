import AppKit

/// Updates itself: asks iklipse for the newest Mac app (as the signed-in person,
/// the downloads are team-only), downloads it, and swaps it in quietly when
/// nobody is using iklipse (no call ringing, the window hidden or idle), then
/// opens iklipse again in the menu bar.
final class Updater {
    unowned let app: AppDelegate
    var timer: Timer?
    var lastCheck: Date?
    var busy = false
    var ready: URL?

    init(app: AppDelegate) {
        self.app = app
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in self?.tick() }
        // Updates of versions already running.
        let tmp = FileManager.default.temporaryDirectory
        for f in (try? FileManager.default.contentsOfDirectory(atPath: tmp.path)) ?? [] where f.hasPrefix("iklipse-") && f.hasSuffix(".dmg") {
            try? FileManager.default.removeItem(at: tmp.appendingPathComponent(f))
        }
    }

    /// Just signed in: the first check.
    func soon() {
        if lastCheck == nil { checkNow() }
    }

    func tick() {
        if ready != nil { tryInstall() } else if lastCheck.map({ Date().timeIntervalSince($0) >= 3600 }) ?? true { checkNow() }
    }

    func checkNow() {
        guard !busy, let token = app.token else { return }
        busy = true
        lastCheck = Date()
        var req = URLRequest(url: Config.api)
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = Data(#"{"platform":"mac"}"#.utf8)
        URLSession.shared.dataTask(with: req) { data, res, _ in
            guard (res as? HTTPURLResponse)?.statusCode == 200, let data,
                  let m = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let code = (m["code"] as? NSNumber)?.intValue, code > Config.code,
                  let s = m["url"] as? String, let url = URL(string: s)
            else { return self.done(nil) }
            let dest = FileManager.default.temporaryDirectory.appendingPathComponent("iklipse-\(code).dmg")
            if FileManager.default.fileExists(atPath: dest.path) { return self.done(dest) }
            URLSession.shared.downloadTask(with: url) { file, res, _ in
                guard let file, (res as? HTTPURLResponse)?.statusCode == 200 else { return self.done(nil) }
                try? FileManager.default.moveItem(at: file, to: dest)
                self.done(FileManager.default.fileExists(atPath: dest.path) ? dest : nil)
            }.resume()
        }.resume()
    }

    /// Offline or nothing new: the next hour.
    func done(_ dmg: URL?) {
        DispatchQueue.main.async {
            self.busy = false
            guard let dmg else { return }
            self.ready = dmg
            self.tryInstall()
        }
    }

    func tryInstall() {
        guard let dmg = ready, !app.ringing else { return }
        if app.window.isVisible && idleSeconds() < 180 { return }
        // Only where it can swap itself (in Applications; not run from the disk image).
        let target = Bundle.main.bundlePath
        guard target.hasSuffix(".app"), FileManager.default.isWritableFile(atPath: (target as NSString).deletingLastPathComponent) else {
            ready = nil
            return
        }
        // After this one quits: mount, swap the app (the old one back if it fails), open it.
        let script = """
            while kill -0 \(ProcessInfo.processInfo.processIdentifier) 2>/dev/null; do sleep 0.5; done
            mnt=$(mktemp -d /tmp/iklipse-update.XXXXXX)
            if hdiutil attach -nobrowse -readonly -noverify -mountpoint "$mnt" "$1" >/dev/null; then
              rm -rf "$2.old" && mv "$2" "$2.old"
              if ditto "$mnt/iklipse.app" "$2"; then rm -rf "$2.old"; else rm -rf "$2"; mv "$2.old" "$2"; fi
              hdiutil detach "$mnt" -quiet || true
            fi
            rm -f "$1"
            open "$2" --args --hidden
            """
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = ["-c", script, "iklipse-update", dmg.path, target]
        do {
            try p.run()
            NSApp.terminate(nil)
        } catch {
            ready = nil
        }
    }

    func idleSeconds() -> Double {
        CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: ~0) ?? .mouseMoved)
    }
}
