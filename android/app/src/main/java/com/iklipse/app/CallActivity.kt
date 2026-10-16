package com.iklipse.app

import android.animation.ObjectAnimator
import android.animation.PropertyValuesHolder
import android.app.Activity
import android.app.KeyguardManager
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.WindowManager
import android.widget.TextView
import android.widget.Toast
import java.lang.ref.WeakReference
import java.util.Locale
import kotlin.concurrent.thread

/**
 * Ikli's call on screen, over the lock screen too: ringing, then what Ikli
 * says. Its words and voice are fetched while it rings, so Ikli speaks the
 * moment it's answered.
 */
class CallActivity : Activity() {
    private var call: Call? = null
    private var answered = false
    private var answeredAt = 0L
    private var said: String? = null
    private var open = false
    private var player: MediaPlayer? = null
    private var voiceReady = false
    private var playOnReady = false
    private var pulse: ObjectAnimator? = null
    private val ui = Handler(Looper.getMainLooper())

    private lateinit var status: TextView
    private lateinit var title: TextView
    private lateinit var group: TextView
    private lateinit var words: TextView

    companion object {
        private var shown: WeakReference<CallActivity>? = null

        /** That call stopped ringing (answered or declined somewhere else, or missed): its screen goes. */
        fun hush(callId: String) {
            Handler(Looper.getMainLooper()).post {
                val a = shown?.get() ?: return@post
                if (a.call?.id == callId && !a.answered) a.finish()
            }
        }
    }

    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        volumeControlStream = AudioManager.STREAM_MUSIC
        setContentView(R.layout.activity_call)
        status = findViewById(R.id.status)
        title = findViewById(R.id.title)
        group = findViewById(R.id.group)
        words = findViewById(R.id.words)

        findViewById<View>(R.id.answer).setOnClickListener { answer() }
        findViewById<View>(R.id.decline).setOnClickListener { leave("decline") }
        findViewById<View>(R.id.hangup).setOnClickListener { leave("end") }
        findViewById<View>(R.id.handled).setOnClickListener { leave("handled", "Marked handled") }
        findViewById<View>(R.id.snooze).setOnClickListener { leave("snooze", "Quiet for 15 minutes") }
        findViewById<View>(R.id.replay).setOnClickListener { replay() }
        findViewById<View>(R.id.open).setOnClickListener { openIklipse() }

