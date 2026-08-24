package com.shiva.assistant.feature.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.LinkInteractionListener
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.shiva.assistant.core.design.LocalShivaPalette
import com.shiva.assistant.core.design.ShivaPalette
import com.shiva.assistant.core.design.ShivaTypography

@Composable
fun MarkdownMessage(
    text: String,
    modifier: Modifier = Modifier,
) {
    val palette = LocalShivaPalette.current
    val blocks = remember(text) { parseBlocks(text) }
    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        blocks.forEach { block ->
            when (block) {
                is MdBlock.Heading -> HeadingBlock(block, palette)
                is MdBlock.Paragraph -> ParagraphBlock(block.text, palette)
                is MdBlock.Code -> CodeBlock(block, palette)
                is MdBlock.BulletList -> BulletListBlock(block, palette)
                is MdBlock.OrderedList -> OrderedListBlock(block, palette)
                is MdBlock.Quote -> QuoteBlock(block, palette)
                is MdBlock.Divider -> DividerBlock(palette)
                is MdBlock.Table -> TableBlock(block, palette)
            }
        }
    }
}

@Composable
private fun HeadingBlock(block: MdBlock.Heading, palette: ShivaPalette) {
    val style = when (block.level) {
        1 -> ShivaTypography.headlineSmall
        2 -> ShivaTypography.titleLarge
        else -> ShivaTypography.titleMedium
    }
    SelectionContainer {
        MarkdownInlineText(
            text = block.text,
            style = style.copy(fontWeight = FontWeight.SemiBold),
            color = palette.text,
        )
    }
}

@Composable
private fun ParagraphBlock(text: String, palette: ShivaPalette) {
    SelectionContainer {
        MarkdownInlineText(
            text = text,
            style = ShivaTypography.bodyLarge,
            color = palette.text,
        )
    }
}

@Composable
private fun CodeBlock(block: MdBlock.Code, palette: ShivaPalette) {
    val clipboard = LocalClipboardManager.current
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(palette.code)
            .border(1.dp, palette.hairline, RoundedCornerShape(16.dp))
            .padding(horizontal = 12.dp, vertical = 10.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = block.language.ifBlank { "code" },
                style = ShivaTypography.labelSmall,
                color = palette.dim,
            )
            IconButton(
                onClick = { clipboard.setText(AnnotatedString(block.code)) },
                modifier = Modifier.height(32.dp),
            ) {
                Icon(
                    Icons.Outlined.ContentCopy,
                    contentDescription = "Copy code",
                    tint = palette.muted,
                )
            }
        }
        SelectionContainer {
            Text(
                text = block.code.trimEnd(),
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState()),
                color = palette.text,
                fontFamily = FontFamily.Monospace,
                fontSize = 12.5.sp,
                lineHeight = 18.sp,
            )
        }
    }
}

@Composable
private fun BulletListBlock(block: MdBlock.BulletList, palette: ShivaPalette) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        block.items.forEach { item ->
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text("•", style = ShivaTypography.bodyLarge, color = palette.accent)
                SelectionContainer(modifier = Modifier.weight(1f)) {
                    MarkdownInlineText(
                        text = item,
                        style = ShivaTypography.bodyLarge,
                        color = palette.text,
                    )
                }
            }
        }
    }
}

@Composable
private fun OrderedListBlock(block: MdBlock.OrderedList, palette: ShivaPalette) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        block.items.forEachIndexed { index, item ->
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text(
                    text = "${block.start + index}.",
                    style = ShivaTypography.bodyLarge.copy(fontWeight = FontWeight.Medium),
                    color = palette.accent,
                )
                SelectionContainer(modifier = Modifier.weight(1f)) {
                    MarkdownInlineText(
                        text = item,
                        style = ShivaTypography.bodyLarge,
                        color = palette.text,
                    )
                }
            }
        }
    }
}

@Composable
private fun QuoteBlock(block: MdBlock.Quote, palette: ShivaPalette) {
    val accent = palette.accent
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(palette.accentSoft)
            .drawBehind {
                drawLine(
                    color = accent,
                    start = Offset(0f, 0f),
                    end = Offset(0f, size.height),
                    strokeWidth = 6.dp.toPx(),
                )
            }
            .padding(start = 14.dp, end = 12.dp, top = 10.dp, bottom = 10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        block.lines.forEach { line ->
            SelectionContainer {
                MarkdownInlineText(
                    text = line,
                    style = ShivaTypography.bodyLarge.copy(fontStyle = FontStyle.Italic),
                    color = palette.muted,
                )
            }
        }
    }
}

@Composable
private fun DividerBlock(palette: ShivaPalette) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp)
            .height(1.dp)
            .background(palette.hairline),
    )
}

@Composable
private fun TableBlock(block: MdBlock.Table, palette: ShivaPalette) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .clip(RoundedCornerShape(14.dp))
            .border(1.dp, palette.hairline, RoundedCornerShape(14.dp)),
    ) {
        TableRow(cells = block.headers, palette = palette, header = true)
        block.rows.forEach { row ->
            TableRow(cells = row, palette = palette, header = false)
        }
    }
}

