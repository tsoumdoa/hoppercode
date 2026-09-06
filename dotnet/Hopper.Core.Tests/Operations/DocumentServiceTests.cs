using System.Text.Json;
using Hopper.Core.Operations;
using Hopper.Core.Protocol;
using Xunit;

namespace Hopper.Core.Tests.Operations;

public sealed class DocumentServiceTests : IDisposable
{
    private readonly string _directory = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "hopper-document-tests-" + Guid.NewGuid().ToString("N"));
    public DocumentServiceTests() => Directory.CreateDirectory(_directory);
    public void Dispose() => Directory.Delete(_directory, true);
    private string FilePath(string name) => System.IO.Path.Combine(_directory, name + ".3dm");
    private static JsonElement Args(object value) => JsonSerializer.SerializeToElement(value, RpcV2Contract.JsonOptions);
    private static JsonElement Manage(FakeService service, object args) => service.Execute(RpcOperation.manageRhinoDocument, Args(args)).Data!.Value;
    [Fact] public void StaleReplacementRejectsEvenAlreadyDirtyDocument()
    {
        var service = new FakeService(); var doc = service.Add(null, true); var observed = service.Describe(doc);
        doc.Revision++;
        var response = Manage(service, new { action = "new", expectedActiveDocument = observed.DocumentId,
            affectedDocuments = new[] { new { documentId = observed.DocumentId, expectedStateToken = observed.StateToken, onUnsaved = "discard" } } });
        Assert.Equal("DOCUMENT_CHANGED", response.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(0, service.Boundaries); Assert.Same(doc, service.Current);
    }
    [Fact] public void SaveThenFailedCloseReportsWrittenFileAndKeepsDocument()
    {
        var service = new FakeService { FailClose = true }; var doc = service.Add(null, true); var observed = service.Describe(doc);
        var path = FilePath("saved");
        var response = Manage(service, new { action = "close", documentId = observed.DocumentId, expectedStateToken = observed.StateToken, onUnsaved = "save", savePath = path });
        Assert.False(response.GetProperty("ok").GetBoolean()); Assert.True(File.Exists(path)); Assert.Same(doc, service.Current);
        Assert.Contains(response.GetProperty("effects").EnumerateArray(), e => e.GetProperty("stage").GetString() == "save" && e.GetProperty("completed").GetBoolean());
        Assert.True(response.GetProperty("outcomeUncertain").GetBoolean());
    }
    [Fact] public void SaveAsCannotOverwriteAnotherOpenDocument()
    {
        var service = new FakeService(); var target = service.Add(FilePath("target"), false); var source = service.Add(null, true); var observed = service.Describe(source);
        var response = Manage(service, new { action = "saveAs", documentId = observed.DocumentId, expectedStateToken = observed.StateToken, path = target.Path, overwrite = true });
        Assert.Equal("DESTINATION_OPEN_IN_OTHER_DOCUMENT", response.GetProperty("error").GetProperty("code").GetString()); Assert.Equal(0, service.Writes);
    }
    [Fact] public void ExternalReplacementIsDetectedByDigestEvenSameFileSize()
    {
        var path = FilePath("existing"); File.WriteAllText(path, "old"); var service = new FakeService(); var doc = service.Add(path, true); var observed = service.Describe(doc);
        var time = File.GetLastWriteTimeUtc(path); File.WriteAllText(path, "new"); File.SetLastWriteTimeUtc(path, time);
        var response = Manage(service, new { action = "save", documentId = observed.DocumentId, expectedStateToken = observed.StateToken });
        Assert.Equal("FILE_CHANGED_EXTERNALLY", response.GetProperty("error").GetProperty("code").GetString()); Assert.Equal(0, service.Writes);
    }
    [Fact] public void SaveEndsEditingSegmentAndPreservesWrittenDocument()
    {
        var service = new FakeService(); var doc = service.Add(null, true); var observed = service.Describe(doc);
        var response = Manage(service, new { action = "saveAs", documentId = observed.DocumentId, expectedStateToken = observed.StateToken, path = FilePath("new") });
        Assert.True(response.GetProperty("ok").GetBoolean()); Assert.Equal(1, service.Boundaries); Assert.Equal(1, service.Writes); Assert.False(doc.Dirty);
    }
    [Fact] public void NativeSaveRefreshesExternalConflictBaseline()
    {
        var path = FilePath("native"); File.WriteAllText(path, "old"); var service = new FakeService(); var doc = service.Add(path, true); service.Describe(doc);
        File.WriteAllText(path, "user"); service.ObserveNativeSave(doc); var observed = service.Describe(doc);
        var response = Manage(service, new { action = "save", documentId = observed.DocumentId, expectedStateToken = observed.StateToken });
        Assert.True(response.GetProperty("ok").GetBoolean());
    }
    [Fact] public void BrowseSupportsBoundedNativeFileInventory()
    {
        File.WriteAllText(FilePath("one"), ""); File.WriteAllText(System.IO.Path.Combine(_directory, "secret.txt"), ""); Directory.CreateDirectory(System.IO.Path.Combine(_directory, "sub"));
        var result = Args(DocumentFiles.Browse(Args(new { path = _directory, kind = "rhino", limit = 1 })));
        Assert.Single(result.GetProperty("entries").EnumerateArray()); Assert.Equal("1", result.GetProperty("nextCursor").GetString());
    }
    [Fact] public void SymlinkDestinationCannotAliasOtherOpenDocument()
    {
        var path = FilePath("real"); File.WriteAllText(path, "original");
        var alias = FilePath("alias"); File.CreateSymbolicLink(alias, path);
        var service = new FakeService(); service.Add(path, false); var doc = service.Add(null, true); var observed = service.Describe(doc);
        var response = Manage(service, new { action = "saveAs", documentId = observed.DocumentId, expectedStateToken = observed.StateToken, path = alias, overwrite = true });
        Assert.Equal("DESTINATION_OPEN_IN_OTHER_DOCUMENT", response.GetProperty("error").GetProperty("code").GetString());
    }
    [Fact] public void CreateDirectoriesOnlyRunsAfterPolicyValidation()
    {
        var service = new FakeService(); var doc = service.Add(null, true); var observed = service.Describe(doc);
        var path = System.IO.Path.Combine(_directory, "nested", "model.3dm");
        var rejected = Manage(service, new { action = "saveAs", documentId = observed.DocumentId, expectedStateToken = "stale", path, createDirectories = true });
        Assert.False(Directory.Exists(System.IO.Path.GetDirectoryName(path)));
        var response = Manage(service, new { action = "saveAs", documentId = observed.DocumentId, expectedStateToken = observed.StateToken, path, createDirectories = true });
        Assert.True(response.GetProperty("ok").GetBoolean()); Assert.True(File.Exists(path));
    }
    [Fact] public void BoundaryCallbackCannotReplaceAnUnobservedDocument()
    {
        var service = new FakeService(); var target = service.Add(null, true); var observed = service.Describe(target);
        service.OnFinish = () => service.Add(null, true);
        var response = Manage(service, new { action = "new", expectedActiveDocument = observed.DocumentId,
            affectedDocuments = new[] { new { documentId = observed.DocumentId, expectedStateToken = observed.StateToken, onUnsaved = "discard" } } });
        Assert.Equal("DOCUMENT_CHANGED", response.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(0, service.Creates); Assert.Equal(0, service.Writes); Assert.True(target.Dirty);
    }
    [Fact] public void BoundaryCallbackCannotDiscardNewTargetEdits()
    {
        var service = new FakeService(); var target = service.Add(null, true); var observed = service.Describe(target);
        service.OnFinish = () => target.Revision++;
        var response = Manage(service, new { action = "close", documentId = observed.DocumentId, expectedStateToken = observed.StateToken, onUnsaved = "discard" });
        Assert.Equal("DOCUMENT_CHANGED", response.GetProperty("error").GetProperty("code").GetString());
        Assert.Same(target, service.Current); Assert.Equal(0, service.Closes);
    }
    [Fact] public void PreSaveCallbackSwitchCannotReplaceAnotherDocument()
    {
        var service = new FakeService(); var target = service.Add(null, true); var observed = service.Describe(target);
        service.OnWrite = () => service.Add(null, true);
        var response = Manage(service, new { action = "new", expectedActiveDocument = observed.DocumentId,
            affectedDocuments = new[] { new { documentId = observed.DocumentId, expectedStateToken = observed.StateToken, onUnsaved = "save", savePath = FilePath("callback-switch") } } });
        Assert.Equal("DOCUMENT_CHANGED", response.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(0, service.Creates); Assert.True(service.Current!.Dirty);
        Assert.Contains(response.GetProperty("effects").EnumerateArray(), e => e.GetProperty("stage").GetString() == "save" && e.GetProperty("completed").GetBoolean());
    }
    [Fact] public void PreSaveCallbackEditCannotBeDiscardedByClose()
    {
        var service = new FakeService(); var target = service.Add(null, true); var observed = service.Describe(target);
        service.OnWrite = () => { target.Revision++; target.Dirty = true; };
        var response = Manage(service, new { action = "close", documentId = observed.DocumentId, expectedStateToken = observed.StateToken, onUnsaved = "save", savePath = FilePath("callback-edit") });
        Assert.Equal("DOCUMENT_CHANGED", response.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(0, service.Closes); Assert.Same(target, service.Current); Assert.True(target.Dirty);
        Assert.Contains(response.GetProperty("effects").EnumerateArray(), e => e.GetProperty("stage").GetString() == "save" && e.GetProperty("completed").GetBoolean());
    }
    private sealed class FakeDoc { public string Id = Guid.NewGuid().ToString(); public string? Path; public bool Dirty; public int Revision; }
    private sealed class FakeService : DocumentService<FakeDoc>
    {
        private readonly List<FakeDoc> _documents = new(); public FakeDoc? Current; public int Boundaries; public int Writes; public bool FailClose; public int Creates; public int Closes; public Action? OnFinish; public Action? OnWrite;
        public FakeDoc Add(string? path, bool dirty) { var doc = new FakeDoc { Path = path, Dirty = dirty }; _documents.Add(doc); Current = doc; return doc; }
        protected override string Kind => "rhino";
        protected override IEnumerable<FakeDoc> Documents => _documents;
        protected override FakeDoc? Active => Current;
        protected override string NativeId(FakeDoc doc) => doc.Id;
        protected override string? PathOf(FakeDoc doc) => doc.Path;
        protected override bool Modified(FakeDoc doc) => doc.Dirty;
        protected override string Fingerprint(FakeDoc doc) => doc.Revision.ToString();
        protected override object Settings(FakeDoc doc) => new { units = "Millimeters" };
        protected override void FinishSegment() { Boundaries++; OnFinish?.Invoke(); }
        protected override bool ReplacesActive => true;
        protected override FakeDoc Create(string? template) { Creates++; _documents.Clear(); return Add(null, false); }
        protected override FakeDoc Open(string path) { _documents.Clear(); return Add(path, false); }
        protected override void Activate(FakeDoc doc) => Current = doc;
        protected override bool Write(FakeDoc doc, string path) { Writes++; File.WriteAllText(path, "saved"); doc.Path = path; doc.Dirty = false; OnWrite?.Invoke(); return true; }
        protected override void Close(FakeDoc doc) { Closes++; if (FailClose) throw new Exception("Simulated close failure"); _documents.Remove(doc); Current = _documents.FirstOrDefault(); }
    }
}
