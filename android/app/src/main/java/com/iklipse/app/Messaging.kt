package com.iklipse.app

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Through Firebase: "call" rings (Ikli's call), "hush" stops it (answered or
 * missed elsewhere), "note" is any other notification from iklipse.
 */
class Messaging : FirebaseMessagingService() {
    override fun onMessageReceived(m: RemoteMessage) {
        when (m.data["type"]) {
            "call" -> Call.from(m.data)?.let { Ikli.ring(this, it) }
            "hush" -> m.data["call"]?.let { Ikli.hush(this, it) }
            "note" -> Ikli.note(this, m.data)
        }
    }

    // Runs off the main thread: iklipse learns the new token.
    override fun onNewToken(token: String) {
        Ikli.checkIn(this, token)
    }
}
