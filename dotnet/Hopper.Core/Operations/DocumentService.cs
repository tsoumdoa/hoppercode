using System.Text.Json;
using Hopper.Core.Protocol;

namespace Hopper.Core.Operations;

/// <summary>Runs inside the host's ordered UI dispatcher, including transition completion.</summary>
public abstract class DocumentService<T> where T : class
{
    protected abstract string Kind { get; }
    protected abstract IEnumerable<T> Documents { get; }
    protected abstract T? Active { get; }
    protected abstract string NativeId(T document);
    protected abstract string? PathOf(T document);
    protected abstract bool Modified(T document);
    protected abstract string Fingerprint(T document);
    // Persisted content only: native overrides exclude path/dirty changes caused by a successful write.
    protected virtual string TransitionFingerprint(T document) => Fingerprint(document);
    protected abstract object? Settings(T document);
    protected abstract void FinishSegment();
    protected abstract T Create(string? template);
    protected abstract T Open(string path);
    protected abstract void Activate(T document);
    protected abstract bool Write(T document, string path);
    protected abstract void Close(T document);
    protected virtual bool ReplacesActive => false;
    protected virtual object Capabilities => new { loaded = true, extensions = Extensions, multiDocument = !ReplacesActive, closesToBlank = ReplacesActive };
    protected string[] Extensions => Kind == "rhino" ? new[] { ".3dm" } : new[] { ".gh", ".ghx" };
    private readonly Dictionary<string, (string? Path, string? Stamp)> _files = new();
    protected string Id(T doc) => $"{DocumentSession.LifecycleInstanceId}:{Kind}:{NativeId(doc)}";
    public T Resolve(string id) => Documents.FirstOrDefault(d => Id(d) == id)
        ?? throw new DocumentOperationException("DOCUMENT_NOT_FOUND", "The document handle is stale or is not open in this host.");
    public ManagedDocument Describe(T doc)
    {
        var path = PathOf(doc);
        if (string.IsNullOrWhiteSpace(path)) path = null;
        if (!_files.TryGetValue(Id(doc), out var baseline) || baseline.Path != path)
            _files[Id(doc)] = (path, DocumentFiles.Stamp(path));
        return new(Id(doc), DocumentSession.LifecycleInstanceId, Kind, path == null ? "Untitled" : System.IO.Path.GetFileName(path), path,
            ReferenceEquals(doc, Active), Modified(doc), path == null || !File.Exists(path) ? null : new FileInfo(path).IsReadOnly,
            DocumentSession.Digest(Id(doc) + "|" + path + "|" + Modified(doc) + "|" + Fingerprint(doc)), Settings(doc));
    }
    public void ObserveNativeSave(T doc) { var path = PathOf(doc); _files[Id(doc)] = (path, DocumentFiles.Stamp(path)); }
    public object List() => new { documents = Documents.Select(Describe).ToArray(), activeDocumentId = Active == null ? null : Id(Active), capabilities = Capabilities,
        lifecycleInstanceId = DocumentSession.LifecycleInstanceId, transaction = DocumentSession.Segment(Kind) };
    public OperationResultV2 Execute(RpcOperation operation, JsonElement args)
    {
        var effects = new List<DocumentEffect>();
        try
        {
            var name = operation.ToString();
            if (name.StartsWith("list")) return DocumentSession.Result(List());
            if (name.EndsWith("Settings")) return DocumentSession.Result(Settings(Resolve(Required(args, "documentId")))!);
            if (name.StartsWith("get")) return DocumentSession.Result(Describe(Resolve(Required(args, "documentId"))));
            return Manage(args, effects);
        }
        catch (Exception error)
        {
            return DocumentSession.Result(new { ok = false, error = new { code = error is DocumentOperationException domain ? domain.Code : error is UnauthorizedAccessException ? "FILE_LOCKED" : "NATIVE_OPERATION_FAILED", message = error.Message },
                effects, remainingDocuments = RemainingDocuments(), transaction = DocumentSession.Segment(Kind), outcomeUncertain = effects.Any(e => !e.Completed), activeDocumentId = Active == null ? null : Id(Active) });
        }
    }
    private object? RemainingDocuments()
    {
        try { return Documents.Select(doc => new { documentId = Id(doc), path = PathOf(doc), isActive = ReferenceEquals(doc, Active) }).ToArray(); }
        catch { return null; } // Preserve the original error and known side effects if inventory refresh also fails.
    }
    private OperationResultV2 Manage(JsonElement args, List<DocumentEffect> effects)
    {
        var action = Required(args, "action");
        if (!new[] { "new", "open", "activate", "save", "saveAs", "close" }.Contains(action))
            throw new DocumentOperationException("INVALID_ACTION", "Unknown document action.");
        var doc = action is "new" or "open" ? null : Resolve(Required(args, "documentId"));
        if (action is "new" or "open" or "activate")
        {
            if (!args.TryGetProperty("expectedActiveDocument", out var expected)) throw new DocumentOperationException("ACTIVE_DOCUMENT_REQUIRED", "Supply the observed active document handle or null.");
            var expectedId = expected.ValueKind == JsonValueKind.Null ? null : expected.GetString();
            if (expectedId != (Active == null ? null : Id(Active))) throw new DocumentOperationException("DOCUMENT_CHANGED", "The active document changed.");
        }
        if (doc != null && action != "activate") ValidateToken(doc, Required(args, "expectedStateToken"));
        var path = action is "open" or "saveAs" ? ValidatePath(Required(args, "path"), action == "open", CreateDirectories(args)) : null;
        var templatePath = action == "new" && Optional(args, "templatePath") is { } template ? ValidatePath(template, true) : null;
        var already = action == "open" ? Documents.FirstOrDefault(d => DocumentFiles.Same(PathOf(d), path)) : null;
        var affected = new List<(T Document, JsonElement Policy)>();
        if (action is "new" or "open" && already == null && ReplacesActive && Active != null)
        {
            var current = Active;
            if (!args.TryGetProperty("affectedDocuments", out var policies) || policies.ValueKind != JsonValueKind.Array)
                throw new DocumentOperationException("AFFECTED_DOCUMENT_REQUIRED", "Supply state and unsaved policy for the document being replaced.");
            var matches = policies.EnumerateArray().Where(p => Optional(p, "documentId") == Id(current)).ToArray();
            if (matches.Length != 1) throw new DocumentOperationException("AFFECTED_DOCUMENT_REQUIRED", "Supply exactly one policy for the document being replaced.");
            ValidateToken(current, Required(matches[0], "expectedStateToken"));
            ValidateUnsaved(current, matches[0]); affected.Add((current, matches[0]));
        }
        if (action == "close") ValidateUnsaved(doc!, args);
        if (action is "save" or "saveAs") PreflightSave(doc!, path ?? PathOf(doc!), args);
        var observedActiveId = Active == null ? null : Id(Active);
        var guardedTargets = new Dictionary<string, string>();
        if (doc != null) guardedTargets[Id(doc)] = Describe(doc).StateToken;
        foreach (var item in affected) guardedTargets[Id(item.Document)] = Describe(item.Document).StateToken;
        void VerifyTransitionState()
        {
            if (observedActiveId != (Active == null ? null : Id(Active)))
                throw new DocumentOperationException("DOCUMENT_CHANGED", "A native callback changed the active document during the transition.");
            foreach (var target in guardedTargets) ValidateToken(Resolve(target.Key), target.Value);
        }
        FinishSegment(); // A failed transition still ends the previous edit segment.
        effects.Add(new("finishEditingSegment", null, null, true));
        VerifyTransitionState();
        foreach (var item in affected) {
            ApplyUnsaved(item.Document, item.Policy, effects);
            // Save checks persisted content before returning. Only its path/dirty changes are accepted here.
            guardedTargets[Id(item.Document)] = Describe(item.Document).StateToken;
            VerifyTransitionState();
        }
        if (action == "close") {
            ApplyUnsaved(doc!, args, effects);
            guardedTargets[Id(doc!)] = Describe(doc!).StateToken;
        }
        VerifyTransitionState();
        if (action is "new" or "open" or "activate") effects.Add(new(action, doc == null ? null : Id(doc), path, false));
        if (action == "new") { doc = Create(templatePath); Activate(doc); }
        else if (action == "open") { doc = already ?? Open(path!); Activate(doc); }
        else if (action == "activate") Activate(doc!);
        else if (action is "save" or "saveAs") Save(doc!, path ?? PathOf(doc!)!, args, effects);
        else if (action == "close") { var id = Id(doc!); var closePath = PathOf(doc!); effects.Add(new("close", id, closePath, false)); Close(doc!); effects[^1] = new("close", id, closePath, true); doc = null; }
        if (action is "new" or "open" or "activate") effects[^1] = new(action, doc == null ? null : Id(doc), doc == null ? null : PathOf(doc), true);
        else effects.Add(new(action, doc == null ? null : Id(doc), doc == null ? null : PathOf(doc), true));
        DocumentSession.Advance(Kind, null, "idle");
        return DocumentSession.Result(new { ok = true, document = doc == null ? null : Describe(doc), alreadyOpen = already != null,
            effects, outcomeUncertain = false, state = List(), transaction = DocumentSession.Segment(Kind) });
    }
    private void ValidateToken(T doc, string token)
    {
        if (Describe(doc).StateToken != token) throw new DocumentOperationException("DOCUMENT_CHANGED", "Document content or metadata changed. Inspect it again before applying policy.");
    }
    private void ValidateUnsaved(T doc, JsonElement policy)
    {
        var onUnsaved = Optional(policy, "onUnsaved") ?? "fail";
        if (!new[] { "fail", "save", "discard" }.Contains(onUnsaved)) throw new DocumentOperationException("INVALID_UNSAVED_POLICY", "onUnsaved must be fail, save, or discard.");
        if (!Modified(doc)) return;
        if (onUnsaved == "fail") throw new DocumentOperationException("UNSAVED_CHANGES", "Document has unsaved changes. Specify save or user-authorized discard.");
        if (onUnsaved == "save") PreflightSave(doc, Optional(policy, "savePath") ?? PathOf(doc), policy);
    }
    private void ApplyUnsaved(T doc, JsonElement policy, List<DocumentEffect> effects)
    {
        if (Modified(doc) && Optional(policy, "onUnsaved") == "save") Save(doc, Optional(policy, "savePath") ?? PathOf(doc)!, policy, effects);
    }
    private static bool CreateDirectories(JsonElement policy) => policy.TryGetProperty("createDirectories", out var create) && create.ValueKind == JsonValueKind.True;
    private string ValidatePath(string path, bool mustExist, bool createDirectories = false)
    {
        var full = DocumentFiles.Canonical(path);
        if (!Extensions.Contains(System.IO.Path.GetExtension(full).ToLowerInvariant())) throw new DocumentOperationException("UNSUPPORTED_EXTENSION", "Unsupported native file extension.");
        if (mustExist && !File.Exists(full)) throw new DocumentOperationException("PATH_NOT_FOUND", "File does not exist.");
        if (!createDirectories && !Directory.Exists(System.IO.Path.GetDirectoryName(full))) throw new DocumentOperationException("PATH_NOT_FOUND", "Parent directory does not exist.");
        return full;
    }
    private void PreflightSave(T doc, string? path, JsonElement policy)
    {
        if (string.IsNullOrWhiteSpace(path)) throw new DocumentOperationException("PATH_REQUIRED", "Unnamed document requires saveAs and an absolute path.");
        path = ValidatePath(path, false, CreateDirectories(policy));
        if (Documents.Any(other => !ReferenceEquals(doc, other) && DocumentFiles.Same(path, PathOf(other))))
            throw new DocumentOperationException("DESTINATION_OPEN_IN_OTHER_DOCUMENT", "Another live document owns the destination file.");
        if (File.Exists(path) && !DocumentFiles.Same(path, PathOf(doc)) && !(policy.TryGetProperty("overwrite", out var overwrite) && overwrite.ValueKind == JsonValueKind.True))
            throw new DocumentOperationException("DESTINATION_EXISTS", "Destination exists; explicit overwrite is required.");
        if (_files.TryGetValue(Id(doc), out var baseline) && DocumentFiles.Same(path, baseline.Path) && baseline.Stamp != DocumentFiles.Stamp(path))
            throw new DocumentOperationException("FILE_CHANGED_EXTERNALLY", "Backing file changed externally since observation; reopen or choose another destination.");
    }
    private void Save(T doc, string path, JsonElement policy, List<DocumentEffect> effects)
    {
        PreflightSave(doc, path, policy);
        path = DocumentFiles.Canonical(path);
        if (CreateDirectories(policy) && !Directory.Exists(System.IO.Path.GetDirectoryName(path))) {
            effects.Add(new("createDirectories", Id(doc), System.IO.Path.GetDirectoryName(path), false));
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(path)!);
            effects[^1] = new("createDirectories", Id(doc), System.IO.Path.GetDirectoryName(path), true);
        }
        var beforeWrite = TransitionFingerprint(doc);
        effects.Add(new("save", Id(doc), path, false, "Native write started; inspect file if completion fails."));
        if (!Write(doc, path)) throw new DocumentOperationException("NATIVE_WRITE_FAILED", "Native writer reported failure.");
        effects[^1] = new("save", Id(doc), path, true);
        _files[Id(doc)] = (PathOf(doc), DocumentFiles.Stamp(PathOf(doc)));
        if (beforeWrite != TransitionFingerprint(doc))
            throw new DocumentOperationException("DOCUMENT_CHANGED", "The file was saved, but a native callback changed document content during the write. Inspect it again before closing or replacing it.");
    }
    protected static string Required(JsonElement args, string key) => Optional(args, key)
        ?? throw new DocumentOperationException("INVALID_ARGUMENT", $"{key} is required.");
    protected static string? Optional(JsonElement args, string key) => args.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
}
