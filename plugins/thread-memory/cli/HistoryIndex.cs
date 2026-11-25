using System.Buffers.Binary;
using System.Globalization;
using System.Numerics;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using SQLitePCL;
using ThreadMemoryHook;
using static SQLitePCL.raw;

namespace ThreadMemoryCli;

internal readonly record struct HistoryAnnotation(string? Cwd, string? ActiveTurn = null, bool InPrefix = false,
    bool OwnsLegacyHistory = false);

internal readonly record struct HistoryIndexedRecord(long Line, long Offset, long Length, string? Timestamp,
    bool Checkpoint, int? WindowNumber, HistoryAnnotation Next);

internal readonly record struct HistoryIndexLocation(long Line, long Offset, long Length, long? TimestampMicroseconds,
    HistoryAnnotation State);

internal sealed class HistoryIndexUnavailable(string message) : Exception(message);

internal sealed class HistoryIndex : IDisposable
{
    private const int Version = 1;
    private const int AnchorBytes = 4096;
    private const int BusyTimeoutMilliseconds = 250;

    private readonly SqliteConnection database;
    private readonly string sourcePath;
    private readonly IndexPosition position;

    private HistoryIndex(SqliteConnection database, FileStream file, string sourcePath, IndexPosition position)
    {
        this.database = database;
        this.sourcePath = sourcePath;
        this.position = position;
        File = file;
    }

    internal FileStream File { get; }

    private sealed record FileSeal(string Device, string Inode, long Size, string Modified, byte[] Prefix, byte[] Tail)
    {
        internal bool SameAs(FileSeal other) => Device == other.Device && Inode == other.Inode && Size == other.Size &&
            Modified == other.Modified && Prefix.AsSpan().SequenceEqual(other.Prefix) && Tail.AsSpan().SequenceEqual(other.Tail);
    }

    private sealed record IndexPosition(long Key, FileSeal Seal, long LastLine, long StateLine, HistoryAnnotation State);

    internal static HistoryIndex? TryOpen(string home, HistorySegment segment,
        Func<FileStream, long, long, long, HistoryAnnotation, IEnumerable<HistoryIndexedRecord>> scan,
        bool build = true, long? throughLine = null)
    {
        if (segment.EndOffset is not null || segment.EndOrdinal is not null ||
            !segment.Path.EndsWith(".jsonl", StringComparison.Ordinal))
            return null;

        FileStream? source = null;
        SqliteConnection? connection = null;
        try
        {
            source = OpenFile(segment.Path);
            RolloutPath rollout = RolloutPath.Resolve(segment.Path, source);
            string path = OrdinaryPath(rollout.Key);
            if (!InSessionDirectory(path, home) || VerifiedOwner(rollout.Name, segment.Header) is not string owner)
                return null;

            string databasePath = Path.Combine(home, "state", "plugins", "thread-memory", "rollout-index.sqlite3");
            FileSeal? initialSeal = null;
            if (!System.IO.File.Exists(databasePath))
            {
                if (!build)
                    return null;
                initialSeal = CaptureSeal(rollout.Key, source, segment.Header, rollout.Stat);
            }

            if (build)
                Directory.CreateDirectory(Path.GetDirectoryName(databasePath)!);
            connection = OpenDatabase(databasePath, build);
            Run(connection, "BEGIN");
            IndexPosition? found = ReadPosition(connection, path);
            if (found is null && !build)
                return null;

            // A later tool call can append records after a reference was minted. An
            // exact line in the verified prefix remains safe to seek immediately.
            bool coveringPrefix = found is not null && throughLine <= found.LastLine &&
                MatchesPrefix(rollout.Key, source, found.Seal);
            if (!coveringPrefix)
            {
                FileSeal seal = initialSeal ?? CaptureSeal(rollout.Key, source, segment.Header, rollout.Stat);
                if (found is null || !found.Seal.SameAs(seal))
                {
                    Run(connection, "ROLLBACK");
                    Run(connection, "BEGIN IMMEDIATE");
                    found = ReadPosition(connection, path);
                    if (found is null && !build)
                        return null;
                    RolloutFileStat current = RolloutFileStat.Capture(source);
                    if (current != rollout.Stat)
                        seal = CaptureSeal(rollout.Key, source, segment.Header, current);
                    if (found is null || !found.Seal.SameAs(seal))
                        Refresh(connection, path, owner, rollout.Key, source, segment.Header, scan, seal, found);
                    Run(connection, "COMMIT");
                    Run(connection, "BEGIN");
                    found = ReadPosition(connection, path);
                }
            }
            if (found is null)
                return null;

            var index = new HistoryIndex(connection, source, rollout.Key, found);
            if (!coveringPrefix)
                index.Verify();
            connection = null;
            source = null;
            return index;
        }
        catch (Exception error) when (error is HistoryIndexUnavailable or RolloutReadException or
            SqliteException or IOException or UnauthorizedAccessException or JsonException or InvalidOperationException)
        {
            return null;
        }
        finally
        {
            connection?.Dispose();
            source?.Dispose();
        }
    }

