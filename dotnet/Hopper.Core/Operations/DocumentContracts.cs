using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Hopper.Core.Protocol;

namespace Hopper.Core.Operations;

public sealed record ExpectedDocument(string DocumentId, string LifecycleInstanceId, string? SettingsRevision = null);
public sealed record DocumentSegment(string? DocumentId, string? SegmentId, long Epoch, string State, string LifecycleInstanceId);
public sealed record ManagedDocument(string DocumentId, string LifecycleInstanceId, string Kind, string Name,
    string? Path, bool IsActive, bool IsModified, bool? IsReadOnly, string StateToken, object? Settings);
public sealed record DocumentEffect(string Stage, string? DocumentId, string? Path, bool Completed, string? Message = null);
public sealed class DocumentOperationException : Exception
{
    public string Code { get; }
    public DocumentOperationException(string code, string message) : base(message) => Code = code;
}

/// <summary>UI-dispatcher-owned identity shared by independent native adapters.</summary>
public static class DocumentSession
{
    public static string LifecycleInstanceId { get; private set; } = Guid.NewGuid().ToString("N");
    private static readonly Dictionary<string, DocumentSegment> Segments = new();
    public static Action? ReconcileGrasshopper { get; set; }
    public static Action? EnsureRhinoDocumentReady { get; set; }
    public static Func<string?, object?>? ReadRhinoSettings { get; set; }
    public static Func<string?>? ActiveRhinoDocumentId { get; set; }
    public static void Start(string lifecycleInstanceId) { LifecycleInstanceId = lifecycleInstanceId; Segments.Clear(); }
    public static DocumentSegment Segment(string owner) => Segments.TryGetValue(owner, out var value)
        ? value : new(null, null, 0, "idle", LifecycleInstanceId);
    public static DocumentSegment Advance(string owner, string? documentId, string state)
    {
        var previous = Segment(owner);
        return Segments[owner] = new(documentId, state == "active" ? Guid.NewGuid().ToString("N") : null,
            previous.Epoch + 1, state, LifecycleInstanceId);
    }
    public static void ValidateSegment(string owner, JsonElement args)
    {
        if (!args.TryGetProperty("expectedSegment", out var expected) || expected.ValueKind == JsonValueKind.Null) return;
        var current = Segment(owner);
        if (expected.Deserialize<DocumentSegment>(RpcV2Contract.JsonOptions) is not { } target
            || target.DocumentId != current.DocumentId || target.SegmentId != current.SegmentId
            || target.Epoch != current.Epoch || target.LifecycleInstanceId != current.LifecycleInstanceId)
            throw new DocumentOperationException("TRANSACTION_CHANGED", "The editing segment changed. Reconcile document transaction state before continuing.");
    }
    public static string Digest(string text) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text)));
    public static OperationResultV2 Result(object data) => new() { Class = RpcResultClass.completed,
        ReasonCode = RpcReasonCode.OK, Data = JsonSerializer.SerializeToElement(data, RpcV2Contract.JsonOptions) };
}

public static class DocumentFiles
{
    public static string Canonical(string path)
    {
        if (!System.IO.Path.IsPathFullyQualified(path)) throw new DocumentOperationException("ABSOLUTE_PATH_REQUIRED", "Use an absolute path.");
        var full = System.IO.Path.GetFullPath(path);
        var root = System.IO.Path.GetPathRoot(full)!;
        foreach (var part in full[root.Length..].Split(System.IO.Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries))
        {
            var parent = root;
            root = System.IO.Path.Combine(root, part);
            // Ask the filesystem whether the supplied spelling exists before resolving casing.
            // This preserves distinct names on case-sensitive APFS and resolves aliases on default APFS.
            if ((File.Exists(root) || Directory.Exists(root)) && Directory.Exists(parent)) {
                var names = Directory.EnumerateFileSystemEntries(parent).ToArray();
                root = names.FirstOrDefault(name => System.IO.Path.GetFileName(name) == part)
                    ?? names.FirstOrDefault(name => string.Equals(System.IO.Path.GetFileName(name), part, StringComparison.OrdinalIgnoreCase)) ?? root;
            }
            FileSystemInfo info = Directory.Exists(root) ? new DirectoryInfo(root) : new FileInfo(root);
            if (info.Exists && info.LinkTarget != null) root = info.ResolveLinkTarget(true)!.FullName;
        }
        return root;
    }
    public static bool Same(string? left, string? right) => left != null && right != null && string.Equals(Canonical(left), Canonical(right),
        StringComparison.Ordinal);
    public static string? Stamp(string? path)
    {
        if (string.IsNullOrEmpty(path) || !File.Exists(path)) return null;
        using var stream = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        return Convert.ToHexString(SHA256.HashData(stream));
    }
    public static object Browse(JsonElement args)
    {
        var path = Canonical(args.GetProperty("path").GetString()!);
        if (!Directory.Exists(path)) throw new DocumentOperationException("PATH_NOT_FOUND", "Directory does not exist.");
        var kind = args.TryGetProperty("kind", out var k) ? k.GetString() : null;
        var extensions = kind == "rhino" ? new[] { ".3dm" } : kind == "grasshopper" ? new[] { ".gh", ".ghx" } : new[] { ".3dm", ".gh", ".ghx" };
        var offset = args.TryGetProperty("cursor", out var c) && int.TryParse(c.GetString(), out var n) ? n : 0;
        if (offset < 0) throw new DocumentOperationException("INVALID_CURSOR", "Cursor must be nonnegative.");
        var limit = args.TryGetProperty("limit", out var l) ? Math.Clamp(l.GetInt32(), 1, 200) : 100;
        var entries = new DirectoryInfo(path).EnumerateFileSystemInfos().Where(e => e is DirectoryInfo || extensions.Contains(e.Extension.ToLowerInvariant()))
            .OrderBy(e => e.Name, StringComparer.Ordinal).Skip(offset).Take(limit + 1).ToArray();
        return new { path, entries = entries.Take(limit).Select(e => {
            try { return new { name = e.Name, path = Canonical(e.FullName), kind = e is DirectoryInfo ? "directory" : "file", extension = e is DirectoryInfo ? null : e.Extension.ToLowerInvariant(), error = (string?)null }; }
            catch (Exception error) { return new { name = e.Name, path = e.FullName, kind = "unreadable", extension = (string?)null, error = (string?)error.Message }; }
        }).ToArray(), nextCursor = entries.Length > limit ? (offset + limit).ToString() : null };
    }
}
