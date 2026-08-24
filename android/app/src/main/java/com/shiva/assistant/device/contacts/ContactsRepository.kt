package com.shiva.assistant.device.contacts

data class ContactMatch(
    val id: String,
    val displayName: String,
    val phoneNumber: String?,
)

interface ContactsRepository {
    suspend fun search(query: String, limit: Int = 8): List<ContactMatch>
}
