#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text.Json;
using Grasshopper;
using Grasshopper.Kernel;
using Hopper.Core.Operations;

namespace rhino_zmq_poc;

internal sealed class GrasshopperDocumentOperations : DocumentService<GH_Document>, IDisposable
{
    private static GrasshopperDocumentOperations? _instance;
    public static GrasshopperDocumentOperations Instance => _instance ??= new();
    private readonly Dictionary<GH_Document, Action> _unsubscribe = new();
    public void Dispose() { foreach (var unsubscribe in _unsubscribe.Values) unsubscribe(); _unsubscribe.Clear(); _handles.Clear(); _instance = null; }
    private readonly Dictionary<GH_Document, string> _handles = new();
    protected override string Kind => "grasshopper";
    protected override IEnumerable<GH_Document> Documents {
        get {
            var live = Enumerable.Range(0, Instances.DocumentServer.DocumentCount).Select(i => Instances.DocumentServer[i]).ToArray();
            foreach (var stale in _handles.Keys.Except(live).ToArray()) { if (_unsubscribe.Remove(stale, out var unsubscribe)) unsubscribe(); _handles.Remove(stale); }
            return live;
        }
    }
    protected override GH_Document? Active => Instances.ActiveCanvas?.Document;
    protected override string NativeId(GH_Document doc)
    {
        if (!_handles.TryGetValue(doc, out var id)) {
            _handles[doc] = id = Guid.NewGuid().ToString("N");
            GH_Document.FilePathChangedEventHandler pathChanged = (_, _) => AgentTransaction.AbandonActive();
            GH_Document.ModifiedChangedEventHandler modified = (_, _) => { if (!doc.IsModified) { AgentTransaction.ObserveSaved(); ObserveNativeSave(doc); } };
            GH_Document.UndoStateChangedEventHandler undo = (_, _) => AgentTransaction.AbandonExternal();
            doc.FilePathChanged += pathChanged; doc.ModifiedChanged += modified; doc.UndoStateChanged += undo;
            _unsubscribe[doc] = () => { doc.FilePathChanged -= pathChanged; doc.ModifiedChanged -= modified; doc.UndoStateChanged -= undo; };
        }
        return id;
    }
    public string? ActiveId => Active == null ? null : Id(Active);
    protected override string? PathOf(GH_Document doc) => doc.FilePath;
    protected override bool Modified(GH_Document doc) => doc.IsModified;
    protected override string Fingerprint(GH_Document doc)
    {
        var bytes = DocumentSnapshots.Serialize(doc) ?? throw new DocumentOperationException("STATE_VALIDATION_UNAVAILABLE", "Cannot serialize all persisted Grasshopper document state.");
        return Convert.ToHexString(SHA256.HashData(bytes));
    }
    protected override string TransitionFingerprint(GH_Document doc)
    {
        var archive = new GH_IO.Serialization.GH_Archive();
        if (!archive.AppendObject(doc, "Definition"))
            throw new DocumentOperationException("STATE_VALIDATION_UNAVAILABLE", "Cannot serialize Grasshopper document content.");
        // SaveAs updates the persisted filename here. Ignore only that derived
        // metadata when detecting content changes made by callbacks during a save.
        var properties = archive.GetRootNode.FindChunk("Definition")?.FindChunk("DefinitionProperties") as GH_IO.Serialization.GH_Chunk
            ?? throw new DocumentOperationException("STATE_VALIDATION_UNAVAILABLE", "Grasshopper definition properties are unavailable.");
        properties.RemoveItem("Name");
        return Convert.ToHexString(SHA256.HashData(archive.Serialize_Binary()));
    }
    protected override object Settings(GH_Document doc)
    {
        var active = DocumentSession.ActiveRhinoDocumentId?.Invoke();
        var associated = doc.RhinoDocument;
        var association = associated == null ? null : $"{DocumentSession.LifecycleInstanceId}:rhino:{associated.RuntimeSerialNumber}";
        var settings = active == null ? null : DocumentSession.ReadRhinoSettings?.Invoke(active);
        var contextRevision = DocumentSession.Digest(association + "|" + active + "|" + JsonSerializer.Serialize(settings));
        return new { documentId = Id(doc), lifecycleInstanceId = DocumentSession.LifecycleInstanceId,
            settingsRevision = contextRevision, resolutionSource = settings == null ? "unresolved" : "activeRhinoDocument", associatedRhinoDocumentId = association,
            activeRhinoDocumentId = active, sourceDocumentId = active, contextMismatch = association != null && association != active,
            settings, solverEnabled = doc.Enabled,
            diagnostics = new[] { "Standard Grasshopper tolerance helpers use active Rhino context. Components and explicit tolerance inputs may use other settings." } };
    }
    public object? CurrentSettings => Active == null ? null : Settings(Active);
    protected override void FinishSegment()
    {
        DocumentSession.EnsureRhinoDocumentReady?.Invoke();
        if (Instances.ActiveCanvas == null) new Grasshopper.Plugin.GH_RhinoScriptInterface().LoadEditor();
        if (Instances.ActiveCanvas == null)
            throw new DocumentOperationException("CAPABILITY_UNAVAILABLE", "Grasshopper could not create an active canvas.");
        AgentTransaction.Reconcile();
        var result = AgentTransaction.CommitActive();
        if (result.Contains(" error:", StringComparison.OrdinalIgnoreCase)) throw new DocumentOperationException("TRANSACTION_COMPLETION_FAILED", result);
        DocumentSession.Advance(Kind, null, "idle");
    }
    protected override GH_Document Create(string? template)
    {
        if (template != null) {
            var io = new GH_DocumentIO();
            if (!io.Open(template) || io.Document == null) throw new DocumentOperationException("NATIVE_OPEN_FAILED", "Cannot load template.");
            io.Document.FilePath = null;
            io.Document.IsModified = true;
            Instances.DocumentServer.AddDocument(io.Document);
            Activate(io.Document);
            return io.Document;
        }
        var document = new GH_Document();
        Instances.DocumentServer.AddDocument(document);
        Activate(document);
        return document;
    }
    protected override GH_Document Open(string path)
    {
        var io = new GH_DocumentIO();
        if (!io.Open(path) || io.Document == null) throw new DocumentOperationException("NATIVE_OPEN_FAILED", "Grasshopper failed to deserialize the definition.");
        var document = io.Document;
        Instances.DocumentServer.AddDocument(document);
        Activate(document);
        return document;
    }
    protected override void Activate(GH_Document doc)
    {
        if (Instances.ActiveCanvas == null) throw new DocumentOperationException("CAPABILITY_UNAVAILABLE", "Grasshopper has no active canvas.");
        Instances.ActiveCanvas.Document = doc;
        if (Instances.ActiveCanvas.Document != doc) throw new DocumentOperationException("ACTIVATION_FAILED", "Grasshopper did not activate the definition.");
    }
    protected override bool Write(GH_Document doc, string path)
    {
        var before = TransitionFingerprint(doc);
        var io = new GH_DocumentIO { Document = doc };
        if (!io.SaveQuiet(path)) return false;
        doc.FilePath = path;
        try { doc.IsModified = before != TransitionFingerprint(doc); }
        catch { doc.IsModified = true; throw; }
        return true;
    }
    protected override void Close(GH_Document doc)
    {
        if (Active == doc && Instances.ActiveCanvas != null) Instances.ActiveCanvas.Document = Documents.FirstOrDefault(d => d != doc);
        Instances.DocumentServer.RemoveDocument(doc);
        if (Documents.Contains(doc)) throw new DocumentOperationException("NATIVE_CLOSE_FAILED", "Grasshopper document remains registered.");
        if (_unsubscribe.Remove(doc, out var unsubscribe)) unsubscribe();
        _handles.Remove(doc);
        doc.Dispose();
    }
}
