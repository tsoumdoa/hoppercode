#nullable enable
using System;
using System.Collections.Generic;
using System.Collections;
using System.Diagnostics;
using System.Threading;
using System.Linq;
using System.Reflection;
using Hopper.Core.Operations;
using Rhino;
using Rhino.UI;

namespace rhino_zmq_poc;

/// <summary>
/// RhinoDoc.Create creates a windowless native model on macOS. Use AppKit's public
/// document controller to create document windows, and NSDocument.Close to close
/// exact windows, including unnamed models. Reflection avoids a platform-specific
/// assembly dependency in the cross-platform RhinoCommon build.
/// </summary>
internal static class MacDocumentWindows
{
    private static readonly Dictionary<uint, object> NativeDocuments = new();
    private sealed record PendingOpen(HashSet<uint> Before, object Native,
        Action<RhinoDoc>? Initialize, bool WasRegistered);
    private static readonly List<PendingOpen> PendingOpens = new();
    public static void Forget(uint serial) => NativeDocuments.Remove(serial);
    public static void Reset() { NativeDocuments.Clear(); PendingOpens.Clear(); }
    private static Type PlatformType(string name) => AppDomain.CurrentDomain.GetAssemblies()
        .Select(assembly => assembly.GetType(name, false)).FirstOrDefault(type => type != null)
        ?? throw new DocumentOperationException("CAPABILITY_UNAVAILABLE", $"The macOS host does not expose {name}.");
    private static object Controller => PlatformType("AppKit.NSDocumentController")
        .GetProperty("SharedDocumentController", BindingFlags.Public | BindingFlags.Static)!.GetValue(null)!;
    private static object? Property(object? value, string name) => value?.GetType().GetProperty(name)?.GetValue(value);
    private static object Invoke(object target, string method, object?[] args, Func<MethodInfo, bool>? filter = null)
    {
        var selected = target.GetType().GetMethods().FirstOrDefault(m => m.Name == method && m.GetParameters().Length == args.Length && (filter?.Invoke(m) ?? true))
            ?? throw new DocumentOperationException("CAPABILITY_UNAVAILABLE", $"The macOS document API {method} is unavailable.");
        try { return selected.Invoke(target, args)!; }
        catch (TargetInvocationException error) { throw new DocumentOperationException("NATIVE_OPERATION_FAILED", error.InnerException?.Message ?? error.Message); }
    }
    private static RhinoDoc? ResolveCreatedDocument(HashSet<uint> before, object native)
    {
        var controllers = Property(native, "WindowControllers") as IEnumerable;
        var windows = controllers?.Cast<object>().Select(controller => Property(controller, "Window")).Where(window => window != null).ToArray() ?? Array.Empty<object>();
        var created = RhinoDoc.OpenDocuments(false).Where(doc => !before.Contains(doc.RuntimeSerialNumber)).Where(doc => {
            var control = RhinoEtoApp.MainWindowForDocument(doc)?.ControlObject;
            if (control == null) return false;
            var window = Property(control, "Window") ?? control;
            var handle = Property(window, "Handle");
            return handle != null && windows.Any(candidate => Equals(handle, Property(candidate, "Handle")));
        }).ToArray();
        if (created.Length > 1) throw new DocumentOperationException("NATIVE_OPEN_FAILED", "The new macOS document maps to multiple Rhino models.");
        return created.SingleOrDefault();
    }
    private static bool? IsRegistered(object native)
    {
        if (Property(Controller, "Documents") is not IEnumerable documents) return null;
        var handle = Property(native, "Handle");
        return documents.Cast<object>().Any(candidate => ReferenceEquals(candidate, native)
            || handle != null && Equals(handle, Property(candidate, "Handle")));
    }
    private static RhinoDoc CreatedDocument(HashSet<uint> before, object native, Action<RhinoDoc>? initialize = null)
    {
        // The AppKit API can return before Rhino's model is registered. Keep this
        // dispatcher item pending while native UI callbacks complete. OrderedDispatcher
        // does not post another item while _running is true.
        var elapsed = Stopwatch.StartNew();
        var wasRegistered = IsRegistered(native) == true;
        while (elapsed.Elapsed < TimeSpan.FromSeconds(30)) {
            var document = ResolveCreatedDocument(before, native);
            if (document != null) {
                NativeDocuments[document.RuntimeSerialNumber] = native;
                initialize?.Invoke(document);
                return document;
            }
            var registered = IsRegistered(native);
            if (wasRegistered && registered == false)
                throw new DocumentOperationException("NATIVE_OPEN_FAILED", "The macOS document was closed before initialization completed.");
            wasRegistered |= registered == true;
            RhinoApp.Wait();
            Thread.Sleep(1);
        }
        PendingOpens.Add(new(before, native, initialize, wasRegistered));
        throw new DocumentOperationException("NATIVE_COMPLETION_PENDING", "macOS has accepted the open but its Rhino model has not completed initialization. The file may still open; do not replay the operation. Dependent mutations are blocked until initialization finishes.");
    }
    public static void EnsureSettled()
    {
        foreach (var pending in PendingOpens.ToArray()) {
            var document = ResolveCreatedDocument(pending.Before, pending.Native);
            if (document == null) {
                if (pending.WasRegistered && IsRegistered(pending.Native) == false) {
                    PendingOpens.Remove(pending);
                    throw new DocumentOperationException("NATIVE_OPEN_FAILED", "The pending macOS document was closed before initialization completed. Inspect current documents before continuing.");
                }
                throw new DocumentOperationException("HOST_BUSY", "A previous native document open has not finished. Inspect document state later; do not replay it.");
            }
            NativeDocuments[document.RuntimeSerialNumber] = pending.Native;
            // Native initialization may have partial effects before throwing. Retire
            // the continuation first so a later request never replays those effects.
            PendingOpens.Remove(pending);
            pending.Initialize?.Invoke(document);
        }
    }
    public static RhinoDoc New(string? template)
    {
        var before = RhinoDoc.OpenDocuments(false).Select(doc => doc.RuntimeSerialNumber).ToHashSet();
        object?[] args = { true, null };
        var native = Invoke(Controller, "OpenUntitledDocument", args);
        if (native == null) throw new DocumentOperationException("NATIVE_OPEN_FAILED", args[1]?.ToString() ?? "macOS could not create an unnamed document.");
        void Initialize(RhinoDoc document) {
            if (template == null) return;
            Activate(document);
            if (RhinoDoc.ActiveDoc != document)
                throw new DocumentOperationException("ACTIVATION_FAILED", "Cannot activate the new document for template initialization.");
            using var options = new Rhino.FileIO.FileReadOptions { NewMode = true, BatchMode = true, UseScaleGeometry = true, ScaleGeometry = false };
            if (!RhinoDoc.ReadFile(template, options))
                throw new DocumentOperationException("NATIVE_OPEN_FAILED", "Could not initialize the new document from its template.");
            document.Modified = true;
        }
        return CreatedDocument(before, native, Initialize);
    }
    private static object? FileUrl(string path) => PlatformType("Foundation.NSUrl").GetMethod("FromFilename", BindingFlags.Public | BindingFlags.Static, null, new[] { typeof(string) }, null)!.Invoke(null, new object[] { path });
    public static RhinoDoc Open(string path)
    {
        var before = RhinoDoc.OpenDocuments(false).Select(doc => doc.RuntimeSerialNumber).ToHashSet();
        object?[] args = { FileUrl(path), true, null };
        var native = Invoke(Controller, "OpenDocument", args, method => method.GetParameters()[2].ParameterType.IsByRef);
        if (native == null) throw new DocumentOperationException("NATIVE_OPEN_FAILED", args[2]?.ToString() ?? "macOS could not open the file.");
        return CreatedDocument(before, native);
    }
    public static void Activate(RhinoDoc document)
    {
        var window = RhinoEtoApp.MainWindowForDocument(document)
            ?? throw new DocumentOperationException("NATIVE_WINDOW_UNAVAILABLE", "The Rhino document has no macOS model window.");
        var nativeWindow = Property(window.ControlObject, "Window") ?? window.ControlObject;
        Invoke(nativeWindow, "MakeKeyAndOrderFront", new object?[] { null });
        var application = PlatformType("AppKit.NSApplication").GetProperty("SharedApplication", BindingFlags.Public | BindingFlags.Static)!.GetValue(null)!;
        Invoke(application, "ActivateIgnoringOtherApps", new object?[] { true });
        RhinoDoc.ActiveDoc = document;
        RhinoApp.SetFocusToMainWindow(document);
        var elapsed = Stopwatch.StartNew();
        while (RhinoDoc.ActiveDoc != document && elapsed.Elapsed < TimeSpan.FromSeconds(3))
        {
            RhinoApp.Wait();
            Thread.Sleep(1);
        }
    }
    public static void Close(RhinoDoc document)
    {
        var window = RhinoEtoApp.MainWindowForDocument(document)
            ?? throw new DocumentOperationException("NATIVE_WINDOW_UNAVAILABLE", "The Rhino document has no macOS model window.");
        var control = window.ControlObject;
        var controller = Property(control, "WindowController");
        var native = Property(controller, "Document") ?? Property(control, "Document");
        if (native == null) NativeDocuments.TryGetValue(document.RuntimeSerialNumber, out native);
        if (native == null) throw new DocumentOperationException("CAPABILITY_UNAVAILABLE", "Cannot resolve the macOS document belonging to this model window.");
        Invoke(native, "Close", Array.Empty<object?>());
        // Close can remove the Rhino model before AppKit finishes its controller
        // bookkeeping. Do not let an immediate reopen reuse the closed NSDocument.
        Invoke(Controller, "RemoveDocument", new object?[] { native });
        NativeDocuments.Remove(document.RuntimeSerialNumber);
    }
}
