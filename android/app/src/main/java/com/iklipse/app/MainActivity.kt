package com.iklipse.app

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import com.google.firebase.messaging.FirebaseMessaging
import org.json.JSONObject
import java.net.URL
import kotlin.concurrent.thread

/** Link this phone to a person in iklipse, check it can ring, test it, open iklipse. */
class MainActivity : Activity() {
    private lateinit var code: EditText
    private lateinit var message: TextView
    private val ui = Handler(Looper.getMainLooper())

    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        setContentView(R.layout.activity_main)
        Ikli.channel(this)
        code = findViewById(R.id.code)
        message = findViewById(R.id.message)
        findViewById<TextView>(R.id.version).text = "Version ${BuildConfig.VERSION_NAME}"

        findViewById<View>(R.id.link).setOnClickListener { link(code.text.toString()) }
        findViewById<View>(R.id.get_code).setOnClickListener { browse("${BuildConfig.APP_URL}#/alerts?tab=phone&link=1") }
        findViewById<View>(R.id.open).setOnClickListener { browse(BuildConfig.APP_URL) }
        findViewById<View>(R.id.get_update).setOnClickListener { browse("${BuildConfig.RELEASES}iklipse.apk") }
        findViewById<View>(R.id.test).setOnClickListener {
            Toast.makeText(this, "Ringing in 5 seconds", Toast.LENGTH_SHORT).show()
            val app = applicationContext
            ui.postDelayed({ Ikli.ring(app, Call(Call.LOCAL, "", "This is a test call", "Ring test", System.currentTimeMillis() + 30_000)) }, 5000)
        }
        pairFrom(intent)
    }

    override fun onNewIntent(i: Intent) {
        super.onNewIntent(i)
        setIntent(i)
        pairFrom(i)
    }

    override fun onResume() {
        super.onResume()
        refresh()
        thread {
            Ikli.checkIn(this, null)
            runOnUiThread { refresh() }
            val latest = runCatching { JSONObject(URL("${BuildConfig.RELEASES}version.json").readText()).optInt("code") }.getOrDefault(0)
            if (latest > BuildConfig.VERSION_CODE) runOnUiThread { findViewById<View>(R.id.update).visibility = View.VISIBLE }
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        refresh()
    }

    /** iklipse://pair?code=… (Alerts > My phone > Link this phone). */
    private fun pairFrom(i: Intent?) {
        val c = i?.data?.takeIf { it.scheme == "iklipse" }?.getQueryParameter("code") ?: return
        code.setText(c)
        link(c)
    }

    private fun link(raw: String) {
        val c = raw.uppercase().filter { it.isLetterOrDigit() }
        if (c.length != 8) return say("The code has 8 letters and numbers")
        say(null)
        findViewById<Button>(R.id.link).apply {
            isEnabled = false
            text = "Linking…"
        }
        FirebaseMessaging.getInstance().token.addOnCompleteListener { t ->
            val token = if (t.isSuccessful) t.result else null
            thread {
                val error = try {
                    if (token == null) throw IllegalStateException("This phone couldn't reach Firebase. Check the internet and try again.")
                    val r = Ikli.post(
                        "pair",
                        JSONObject().put("code", c).put("token", token).put("device", Ikli.device).put("version", BuildConfig.VERSION_NAME),
                    )
                    Ikli.prefs(this).edit()
                        .putString("id", r.getString("id"))
                        .putString("key", r.getString("key"))
                        .putString("name", r.optString("name"))
                        .apply()
                    null
                } catch (e: Exception) {
                    e.message ?: "Couldn't link this phone"
                }
                runOnUiThread {
                    findViewById<Button>(R.id.link).apply {
                        isEnabled = true
                        text = "Link"
                    }
                    if (error != null) say(error) else {
                        code.setText("")
                        Toast.makeText(this, "Linked. Ikli's calls ring here now.", Toast.LENGTH_LONG).show()
                    }
                    refresh()
                }
            }
        }
    }

    private fun say(text: String?) {
        message.text = text
        message.visibility = if (text == null) View.GONE else View.VISIBLE
    }

    private fun refresh() {
        val name = Ikli.prefs(this).getString("id", null)?.let { Ikli.prefs(this).getString("name", "") }
        findViewById<TextView>(R.id.linked).text = if (name != null) "Linked to ${name.ifBlank { "your account" }}" else "Not linked yet"
        findViewById<TextView>(R.id.link_help).text =
            if (name != null) "Ikli's calls for you ring on this phone. To link it to someone else, enter their code."
            else "In iklipse, open Alerts > My phone and tap Link this phone. Or type the code it shows here."

        val checks = findViewById<LinearLayout>(R.id.checks)
        checks.removeAllViews()
        val notify = Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        check(checks, "Notifications", notify) {
            if (Build.VERSION.SDK_INT >= 33 && shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS).not() && askedBefore()) appSettings()
            else if (Build.VERSION.SDK_INT >= 33) {
                Ikli.prefs(this).edit().putBoolean("asked", true).apply()
                requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
            }
        }
        check(checks, "Full screen when locked", Ikli.canRingFullScreen(this)) {
            if (Build.VERSION.SDK_INT >= 34) open(Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:$packageName")))
        }
        check(checks, "Call sound and pop-up", notify && Ikli.callsChannelOn(this)) {
            open(
                Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
                    .putExtra(Settings.EXTRA_CHANNEL_ID, Ikli.CALLS),
            )
        }
    }

    private fun askedBefore() = Ikli.prefs(this).getBoolean("asked", false)

    private fun appSettings() {
        runCatching { startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName)) }
    }

    /** A row: what's needed, and On or a button that fixes it. */
    private fun check(into: LinearLayout, label: String, ok: Boolean, fix: () -> Unit) {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(12), 0, 0)
        }
        row.addView(TextView(this).apply {
            text = label
            setTextColor(getColor(R.color.muted))
            textSize = 15f
        }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        if (ok) {
            row.addView(TextView(this).apply {
                text = "On"
                setTextColor(getColor(R.color.success))
                textSize = 15f
            })
        } else {
            row.addView(Button(this).apply {
                text = "Turn on"
                isAllCaps = false
                setTextColor(0xFFFFFFFF.toInt())
                setBackgroundResource(R.drawable.btn_primary)
                stateListAnimator = null
                setPadding(dp(16), 0, dp(16), 0)
                setOnClickListener { fix() }
            }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, dp(40)))
        }
        into.addView(row)
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun open(i: Intent) {
        runCatching { startActivity(i) }.onFailure { appSettings() }
    }

    private fun browse(url: String) {
        runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
    }
}
