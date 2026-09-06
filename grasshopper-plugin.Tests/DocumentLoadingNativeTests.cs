using System.Text.Json;
using System.Xml.Linq;
using Grasshopper;
using Grasshopper.Kernel;
using Grasshopper.Kernel.Special;
using Hopper.Core.Operations;
using Hopper.Core.Protocol;
using Rhino;
using rhino_zmq_poc;
using Xunit;

namespace grasshopper_plugin.Tests;

/// <summary>Explicit native entry points; use run-native-tests.mjs inside Rhino.</summary>
public static class DocumentLoadingNativeTests
{
    private static JsonElement Args(object value) => JsonSerializer.SerializeToElement(value);
    public static void RejectInvalidRhinoFiles()
    {
        Assert.True(OperatingSystem.IsWindows());
        var service = RhinoDocumentOperations.Instance;
        var doc = RhinoDoc.ActiveDoc;
        var observed = service.Describe(doc);
        var root = Path.Combine(Path.GetTempPath(), "hopper-invalid-model-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var path = Path.Combine(root, "invalid.3dm"); File.WriteAllText(path, "not a Rhino model");
        try {
            foreach (var action in new[] { "open", "new" }) {
                var result = service.Execute(RpcOperation.manageRhinoDocument, Args(new {
                    action, path, templatePath = path, expectedActiveDocument = observed.DocumentId,
                    affectedDocuments = new[] { new { documentId = observed.DocumentId, expectedStateToken = observed.StateToken, onUnsaved = "discard" } }
                })).Data!.Value;
                Assert.False(result.GetProperty("ok").GetBoolean(), result.ToString());
                Assert.Equal("NATIVE_OPEN_FAILED", result.GetProperty("error").GetProperty("code").GetString());
                Assert.Same(doc, RhinoDoc.ActiveDoc);
                Assert.Equal(observed.StateToken, service.Describe(doc).StateToken);
                Assert.Equal(observed.IsModified, doc.Modified);
            }
        } finally { service.Dispose(); }
    }
    public static void RejectMissingGrasshopperComponents()
    {
        var service = GrasshopperDocumentOperations.Instance;
        var root = Path.Combine(Path.GetTempPath(), "hopper-missing-component-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var path = Path.Combine(root, "missing.ghx");
        using var fixture = new GH_Document();
        var panel = new GH_Panel(); panel.CreateAttributes(); fixture.AddObject(panel, false);
        var archive = new GH_IO.Serialization.GH_Archive(); Assert.True(archive.AppendObject(fixture, "Definition"));
        var xml = XDocument.Parse(archive.Serialize_Xml());
        xml.Descendants("item").First(item => (string?)item.Attribute("name") == "GUID").Value = Guid.NewGuid().ToString();
        xml.Save(path);
        var count = Instances.DocumentServer.DocumentCount;
        var active = service.ActiveId;
        var setting = CentralSettings.TryDownloadMissingPlugins;
        try {
            foreach (var action in new[] { "open", "new" }) {
                var result = service.Execute(RpcOperation.manageGrasshopperDocument, Args(new { action, path, templatePath = path, expectedActiveDocument = active })).Data!.Value;
                Assert.False(result.GetProperty("ok").GetBoolean(), result.ToString());
                Assert.Contains(result.GetProperty("error").GetProperty("code").GetString(), new[] { "MISSING_COMPONENTS", "NATIVE_OPEN_FAILED" });
                Assert.Equal(count, Instances.DocumentServer.DocumentCount);
                Assert.Equal(active, service.ActiveId);
                Assert.Equal(setting, CentralSettings.TryDownloadMissingPlugins);
            }
        } finally { service.Dispose(); }
    }
    public static void ValidGrasshopperRoundTrips()
    {
        var root = Path.Combine(Path.GetTempPath(), "hopper-valid-gh-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try {
            var method = typeof(DocumentManagementNativeTests).GetMethod("GrasshopperLifecycle", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic)!;
            method.Invoke(null, new object[] { root });
        } finally { GrasshopperDocumentOperations.Instance.Dispose(); }
    }
}
