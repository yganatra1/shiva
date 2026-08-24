package com.shiva.assistant.core.security

class KeystoreDeviceTokenStore(
    private val vault: SecureVault,
) : DeviceTokenStore {
    override fun token(): String? = vault.getString(SecureVault.DEVICE_TOKEN)

    override fun save(token: String) {
        vault.putString(SecureVault.DEVICE_TOKEN, token)
    }

    override fun clear() {
        vault.remove(SecureVault.DEVICE_TOKEN)
    }
}