    internal void Verify()
    {
        try
        {
            if (MatchesPrefix(sourcePath, File, position.Seal))
                return;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            throw new HistoryIndexUnavailable("Cannot verify the indexed rollout.");
        }
        throw new HistoryIndexUnavailable("Rollout changed during indexed search.");
    }

    internal IEnumerable<(long Line, int? WindowNumber)> Checkpoints()
    {
        using sqlite3_stmt statement = Prepare(database, """
            SELECT line, window_number FROM record_locations
            WHERE rollout = ? AND is_checkpoint = 1 ORDER BY line
            """);
        Bind(database, statement, position.Key);
        while (ReadRow(statement))
        {
            string? raw = OptionalText(statement, 1);
            int? number = int.TryParse(raw, NumberStyles.None, CultureInfo.InvariantCulture, out int parsed) ? parsed : null;
            yield return (sqlite3_column_int64(statement, 0), number);
        }
    }

    internal IEnumerable<HistoryIndexLocation> Rows(long firstLine, long? lastLine, DateTimeOffset? since,
        DateTimeOffset? until, bool reverse = false)
    {
        long last = Math.Min(lastLine ?? position.LastLine, position.LastLine);
        firstLine = Math.Max(1, firstLine);
        if (firstLine > last)
            yield break;

        var parameters = new List<object?> { position.Key, firstLine, last };
        string filter = "r.rollout = ? AND r.line BETWEEN ? AND ?";
        if (since is DateTimeOffset start)
        {
            filter += " AND r.timestamp_us >= ?";
            parameters.Add(Microseconds(start));
        }
        if (until is DateTimeOffset stop)
        {
            filter += " AND r.timestamp_us < ?";
            parameters.Add(Microseconds(stop));
        }

        string index = parameters.Count > 3 && firstLine == 1 && last == position.LastLine
            ? " INDEXED BY locations_time" : "";
        string order = reverse ? "DESC" : "ASC";
        using sqlite3_stmt statement = Prepare(database, $"""
            SELECT r.line, r.offset, r.length, r.timestamp_us, s.cwd, s.active_turn, s.in_prefix
            FROM record_locations AS r{index}
            JOIN annotation_states AS s ON s.rollout = r.rollout AND s.line = r.state_line
            WHERE {filter} ORDER BY r.line {order}
            """);
        Bind(database, statement, parameters.ToArray());
        while (ReadRow(statement))
        {
            long offset = sqlite3_column_int64(statement, 1);
            long length = sqlite3_column_int64(statement, 2);
            if (offset < 0 || length <= 0 || length > position.Seal.Size - offset)
                throw new HistoryIndexUnavailable("Invalid indexed rollout record location.");
            long? timestamp = sqlite3_column_type(statement, 3) == SQLITE_NULL ? null : sqlite3_column_int64(statement, 3);
            yield return new HistoryIndexLocation(sqlite3_column_int64(statement, 0), offset, length, timestamp,
                ReadState(statement, 4));
        }
    }

