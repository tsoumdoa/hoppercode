using System.Text.Json;
using Grasshopper;
using Grasshopper.Kernel;
using Grasshopper.Kernel.Special;
using Hopper.Core.Operations;
using Hopper.Core.Protocol;
using Rhino;
using Rhino.Geometry;
using rhino_zmq_poc;
using Xunit;

namespace grasshopper_plugin.Tests;

/// <summary>
/// Explicit native smoke entry point, not a dotnet-test Fact. Run inside Rhino
/// using scripts/run-native-tests.mjs. Every mutation targets disposable documents.
/// </summary>
public static class DocumentManagementNativeTests
{
    public static void RunAll()
    {
        if (!OperatingSystem.IsMacOS())
            throw new InvalidOperationException("This preservation harness currently requires macOS multi-document Rhino.");
        var originalRhino = RhinoDoc.ActiveDoc;
        var originalGh = Instances.ActiveCanvas?.Document;
        var originalRhinoIds = RhinoDoc.OpenDocuments(false).Select(d => d.RuntimeSerialNumber).ToHashSet();
        var originalGhIds = GhDocuments().Select(d => d.DocumentID).ToHashSet();
        var originalModified = originalRhino?.Modified;
        var originalUnits = originalRhino?.ModelUnitSystem;
        var root = Path.Combine(Path.GetTempPath(), "hopper-document-native-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        Exception? testFailure = null;
        try
        {
            File.AppendAllText(Path.Combine(root, "progress.log"), "Rhino lifecycle started\n");
            RhinoLifecycle(root);
            if (originalRhino != null) MacDocumentWindows.Activate(originalRhino);
            File.AppendAllText(Path.Combine(root, "progress.log"), "Grasshopper lifecycle started\n");
            GrasshopperLifecycle(root);
            File.AppendAllText(Path.Combine(root, "progress.log"), "Grasshopper external save started\n");
            GrasshopperExternalSavePreservesCurrentState(root);
            GrasshopperSaveCallbackRemainsDirty(root);
        }
        catch (Exception error) { testFailure = error; }
        finally
        {
            try {
            AgentTransaction.AbandonActive();
            RhinoAgentTransaction.CommitActive();
            var canvas = (object?)Instances.ActiveCanvas;
            canvas?.GetType().GetProperty("Document")?.SetValue(canvas, originalGh);
            foreach (var doc in GhDocuments().Where(d => !originalGhIds.Contains(d.DocumentID)))
            {
                Instances.DocumentServer.RemoveDocument(doc);
                doc.Dispose();
            }
            foreach (var doc in RhinoDoc.OpenDocuments(false).Where(d => !originalRhinoIds.Contains(d.RuntimeSerialNumber)).ToArray())
            {
                doc.Modified = false;
                RhinoDoc.ActiveDoc = doc;
                MacDocumentWindows.Close(doc);
            }
            if (originalRhino != null) MacDocumentWindows.Activate(originalRhino);
            if (originalRhino != null)
            {
                Assert.Equal(originalModified, originalRhino.Modified);
                Assert.Equal(originalUnits, originalRhino.ModelUnitSystem);
                Assert.Same(originalRhino, RhinoDoc.ActiveDoc);
            }
            Assert.True(originalRhinoIds.SetEquals(RhinoDoc.OpenDocuments(false).Select(d => d.RuntimeSerialNumber)));
            Assert.True(originalGhIds.SetEquals(GhDocuments().Select(d => d.DocumentID)));
            } catch (Exception cleanupError) { if (testFailure != null) throw new AggregateException("Native test and cleanup both failed", testFailure, cleanupError); throw; }
            finally {
                try { RhinoDocumentOperations.Instance.Dispose(); }
                finally { GrasshopperDocumentOperations.Instance.Dispose(); }
            }
        }
        if (testFailure != null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(testFailure).Throw();
    }

    private static void RhinoLifecycle(string root)
    {
        var service = RhinoDocumentOperations.Instance;
        var result = Success(service, RpcOperation.manageRhinoDocument, new
        {
            action = "new", expectedActiveDocument = service.ActiveId,
            affectedDocuments = Array.Empty<object>(),
        });
        var id = result.GetProperty("document").GetProperty("documentId").GetString()!;
        var doc = service.Resolve(id);
        Assert.Same(doc, RhinoDoc.ActiveDoc);
        Assert.Null(service.Describe(doc).Path);
        Assert.True(doc.Views.GetStandardRhinoViews().Length > 0, "A newly created visible Rhino document must have a viewport.");
        var initial = service.Describe(doc);
        var pointId = doc.Objects.AddPoint(new Point3d(12, 34, 56));
        Assert.NotEqual(Guid.Empty, pointId);
        Assert.NotEqual(initial.StateToken, service.Describe(doc).StateToken);

        var settings = service.Execute(RpcOperation.getRhinoDocumentSettings, Json(new { documentId = id })).Data!.Value;
        var beforeRevision = settings.GetProperty("settingsRevision").GetString();
        doc.ModelAbsoluteTolerance = 0.0025;
        var changedSettings = service.Execute(RpcOperation.getRhinoDocumentSettings, Json(new { documentId = id })).Data!.Value;
        Assert.Equal(0.0025, changedSettings.GetProperty("model").GetProperty("absoluteTolerance").GetDouble());
        Assert.NotEqual(beforeRevision, changedSettings.GetProperty("settingsRevision").GetString());
        var stale = service.Describe(doc);
        doc.Objects.AddPoint(new Point3d(1, 2, 3));
        Error(service, RpcOperation.manageRhinoDocument, new { action = "close", documentId = id,
            expectedStateToken = stale.StateToken, onUnsaved = "discard" }, "DOCUMENT_CHANGED");

        var path = Path.Combine(root, "model α.3dm");
        Success(service, RpcOperation.manageRhinoDocument, new { action = "saveAs", documentId = id,
            expectedStateToken = service.Describe(doc).StateToken, path });
        Assert.True(File.Exists(path));
        Assert.True(DocumentFiles.Same(path, doc.Path));
        Assert.False(doc.Modified);
        Success(service, RpcOperation.manageRhinoDocument, new { action = "close", documentId = id,
            expectedStateToken = service.Describe(doc).StateToken, onUnsaved = "fail" });
        result = Success(service, RpcOperation.manageRhinoDocument, new { action = "open", path,
            expectedActiveDocument = service.ActiveId, affectedDocuments = Array.Empty<object>() });
        var reopenedId = result.GetProperty("document").GetProperty("documentId").GetString()!;
        Assert.NotEqual(id, reopenedId);
        var reopened = service.Resolve(reopenedId);
        Assert.NotNull(reopened.Objects.FindId(pointId));
        Assert.Equal(0.0025, reopened.ModelAbsoluteTolerance);
        var duplicate = Success(service, RpcOperation.manageRhinoDocument, new { action = "open", path,
            expectedActiveDocument = service.ActiveId, affectedDocuments = Array.Empty<object>() });
        Assert.True(duplicate.GetProperty("alreadyOpen").GetBoolean());
        Assert.Equal(reopenedId, duplicate.GetProperty("document").GetProperty("documentId").GetString());
        var templateCreated = Success(service, RpcOperation.manageRhinoDocument, new { action = "new", templatePath = path,
            expectedActiveDocument = service.ActiveId, affectedDocuments = Array.Empty<object>() });
        var templateId = templateCreated.GetProperty("document").GetProperty("documentId").GetString()!;
        var fromTemplate = service.Resolve(templateId);
        Assert.Null(service.Describe(fromTemplate).Path);
        Assert.Equal(0.0025, fromTemplate.ModelAbsoluteTolerance);
        Assert.NotNull(fromTemplate.Objects.FindId(pointId));
        Success(service, RpcOperation.manageRhinoDocument, new { action = "close", documentId = templateId,
            expectedStateToken = service.Describe(fromTemplate).StateToken, onUnsaved = "discard" });
        Success(service, RpcOperation.manageRhinoDocument, new { action = "close", documentId = reopenedId,
            expectedStateToken = service.Describe(reopened).StateToken, onUnsaved = "fail" });
    }

    private static void GrasshopperLifecycle(string root)
    {
        var service = GrasshopperDocumentOperations.Instance;
        foreach (var extension in new[] { ".gh", ".ghx" })
        {
            var created = Success(service, RpcOperation.manageGrasshopperDocument, new { action = "new",
                expectedActiveDocument = service.ActiveId, affectedDocuments = Array.Empty<object>() });
            var id = created.GetProperty("document").GetProperty("documentId").GetString()!;
            var doc = service.Resolve(id);
            var panel = new GH_Panel { UserText = "native roundtrip α" };
            panel.CreateAttributes();
            doc.AddObject(panel, false);
            var first = service.Describe(doc).StateToken;
            Assert.Equal(first, service.Describe(doc).StateToken);
            doc.NewSolution(false);
            Assert.Equal(first, service.Describe(doc).StateToken);
            var enabled = GH_Document.EnableSolutions;
            try
            {
                GH_Document.EnableSolutions = false;
                panel.UserText = "updated while solver disabled";
                doc.IsModified = true;
                Assert.NotEqual(first, service.Describe(doc).StateToken);
            }
            finally { GH_Document.EnableSolutions = enabled; }
            Error(service, RpcOperation.manageGrasshopperDocument, new { action = "close", documentId = id,
                expectedStateToken = first, onUnsaved = "discard" }, "DOCUMENT_CHANGED");
            var path = Path.Combine(root, "definition α" + extension);
            void Snapshot(string suffix) {
                var archive = new GH_IO.Serialization.GH_Archive();
                archive.AppendObject(doc, "Definition");
                File.WriteAllText(Path.Combine(root, "save-" + suffix + ".xml"), archive.Serialize_Xml());
            }
            Snapshot("before");
            try { Success(service, RpcOperation.manageGrasshopperDocument, new { action = "saveAs", documentId = id,
                expectedStateToken = service.Describe(doc).StateToken, path }); }
            finally { Snapshot("after"); }
            Assert.True(File.Exists(path));
            Assert.False(doc.IsModified);
            var second = Success(service, RpcOperation.manageGrasshopperDocument, new { action = "new", templatePath = path,
                expectedActiveDocument = service.ActiveId, affectedDocuments = Array.Empty<object>() });
            var secondId = second.GetProperty("document").GetProperty("documentId").GetString()!;
            var secondDoc = service.Resolve(secondId);
            Assert.Null(service.Describe(secondDoc).Path);
            Assert.Equal("updated while solver disabled", Assert.Single(secondDoc.Objects.OfType<GH_Panel>()).UserText);
            Error(service, RpcOperation.manageGrasshopperDocument, new { action = "saveAs", documentId = secondId,
                expectedStateToken = service.Describe(secondDoc).StateToken, path, overwrite = true }, "DESTINATION_OPEN_IN_OTHER_DOCUMENT");
            Success(service, RpcOperation.manageGrasshopperDocument, new { action = "close", documentId = secondId,
                expectedStateToken = service.Describe(secondDoc).StateToken, onUnsaved = "discard" });
            Success(service, RpcOperation.manageGrasshopperDocument, new { action = "close", documentId = id,
                expectedStateToken = service.Describe(doc).StateToken, onUnsaved = "fail" });
            var reopened = Success(service, RpcOperation.manageGrasshopperDocument, new { action = "open", path,
                expectedActiveDocument = service.ActiveId, affectedDocuments = Array.Empty<object>() });
            var reopenedId = reopened.GetProperty("document").GetProperty("documentId").GetString()!;
            Assert.NotEqual(id, reopenedId);
            var reopenedDoc = service.Resolve(reopenedId);
            Assert.Equal("updated while solver disabled", Assert.Single(reopenedDoc.Objects.OfType<GH_Panel>()).UserText);
            Success(service, RpcOperation.manageGrasshopperDocument, new { action = "close", documentId = reopenedId,
                expectedStateToken = service.Describe(reopenedDoc).StateToken, onUnsaved = "fail" });
        }
    }

    private static void GrasshopperExternalSavePreservesCurrentState(string root)
    {
        var service = GrasshopperDocumentOperations.Instance;
        var created = Success(service, RpcOperation.manageGrasshopperDocument, new { action = "new",
            expectedActiveDocument = service.ActiveId, affectedDocuments = Array.Empty<object>() });
        var id = created.GetProperty("document").GetProperty("documentId").GetString()!;
        var doc = service.Resolve(id);
        Assert.Contains("started", AgentTransaction.Begin(doc));
        AgentTransaction.BeforeMutation();
        var panel = new GH_Panel { UserText = "preserve after native save" };
        try { panel.CreateAttributes(); doc.AddObject(panel, false); doc.IsModified = true; }
        finally { AgentTransaction.AfterMutation(); }
        var path = Path.Combine(root, "external-save.gh");
        var io = new GH_DocumentIO { Document = doc };
        Assert.True(io.SaveQuiet(path));
        doc.FilePath = path;
        doc.IsModified = false;
        AgentTransaction.CancelActive();
        Assert.Equal("preserve after native save", Assert.Single(doc.Objects.OfType<GH_Panel>()).UserText);
        Success(service, RpcOperation.manageGrasshopperDocument, new { action = "close", documentId = id,
            expectedStateToken = service.Describe(doc).StateToken, onUnsaved = "fail" });
    }

    private static GH_Document[] GhDocuments() => Enumerable.Range(0, Instances.DocumentServer.DocumentCount)
        .Select(i => Instances.DocumentServer[i]).ToArray();
    private static void GrasshopperSaveCallbackRemainsDirty(string root)
    {
        var service = GrasshopperDocumentOperations.Instance;
        var created = Success(service, RpcOperation.manageGrasshopperDocument, new { action = "new",
            expectedActiveDocument = service.ActiveId, affectedDocuments = Array.Empty<object>() });
        var id = created.GetProperty("document").GetProperty("documentId").GetString()!;
        var doc = service.Resolve(id);
        var panel = new GH_Panel { UserText = "before save" };
        panel.CreateAttributes();
        doc.AddObject(panel, false);
        doc.IsModified = true;
        GH_Document.FilePathChangedEventHandler callback = (_, _) => { panel.UserText = "edited during save"; doc.IsModified = true; };
        doc.FilePathChanged += callback;
        var path = Path.Combine(root, "callback.gh");
        try { Error(service, RpcOperation.manageGrasshopperDocument, new { action = "saveAs", documentId = id,
            expectedStateToken = service.Describe(doc).StateToken, path }, "DOCUMENT_CHANGED"); }
        finally { doc.FilePathChanged -= callback; }
        Assert.True(File.Exists(path));
        Assert.True(doc.IsModified);
        Assert.Equal("edited during save", panel.UserText);
        Success(service, RpcOperation.manageGrasshopperDocument, new { action = "close", documentId = id,
            expectedStateToken = service.Describe(doc).StateToken, onUnsaved = "discard" });
    }
    private static JsonElement Json(object value) => JsonSerializer.SerializeToElement(value, RpcV2Contract.JsonOptions);
    private static JsonElement Success<T>(DocumentService<T> service, RpcOperation operation, object args) where T : class
    {
        var result = service.Execute(operation, Json(args));
        Assert.True(result.Data!.Value.TryGetProperty("ok", out var ok) && ok.GetBoolean(), result.Data.ToString());
        return result.Data!.Value;
    }
    private static void Error<T>(DocumentService<T> service, RpcOperation operation, object args, string code) where T : class
    {
        var result = service.Execute(operation, Json(args));
        Assert.False(result.Data!.Value.GetProperty("ok").GetBoolean());
        Assert.Equal(code, result.Data!.Value.GetProperty("error").GetProperty("code").GetString());
    }
}
