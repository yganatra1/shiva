package com.shiva.assistant.feature.chat

import android.Manifest
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.MicNone
import androidx.compose.material.icons.outlined.PhotoCamera
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil.compose.AsyncImage
import com.shiva.assistant.AppContainer
import com.shiva.assistant.core.connection.ConnectionStatus
import com.shiva.assistant.core.design.EmptyState
import com.shiva.assistant.core.design.LocalShivaPalette
import com.shiva.assistant.core.design.ShivaTypography
import com.shiva.assistant.core.design.StatusChip
import com.shiva.assistant.data.chat.ChatImageAttachment
import com.shiva.assistant.data.chat.ChatMessage
import com.shiva.assistant.data.chat.ChatRole
import com.shiva.assistant.data.chat.MessageStatus
import com.shiva.assistant.data.settings.AppSettings
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@Composable
fun ChatScreen(
    container: AppContainer,
    settings: AppSettings,
    modifier: Modifier = Modifier,
) {
    val palette = LocalShivaPalette.current
    val chat by container.chatRepository.state.collectAsStateWithLifecycle()
    val conversations by container.chatRepository.conversations.collectAsStateWithLifecycle()
    val activeConversationId by container.chatRepository.activeConversationId.collectAsStateWithLifecycle()
    val connection by container.connectionMonitor.state.collectAsStateWithLifecycle()
    var composer by remember { mutableStateOf("") }
    var pendingImageUri by remember { mutableStateOf<Uri?>(null) }
    var imageError by remember { mutableStateOf<String?>(null) }
    var voiceHint by remember { mutableStateOf(false) }
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var captureUri by remember { mutableStateOf<Uri?>(null) }
    val drawerState = rememberDrawerState(DrawerValue.Closed)

    val pickImage = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia(),
    ) { uri ->
        if (uri != null) {
            pendingImageUri = uri
            imageError = null
        }
    }

    val takePicture = rememberLauncherForActivityResult(
        ActivityResultContracts.TakePicture(),
    ) { success ->
        if (success) {
            pendingImageUri = captureUri
            imageError = null
        }
    }

    val requestCameraPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) {
            val file = File(context.cacheDir, "chat_capture_${System.currentTimeMillis()}.jpg")
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
            captureUri = uri
            takePicture.launch(uri)
        } else {
            imageError = "Camera permission is required to take a photo."
        }
    }

    LaunchedEffect(chat.messages.size, chat.messages.lastOrNull()?.content) {
        if (chat.messages.isNotEmpty()) {
            listState.animateScrollToItem(chat.messages.lastIndex)
        }
    }

    fun launchCamera() {
        val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED
        if (granted) {
            val file = File(context.cacheDir, "chat_capture_${System.currentTimeMillis()}.jpg")
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
            captureUri = uri
            takePicture.launch(uri)
        } else {
            requestCameraPermission.launch(Manifest.permission.CAMERA)
        }
    }

    ConversationNavigationDrawer(
        drawerState = drawerState,
        conversations = conversations,
        activeConversationId = activeConversationId,
        switchingEnabled = !chat.sending,
        onNewConversation = {
            pendingImageUri = null
            scope.launch {
                container.chatRepository.newConversation()
                drawerState.close()
            }
        },
        onSelectConversation = { localId ->
            pendingImageUri = null
            scope.launch {
                container.chatRepository.selectConversation(localId)
                drawerState.close()
            }
        },
        onRenameConversation = { localId, title ->
            scope.launch { container.chatRepository.renameConversation(localId, title) }
        },
        onDeleteConversation = { localId ->
            pendingImageUri = null
            scope.launch { container.chatRepository.deleteConversation(localId) }
        },
    ) {
        Column(
            modifier = modifier
                .fillMaxSize()
                .background(palette.background)
                .imePadding(),
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 8.dp, end = 12.dp, top = 8.dp, bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Row(
                    modifier = Modifier.weight(1f),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconButton(onClick = { scope.launch { drawerState.open() } }) {
                        Icon(
                            Icons.Outlined.Menu,
                            contentDescription = "Open conversations",
                            tint = palette.text,
                        )
                    }
                    Column(modifier = Modifier.weight(1f)) {
                        Text("Shiva", style = ShivaTypography.headlineSmall, color = palette.text)
                        Text(
                            text = croppedChatTitle(
                                conversations
                                    .firstOrNull { it.localId == activeConversationId }
                                    ?.title
                                    ?: settings.identity.deviceName,
                            ),
                            style = ShivaTypography.bodySmall,
                            color = palette.muted,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            softWrap = false,
                        )
                    }
                }
                StatusChip(
                    label = connection.label(),
                    connected = connection.status == ConnectionStatus.CONNECTED,
                    connecting = connection.status == ConnectionStatus.CONNECTING,
                )
            }
            Box(modifier = Modifier.weight(1f)) {
                if (chat.messages.isEmpty()) {
                    EmptyState(
                        title = "Shiva is ready",
                        body = "Ask anything, or attach a photo. Your phone talks to your own server over Tailscale.",
                        modifier = Modifier
                            .align(Alignment.Center)
                            .padding(32.dp),
                    )
                } else {
                    LazyColumn(
                        state = listState,
                        modifier = Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        items(chat.messages, key = { it.id }) { message ->
                            MessageBubble(
                                message = message,
                                onRetry = {
                                    scope.launch { container.chatRepository.retry(message.id) }
                                },
                            )
                        }
                    }
                }
            }
            AnimatedVisibility(visible = voiceHint) {
                Text(
                    text = "Voice is coming next. Audio will go to your Shiva server, not a second brain on this phone.",
                    modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp),
                    style = ShivaTypography.bodySmall,
                    color = palette.muted,
                )
            }
            if (connection.status == ConnectionStatus.SERVER_UNAVAILABLE ||
                connection.status == ConnectionStatus.AUTHENTICATION_FAILED ||
                connection.status == ConnectionStatus.DISCONNECTED
            ) {
                Text(
                    text = "Unable to reach Shiva. Check Tailscale, that the server is running, and the configured address.",
                    modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp),
                    style = ShivaTypography.bodySmall,
                    color = palette.danger,
                )
            }
            imageError?.let { error ->
                Text(
                    text = error,
                    modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp),
                    style = ShivaTypography.bodySmall,
                    color = palette.danger,
                )
            }
            pendingImageUri?.let { uri ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    AsyncImage(
                        model = uri,
                        contentDescription = "Attached photo",
                        modifier = Modifier
                            .size(64.dp)
                            .clip(RoundedCornerShape(12.dp))
                            .border(1.dp, palette.hairline, RoundedCornerShape(12.dp)),
                        contentScale = ContentScale.Crop,
                    )
                    Text(
                        "Photo attached",
                        style = ShivaTypography.bodySmall,
                        color = palette.muted,
                        modifier = Modifier.weight(1f),
                    )
                    IconButton(onClick = { pendingImageUri = null }) {
                        Icon(Icons.Outlined.Close, contentDescription = "Remove photo", tint = palette.muted)
                    }
                }
            }
            ComposerBar(
                value = composer,
                onValueChange = { composer = it },
                sending = chat.sending,
                canSend = (composer.isNotBlank() || pendingImageUri != null) && !chat.sending,
                onSend = {
                    val text = composer
                    val uri = pendingImageUri
                    composer = ""
                    pendingImageUri = null
                    imageError = null
                    scope.launch {
                        val attachments = if (uri != null) {
                            val encoded = withContext(Dispatchers.IO) {
                                ChatImageEncoder.encodeJpegBase64(context, uri)
                            }
                            if (encoded == null) {
                                imageError = "Could not prepare that photo. Try another image."
                                return@launch
                            }
                            listOf(ChatImageAttachment(base64Jpeg = encoded, previewUri = uri.toString()))
                        } else {
                            emptyList()
                        }
                        container.chatRepository.send(text, attachments)
                    }
                },
                onNewConversation = {
                    pendingImageUri = null
                    scope.launch { container.chatRepository.newConversation() }
                },
                onAttach = {
                    pickImage.launch(
                        PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly),
                    )
                },
                onCamera = { launchCamera() },
                onMic = { voiceHint = true },
            )
        }
    }
}

