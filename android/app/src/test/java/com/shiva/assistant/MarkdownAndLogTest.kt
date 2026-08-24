package com.shiva.assistant

import com.shiva.assistant.core.logging.ShivaLog
import com.shiva.assistant.feature.chat.MdBlock
import com.shiva.assistant.feature.chat.inlineMarkdown
import com.shiva.assistant.feature.chat.parseBlocks
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MarkdownAndLogTest {
    @Test
    fun splitsFencedCodeBlocks() {
        val blocks = parseBlocks("Hello\n```kotlin\nval x = 1\n```\nDone")
        assertEquals(3, blocks.size)
        assertTrue(blocks[1] is MdBlock.Code)
        assertEquals("kotlin", (blocks[1] as MdBlock.Code).language)
        assertEquals("val x = 1", (blocks[1] as MdBlock.Code).code)
    }

    @Test
    fun parsesHeadingsListsQuotesAndDivider() {
        val markdown = """
            # Title
            ## Subtitle
            - one
            - two
            1. first
            2. second
            > quoted
            ---
            body
        """.trimIndent()
        val blocks = parseBlocks(markdown)
        assertTrue(blocks[0] is MdBlock.Heading)
        assertEquals(1, (blocks[0] as MdBlock.Heading).level)
        assertTrue(blocks.any { it is MdBlock.BulletList })
        assertTrue(blocks.any { it is MdBlock.OrderedList })
        assertTrue(blocks.any { it is MdBlock.Quote })
        assertTrue(blocks.any { it is MdBlock.Divider })
        assertTrue(blocks.any { it is MdBlock.Paragraph && it.text == "body" })
    }

    @Test
    fun parsesSimpleTables() {
        val markdown = """
            | Name | Age |
            | ---- | --- |
            | Ada  | 36  |
            | Lin  | 41  |
        """.trimIndent()
        val blocks = parseBlocks(markdown)
        assertEquals(1, blocks.size)
        val table = blocks[0] as MdBlock.Table
        assertEquals(listOf("Name", "Age"), table.headers)
        assertEquals(2, table.rows.size)
        assertEquals(listOf("Ada", "36"), table.rows[0])
    }

    @Test
    fun inlineMarkdownSupportsLinksAndStrike() {
        val annotated = inlineMarkdown("see [docs](https://example.com) and ~~old~~")
        assertTrue(annotated.text.contains("docs"))
        assertTrue(annotated.text.contains("old"))
        assertTrue(annotated.getLinkAnnotations(0, annotated.length).isNotEmpty())
    }

    @Test
    fun sanitizesAuthorizationValues() {
        val sanitized = ShivaLog.sanitize("authorization: Bearer super-secret-token")
        assertFalse(sanitized.contains("super-secret-token"))
        assertTrue(sanitized.contains("[redacted]"))
    }
}
