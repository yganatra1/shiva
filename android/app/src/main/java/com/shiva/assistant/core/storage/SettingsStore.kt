package com.shiva.assistant.core.storage

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.shiva.assistant.core.design.ThemeMode
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.shivaDataStore by preferencesDataStore(name = "shiva_settings")

class SettingsStore(
    context: Context,
) {
    private val dataStore = context.applicationContext.shivaDataStore

    val settings: Flow<PersistedSettings> = dataStore.data.map { prefs ->
        PersistedSettings(
            serverUrl = prefs[SERVER_URL],
            onboardingComplete = prefs[ONBOARDING] ?: false,
            deviceName = prefs[DEVICE_NAME] ?: "",
            themeMode = runCatching { ThemeMode.valueOf(prefs[THEME] ?: ThemeMode.DARK.name) }
                .getOrDefault(ThemeMode.DARK),
            conversationId = prefs[CONVERSATION_ID],
            cachedTranscript = prefs[TRANSCRIPT],
            chatArchive = prefs[CHAT_ARCHIVE],
            lastSuccessfulConnectionMs = prefs[LAST_SUCCESS],
            keepAliveInBackground = prefs[KEEP_ALIVE] ?: true,
        )
    }

    suspend fun setServerUrl(url: String) {
        dataStore.edit { it[SERVER_URL] = url }
    }

    suspend fun setOnboardingComplete() {
        dataStore.edit { it[ONBOARDING] = true }
    }

    suspend fun setDeviceName(name: String) {
        dataStore.edit { it[DEVICE_NAME] = name }
    }

    suspend fun setThemeMode(mode: ThemeMode) {
        dataStore.edit { it[THEME] = mode.name }
    }

    suspend fun setConversation(conversationId: String?, transcriptJson: String?) {
        dataStore.edit { prefs ->
            if (conversationId == null) prefs.remove(CONVERSATION_ID) else prefs[CONVERSATION_ID] = conversationId
            if (transcriptJson == null) prefs.remove(TRANSCRIPT) else prefs[TRANSCRIPT] = transcriptJson
        }
    }

    suspend fun setChatArchive(archiveJson: String) {
        dataStore.edit { prefs ->
            prefs[CHAT_ARCHIVE] = archiveJson
            prefs.remove(CONVERSATION_ID)
            prefs.remove(TRANSCRIPT)
        }
    }

    suspend fun setLastSuccessfulConnection(epochMs: Long) {
        dataStore.edit { it[LAST_SUCCESS] = epochMs }
    }

    suspend fun setKeepAliveInBackground(enabled: Boolean) {
        dataStore.edit { it[KEEP_ALIVE] = enabled }
    }

    companion object {
        private val SERVER_URL = stringPreferencesKey("server_url")
        private val ONBOARDING = booleanPreferencesKey("onboarding_complete")
        private val DEVICE_NAME = stringPreferencesKey("device_name")
        private val THEME = stringPreferencesKey("theme_mode")
        private val CONVERSATION_ID = stringPreferencesKey("conversation_id")
        private val TRANSCRIPT = stringPreferencesKey("transcript_cache")
        private val CHAT_ARCHIVE = stringPreferencesKey("chat_archive_v1")
        private val LAST_SUCCESS = longPreferencesKey("last_success_ms")
        private val KEEP_ALIVE = booleanPreferencesKey("keep_alive_background")
    }
}

data class PersistedSettings(
    val serverUrl: String?,
    val onboardingComplete: Boolean,
    val deviceName: String,
    val themeMode: ThemeMode,
    val conversationId: String?,
    val cachedTranscript: String?,
    val chatArchive: String?,
    val lastSuccessfulConnectionMs: Long?,
    val keepAliveInBackground: Boolean,
)
