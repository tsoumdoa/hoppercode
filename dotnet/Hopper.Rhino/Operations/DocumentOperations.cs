#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using Hopper.Core.Operations;
using Rhino;
using Rhino.FileIO;

namespace rhino_zmq_poc;

internal sealed class RhinoDocumentOperations : DocumentService<RhinoDoc>, IDisposable
{
    private static RhinoDocumentOperations? _instance;
    public static RhinoDocumentOperations Instance => _instance ??= new();
    private readonly List<Action> _unsubscribe = new();
    public void Dispose() { foreach (var unsubscribe in _unsubscribe) unsubscribe(); _unsubscribe.Clear(); DocumentSession.ReadRhinoSettings = null; DocumentSession.ActiveRhinoDocumentId = null; DocumentSession.EnsureRhinoDocumentReady = null; MacDocumentWindows.Reset(); _instance = null; }
    private readonly Dictionary<uint, long> _revisions = new();
    private readonly Dictionary<uint, long> _contentRevisions = new();
    private int _managedDepth;
    private bool _managed => _managedDepth > 0;
    private RhinoDocumentOperations()
    {
        DocumentSession.EnsureRhinoDocumentReady = EnsureDocumentReady;
        DocumentSession.ReadRhinoSettings = id => id == null ? (Active == null ? null : Settings(Active)) : Settings(Resolve(id));
        DocumentSession.ActiveRhinoDocumentId = () => Active == null ? null : Id(Active);
        EventHandler<Rhino.DocObjects.RhinoObjectEventArgs> AddRhinoObjectHandler = (_, e) => Touch(e.TheObject.Document);
        RhinoDoc.AddRhinoObject += AddRhinoObjectHandler;
        _unsubscribe.Add(() => RhinoDoc.AddRhinoObject -= AddRhinoObjectHandler);
        EventHandler<Rhino.DocObjects.RhinoObjectEventArgs> DeleteRhinoObjectHandler = (_, e) => Touch(e.TheObject.Document);
        RhinoDoc.DeleteRhinoObject += DeleteRhinoObjectHandler;
        _unsubscribe.Add(() => RhinoDoc.DeleteRhinoObject -= DeleteRhinoObjectHandler);
        EventHandler<Rhino.DocObjects.RhinoReplaceObjectEventArgs> ReplaceRhinoObjectHandler = (_, e) => Touch(e.Document);
        RhinoDoc.ReplaceRhinoObject += ReplaceRhinoObjectHandler;
        _unsubscribe.Add(() => RhinoDoc.ReplaceRhinoObject -= ReplaceRhinoObjectHandler);
        EventHandler<Rhino.DocObjects.RhinoObjectEventArgs> UndeleteRhinoObjectHandler = (_, e) => Touch(e.TheObject.Document);
        RhinoDoc.UndeleteRhinoObject += UndeleteRhinoObjectHandler;
        _unsubscribe.Add(() => RhinoDoc.UndeleteRhinoObject -= UndeleteRhinoObjectHandler);
        EventHandler<Rhino.DocObjects.RhinoModifyObjectAttributesEventArgs> ModifyObjectAttributesHandler = (_, e) => Touch(e.Document);
        RhinoDoc.ModifyObjectAttributes += ModifyObjectAttributesHandler;
        _unsubscribe.Add(() => RhinoDoc.ModifyObjectAttributes -= ModifyObjectAttributesHandler);
        EventHandler<Rhino.DocObjects.Tables.LayerTableEventArgs> LayerTableEventHandler = (_, e) => Touch(e.Document);
        RhinoDoc.LayerTableEvent += LayerTableEventHandler;
        _unsubscribe.Add(() => RhinoDoc.LayerTableEvent -= LayerTableEventHandler);
        EventHandler<Rhino.DocObjects.Tables.MaterialTableEventArgs> MaterialTableEventHandler = (_, e) => Touch(e.Document);
        RhinoDoc.MaterialTableEvent += MaterialTableEventHandler;
        _unsubscribe.Add(() => RhinoDoc.MaterialTableEvent -= MaterialTableEventHandler);
        EventHandler<Rhino.DocObjects.Tables.LinetypeTableEventArgs> LinetypeTableEventHandler = (_, e) => Touch(e.Document);
        RhinoDoc.LinetypeTableEvent += LinetypeTableEventHandler;
        _unsubscribe.Add(() => RhinoDoc.LinetypeTableEvent -= LinetypeTableEventHandler);
        EventHandler<Rhino.DocObjects.Tables.DimStyleTableEventArgs> DimensionStyleTableEventHandler = (_, e) => Touch(e.Document);
        RhinoDoc.DimensionStyleTableEvent += DimensionStyleTableEventHandler;
        _unsubscribe.Add(() => RhinoDoc.DimensionStyleTableEvent -= DimensionStyleTableEventHandler);
        EventHandler<Rhino.DocObjects.Tables.InstanceDefinitionTableEventArgs> InstanceDefinitionTableEventHandler = (_, e) => Touch(e.Document);
        RhinoDoc.InstanceDefinitionTableEvent += InstanceDefinitionTableEventHandler;
        _unsubscribe.Add(() => RhinoDoc.InstanceDefinitionTableEvent -= InstanceDefinitionTableEventHandler);
        EventHandler<Rhino.DocObjects.Tables.GroupTableEventArgs> GroupTableEventHandler = (_, e) => Touch(e.Document);
        RhinoDoc.GroupTableEvent += GroupTableEventHandler;
        _unsubscribe.Add(() => RhinoDoc.GroupTableEvent -= GroupTableEventHandler);
        EventHandler<Rhino.DocObjects.Tables.LightTableEventArgs> LightTableEventHandler = (_, e) => Touch(e.Document);
        RhinoDoc.LightTableEvent += LightTableEventHandler;
        _unsubscribe.Add(() => RhinoDoc.LightTableEvent -= LightTableEventHandler);
        EventHandler<Rhino.DocumentEventArgs> DocumentPropertiesChangedHandler = (_, e) => Touch(e.Document, false);
        RhinoDoc.DocumentPropertiesChanged += DocumentPropertiesChangedHandler;
        _unsubscribe.Add(() => RhinoDoc.DocumentPropertiesChanged -= DocumentPropertiesChangedHandler);
        EventHandler<Rhino.RhinoDoc.UserStringChangedArgs> UserStringChangedHandler = (_, e) => Touch(e.Document);
        RhinoDoc.UserStringChanged += UserStringChangedHandler;
        _unsubscribe.Add(() => RhinoDoc.UserStringChanged -= UserStringChangedHandler);
        EventHandler<RhinoDoc.RenderContentTableEventArgs> RenderMaterialsTableEventHandler = (_, e) => Touch(e.Document);
        RhinoDoc.RenderMaterialsTableEvent += RenderMaterialsTableEventHandler;
        _unsubscribe.Add(() => RhinoDoc.RenderMaterialsTableEvent -= RenderMaterialsTableEventHandler);
        EventHandler<RhinoDoc.RenderContentTableEventArgs> RenderEnvironmentTableEventHandler = (_, e) => Touch(e.Document);
        RhinoDoc.RenderEnvironmentTableEvent += RenderEnvironmentTableEventHandler;
        _unsubscribe.Add(() => RhinoDoc.RenderEnvironmentTableEvent -= RenderEnvironmentTableEventHandler);
        EventHandler<RhinoDoc.RenderContentTableEventArgs> RenderTextureTableEventHandler = (_, e) => Touch(e.Document);
        RhinoDoc.RenderTextureTableEvent += RenderTextureTableEventHandler;
        _unsubscribe.Add(() => RhinoDoc.RenderTextureTableEvent -= RenderTextureTableEventHandler);
        EventHandler<RhinoDoc.TextureMappingEventArgs> TextureMappingEventHandler = (_, e) => Touch(e.Document);
        RhinoDoc.TextureMappingEvent += TextureMappingEventHandler;
        _unsubscribe.Add(() => RhinoDoc.TextureMappingEvent -= TextureMappingEventHandler);
        EventHandler<Rhino.DocumentSaveEventArgs> BeginSaveDocumentHandler = (_, _) => ExternalBoundary();
        RhinoDoc.BeginSaveDocument += BeginSaveDocumentHandler;
        _unsubscribe.Add(() => RhinoDoc.BeginSaveDocument -= BeginSaveDocumentHandler);
        EventHandler<Rhino.DocumentSaveEventArgs> EndSaveDocumentHandler = (_, e) => { if (!_managed) ObserveNativeSave(e.Document); };
        RhinoDoc.EndSaveDocument += EndSaveDocumentHandler;
        _unsubscribe.Add(() => RhinoDoc.EndSaveDocument -= EndSaveDocumentHandler);
        EventHandler<Rhino.DocumentOpenEventArgs> BeginOpenDocumentHandler = (_, _) => ExternalBoundary();
        RhinoDoc.BeginOpenDocument += BeginOpenDocumentHandler;
        _unsubscribe.Add(() => RhinoDoc.BeginOpenDocument -= BeginOpenDocumentHandler);
        EventHandler<Rhino.DocumentEventArgs> CloseDocumentHandler = (_, e) => { MacDocumentWindows.Forget(e.Document.RuntimeSerialNumber); ExternalBoundary(); };
        RhinoDoc.CloseDocument += CloseDocumentHandler;
        _unsubscribe.Add(() => RhinoDoc.CloseDocument -= CloseDocumentHandler);
        EventHandler<Rhino.DocumentEventArgs> ActiveDocumentChangedHandler = (_, _) => ExternalBoundary();
        RhinoDoc.ActiveDocumentChanged += ActiveDocumentChangedHandler;
        _unsubscribe.Add(() => RhinoDoc.ActiveDocumentChanged -= ActiveDocumentChangedHandler);
        EventHandler<Rhino.Commands.UndoRedoEventArgs> UndoRedoHandler = (_, e) => { if (e.IsBeginUndo || e.IsBeginRedo) ExternalBoundary(); };
        Rhino.Commands.Command.UndoRedo += UndoRedoHandler;
        _unsubscribe.Add(() => Rhino.Commands.Command.UndoRedo -= UndoRedoHandler);
    }
    private void Touch(RhinoDoc doc, bool content = true) { _revisions[doc.RuntimeSerialNumber] = _revisions.GetValueOrDefault(doc.RuntimeSerialNumber) + 1; if (content) _contentRevisions[doc.RuntimeSerialNumber] = _contentRevisions.GetValueOrDefault(doc.RuntimeSerialNumber) + 1; }
    private void ExternalBoundary()
    {
        if (_managed) return;
        try { RhinoAgentTransaction.CommitActive(); }
        catch { /* A native close may already have invalidated the undo record. Never touch another document. */ }
        finally { DocumentSession.Advance(Kind, null, "abandoned"); }
    }
    protected override string Kind => "rhino";
    protected override IEnumerable<RhinoDoc> Documents => RhinoDoc.OpenDocuments(false);
    protected override RhinoDoc? Active => RhinoDoc.ActiveDoc;
    protected override string NativeId(RhinoDoc doc) => doc.RuntimeSerialNumber.ToString();
    protected override string? PathOf(RhinoDoc doc) => doc.Path;
    protected override bool Modified(RhinoDoc doc) => OperatingSystem.IsMacOS() ? MacDocumentWindows.IsModified(doc) : doc.Modified;
    protected override void MarkModified(RhinoDoc doc)
    {
        if (OperatingSystem.IsMacOS()) MacDocumentWindows.MarkModified(doc);
        else doc.Modified = true;
    }
    protected override bool ReplacesActive => OperatingSystem.IsWindows();
    protected override string Fingerprint(RhinoDoc doc) => _revisions.GetValueOrDefault(doc.RuntimeSerialNumber) + "|" + SettingsRevision(doc) + "|" + PersistedPropertiesRevision(doc);
    protected override string TransitionFingerprint(RhinoDoc doc) => _contentRevisions.GetValueOrDefault(doc.RuntimeSerialNumber) + "|" + SettingsRevision(doc) + "|" + PersistedPropertiesRevision(doc);
    private static readonly JsonSerializerOptions PropertyJson = new() { NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals };
    private static string PersistedPropertiesRevision(RhinoDoc doc)
    {
        // DocumentPropertiesChanged also fires for save-derived path/date metadata.
        // Compare the supported persisted property values instead of ignoring that
        // entire event category during a write. RenderSettings' native archive
        // includes nested render settings without maintaining a second field list.
        using var render = doc.RenderSettings;
        using var earth = doc.EarthAnchorPoint;
        using var mesh = doc.GetMeshingParameters(Rhino.Geometry.MeshingParameterStyle.Custom);
        using var analysisMesh = doc.GetAnalysisMeshingParameters();
        using var animation = doc.AnimationProperties;
        return DocumentSession.Digest(JsonSerializer.Serialize(new {
            doc.Notes, doc.ModelBasepoint, earth,
            render = render.ToJSON(new SerializationOptions { WriteUserData = true }),
            animation, doc.CustomRenderSizes, doc.MeshingParameterStyle, mesh, analysisMesh,
            doc.ModelSpaceHatchScale, doc.ModelSpaceHatchScalingEnabled,
            doc.ModelSpaceTextScale, doc.ModelSpaceAnnotationScalingEnabled, doc.LayoutSpaceAnnotationScalingEnabled,
        }, PropertyJson));
    }
    public object ReadSettings(string? id) => Settings(id == null ? Active ?? throw new DocumentOperationException("DOCUMENT_NOT_FOUND", "No active Rhino document.") : Resolve(id));
    public string? ActiveId => Active == null ? null : Id(Active);
    public void EnsureDocumentReady() { if (OperatingSystem.IsMacOS()) MacDocumentWindows.EnsureSettled(); }
    public void ValidateExpected(ExpectedDocument? expected)
    {
        EnsureDocumentReady();
        if (expected == null) return;
        if (expected.LifecycleInstanceId != DocumentSession.LifecycleInstanceId || expected.DocumentId != ActiveId)
            throw new DocumentOperationException("DOCUMENT_CHANGED", "The intended Rhino document is no longer active.");
        if (expected.SettingsRevision != null && expected.SettingsRevision != SettingsRevision(Resolve(expected.DocumentId)))
            throw new DocumentOperationException("SETTINGS_CHANGED", "Rhino units or tolerances changed after the script target was inspected.");
    }
    private object Unit(RhinoDoc doc, bool model)
    {
        var unit = model ? doc.ModelUnitSystem : doc.PageUnitSystem;
        string? customName = null;
        double? scale = null;
        if (unit == UnitSystem.CustomUnits && doc.GetCustomUnitSystem(model, out var name, out var meters)) { customName = name; scale = meters; }
        else if (unit != UnitSystem.None && unit != UnitSystem.Unset && unit != UnitSystem.CustomUnits) scale = RhinoMath.UnitScale(unit, UnitSystem.Meters);
        return new { name = unit.ToString(), enumValue = (int)unit, metersPerUnit = scale.HasValue && double.IsFinite(scale.Value) ? scale : null,
            customName, isUnitless = unit == UnitSystem.None, scaleKnown = scale.HasValue && scale > 0 };
    }
    private object Values(RhinoDoc doc) => new {
        model = new { units = Unit(doc, true), absoluteTolerance = doc.ModelAbsoluteTolerance,
            angleToleranceRadians = doc.ModelAngleToleranceRadians, angleToleranceDegrees = doc.ModelAngleToleranceDegrees,
            relativeToleranceRatio = doc.ModelRelativeTolerance, distanceDisplayPrecision = doc.ModelDistanceDisplayPrecision },
        layout = new { units = Unit(doc, false), absoluteTolerance = doc.PageAbsoluteTolerance,
            angleToleranceRadians = doc.PageAngleToleranceRadians, angleToleranceDegrees = doc.PageAngleToleranceDegrees,
            relativeToleranceRatio = doc.PageRelativeTolerance, distanceDisplayPrecision = doc.PageDistanceDisplayPrecision }
    };
    private string SettingsRevision(RhinoDoc doc) => DocumentSession.Digest(JsonSerializer.Serialize(Values(doc)));
    protected override object Settings(RhinoDoc doc)
    {
        var values = JsonSerializer.SerializeToElement(Values(doc));
        return new { documentId = Id(doc), lifecycleInstanceId = DocumentSession.LifecycleInstanceId, settingsRevision = SettingsRevision(doc),
            model = values.GetProperty("model"), layout = values.GetProperty("layout"),
            diagnostics = new[] { "Relative tolerance is the native dimensionless ratio; the Rhino UI displays ratio multiplied by 100 as percent." } };
    }
    protected override void FinishSegment()
    {
        EnsureDocumentReady();
        if (RhinoApp.InCommand > 0) throw new DocumentOperationException("HOST_BUSY", "Rhino has an active command.");
        var result = RhinoAgentTransaction.CommitActive();
        if (result.Contains(" error:", StringComparison.OrdinalIgnoreCase)) throw new DocumentOperationException("TRANSACTION_COMPLETION_FAILED", result);
        DocumentSession.Advance(Kind, null, "idle");
    }
    private T Managed<T>(Func<T> action) { _managedDepth++; try { return action(); } finally { _managedDepth--; } }
    protected override RhinoDoc Create(string? template) => Managed(() => {
        if (OperatingSystem.IsMacOS()) return MacDocumentWindows.New(template);
        var previous = Active; var dirty = previous?.Modified ?? false;
        if (ReplacesActive && previous != null) previous.Modified = false;
        try { var created = RhinoDoc.Create(template) ?? throw new DocumentOperationException("NATIVE_OPEN_FAILED", "Rhino did not create a document."); if (created.Views.GetStandardRhinoViews().Length == 0) created.Views.DefaultViewLayout(); return created; }
        catch { if (previous != null && Documents.Contains(previous)) previous.Modified = dirty; throw; }
    });
    protected override RhinoDoc Open(string path) => Managed(() => {
        if (OperatingSystem.IsMacOS()) return MacDocumentWindows.Open(path);
        var previous = Active; var dirty = previous?.Modified ?? false;
        if (ReplacesActive && previous != null) previous.Modified = false;
        try { return RhinoDoc.Open(path, out _) ?? throw new DocumentOperationException("NATIVE_OPEN_FAILED", "Rhino did not open the file."); }
        catch { if (previous != null && Documents.Contains(previous)) previous.Modified = dirty; throw; }
    });
    protected override void Activate(RhinoDoc doc) => Managed(() => { if (OperatingSystem.IsMacOS()) MacDocumentWindows.Activate(doc); else RhinoDoc.ActiveDoc = doc; if (Active != doc) throw new DocumentOperationException("ACTIVATION_FAILED", "Rhino did not activate the requested document."); return true; });
    protected override bool Write(RhinoDoc doc, string path) => Managed(() => {
        using var options = new FileWriteOptions { UpdateDocumentPath = true, SuppressDialogBoxes = true, SuppressAllInput = true, WriteSelectedObjectsOnly = false, WriteUserData = true };
        return doc.WriteFile(path, options);
    });
    protected override void Close(RhinoDoc doc) => Managed(() => {
        if (OperatingSystem.IsWindows()) Activate(doc);
        var dirty = doc.Modified;
        doc.Modified = false;
        try {
            if (OperatingSystem.IsWindows()) Create(null);
            else MacDocumentWindows.Close(doc);
            if (Documents.Contains(doc)) throw new DocumentOperationException("NATIVE_CLOSE_FAILED", "Target document remains open.");
        } catch { if (Documents.Contains(doc)) doc.Modified = dirty; throw; }
        return true;
    });
}
