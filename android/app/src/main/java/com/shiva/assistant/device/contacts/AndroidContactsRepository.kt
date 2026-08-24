package com.shiva.assistant.device.contacts

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.provider.ContactsContract
import androidx.core.content.ContextCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class AndroidContactsRepository(
    context: Context,
) : ContactsRepository {
    private val appContext = context.applicationContext

    override suspend fun search(query: String, limit: Int): List<ContactMatch> = withContext(Dispatchers.IO) {
        if (ContextCompat.checkSelfPermission(appContext, Manifest.permission.READ_CONTACTS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            return@withContext emptyList()
        }
        val trimmed = query.trim()
        if (trimmed.isEmpty()) return@withContext emptyList()
        val uri = ContactsContract.CommonDataKinds.Phone.CONTENT_FILTER_URI.buildUpon()
            .appendPath(trimmed)
            .build()
        val projection = arrayOf(
            ContactsContract.CommonDataKinds.Phone.CONTACT_ID,
            ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
            ContactsContract.CommonDataKinds.Phone.NUMBER,
        )
        appContext.contentResolver.query(uri, projection, null, null, null)?.use { cursor ->
            val idIdx = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.CONTACT_ID)
            val nameIdx = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME)
            val numberIdx = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.NUMBER)
            val results = LinkedHashMap<String, ContactMatch>()
            while (cursor.moveToNext() && results.size < limit) {
                val id = cursor.getString(idIdx) ?: continue
                if (results.containsKey(id)) continue
                results[id] = ContactMatch(
                    id = id,
                    displayName = cursor.getString(nameIdx).orEmpty(),
                    phoneNumber = cursor.getString(numberIdx),
                )
            }
            results.values.toList()
        } ?: emptyList()
    }
}
