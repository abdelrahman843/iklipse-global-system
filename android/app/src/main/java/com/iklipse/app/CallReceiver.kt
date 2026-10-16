package com.iklipse.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import kotlin.concurrent.thread

/** Decline on the ringing notification: rings again after a while (Alerts > Settings). */
class CallReceiver : BroadcastReceiver() {
    override fun onReceive(c: Context, i: Intent) {
        val call = Call.from(i) ?: return
        Ikli.stop(c)
        CallActivity.hush(call.id)
        if (call.local) return
        val done = goAsync()
        thread {
            runCatching { Ikli.act(call, "decline") }
            done.finish()
        }
    }
}
