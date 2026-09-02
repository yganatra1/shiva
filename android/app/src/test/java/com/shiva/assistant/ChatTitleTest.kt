package com.shiva.assistant

import com.shiva.assistant.feature.chat.CHAT_TITLE_DISPLAY_MAX_CHARS
import com.shiva.assistant.feature.chat.croppedChatTitle
import org.junit.Assert.assertEquals
import org.junit.Test

class ChatTitleTest {
    @Test
    fun keepsShortTitlesUnchanged() {
        assertEquals("Weekend plans", croppedChatTitle("Weekend plans"))
        assertEquals("Yash", croppedChatTitle("  Yash  "))
    }

    @Test
    fun cropsLongTitlesAfterTheDisplayLimit() {
        val title = "Call my wife's brother about the Ahmedabad trip details"
        val cropped = croppedChatTitle(title)
        assertEquals(CHAT_TITLE_DISPLAY_MAX_CHARS + 1, cropped.length)
        assertEquals(title.take(CHAT_TITLE_DISPLAY_MAX_CHARS).trimEnd() + "…", cropped)
    }
}
