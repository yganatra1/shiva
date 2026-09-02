package com.shiva.assistant.feature.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Forum
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DrawerState
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.shiva.assistant.core.design.LocalShivaPalette
import com.shiva.assistant.core.design.ShivaTypography
import com.shiva.assistant.data.chat.ConversationSummary
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ConversationNavigationDrawer(
    drawerState: DrawerState,
    conversations: List<ConversationSummary>,
    activeConversationId: String?,
    switchingEnabled: Boolean,
    onNewConversation: () -> Unit,
    onSelectConversation: (String) -> Unit,
    onRenameConversation: (String, String) -> Unit,
    onDeleteConversation: (String) -> Unit,
    content: @Composable () -> Unit,
) {
    val palette = LocalShivaPalette.current
    var renameTarget by remember { mutableStateOf<ConversationSummary?>(null) }
    var deleteTarget by remember { mutableStateOf<ConversationSummary?>(null) }

    ModalNavigationDrawer(
        drawerState = drawerState,
        gesturesEnabled = true,
        drawerContent = {
            ModalDrawerSheet(
                modifier = Modifier
                    .width(320.dp)
                    .fillMaxHeight(),
                drawerContainerColor = palette.surface,
                drawerContentColor = palette.text,
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxHeight()
                        .padding(top = 16.dp),
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 20.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(Icons.Outlined.Forum, contentDescription = null, tint = palette.accent)
                        Text(
                            text = "Conversations",
                            style = ShivaTypography.headlineSmall,
                            color = palette.text,
                            modifier = Modifier.padding(start = 12.dp),
                        )
                    }
                    NewConversationRow(
                        enabled = switchingEnabled,
                        onClick = onNewConversation,
                    )
                    HorizontalDivider(color = palette.hairline)
                    if (conversations.isEmpty()) {
                        Text(
                            text = "Your previous conversations will appear here.",
                            style = ShivaTypography.bodyMedium,
                            color = palette.muted,
                            modifier = Modifier.padding(24.dp),
                        )
                    } else {
                        LazyColumn(
                            modifier = Modifier.weight(1f),
                            verticalArrangement = Arrangement.spacedBy(4.dp),
                        ) {
                            items(conversations, key = { it.localId }) { conversation ->
                                ConversationRow(
                                    conversation = conversation,
                                    selected = conversation.localId == activeConversationId,
                                    enabled = switchingEnabled,
                                    onClick = { onSelectConversation(conversation.localId) },
                                    onRename = { renameTarget = conversation },
                                    onDelete = { deleteTarget = conversation },
                                )
                            }
                        }
                    }
                    Text(
                        text = if (switchingEnabled) {
                            "Conversation history is stored on this phone."
                        } else {
                            "Wait for Shiva to finish before switching chats."
                        },
                        style = ShivaTypography.labelSmall,
                        color = palette.dim,
                        modifier = Modifier.padding(20.dp),
                    )
                }
            }
        },
        content = content,
    )

    renameTarget?.let { conversation ->
        RenameConversationDialog(
            currentTitle = conversation.title,
            onDismiss = { renameTarget = null },
            onRename = { title ->
                onRenameConversation(conversation.localId, title)
                renameTarget = null
            },
        )
    }

    deleteTarget?.let { conversation ->
        DeleteConversationDialog(
            title = conversation.title,
            onDismiss = { deleteTarget = null },
            onDelete = {
                onDeleteConversation(conversation.localId)
                deleteTarget = null
            },
        )
    }
}

@Composable
private fun NewConversationRow(
    enabled: Boolean,
    onClick: () -> Unit,
) {
    val palette = LocalShivaPalette.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 20.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            Icons.Outlined.Add,
            contentDescription = null,
            tint = if (enabled) palette.accent else palette.dim,
        )
        Text(
            text = "New conversation",
            style = ShivaTypography.titleMedium,
            color = if (enabled) palette.text else palette.dim,
            modifier = Modifier.padding(start = 12.dp),
        )
    }
}

@Composable
private fun ConversationRow(
    conversation: ConversationSummary,
    selected: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
    onRename: () -> Unit,
    onDelete: () -> Unit,
) {
    val palette = LocalShivaPalette.current
    val shape = RoundedCornerShape(14.dp)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 10.dp)
            .clip(shape)
            .background(if (selected) palette.elevated else Color.Transparent)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(start = 12.dp, top = 10.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = croppedChatTitle(conversation.title, DRAWER_TITLE_DISPLAY_MAX_CHARS),
                style = ShivaTypography.bodyMedium,
                color = if (enabled) palette.text else palette.dim,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                softWrap = false,
            )
            Text(
                text = formatConversationDate(conversation.updatedAtEpochMs),
                style = ShivaTypography.labelSmall,
                color = palette.dim,
            )
        }
        IconButton(onClick = onRename, enabled = enabled) {
            Icon(
                Icons.Outlined.Edit,
                contentDescription = "Rename ${conversation.title}",
                tint = if (enabled) palette.muted else palette.dim,
            )
        }
        IconButton(onClick = onDelete, enabled = enabled) {
            Icon(
                Icons.Outlined.DeleteOutline,
                contentDescription = "Delete ${conversation.title}",
                tint = if (enabled) palette.muted else palette.dim,
            )
        }
    }
}

@Composable
private fun RenameConversationDialog(
    currentTitle: String,
    onDismiss: () -> Unit,
    onRename: (String) -> Unit,
) {
    val palette = LocalShivaPalette.current
    var title by remember(currentTitle) { mutableStateOf(currentTitle) }
    val valid = title.isNotBlank()

    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = palette.surface,
        titleContentColor = palette.text,
        textContentColor = palette.muted,
        title = { Text("Rename conversation") },
        text = {
            OutlinedTextField(
                value = title,
                onValueChange = { if (it.length <= 80) title = it },
                label = { Text("Conversation name") },
                singleLine = true,
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = palette.accent,
                    cursorColor = palette.accent,
                    focusedTextColor = palette.text,
                    unfocusedTextColor = palette.text,
                ),
            )
        },
        confirmButton = {
            TextButton(
                enabled = valid,
                onClick = { onRename(title) },
            ) {
                Text("Rename", color = if (valid) palette.accent else palette.dim)
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel", color = palette.muted)
            }
        },
    )
}

@Composable
private fun DeleteConversationDialog(
    title: String,
    onDismiss: () -> Unit,
    onDelete: () -> Unit,
) {
    val palette = LocalShivaPalette.current
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = palette.surface,
        titleContentColor = palette.text,
        textContentColor = palette.muted,
        title = { Text("Delete conversation") },
        text = {
            Text("\"$title\" and its messages will be removed from this phone. This cannot be undone.")
        },
        confirmButton = {
            TextButton(onClick = onDelete) {
                Text("Delete", color = palette.danger)
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel", color = palette.muted)
            }
        },
    )
}

private val CONVERSATION_DATE = DateTimeFormatter.ofPattern("MMM d")

private fun formatConversationDate(epochMs: Long): String =
    Instant.ofEpochMilli(epochMs)
        .atZone(ZoneId.systemDefault())
        .format(CONVERSATION_DATE)
