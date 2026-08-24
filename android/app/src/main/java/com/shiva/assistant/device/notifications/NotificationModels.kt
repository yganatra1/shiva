package com.shiva.assistant.device.notifications

import kotlinx.serialization.Serializable

@Serializable
data class NotificationSummary(
    val key: String,
    val packageName: String,
    val title: String,
    val text: String,
    val postTimeEpochMs: Long,
)

@Serializable
data class NotificationActionSummary(
    val title: String,
)

@Serializable
data class NotificationDetail(
    val key: String,
    val packageName: String,
    val title: String,
    val text: String,
    val bigText: String,
    val postTimeEpochMs: Long,
    val category: String?,
    val actions: List<NotificationActionSummary>,
)

internal fun notificationKey(
    packageName: String,
    tag: String?,
    id: Int,
    postTimeEpochMs: Long,
): String = listOf(packageName, tag.orEmpty(), id.toString(), postTimeEpochMs.toString())
    .joinToString("|")