@Composable
private fun MessageBubble(
    message: ChatMessage,
    onRetry: () -> Unit,
) {
    val palette = LocalShivaPalette.current
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current
    val isUser = message.role == ChatRole.USER
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
    ) {
        Column(
            modifier = Modifier.widthIn(max = if (isUser) 320.dp else 420.dp),
            horizontalAlignment = if (isUser) Alignment.End else Alignment.Start,
        ) {
            if (!isUser) {
                Text("Shiva", style = ShivaTypography.labelSmall, color = palette.accent)
                Spacer(Modifier.height(4.dp))
            }
            Box(
                modifier = Modifier
                    .clip(RoundedCornerShape(22.dp))
                    .background(if (isUser) palette.userBubble else palette.assistantBubble)
                    .border(1.dp, palette.hairline, RoundedCornerShape(22.dp))
                    .padding(horizontal = 16.dp, vertical = 12.dp),
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    message.imagePreviewUri?.let { preview ->
                        AsyncImage(
                            model = Uri.parse(preview),
                            contentDescription = "Sent photo",
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(160.dp)
                                .clip(RoundedCornerShape(14.dp)),
                            contentScale = ContentScale.Crop,
                        )
                    }
                    when {
                        message.status == MessageStatus.THINKING && message.content.isBlank() -> {
                            Text("Thinking…", style = ShivaTypography.bodyMedium, color = palette.muted)
                        }
                        message.status == MessageStatus.FAILED && message.content.isBlank() -> {
                            Text(
                                message.error ?: "Shiva could not complete the request.",
                                style = ShivaTypography.bodyMedium,
                                color = palette.danger,
                            )
                        }
                        message.content.isNotBlank() -> MarkdownMessage(message.content)
                    }
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = formatStamp(message.createdAtEpochMs),
                    style = ShivaTypography.labelSmall,
                    color = palette.dim,
                    modifier = Modifier.padding(top = 6.dp, start = 4.dp, end = 4.dp),
                )
                if (message.content.isNotBlank()) {
                    IconButton(
                        onClick = {
                            clipboard.setText(AnnotatedString(message.content))
                            // Android 13+ shows its own clipboard confirmation popup.
                            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
                                Toast.makeText(context, "Message copied", Toast.LENGTH_SHORT).show()
                            }
                        },
                        modifier = Modifier.size(32.dp),
                    ) {
                        Icon(
                            Icons.Outlined.ContentCopy,
                            contentDescription = "Copy message",
                            tint = palette.muted,
                            modifier = Modifier.size(18.dp),
                        )
                    }
                }
                if (message.status == MessageStatus.FAILED) {
                    IconButton(onClick = onRetry, modifier = Modifier.size(32.dp)) {
                        Icon(Icons.Outlined.Refresh, contentDescription = "Retry", tint = palette.accent)
                    }
                }
            }
        }
    }
}

