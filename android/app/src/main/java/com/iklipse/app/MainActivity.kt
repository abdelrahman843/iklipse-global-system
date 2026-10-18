package com.iklipse.app

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Message
import android.provider.Settings
import android.view.View
import android.view.WindowInsets
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.content.FileProvider
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.io.File
import java.net.URL
import kotlin.concurrent.thread

/**
 * iklipse itself: the web app in a WebView, plus what a browser can't do.
 * The page talks to it through "IklipseApp" messages (src/lib/nativeApp.ts):
 * link this phone to whoever signs in, unlink on sign-out, save files, open
 * Phone settings, open a sign-in (connecting Calendly, Google) in the app's own
 * browser tab; the sign-in comes back through iklipse://back and the tab
 * closes. Links to other sites open in the browser; files download.
 * Checks for a newer app on the way in, downloads it and asks to install.
 */
class MainActivity : Activity() {
    private lateinit var web: WebView
    private lateinit var offline: View
    private var pick: ValueCallback<Array<Uri>>? = null
    private var pendingInstall: File? = null
    private var updating = false
    private var lastCheck = 0L

    private val app = Uri.parse(BuildConfig.APP_URL)
    private val api = Uri.parse(BuildConfig.API)

    companion object {
        private const val PICK = 41
        private const val ORIGIN = "https://abdelrahman843.github.io"
    }

    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        setContentView(R.layout.activity_main)
        Ikli.channel(this)
        web = findViewById(R.id.web)
        offline = findViewById(R.id.offline)
        findViewById<View>(R.id.retry).setOnClickListener {
            offline.visibility = View.GONE
            web.reload()
        }
        if (Build.VERSION.SDK_INT >= 30) {
            // The page sits between the phone's bars and above the keyboard.
            val root = findViewById<View>(android.R.id.content)
            root.setOnApplyWindowInsetsListener { v, insets ->
                val i = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime())
                v.setPadding(i.left, i.top, i.right, i.bottom)
                WindowInsets.CONSUMED
            }
        }
        setUp()
        val start = backFrom(intent) ?: intent.getStringExtra("url")?.takeIf { ours(Uri.parse(it)) } ?: BuildConfig.APP_URL
        if (b == null || web.restoreState(b) == null) web.loadUrl(start)
        askForNotifications()
        // Updates already installed.
        File(cacheDir, "updates").listFiles()
            ?.filter { (it.name.removePrefix("iklipse-").substringBefore(".").toIntOrNull() ?: 0) <= BuildConfig.VERSION_CODE }
            ?.forEach { it.delete() }
    }

    override fun onNewIntent(i: Intent) {
        super.onNewIntent(i)
        setIntent(i)
        (backFrom(i) ?: i.getStringExtra("url"))?.let { go(it) }
    }

    override fun onResume() {
        super.onResume()
        pendingInstall?.let { if (Build.VERSION.SDK_INT < 26 || packageManager.canRequestPackageInstalls()) install(it) }
        checkForUpdate(false)
    }

    override fun onPause() {
        super.onPause()
        CookieManager.getInstance().flush()
    }

    override fun onSaveInstanceState(out: Bundle) {
        super.onSaveInstanceState(out)
        web.saveState(out)
    }

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else moveTaskToBack(true)
    }

    @Suppress("DEPRECATION")
    override fun onActivityResult(req: Int, res: Int, data: Intent?) {
        if (req != PICK) return super.onActivityResult(req, res, data)
        val picked = if (res != RESULT_OK || data == null) null
        else data.clipData?.let { c -> Array(c.itemCount) { c.getItemAt(it).uri } } ?: data.data?.let { arrayOf(it) }
        pick?.onReceiveValue(picked)
        pick = null
    }

    // ---------------------------------------------------------------- the page --

    private fun ours(u: Uri) = u.scheme == "https" && u.host == app.host && (u.path ?: "/").startsWith(app.path ?: "/")

    /** Back from a sign-in: iklipse://back?to=/connections?calendly=connected -> that page of iklipse. */
    private fun backFrom(i: Intent?): String? {
        val d = i?.data ?: return null
        if (d.scheme != "iklipse" || d.host != "back") return null
        val to = d.getQueryParameter("to")?.takeIf { it.startsWith("/") && !it.startsWith("//") } ?: "/connections"
        return BuildConfig.APP_URL.substringBefore("#").trimEnd('/') + "/#" + to
    }

    /** A sign-in page in the app's own browser tab (Google doesn't allow signing in inside a WebView). */
    private fun signIn(url: String) {
        val u = Uri.parse(url)
        if (u.scheme != "https") return
        try {
            CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(this, u)
        } catch (e: Exception) {
            leave(u)
        }
    }

    /** Files come from iklipse's storage (signed links): those download. */
    private fun isFile(u: Uri) = u.host == api.host

    private fun go(url: String) {
        val u = Uri.parse(url)
        if (!ours(u)) return
        if (web.url == null) web.loadUrl(url) else web.evaluateJavascript("location.href=${JSONObject.quote(url)}", null)
    }

    private fun setUp() {
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false // Ikli's voice plays the moment a call is answered
            setSupportMultipleWindows(true)
            javaScriptCanOpenWindowsAutomatically = true
            allowFileAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            userAgentString = "$userAgentString iklipseApp/android/${BuildConfig.VERSION_CODE}"
        }
        CookieManager.getInstance().setAcceptCookie(true)

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(v: WebView, r: WebResourceRequest): Boolean {
                if (ours(r.url)) return false
                leave(r.url)
                return true
            }

            override fun onReceivedError(v: WebView, r: WebResourceRequest, e: WebResourceError) {
                if (r.isForMainFrame) offline.visibility = View.VISIBLE
            }

            override fun onRenderProcessGone(v: WebView, d: RenderProcessGoneDetail): Boolean {
                recreate()
                return true
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(v: WebView, cb: ValueCallback<Array<Uri>>, p: FileChooserParams): Boolean {
                pick?.onReceiveValue(null)
                pick = cb
                val i = p.createIntent().apply {
                    if (p.mode == FileChooserParams.MODE_OPEN_MULTIPLE) putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                }
                return try {
                    @Suppress("DEPRECATION")
                    startActivityForResult(i, PICK)
                    true
                } catch (e: ActivityNotFoundException) {
                    pick = null
                    false
                }
            }

            // window.open: iklipse's own pages open here, the rest in the browser.
            override fun onCreateWindow(v: WebView, dialog: Boolean, user: Boolean, msg: Message): Boolean {
                var taken = false
                val take = { u: Uri ->
                    if (!taken) {
                        taken = true
                        if (ours(u)) web.loadUrl(u.toString()) else leave(u)
                    }
                }
                val probe = WebView(this@MainActivity)
                probe.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(w: WebView, r: WebResourceRequest): Boolean {
                        take(r.url)
                        w.destroy()
                        return true
                    }

                    override fun onPageStarted(w: WebView, url: String?, favicon: Bitmap?) {
                        if (url != null && url != "about:blank") {
                            take(Uri.parse(url))
                            w.stopLoading()
                            w.destroy()
                        }
                    }
                }
                (msg.obj as WebView.WebViewTransport).webView = probe
                msg.sendToTarget()
                return true
            }
        }

        // Files the page links to; blobs come through "save" instead.
        web.setDownloadListener { url, _, disposition, mime, _ ->
            if (url.startsWith("http")) download(Uri.parse(url), disposition, mime)
        }

        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, "IklipseApp", setOf(ORIGIN)) { _, message, _, isMainFrame, reply ->
                val data = message.data
                if (isMainFrame && data != null) handle(data, reply)
            }
        }
    }

    /** Another site: the browser (or the app it belongs to). A file of iklipse's: Downloads. */
    private fun leave(u: Uri) {
        if (isFile(u)) return download(u, null, null)
        try {
            val i = if (u.scheme == "intent") Intent.parseUri(u.toString(), Intent.URI_INTENT_SCHEME) else Intent(Intent.ACTION_VIEW, u)
            i.addCategory(Intent.CATEGORY_BROWSABLE)
            i.component = null
            i.selector = null
            startActivity(i)
        } catch (e: Exception) {
            Toast.makeText(this, "Nothing on this phone opens that link", Toast.LENGTH_SHORT).show()
        }
    }

    private fun download(u: Uri, disposition: String?, mime: String?) {
        val name = u.getQueryParameter("download")?.takeIf { it.isNotBlank() } ?: URLUtil.guessFileName(u.toString(), disposition, mime)
        try {
            val req = DownloadManager.Request(u)
                .setTitle(name)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "iklipse/$name")
            mime?.let { req.setMimeType(it) }
            getSystemService(DownloadManager::class.java).enqueue(req)
            Toast.makeText(this, "Downloading $name", Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            runCatching { startActivity(Intent(Intent.ACTION_VIEW, u)) }
        }
    }

    // ------------------------------------------------------- page's messages --

    private fun handle(data: String, reply: JavaScriptReplyProxy) {
        val m = runCatching { JSONObject(data) }.getOrNull() ?: return
        val id = m.opt("id")
        val answer = { o: JSONObject -> runOnUiThread { runCatching { reply.postMessage(o.put("id", id).toString()) } } }
        when (m.optString("t")) {
            "info" -> answer(
                JSONObject()
                    .put("platform", "android")
                    .put("version", BuildConfig.VERSION_NAME)
                    .put("code", BuildConfig.VERSION_CODE)
                    .put("back", true)
                    .put("user", Ikli.prefs(this).getString("user", null)?.takeIf { it.isNotBlank() } ?: JSONObject.NULL),
            )
            "link" -> thread {
                val error = Ikli.pair(this, m.optString("code"))
                answer(JSONObject().put("ok", error == null).put("error", error ?: JSONObject.NULL))
                if (error == null) runOnUiThread { afterLink() }
            }
            "unlink" -> thread {
                Ikli.unpair(this)
                answer(JSONObject().put("ok", true))
            }
            "settings" -> startActivity(Intent(this, SetupActivity::class.java))
            "signin" -> runOnUiThread { signIn(m.optString("url")) }
            "save" -> thread {
                val error = Ikli.save(this, m.optString("name"), m.optString("mime"), m.optString("b64"))
                answer(JSONObject().put("ok", error == null).put("error", error ?: JSONObject.NULL))
                runOnUiThread { Toast.makeText(this, error ?: "Saved to Downloads", Toast.LENGTH_SHORT).show() }
            }
            "update" -> checkForUpdate(true)
        }
    }

    // ---------------------------------------------------------- permissions --

    private fun askForNotifications() {
        if (Build.VERSION.SDK_INT < 33 || Ikli.canNotify(this)) return
        val p = Ikli.prefs(this)
        if (p.getBoolean("asked", false)) return
        p.edit().putBoolean("asked", true).apply()
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
    }

    /** Linked: once, ask to let calls ring full screen (Android 14 needs a switch for it). */
    private fun afterLink() {
        askForNotifications()
        if (Ikli.canRingFullScreen(this) || isFinishing) return
        val p = Ikli.prefs(this)
        if (p.getBoolean("asked-full-screen", false)) return
        p.edit().putBoolean("asked-full-screen", true).apply()
        AlertDialog.Builder(this)
            .setTitle("Let Ikli's calls ring full screen")
            .setMessage("So a call shows over the lock screen like a real one. Turn on iklipse on the next screen.")
            .setPositiveButton("Open settings") { _, _ ->
                if (Build.VERSION.SDK_INT >= 34) runCatching {
                    startActivity(Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:$packageName")))
                }
            }
            .setNegativeButton("Later", null)
            .show()
    }

    // --------------------------------------------------------------- updates --

    /** Asks iklipse for a newer app (at most every 20 minutes, unless asked to). */
    private fun checkForUpdate(force: Boolean) {
        if (updating || (!force && System.currentTimeMillis() - lastCheck < 20 * 60_000)) return
        lastCheck = System.currentTimeMillis()
        thread {
            val u = Ikli.checkIn(this, null)?.optJSONObject("update") ?: return@thread
            runOnUiThread { offerUpdate(u) }
        }
    }

    /** Downloads the new version, then asks to install it (Android needs that one tap). */
    private fun offerUpdate(u: JSONObject) {
        val code = u.optInt("code")
        val url = u.optString("url")
        if (code <= BuildConfig.VERSION_CODE || !url.startsWith("https://") || updating) return
        updating = true
        thread {
            val f = File(cacheDir, "updates/iklipse-$code.apk")
            val ok = runCatching {
                f.parentFile?.mkdirs()
                val part = File(f.path + ".part")
                URL(url).openStream().use { i -> part.outputStream().use { i.copyTo(it) } }
                part.renameTo(f)
            }.getOrDefault(false)
            runOnUiThread {
                updating = false
                if (!ok || isFinishing) return@runOnUiThread
                AlertDialog.Builder(this)
                    .setTitle("A new iklipse is ready")
                    .setMessage("Version ${u.optString("name")}. Install it now? It takes a few seconds.")
                    .setPositiveButton("Install") { _, _ -> install(f) }
                    .setNegativeButton("Later", null)
                    .show()
            }
        }
    }

    private fun install(f: File) {
        if (Build.VERSION.SDK_INT >= 26 && !packageManager.canRequestPackageInstalls()) {
            pendingInstall = f
            Toast.makeText(this, "Allow iklipse to install its updates, then come back", Toast.LENGTH_LONG).show()
            runCatching { startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName"))) }
            return
        }
        pendingInstall = null
        val uri = FileProvider.getUriForFile(this, "$packageName.files", f)
        runCatching {
            startActivity(
                Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        }
    }
}
