package com.shiva.assistant

import android.content.Context
import com.shiva.assistant.core.connection.BackgroundConnectionManager
import com.shiva.assistant.core.connection.ConnectionMonitor
import com.shiva.assistant.core.network.OkHttpDeviceChannel
import com.shiva.assistant.core.network.OkHttpShivaClient
import com.shiva.assistant.core.network.UnsupportedDeviceRegistrationClient
import com.shiva.assistant.core.security.KeystoreDeviceTokenStore
import com.shiva.assistant.core.security.SecureVault
import com.shiva.assistant.core.storage.SettingsStore
import com.shiva.assistant.data.chat.ChatRepository
import com.shiva.assistant.data.chat.DataStoreChatCache
import com.shiva.assistant.data.settings.SettingsRepository
import com.shiva.assistant.device.automation.AccessibilityUiEngine
import com.shiva.assistant.device.automation.AppLauncher
import com.shiva.assistant.device.automation.AppListCommandHandler
import com.shiva.assistant.device.automation.AppOpenCommandHandler
import com.shiva.assistant.device.automation.UiEngine
import com.shiva.assistant.device.camera.AndroidCameraController
import com.shiva.assistant.device.camera.CameraCommandHandler
import com.shiva.assistant.device.capability.AndroidCapabilityRegistry
import com.shiva.assistant.device.command.DeviceActivityLog
import com.shiva.assistant.device.command.DeviceCommandRouter
import com.shiva.assistant.device.contacts.AndroidContactsRepository
import com.shiva.assistant.device.contacts.ContactsCommandHandler
import com.shiva.assistant.device.identity.DeviceIdentityStore
import com.shiva.assistant.device.location.AndroidLocationController
import com.shiva.assistant.device.location.LocationCommandHandler
import com.shiva.assistant.device.notifications.AndroidNotificationSendController
import com.shiva.assistant.device.notifications.AndroidNotificationsRepository
import com.shiva.assistant.device.notifications.NotificationSendCommandHandler
import com.shiva.assistant.device.notifications.NotificationStore
import com.shiva.assistant.device.notifications.NotificationsListCommandHandler
import com.shiva.assistant.device.notifications.NotificationsReadCommandHandler
import com.shiva.assistant.device.phone.AndroidPhoneController
import com.shiva.assistant.device.phone.PhoneCommandHandler
import com.shiva.assistant.device.sms.AndroidSmsController
import com.shiva.assistant.device.sms.SmsCommandHandler
import com.shiva.assistant.device.status.AndroidDeviceStatusController
import com.shiva.assistant.device.status.DeviceStatusCommandHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicReference

class AppContainer(
    context: Context,
) {
    private val appContext = context.applicationContext
    private val ioScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    val applicationScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    val vault = SecureVault(appContext)
    val tokenStore = KeystoreDeviceTokenStore(vault)
    val identityStore = DeviceIdentityStore(vault)
    val settingsStore = SettingsStore(appContext)
    val settingsRepository = SettingsRepository(settingsStore, identityStore)

    private val serverUrl = AtomicReference<String?>(null)

    val client = OkHttpShivaClient(
        urlProvider = { serverUrl.get() },
        tokenStore = tokenStore,
    )
    val connectionMonitor = ConnectionMonitor(
        client = client,
        urlProvider = { serverUrl.get() },
        scope = ioScope,
    )
    val notificationStore = NotificationStore()
    val capabilities = AndroidCapabilityRegistry(appContext)
    val phoneController = AndroidPhoneController(appContext)
    val contactsRepository = AndroidContactsRepository(appContext)
    val notificationsRepository = AndroidNotificationsRepository(appContext, notificationStore)
    val smsController = AndroidSmsController(appContext)
    val locationController = AndroidLocationController(appContext)
    val deviceStatusController = AndroidDeviceStatusController(appContext)
    val notificationSendController = AndroidNotificationSendController(appContext)
    val cameraController = AndroidCameraController(appContext)
    val uiEngine: UiEngine = AccessibilityUiEngine()
    val appLauncher = AppLauncher(appContext)
    val deviceActivityLog = DeviceActivityLog()
    val commandRouter = DeviceCommandRouter(
        handlers = listOf(
            PhoneCommandHandler(phoneController),
            ContactsCommandHandler(contactsRepository),
            NotificationsListCommandHandler(notificationsRepository),
            NotificationsReadCommandHandler(notificationsRepository),
            SmsCommandHandler(smsController),
            LocationCommandHandler(locationController),
            DeviceStatusCommandHandler(deviceStatusController),
            NotificationSendCommandHandler(notificationSendController),
            CameraCommandHandler(cameraController),
            AppOpenCommandHandler(appLauncher),
            AppListCommandHandler(appLauncher),
        ),
        observer = deviceActivityLog,
    )
    val deviceChannel = OkHttpDeviceChannel(
        urlProvider = { serverUrl.get() },
        tokenStore = tokenStore,
        commandRouter = commandRouter,
        scope = ioScope,
    )
    val backgroundConnectionManager = BackgroundConnectionManager(
        context = appContext,
        connectionMonitor = connectionMonitor,
        deviceChannel = deviceChannel,
        scope = applicationScope,
    )
    val chatRepository = ChatRepository(
        client = client,
        cache = DataStoreChatCache(settingsStore),
        updateScope = applicationScope,
    )
    val registrationClient = UnsupportedDeviceRegistrationClient()

    fun rememberServerUrl(url: String?) {
        serverUrl.set(url)
    }

    init {
        applicationScope.launch {
            settingsStore.settings.collect { settings ->
                settings.serverUrl?.let { serverUrl.set(it) }
                backgroundConnectionManager.syncFromSettings(settings)
            }
        }
        applicationScope.launch {
            chatRepository.restore()
        }
        connectionMonitor.start()
    }
}