    internal static long? TimestampMicroseconds(string? timestamp) =>
        HistorySource.TryInstant(timestamp, out var parsed) ? Microseconds(parsed) : null;

    public void Dispose()
    {
        database.Dispose();
        File.Dispose();
    }

    private static long Microseconds(DateTimeOffset timestamp) =>
        timestamp.UtcTicks / 10 - DateTime.UnixEpoch.Ticks / 10;

    private static string OrdinaryPath(string path) => path.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)
        ? @"\\" + path[8..] : path.StartsWith(@"\\?\", StringComparison.Ordinal) && path.Length >= 6 && path[5] == ':'
            ? path[4..] : path;

    private static bool InSessionDirectory(string path, string home) =>
        IsUnder(path, Path.Combine(home, "sessions")) || IsUnder(path, Path.Combine(home, "archived_sessions"));

    private static bool IsUnder(string path, string directory)
    {
        if (RolloutPath.ResolveDirectory(directory) is not string resolved)
            return false;
        string relative = Path.GetRelativePath(OrdinaryPath(resolved), path);
        return relative != "." && relative != ".." && !relative.StartsWith(@"..\", StringComparison.Ordinal) &&
            !Path.IsPathRooted(relative);
    }

    private static string? VerifiedOwner(string filename, JsonElement header)
    {
        string stem = Path.GetFileNameWithoutExtension(filename);
        if (!stem.StartsWith("rollout-", StringComparison.Ordinal) || stem.Length < 64 ||
            !Guid.TryParseExact(stem.AsSpan(stem.Length - 36), "D", out _))
            return null;
        ReadOnlySpan<char> owner = stem.AsSpan(28);
        int suffix = owner.IndexOf('_');
        if (suffix >= 0)
            owner = owner[..suffix];
        return header.Text("id").AsSpan().SequenceEqual(owner) && Guid.TryParseExact(owner, "D", out Guid id)
            ? id.ToString("D") : null;
    }

    private static FileStream OpenFile(string path) =>
        new(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, bufferSize: 1);

    private static RolloutFileStat CurrentStat(string path, FileStream source)
    {
        RolloutFileStat stat = RolloutFileStat.Capture(source);
        using FileStream current = OpenFile(path);
        RolloutFileStat named = RolloutFileStat.Capture(current);
        if (stat.Inode == 0 || stat.Device != named.Device || stat.Inode != named.Inode)
            throw new HistoryIndexUnavailable("Rollout file was replaced.");
        return stat;
    }

    private static void ReadAt(FileStream source, long offset, Span<byte> result)
    {
        while (!result.IsEmpty)
        {
            int read = RandomAccess.Read(source.SafeFileHandle, result, offset);
            if (read == 0)
                throw new HistoryIndexUnavailable("Rollout file was shortened.");
            result = result[read..];
            offset += read;
        }
    }

    private static (byte[] Prefix, byte[] Tail) Anchors(FileStream source, long size)
    {
        if (size <= 0)
            throw new HistoryIndexUnavailable("Rollout has no complete record.");
        int width = (int)Math.Min(size, AnchorBytes);
        Span<byte> buffer = stackalloc byte[width];
        ReadAt(source, size - width, buffer);
        if (buffer[^1] != (byte)'\n')
            throw new HistoryIndexUnavailable("Rollout ends with an unterminated record.");
        byte[] tail = Blake2b128(buffer);
        if (size == width)
            return (tail, tail);
        ReadAt(source, 0, buffer);
        return (Blake2b128(buffer), tail);
    }

    private static FileSeal CaptureSeal(string path, FileStream source, JsonElement header, RolloutFileStat stat)
    {
        var (prefix, tail) = Anchors(source, stat.Length);
        source.Position = 0;
        if (!JsonElement.DeepEquals(HistorySource.ReadHeader(path, source), header))
            throw new HistoryIndexUnavailable("Rollout session metadata changed.");
        return new FileSeal(stat.Device.ToString(CultureInfo.InvariantCulture), stat.Inode.ToString(CultureInfo.InvariantCulture),
            stat.Length, stat.ModifiedNanoseconds.ToString(CultureInfo.InvariantCulture), prefix, tail);
    }

    private static bool MatchesPrefix(string path, FileStream source, FileSeal seal)
    {
        RolloutFileStat stat = CurrentStat(path, source);
        if (stat.Device.ToString(CultureInfo.InvariantCulture) != seal.Device ||
            stat.Inode.ToString(CultureInfo.InvariantCulture) != seal.Inode || stat.Length < seal.Size ||
            (stat.Length == seal.Size && stat.ModifiedNanoseconds.ToString(CultureInfo.InvariantCulture) != seal.Modified))
            return false;
        try
        {
            var (prefix, tail) = Anchors(source, seal.Size);
            return prefix.AsSpan().SequenceEqual(seal.Prefix) && tail.AsSpan().SequenceEqual(seal.Tail);
        }
        catch (HistoryIndexUnavailable)
        {
            return false;
        }
    }

    private static IndexPosition? ReadPosition(SqliteConnection connection, string path)
    {
        using sqlite3_stmt statement = Prepare(connection, """
            SELECT f.id, f.device, f.inode, f.size, f.mtime_ns, f.prefix, f.tail,
                f.last_line, f.state_line, s.cwd, s.active_turn, s.in_prefix
            FROM rollout_files AS f
            JOIN annotation_states AS s ON s.rollout = f.id AND s.line = f.state_line
            WHERE f.path = ?
            """);
        Bind(connection, statement, path);
        if (!ReadRow(statement))
            return null;
        var seal = new FileSeal(sqlite3_column_text(statement, 1).utf8_to_string(),
            sqlite3_column_text(statement, 2).utf8_to_string(), sqlite3_column_int64(statement, 3),
            sqlite3_column_text(statement, 4).utf8_to_string(),
            sqlite3_column_blob(statement, 5).ToArray(), sqlite3_column_blob(statement, 6).ToArray());
        long line = sqlite3_column_int64(statement, 7);
        long stateLine = sqlite3_column_int64(statement, 8);
        return seal.Size > 0 && line > 0 && stateLine >= 0 && stateLine <= line
            ? new IndexPosition(sqlite3_column_int64(statement, 0), seal, line, stateLine, ReadState(statement, 9))
            : null;
    }

    private static HistoryAnnotation ReadState(sqlite3_stmt statement, int index) =>
        new(OptionalText(statement, index), OptionalText(statement, index + 1), sqlite3_column_int(statement, index + 2) != 0);

    private static string? OptionalText(sqlite3_stmt statement, int index) =>
        sqlite3_column_type(statement, index) == SQLITE_NULL ? null : sqlite3_column_text(statement, index).utf8_to_string();

    private static void Refresh(SqliteConnection connection, string path, string owner, string sourcePath, FileStream source,
        JsonElement header,
        Func<FileStream, long, long, long, HistoryAnnotation, IEnumerable<HistoryIndexedRecord>> scan,
        FileSeal seal, IndexPosition? previous)
    {
        if (previous is not null && !MatchesPrefix(sourcePath, source, previous.Seal))
            previous = null;

        long key, stateLine, line, offset;
        HistoryAnnotation state;
        using sqlite3_stmt insertState = Prepare(connection, "INSERT INTO annotation_states VALUES (?, ?, ?, ?, ?)");
        if (previous is null)
        {
            Execute(connection, "DELETE FROM rollout_files WHERE path = ?", path);
            Execute(connection, """
                INSERT INTO rollout_files (path, owner_thread_id, device, inode, size, mtime_ns, prefix, tail, last_line, state_line)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
                """, path, owner, seal.Device, seal.Inode, seal.Size, seal.Modified, seal.Prefix, seal.Tail);
            key = sqlite3_last_insert_rowid(connection.Handle!);
            stateLine = line = offset = 0;
            state = new HistoryAnnotation(header.Text("cwd"));
            InsertState(connection, insertState, key, stateLine, state);
        }
        else
        {
            (key, stateLine, line, offset, state) = (previous.Key, previous.StateLine, previous.LastLine,
                previous.Seal.Size, previous.State);
        }

        using sqlite3_stmt insertLocation = Prepare(connection, "INSERT INTO record_locations VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
        foreach (HistoryIndexedRecord record in scan(source, line, offset, seal.Size, state))
        {
            if (record.Line <= line || record.Offset < offset || record.Length <= 0 || record.Length > seal.Size - record.Offset)
                throw new HistoryIndexUnavailable("Rollout changed during indexing.");
            Execute(connection, insertLocation, key, record.Line, record.Offset, record.Length,
                TimestampMicroseconds(record.Timestamp), record.Checkpoint ? 1 : 0,
                record.Checkpoint ? record.WindowNumber?.ToString(CultureInfo.InvariantCulture) : null, stateLine);
            line = record.Line;
            offset = record.Offset + record.Length;
            if (state != record.Next)
            {
                state = record.Next;
                stateLine = line;
                InsertState(connection, insertState, key, stateLine, state);
            }
        }
        line += CountBlankLines(source, offset, seal.Size);
        if (!MatchesPrefix(sourcePath, source, seal))
            throw new HistoryIndexUnavailable("Rollout changed during indexing.");
        Execute(connection, """
            UPDATE rollout_files SET size = ?, mtime_ns = ?, prefix = ?, tail = ?, last_line = ?, state_line = ? WHERE id = ?
            """, seal.Size, seal.Modified, seal.Prefix, seal.Tail, line, stateLine, key);
    }

    private static long CountBlankLines(FileStream source, long offset, long end)
    {
        long lines = 0;
        if (offset >= end)
            return lines;
        Span<byte> buffer = stackalloc byte[AnchorBytes];
        while (offset < end)
        {
            Span<byte> raw = buffer[..(int)Math.Min(end - offset, buffer.Length)];
            ReadAt(source, offset, raw);
            foreach (byte value in raw)
            {
                if (value == (byte)'\n')
                    lines++;
                else if (value is not ((byte)' ' or (byte)'\t' or (byte)'\r' or (byte)'\v' or (byte)'\f'))
                    throw new HistoryIndexUnavailable("Rollout changed during indexing.");
            }
            offset += raw.Length;
        }
        return lines;
    }

    private static void InsertState(SqliteConnection connection, sqlite3_stmt statement, long key, long line,
        HistoryAnnotation state) => Execute(connection, statement, key, line, state.Cwd, state.ActiveTurn, state.InPrefix ? 1 : 0);

    private static SqliteConnection OpenDatabase(string path, bool build)
    {
        var connection = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = path,
            Mode = build ? SqliteOpenMode.ReadWriteCreate : SqliteOpenMode.ReadWrite,
            Pooling = false,
        }.ToString());
        try
        {
            connection.Open();
            SqliteException.ThrowExceptionForRC(sqlite3_busy_timeout(connection.Handle!, BusyTimeoutMilliseconds), connection.Handle);
            Run(connection, "PRAGMA foreign_keys = ON");
            int version = ReadVersion(connection);
            if (version == 0 && build)
            {
                Run(connection, "PRAGMA journal_mode = WAL");
                Run(connection, "BEGIN IMMEDIATE");
                version = ReadVersion(connection);
                if (version == 0)
                {
                    Run(connection, SchemaV1);
                    version = Version;
                }
                Run(connection, "COMMIT");
            }
            if (version != Version)
                throw new HistoryIndexUnavailable("Unsupported rollout index schema.");
            return connection;
        }
        catch
        {
            connection.Dispose();
            throw;
        }
    }

    private static int ReadVersion(SqliteConnection connection)
    {
        using sqlite3_stmt statement = Prepare(connection, "PRAGMA user_version");
        return ReadRow(statement) ? sqlite3_column_int(statement, 0) : -1;
    }

    private static void Run(SqliteConnection connection, string sql) =>
        SqliteException.ThrowExceptionForRC(sqlite3_exec(connection.Handle!, sql), connection.Handle);

    private static sqlite3_stmt Prepare(SqliteConnection connection, string sql)
    {
        int result = sqlite3_prepare_v2(connection.Handle!, sql, out sqlite3_stmt statement);
        if (result == SQLITE_OK)
            return statement;
        statement?.Dispose();
        throw new HistoryIndexUnavailable("Cannot prepare rollout index query.");
    }

    private static bool ReadRow(sqlite3_stmt statement)
    {
        int result = sqlite3_step(statement);
        if (result is not (SQLITE_ROW or SQLITE_DONE))
            throw new HistoryIndexUnavailable("Cannot read rollout index query.");
        return result == SQLITE_ROW;
    }

    private static void Execute(SqliteConnection connection, string sql, params object?[] parameters)
    {
        using sqlite3_stmt statement = Prepare(connection, sql);
        Execute(connection, statement, parameters);
    }

    private static void Execute(SqliteConnection connection, sqlite3_stmt statement, params object?[] parameters)
    {
        Bind(connection, statement, parameters);
        SqliteException.ThrowExceptionForRC(sqlite3_step(statement), connection.Handle);
        SqliteException.ThrowExceptionForRC(sqlite3_reset(statement), connection.Handle);
    }

    private static void Bind(SqliteConnection connection, sqlite3_stmt statement, params object?[] parameters)
    {
        for (int index = 0; index < parameters.Length; index++)
        {
            int position = index + 1;
            int result = parameters[index] switch
            {
                null => sqlite3_bind_null(statement, position),
                string text => sqlite3_bind_text(statement, position, text),
                int integer => sqlite3_bind_int(statement, position, integer),
                long integer => sqlite3_bind_int64(statement, position, integer),
                byte[] bytes => sqlite3_bind_blob(statement, position, bytes),
                _ => throw new ArgumentException("Unsupported rollout index parameter."),
            };
            SqliteException.ThrowExceptionForRC(result, connection.Handle);
        }
    }

    // The Desktop panel also opens this database through Python.
    private const string SchemaV1 = """
        CREATE TABLE rollout_files (
            id INTEGER PRIMARY KEY,
            path TEXT NOT NULL UNIQUE,
            owner_thread_id TEXT NOT NULL,
            device TEXT NOT NULL,
            inode TEXT NOT NULL,
            size INTEGER NOT NULL,
            mtime_ns TEXT NOT NULL,
            prefix BLOB NOT NULL,
            tail BLOB NOT NULL,
            last_line INTEGER NOT NULL,
            state_line INTEGER NOT NULL
        );
        CREATE INDEX rollout_files_owner ON rollout_files (owner_thread_id);
        CREATE TABLE annotation_states (
            rollout INTEGER NOT NULL REFERENCES rollout_files (id) ON DELETE CASCADE,
            line INTEGER NOT NULL,
            cwd TEXT,
            active_turn TEXT,
            in_prefix INTEGER NOT NULL,
            PRIMARY KEY (rollout, line)
        ) WITHOUT ROWID;
        CREATE TABLE record_locations (
            rollout INTEGER NOT NULL REFERENCES rollout_files (id) ON DELETE CASCADE,
            line INTEGER NOT NULL,
            offset INTEGER NOT NULL,
            length INTEGER NOT NULL,
            timestamp_us INTEGER,
            is_checkpoint INTEGER NOT NULL,
            window_number TEXT,
            state_line INTEGER NOT NULL,
            PRIMARY KEY (rollout, line)
        ) WITHOUT ROWID;
        CREATE INDEX locations_time ON record_locations (rollout, timestamp_us, line) WHERE timestamp_us IS NOT NULL;
        CREATE INDEX locations_checkpoints ON record_locations (rollout, line) WHERE is_checkpoint = 1;
        PRAGMA user_version = 1;
        """;

    // BLAKE2b-128 seals keep byte-for-byte parity with the index written by the Python reader.
    private static byte[] Blake2b128(ReadOnlySpan<byte> data)
    {
        ReadOnlySpan<ulong> iv = [0x6a09e667f3bcc908, 0xbb67ae8584caa73b, 0x3c6ef372fe94f82b, 0xa54ff53a5f1d36f1,
            0x510e527fade682d1, 0x9b05688c2b3e6c1f, 0x1f83d9abfb41bd6b, 0x5be0cd19137e2179];
        ReadOnlySpan<byte> order = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
            14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
            11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4,
            7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8,
            9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13,
            2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9,
            12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11,
            13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10,
            6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5,
            10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0];
        Span<ulong> state = stackalloc ulong[8];
        iv.CopyTo(state);
        state[0] ^= 0x01010010;
        Span<byte> finalBlock = stackalloc byte[128];
        Span<ulong> words = stackalloc ulong[16];
        Span<ulong> work = stackalloc ulong[16];
        for (int offset = 0; ; offset += 128)
        {
            int size = Math.Min(128, data.Length - offset);
            bool final = offset + size == data.Length;
            ReadOnlySpan<byte> block = data.Slice(offset, size);
            if (size < 128)
            {
                finalBlock.Clear();
                block.CopyTo(finalBlock);
                for (int i = 0; i < words.Length; i++)
                    words[i] = BinaryPrimitives.ReadUInt64LittleEndian(finalBlock[(8 * i)..]);
            }
            else
            {
                for (int i = 0; i < words.Length; i++)
                    words[i] = BinaryPrimitives.ReadUInt64LittleEndian(block[(8 * i)..]);
            }
            state.CopyTo(work);
            iv.CopyTo(work[8..]);
            work[12] ^= (ulong)(offset + size);
            if (final)
                work[14] = ~work[14];
            for (int round = 0; round < 12; round++)
            {
                ReadOnlySpan<byte> perm = order.Slice(round % 10 * 16, 16);
                Mix(work, 0, 4, 8, 12, words[perm[0]], words[perm[1]]);
                Mix(work, 1, 5, 9, 13, words[perm[2]], words[perm[3]]);
                Mix(work, 2, 6, 10, 14, words[perm[4]], words[perm[5]]);
                Mix(work, 3, 7, 11, 15, words[perm[6]], words[perm[7]]);
                Mix(work, 0, 5, 10, 15, words[perm[8]], words[perm[9]]);
                Mix(work, 1, 6, 11, 12, words[perm[10]], words[perm[11]]);
                Mix(work, 2, 7, 8, 13, words[perm[12]], words[perm[13]]);
                Mix(work, 3, 4, 9, 14, words[perm[14]], words[perm[15]]);
            }
            for (int i = 0; i < state.Length; i++)
                state[i] ^= work[i] ^ work[i + 8];
            if (final)
                break;
        }
        var digest = new byte[16];
        BinaryPrimitives.WriteUInt64LittleEndian(digest, state[0]);
        BinaryPrimitives.WriteUInt64LittleEndian(digest.AsSpan(8), state[1]);
        return digest;
    }

    private static void Mix(Span<ulong> values, int a, int b, int c, int d, ulong x, ulong y)
    {
        unchecked
        {
            values[a] += values[b] + x;
            values[d] = BitOperations.RotateRight(values[d] ^ values[a], 32);
            values[c] += values[d];
            values[b] = BitOperations.RotateRight(values[b] ^ values[c], 24);
            values[a] += values[b] + y;
            values[d] = BitOperations.RotateRight(values[d] ^ values[a], 16);
            values[c] += values[d];
            values[b] = BitOperations.RotateRight(values[b] ^ values[c], 63);
        }
    }
}