internal const val COMPOSER_MAX_LINES = 6

@Composable
private fun ComposerBar(
    value: String,
    onValueChange: (String) -> Unit,
    sending: Boolean,
    canSend: Boolean,
    onSend: () -> Unit,
    onNewConversation: () -> Unit,
    onAttach: () -> Unit,
    onCamera: () -> Unit,
    onMic: () -> Unit,
) {
    val palette = LocalShivaPalette.current
    var composerFocused by remember { mutableStateOf(false) }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 6.dp),
        verticalAlignment = Alignment.Bottom,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        IconButton(
            onClick = onNewConversation,
            modifier = Modifier
                .clip(CircleShape)
                .background(palette.elevated),
        ) {
            Icon(Icons.Outlined.Add, contentDescription = "New conversation", tint = palette.text)
        }
        AnimatedVisibility(visible = !composerFocused) {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                IconButton(onClick = onAttach, enabled = !sending) {
                    Icon(Icons.Outlined.Image, contentDescription = "Attach photo", tint = palette.text)
                }
                IconButton(onClick = onCamera, enabled = !sending) {
                    Icon(Icons.Outlined.PhotoCamera, contentDescription = "Take photo", tint = palette.text)
                }
            }
        }
        TextField(
            value = value,
            onValueChange = onValueChange,
            modifier = Modifier
                .weight(1f)
                .heightIn(min = 48.dp)
                .onFocusChanged { composerFocused = it.isFocused },
            placeholder = { Text("Message Shiva", color = palette.dim) },
            minLines = 1,
            maxLines = COMPOSER_MAX_LINES,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Default),
            shape = RoundedCornerShape(24.dp),
            colors = TextFieldDefaults.colors(
                focusedContainerColor = palette.surface,
                unfocusedContainerColor = palette.surface,
                focusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
                unfocusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
                cursorColor = palette.accent,
                focusedTextColor = palette.text,
                unfocusedTextColor = palette.text,
            ),
        )
        IconButton(onClick = onMic) {
            Icon(Icons.Outlined.MicNone, contentDescription = "Voice coming next", tint = palette.muted)
        }
        IconButton(
            onClick = onSend,
            enabled = canSend,
            modifier = Modifier
                .clip(CircleShape)
                .background(if (canSend) palette.accent else palette.elevated),
        ) {
            Icon(
                Icons.AutoMirrored.Outlined.Send,
                contentDescription = "Send",
                tint = if (canSend) com.shiva.assistant.core.design.ShivaColors.Graphite else palette.muted,
            )
        }
    }
}

internal const val CHAT_TITLE_DISPLAY_MAX_CHARS = 22
internal const val DRAWER_TITLE_DISPLAY_MAX_CHARS = 28

internal fun croppedChatTitle(
    title: String,
    maxChars: Int = CHAT_TITLE_DISPLAY_MAX_CHARS,
): String {
    val normalized = title.trim()
    if (normalized.length <= maxChars) return normalized
    return normalized.take(maxChars).trimEnd() + "…"
}

private val TIME = DateTimeFormatter.ofPattern("h:mm a")

private fun formatStamp(epochMs: Long): String {
    return Instant.ofEpochMilli(epochMs).atZone(ZoneId.systemDefault()).toLocalTime().format(TIME)
}