@Composable
private fun TableRow(
    cells: List<String>,
    palette: ShivaPalette,
    header: Boolean,
) {
    Row(
        modifier = Modifier
            .background(if (header) palette.elevated else palette.code)
            .padding(horizontal = 4.dp),
    ) {
        cells.forEach { cell ->
            Box(
                modifier = Modifier
                    .width(120.dp)
                    .padding(horizontal = 8.dp, vertical = 8.dp),
            ) {
                MarkdownInlineText(
                    text = cell,
                    style = if (header) ShivaTypography.labelLarge else ShivaTypography.bodyMedium,
                    color = palette.text,
                )
            }
        }
    }
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(1.dp)
            .background(palette.hairline),
    )
}

@Composable
private fun MarkdownInlineText(
    text: String,
    style: TextStyle,
    color: Color,
) {
    val palette = LocalShivaPalette.current
    val uriHandler = LocalUriHandler.current
    val annotated = remember(text, palette.accent) {
        inlineMarkdown(
            text = text,
            linkColor = palette.accent,
            onLinkClick = { url -> uriHandler.openUri(url) },
        )
    }
    Text(
        text = annotated,
        style = style.copy(color = color),
    )
}

internal sealed interface MdBlock {
    data class Heading(val level: Int, val text: String) : MdBlock
    data class Paragraph(val text: String) : MdBlock
    data class Code(val language: String, val code: String) : MdBlock
    data class BulletList(val items: List<String>) : MdBlock
    data class OrderedList(val start: Int, val items: List<String>) : MdBlock
    data class Quote(val lines: List<String>) : MdBlock
    data object Divider : MdBlock
    data class Table(val headers: List<String>, val rows: List<List<String>>) : MdBlock
}

internal fun parseBlocks(text: String): List<MdBlock> {
    val blocks = mutableListOf<MdBlock>()
    val lines = text.replace("\r\n", "\n").split('\n')
    var i = 0

    fun flushParagraph(buffer: StringBuilder) {
        val value = buffer.toString().trim()
        if (value.isNotEmpty()) blocks += MdBlock.Paragraph(value)
        buffer.clear()
    }

    val paragraph = StringBuilder()
    while (i < lines.size) {
        val line = lines[i]
        val trimmed = line.trim()

        when {
            trimmed.startsWith("```") -> {
                flushParagraph(paragraph)
                val language = trimmed.removePrefix("```").trim()
                val code = StringBuilder()
                i += 1
                while (i < lines.size && !lines[i].trimStart().startsWith("```")) {
                    if (code.isNotEmpty()) code.append('\n')
                    code.append(lines[i])
                    i += 1
                }
                blocks += MdBlock.Code(language, code.toString())
            }

            lineContainsTablePipe(trimmed) &&
                i + 1 < lines.size &&
                isTableSeparatorLine(lines[i + 1].trim()) -> {
                flushParagraph(paragraph)
                val headers = splitTableRow(trimmed)
                val rows = mutableListOf<List<String>>()
                i += 2
                while (i < lines.size && lineContainsTablePipe(lines[i].trim())) {
                    val row = lines[i].trim()
                    if (!isTableSeparatorLine(row)) {
                        rows += splitTableRow(row)
                    }
                    i += 1
                }
                i -= 1
                blocks += MdBlock.Table(headers, rows)
            }

            trimmed.matches(Regex("^#{1,6}\\s+.+$")) -> {
                flushParagraph(paragraph)
                val level = trimmed.takeWhile { it == '#' }.length.coerceIn(1, 6)
                val content = trimmed.drop(level).trim()
                blocks += MdBlock.Heading(level.coerceAtMost(3), content)
            }

            trimmed == "---" || trimmed == "***" || trimmed == "___" -> {
                flushParagraph(paragraph)
                blocks += MdBlock.Divider
            }

            trimmed.startsWith("> ") || trimmed == ">" -> {
                flushParagraph(paragraph)
                val quoteLines = mutableListOf<String>()
                while (i < lines.size) {
                    val current = lines[i].trim()
                    if (current.startsWith("> ")) {
                        quoteLines += current.removePrefix("> ")
                    } else if (current == ">") {
                        quoteLines += ""
                    } else {
                        break
                    }
                    i += 1
                }
                i -= 1
                blocks += MdBlock.Quote(quoteLines.filter { it.isNotBlank() }.ifEmpty { listOf("") })
            }

            trimmed.matches(Regex("^[-*+]\\s+.+$")) -> {
                flushParagraph(paragraph)
                val items = mutableListOf<String>()
                while (i < lines.size && lines[i].trim().matches(Regex("^[-*+]\\s+.+$"))) {
                    items += lines[i].trim().replaceFirst(Regex("^[-*+]\\s+"), "")
                    i += 1
                }
                i -= 1
                blocks += MdBlock.BulletList(items)
            }

            trimmed.matches(Regex("^\\d+\\.\\s+.+$")) -> {
                flushParagraph(paragraph)
                val start = trimmed.takeWhile { it.isDigit() }.toIntOrNull() ?: 1
                val items = mutableListOf<String>()
                while (i < lines.size && lines[i].trim().matches(Regex("^\\d+\\.\\s+.+$"))) {
                    items += lines[i].trim().replaceFirst(Regex("^\\d+\\.\\s+"), "")
                    i += 1
                }
                i -= 1
                blocks += MdBlock.OrderedList(start, items)
            }

            trimmed.isEmpty() -> flushParagraph(paragraph)

            else -> {
                if (paragraph.isNotEmpty()) paragraph.append('\n')
                paragraph.append(line)
            }
        }
        i += 1
    }
    flushParagraph(paragraph)
    return blocks.ifEmpty { listOf(MdBlock.Paragraph(text)) }
}

