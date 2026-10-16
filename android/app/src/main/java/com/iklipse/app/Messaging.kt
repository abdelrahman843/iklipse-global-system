package com.iklipse.app

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/** Ikli's calls through Firebase: "call" rings, "hush" stops it (answered or missed elsewhere). */
class Messaging : FirebaseMessagingService() {
    override fun onMessageReceived(m: RemoteMessage) {
        when (m.data["type"]) {
            "call" -> Call.from(m.data)?.let { Ikli.ring(this, it) }
            "hush" -> m.data["call"]?.let { Ikli.hush(this, it) }
        }
    }

    // Runs off the main thread: iklipse learns the new token.
    override fun onNewToken(token: String) {
        Ikli.checkIn(this, token)
    }
}
