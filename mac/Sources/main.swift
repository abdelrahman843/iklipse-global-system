import AppKit

// iklipse for Mac: the web app in a window (WKWebView), kept running in the
// menu bar so notifications and Ikli's calls reach the computer with the window
// closed. The Mac twin of desktop/ (Windows). Built by mac/build.sh.

let delegate = AppDelegate()
let app = NSApplication.shared
app.delegate = delegate
app.run()
