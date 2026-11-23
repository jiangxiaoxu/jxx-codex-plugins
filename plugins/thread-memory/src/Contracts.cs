namespace ThreadMemoryHook;

internal sealed record ReminderReceipt(string NotifyId, int Tier, string RecordKey, string? RecordedAt);

internal sealed record CompactionObservation(string Window, string? CompactedAt, string? PreviousWindow);

internal sealed record StoredCheckpoint(string Path, string Raw);
