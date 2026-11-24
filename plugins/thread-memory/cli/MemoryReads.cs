using Microsoft.Data.Sqlite;
using ThreadMemoryHook;

namespace ThreadMemoryCli;

internal static class MemoryReads
{
    internal static void Record(HookStore store, string threadId)
    {
        long timestamp = HookStore.NowMicroseconds();
        try
        {
            using var connection = store.OpenExisting(SqliteOpenMode.ReadWrite);
            if (connection is null)
                return;
            using var command = connection.CreateCommand();
            command.CommandText = """
                CREATE TABLE IF NOT EXISTS memory_reads (
                    thread_id TEXT PRIMARY KEY NOT NULL,
                    last_read_us INTEGER NOT NULL
                )
                """;
            command.ExecuteNonQuery();

            command.CommandText = """
                INSERT INTO memory_reads (thread_id, last_read_us)
                SELECT $thread, $timestamp
                WHERE EXISTS (SELECT 1 FROM memory_revisions WHERE thread_id = $thread)
                ON CONFLICT(thread_id) DO UPDATE SET last_read_us = MAX(memory_reads.last_read_us, excluded.last_read_us)
                """;
            command.Parameters.AddWithValue("$thread", threadId);
            command.Parameters.AddWithValue("$timestamp", timestamp);
            command.ExecuteNonQuery();
        }
        catch (Exception error) when (error is SqliteException or IOException or UnauthorizedAccessException)
        {
            // A storage failure must not invalidate an already delivered note.
        }
    }
}
