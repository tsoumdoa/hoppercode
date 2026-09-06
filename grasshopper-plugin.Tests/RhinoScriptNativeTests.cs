using System.Text.Json;
using Hopper.Core.Operations;
using Hopper.Core.Protocol;
using Hopper.Rhino.Host;
using Rhino;
using rhino_zmq_poc;
using Xunit;

namespace grasshopper_plugin.Tests;

/// <summary>Explicit native entry point. Runs only in a disposable Mac document.</summary>
public static class RhinoScriptNativeTests
{
    public static void RunAll()
    {
        if (!OperatingSystem.IsMacOS()) throw new InvalidOperationException("This preservation test requires Mac multi-document Rhino.");
        var original = RhinoDoc.ActiveDoc;
        var originalModified = original?.Modified;
        var originalIds = RhinoDoc.OpenDocuments(false).Select(d => d.RuntimeSerialNumber).ToHashSet();
        var service = RhinoDocumentOperations.Instance;
        RhinoDoc? fixture = null;
        Exception? failure = null;
        try
        {
            var created = service.Execute(RpcOperation.manageRhinoDocument, Json(new { action = "new",
                expectedActiveDocument = service.ActiveId, affectedDocuments = Array.Empty<object>() })).Data!.Value;
            Assert.True(created.GetProperty("ok").GetBoolean(), created.ToString());
            var id = created.GetProperty("document").GetProperty("documentId").GetString()!;
            fixture = service.Resolve(id);
            var executor = new RhinoOperationExecutor();
            ExpectedDocument Target() => new(id, DocumentSession.LifecycleInstanceId,
                service.Execute(RpcOperation.getRhinoDocumentSettings, Json(new { documentId = id })).Data!.Value
                    .GetProperty("settingsRevision").GetString());
            var target = Target();
            var started = executor.BeginTransaction("Hopper native script test");
            Assert.True(started.Succeeded, started.Error);
            var python = executor.RunScript(new RhinoScriptArguments("python",
                "import Rhino\nimport scriptcontext as sc\nsc.doc.Objects.AddPoint(Rhino.Geometry.Point3d(2,3,4))\nprint('python native test')", false, target));
            Assert.True(python.Succeeded, python.Error);
            Assert.Contains("python native test", python.Output);
            Assert.Single(fixture.Objects);
            var csharp = executor.RunScript(new RhinoScriptArguments("csharp",
                "Rhino.RhinoDoc.ActiveDoc.Objects.AddPoint(new Rhino.Geometry.Point3d(5,6,7));\nSystem.Console.WriteLine(\"csharp native test\");", false, target));
            Assert.True(csharp.Succeeded, csharp.Error);
            Assert.Equal(2, fixture.Objects.Count);

            fixture.ModelAbsoluteTolerance *= 2;
            var changed = Assert.Throws<DocumentOperationException>(() => executor.RunScript(new RhinoScriptArguments("python",
                "raise Exception('must not execute')", false, target)));
            Assert.Equal("SETTINGS_CHANGED", changed.Code);
            var wrong = Assert.Throws<DocumentOperationException>(() => executor.RunScript(new RhinoScriptArguments("csharp",
                "throw new System.Exception(\"must not execute\");", false,
                new ExpectedDocument("stale-document", DocumentSession.LifecycleInstanceId))));
            Assert.Equal("DOCUMENT_CHANGED", wrong.Code);
            Assert.Equal(2, fixture.Objects.Count);
            Assert.True(executor.CommitTransaction().Succeeded);
            Assert.True(fixture.Undo(), "The two script mutations should have one native undo record.");
            Assert.Empty(fixture.Objects);
        }
        catch (Exception error) { failure = error; throw; }
        finally
        {
            try
            {
                RhinoAgentTransaction.CommitActive();
                if (fixture != null && RhinoDoc.OpenDocuments(false).Contains(fixture))
                {
                    var current = service.Describe(fixture);
                    var closed = service.Execute(RpcOperation.manageRhinoDocument, Json(new { action = "close",
                        documentId = current.DocumentId, expectedStateToken = current.StateToken, onUnsaved = "discard" })).Data!.Value;
                    Assert.True(closed.GetProperty("ok").GetBoolean(), closed.ToString());
                }
                if (original != null) MacDocumentWindows.Activate(original);
                Assert.True(originalIds.SetEquals(RhinoDoc.OpenDocuments(false).Select(d => d.RuntimeSerialNumber)));
                if (original != null) Assert.Equal(originalModified, original.Modified);
            }
            catch (Exception cleanup) { if (failure != null) throw new AggregateException(failure, cleanup); throw; }
            finally { service.Dispose(); }
        }
    }

    private static JsonElement Json(object value) => JsonSerializer.SerializeToElement(value, RpcV2Contract.JsonOptions);
}
