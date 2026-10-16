package com.iklipse.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.os.Bundle
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.graphics.drawable.IconCompat
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/** One of Ikli's calls, as Firebase brings it (whatsapp-bot ringPhone). */
data class Call(val id: String, val sig: String, val title: String, val group: String, val until: Long) {
    val local get() = id == LOCAL

    fun into(i: Intent): Intent = i.putExtras(Bundle().apply {
        putString("call", id)
        putString("sig", sig)
        putString("title", title)
        putString("group", group)
        putLong("until", until)
    })

    companion object {
        /** The ring test on this phone: nothing goes to iklipse. */
        const val LOCAL = "local"

        fun from(d: Map<String, String>): Call? {
            val id = d["call"] ?: return null
            val ms = d["ms"]?.toLongOrNull() ?: 55_000L
            return Call(id, d["sig"].orEmpty(), d["title"].orEmpty(), d["group"].orEmpty(), System.currentTimeMillis() + ms)
        }

        fun from(i: Intent?): Call? {
            val id = i?.getStringExtra("call") ?: return null
            return Call(id, i.getStringExtra("sig").orEmpty(), i.getStringExtra("title").orEmpty(), i.getStringExtra("group").orEmpty(), i.getLongExtra("until", 0))
        }
    }
}

object Ikli {
    const val CALLS = "calls-v1"
    private const val NOTE = 7

    fun prefs(c: Context) = c.getSharedPreferences("ikli", Context.MODE_PRIVATE)

    val device get() = "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${Build.MODEL} · Android ${Build.VERSION.RELEASE}"

    /** POSTs to the whatsapp-bot function; throws with its message. Not on the main thread. */
    fun post(path: String, body: JSONObject): JSONObject {
        val con = URL("${BuildConfig.API}/$path").openConnection() as HttpURLConnection
        try {
            con.requestMethod = "POST"
            con.connectTimeout = 15_000
            con.readTimeout = 25_000
            con.doOutput = true
            con.setRequestProperty("Content-Type", "application/json")
            con.outputStream.use { it.write(body.toString().toByteArray()) }
            val code = con.responseCode
            val text = (if (code in 200..299) con.inputStream else con.errorStream)?.bufferedReader()?.use { it.readText() }.orEmpty()
            val json = runCatching { JSONObject(text) }.getOrElse { JSONObject() }
            if (code !in 200..299) throw IOException(json.optString("error").ifEmpty { "iklipse didn't answer ($code)" })
            return json
        } finally {
            con.disconnect()
        }
    }

    /** A button on a call: answer, decline, end, handled, snooze, state (voice: with a link to Ikli's voice). */
    fun act(call: Call, act: String, voice: Boolean = false): JSONObject =
        post("act", JSONObject().put("call", call.id).put("sig", call.sig).put("act", act).put("voice", voice))

    /** Tells iklipse this phone's Firebase token and version; false once it was unlinked there. */
    fun checkIn(c: Context, token: String?): Boolean {
        val p = prefs(c)
        val id = p.getString("id", null) ?: return false
        val key = p.getString("key", null) ?: return false
        return try {
            val r = post("phone", JSONObject().put("id", id).put("key", key).put("token", token ?: "").put("version", BuildConfig.VERSION_NAME))
            p.edit().putString("name", r.optString("name", p.getString("name", "") ?: "")).apply()
            true
        } catch (e: IOException) {
            if (e.message?.contains("isn't linked") == true) {
                p.edit().remove("id").remove("key").remove("name").apply()
                false
            } else true
        }
    }

    // ------------------------------------------------------------------ ringing --

    /** Rings like a phone call: the ringtone over and over, full screen on a locked phone. */
    fun channel(c: Context) {
        val nm = c.getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CALLS) != null) return
        nm.createNotificationChannel(NotificationChannel(CALLS, "Ikli's calls", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Rings like a phone call until you answer"
            setSound(
                RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build(),
            )
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 1000, 1000)
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        })
    }

    private const val FLAGS = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE

    fun ring(c: Context, call: Call) {
        channel(c)
        val screen = PendingIntent.getActivity(c, 1, call.into(Intent(c, CallActivity::class.java)), FLAGS)
        val answer = PendingIntent.getActivity(c, 2, call.into(Intent(c, CallActivity::class.java)).putExtra("answer", true), FLAGS)
        val decline = PendingIntent.getBroadcast(c, 3, call.into(Intent(c, CallReceiver::class.java)), FLAGS)
        val ikli = Person.Builder()
            .setName("Ikli")
            .setIcon(IconCompat.createWithResource(c, R.drawable.ikli))
            .setImportant(true)
            .build()
        val n = NotificationCompat.Builder(c, CALLS)
            .setSmallIcon(R.drawable.ic_call)
            .setContentTitle("Ikli is calling you")
            .setContentText(listOf(call.title, call.group).filter { it.isNotBlank() }.joinToString(" · "))
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            .setContentIntent(screen)
            .setFullScreenIntent(screen, true)
            .setStyle(NotificationCompat.CallStyle.forIncomingCall(ikli, decline, answer))
            .setTimeoutAfter((call.until - System.currentTimeMillis()).coerceAtLeast(5_000))
            .build()
        n.flags = n.flags or Notification.FLAG_INSISTENT
        prefs(c).edit().putString("ringing", call.id).apply()
        c.getSystemService(NotificationManager::class.java).notify(NOTE, n)
    }

    /** Stops the ringing (answered, declined, missed). */
    fun stop(c: Context) {
        prefs(c).edit().remove("ringing").apply()
        c.getSystemService(NotificationManager::class.java).cancel(NOTE)
    }

    /** That call stopped ringing somewhere else. */
    fun hush(c: Context, callId: String) {
        if (prefs(c).getString("ringing", null) == callId) stop(c)
        CallActivity.hush(callId)
    }

    /** Can this phone ring full screen (Android 14 asks once for it)? */
    fun canRingFullScreen(c: Context) =
        Build.VERSION.SDK_INT < 34 || c.getSystemService(NotificationManager::class.java).canUseFullScreenIntent()

    /** Are the calls' sound and pop-up on (people can turn the channel down)? */
    fun callsChannelOn(c: Context): Boolean {
        val nm = c.getSystemService(NotificationManager::class.java)
        if (!nm.areNotificationsEnabled()) return false
        val ch = nm.getNotificationChannel(CALLS) ?: return true
        return ch.importance >= NotificationManager.IMPORTANCE_HIGH
    }
}
