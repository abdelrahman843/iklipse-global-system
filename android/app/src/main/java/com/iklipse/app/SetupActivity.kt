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
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast

/** Phone settings (Apps in iklipse): who this phone is linked to, can it ring, a ring test. */
class SetupActivity : Activity() {
    private val ui = Handler(Looper.getMainLooper())

    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        setContentView(R.layout.activity_setup)
        Ikli.channel(this)
        findViewById<TextView>(R.id.version).text = "Version ${BuildConfig.VERSION_NAME}"
        findViewById<View>(R.id.back).setOnClickListener { finish() }
        findViewById<View>(R.id.test).setOnClickListener {
            Toast.makeText(this, "Ringing in 5 seconds", Toast.LENGTH_SHORT).show()
            val app = applicationContext
            ui.postDelayed({ Ikli.ring(app, Call(Call.LOCAL, "", "This is a test call", "Ring test", System.currentTimeMillis() + 30_000)) }, 5000)
        }
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        refresh()
    }

    private fun refresh() {
        val p = Ikli.prefs(this)
        val name = p.getString("id", null)?.let { p.getString("name", "") }
        findViewById<TextView>(R.id.linked).text =
            if (name != null) "Calls and notifications for ${name.ifBlank { "you" }}" else "Sign in to iklipse to get your calls here"

        val checks = findViewById<LinearLayout>(R.id.checks)
        checks.removeAllViews()
        val notify = Ikli.canNotify(this)
        need(checks, "Notifications", notify) {
            if (Build.VERSION.SDK_INT >= 33 && !shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS) && p.getBoolean("asked", false)) appSettings()
            else if (Build.VERSION.SDK_INT >= 33) {
                p.edit().putBoolean("asked", true).apply()
                requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
            }
        }
        need(checks, "Full screen when locked", Ikli.canRingFullScreen(this)) {
            if (Build.VERSION.SDK_INT >= 34) open(Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:$packageName")))
        }
        need(checks, "Call sound and pop-up", notify && Ikli.callsChannelOn(this)) {
            open(
                Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
                    .putExtra(Settings.EXTRA_CHANNEL_ID, Ikli.CALLS),
            )
        }
    }

    private fun appSettings() {
        runCatching { startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName)) }
    }

    /** A row: what's needed, and On or a button that turns it on. */
    private fun need(into: LinearLayout, label: String, ok: Boolean, fix: () -> Unit) {
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
}