        pulse = ObjectAnimator.ofPropertyValuesHolder(
            findViewById<View>(R.id.orb),
            PropertyValuesHolder.ofFloat(View.SCALE_X, 1f, 1.07f),
            PropertyValuesHolder.ofFloat(View.SCALE_Y, 1f, 1.07f),
        ).apply {
            duration = 700
            repeatCount = ObjectAnimator.INFINITE
            repeatMode = ObjectAnimator.REVERSE
        }
        shown = WeakReference(this)
        show(intent)
    }

    override fun onNewIntent(i: Intent) {
        super.onNewIntent(i)
        setIntent(i)
        show(i)
    }

    override fun onDestroy() {
        ui.removeCallbacksAndMessages(null)
        pulse?.cancel()
        player?.release()
        player = null
        if (shown?.get() === this) shown = null
        super.onDestroy()
    }

    private fun show(i: Intent) {
        val c = Call.from(i) ?: return finish()
        val wantsAnswer = i.getBooleanExtra("answer", false)
        if (c.id == call?.id) {
            if (wantsAnswer) answer()
            return
        }
        // A new call: whatever was on screen ends.
        ui.removeCallbacksAndMessages(null)
        player?.release()
        player = null
        call = c
        answered = false
        said = null
        open = false
        voiceReady = false
        playOnReady = false
        title.text = c.title
        group.text = c.group
        group.visibility = if (c.group.isBlank()) View.GONE else View.VISIBLE
        words.visibility = View.GONE
        status.text = "Calling you…"
        findViewById<View>(R.id.ringing).visibility = View.VISIBLE
        findViewById<View>(R.id.talking).visibility = View.GONE
        pulse?.start()
        if (!c.local) prefetch(c)
        if (wantsAnswer) answer() else ui.post(watch)
    }

    /** While it rings: Ikli's words and voice, ready for the moment it's answered. */
    private fun prefetch(c: Call) = thread {
        val r = runCatching { Ikli.act(c, "state", voice = true) }.getOrNull() ?: return@thread
        val w = r.optString("words").takeIf { it.isNotBlank() && it != "null" }
        val a = r.optString("audio").takeIf { it.startsWith("https://") }
        val o = r.optBoolean("open")
        runOnUiThread {
            if (call?.id != c.id) return@runOnUiThread
            said = said ?: w
            open = open || o
            if (a != null && player == null) load(a)
            if (answered) {
                if (words.visibility != View.VISIBLE && w != null) showWords(w)
                buttons()
                speak()
            }
        }
    }

    private fun load(url: String) {
        voiceReady = false
        player = MediaPlayer().apply {
            setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            setOnPreparedListener {
                voiceReady = true
                if (playOnReady) it.start()
            }
            setOnErrorListener { _, _, _ ->
                if (answered) Toast.makeText(this@CallActivity, "Couldn't play Ikli's voice", Toast.LENGTH_SHORT).show()
                true
            }
            runCatching {
                setDataSource(url)
                prepareAsync()
            }
        }
    }

    /** Ikli's voice out loud: now, or as soon as it's loaded. */
    private fun speak() {
        val p = player ?: return
        if (voiceReady) runCatching { if (!p.isPlaying) p.start() } else playOnReady = true
    }

    private fun showWords(w: String) {
        words.text = w
        words.visibility = View.VISIBLE
    }

    private fun buttons() {
        findViewById<View>(R.id.handled).visibility = if (open) View.VISIBLE else View.GONE
        findViewById<View>(R.id.snooze).visibility = if (open) View.VISIBLE else View.GONE
        findViewById<View>(R.id.replay).visibility = if (player != null) View.VISIBLE else View.GONE
    }

    /** While it rings: missed at its time, gone once it stops ringing elsewhere. */
    private val watch = object : Runnable {
        override fun run() {
            val c = call ?: return
            if (answered) return
            if (System.currentTimeMillis() > c.until) {
                Ikli.stop(this@CallActivity)
                status.text = "Missed call"
                pulse?.cancel()
                ui.postDelayed({ if (!answered) finish() }, 1500)
                return
            }
            if (!c.local) thread {
                val st = runCatching { Ikli.act(c, "state").optString("status") }.getOrNull()
                if (st != null && st != "ringing") runOnUiThread { if (!answered && call?.id == c.id) { Ikli.stop(this@CallActivity); finish() } }
            }
            ui.postDelayed(this, 4000)
        }
    }

    private fun answer() {
        val c = call ?: return
        if (answered) return
        answered = true
        Ikli.stop(this)
        ui.removeCallbacks(watch)
        pulse?.cancel()
        findViewById<View>(R.id.ringing).visibility = View.GONE
        findViewById<View>(R.id.talking).visibility = View.VISIBLE
        answeredAt = System.currentTimeMillis()
        ui.post(clock)
        if (c.local) {
            showWords("Hi, it's Ikli from iklipse. This is how my calls ring on this phone.")
            buttons()
            return
        }
        // Ready while it rang: Ikli speaks now; the server hears about it meanwhile.
        said?.let { showWords(it) }
        buttons()
        speak()
        thread {
            try {
                val r = Ikli.act(c, "answer")
                runOnUiThread {
                    open = r.optBoolean("open")
                    if (words.visibility != View.VISIBLE) {
                        showWords(r.optString("words").takeIf { it.isNotBlank() && it != "null" } ?: "Open iklipse to see what this is about.")
                    }
                    if (player == null) r.optString("audio").takeIf { it.startsWith("https://") }?.let { load(it) }
                    buttons()
                    speak()
                }
            } catch (e: Exception) {
                runOnUiThread { Toast.makeText(this, e.message ?: "Couldn't reach iklipse", Toast.LENGTH_LONG).show() }
            }
        }
    }

    private val clock = object : Runnable {
        override fun run() {
            val s = (System.currentTimeMillis() - answeredAt) / 1000
            status.text = String.format(Locale.US, "%02d:%02d", s / 60, s % 60)
            ui.postDelayed(this, 1000)
        }
    }

    private fun replay() {
        player?.let {
            runCatching {
                it.seekTo(0)
                it.start()
            }
        }
    }

    /** Decline, hang up, handled, 15 min: tells iklipse, then the screen goes. */
    private fun leave(act: String, note: String? = null) {
        val c = call
        Ikli.stop(this)
        player?.release()
        player = null
        if (c != null && !c.local) {
            val app = applicationContext
            thread {
                val ok = runCatching { Ikli.act(c, act) }.isSuccess
                if (note != null) Handler(Looper.getMainLooper()).post {
                    Toast.makeText(app, if (ok) note else "Couldn't reach iklipse. Try in the app.", Toast.LENGTH_SHORT).show()
                }
            }
        }
        finish()
    }

    private fun openIklipse() {
        val go = {
            startActivity(
                Intent(this, MainActivity::class.java)
                    .putExtra("url", "${BuildConfig.APP_URL}#/alerts")
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            )
            finish()
        }
        val km = getSystemService(KeyguardManager::class.java)
        if (km.isKeyguardLocked) {
            km.requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
                override fun onDismissSucceeded() = go()
            })
        } else go()
    }
}