private fun isTableSeparatorLine(line: String): Boolean {
    if (!line.contains('-')) return false
    val cells = splitTableRow(line)
    if (cells.isEmpty()) return false
    return cells.all { cell ->
        cell.isNotEmpty() && cell.all { it == '-' || it == ':' || it == ' ' }
    }
}

private fun lineContainsTablePipe(line: String): Boolean = line.contains('|')

private fun splitTableRow(line: String): List<String> {
    return line.trim()
        .removePrefix("|")
        .removeSuffix("|")
        .split('|')
        .map { it.trim() }
}

internal fun inlineMarkdown(
    text: String,
    linkColor: Color = Color.Unspecified,
    onLinkClick: ((String) -> Unit)? = null,
): AnnotatedString = buildAnnotatedString {
    var i = 0
    while (i < text.length) {
        when {
            text.startsWith("[", i) -> {
                val closeLabel = text.indexOf(']', i + 1)
                if (closeLabel > i && closeLabel + 1 < text.length && text[closeLabel + 1] == '(') {
                    val closeUrl = text.indexOf(')', closeLabel + 2)
                    if (closeUrl > closeLabel) {
                        val label = text.substring(i + 1, closeLabel)
                        val url = text.substring(closeLabel + 2, closeUrl)
                        val link = LinkAnnotation.Url(
                            url = url,
                            styles = TextLinkStyles(
                                style = SpanStyle(
                                    color = linkColor,
                                    textDecoration = TextDecoration.Underline,
                                    fontWeight = FontWeight.Medium,
                                ),
                            ),
                            linkInteractionListener = onLinkClick?.let { handler ->
                                LinkInteractionListener { handler(url) }
                            },
                        )
                        withLink(link) {
                            append(label)
                        }
                        i = closeUrl + 1
                        continue
                    }
                }
                append(text[i])
                i += 1
            }

            text.startsWith("***", i) || text.startsWith("___", i) -> {
                val marker = text.substring(i, i + 3)
                val end = text.indexOf(marker, i + 3)
                if (end > 0) {
                    pushStyle(
                        SpanStyle(fontWeight = FontWeight.SemiBold, fontStyle = FontStyle.Italic),
                    )
                    append(text.substring(i + 3, end))
                    pop()
                    i = end + 3
                } else {
                    append(text[i])
                    i += 1
                }
            }

            text.startsWith("**", i) || text.startsWith("__", i) -> {
                val marker = text.substring(i, i + 2)
                val end = text.indexOf(marker, i + 2)
                if (end > 0) {
                    pushStyle(SpanStyle(fontWeight = FontWeight.SemiBold))
                    append(text.substring(i + 2, end))
                    pop()
                    i = end + 2
                } else {
                    append(text[i])
                    i += 1
                }
            }

            text.startsWith("~~", i) -> {
                val end = text.indexOf("~~", i + 2)
                if (end > 0) {
                    pushStyle(SpanStyle(textDecoration = TextDecoration.LineThrough))
                    append(text.substring(i + 2, end))
                    pop()
                    i = end + 2
                } else {
                    append(text[i])
                    i += 1
                }
            }

            text.startsWith("`", i) -> {
                val end = text.indexOf('`', i + 1)
                if (end > 0) {
                    pushStyle(
                        SpanStyle(
                            fontFamily = FontFamily.Monospace,
                            fontSize = 13.sp,
                            background = Color(0x22000000),
                        ),
                    )
                    append(text.substring(i + 1, end))
                    pop()
                    i = end + 1
                } else {
                    append(text[i])
                    i += 1
                }
            }

            text.startsWith("*", i) || text.startsWith("_", i) -> {
                val marker = text[i]
                val end = text.indexOf(marker, i + 1)
                if (end > i + 1) {
                    pushStyle(SpanStyle(fontStyle = FontStyle.Italic))
                    append(text.substring(i + 1, end))
                    pop()
                    i = end + 1
                } else {
                    append(text[i])
                    i += 1
                }
            }

            else -> {
                append(text[i])
                i += 1
            }
        }
    }
}
