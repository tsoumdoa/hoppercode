using Grasshopper.Kernel;
using Grasshopper;
using Hopper.Core.Operations;

namespace rhino_zmq_poc
{
    internal static class AgentTransaction
    {
        private static readonly BoundTransactionState<GH_Document, byte[]> State =
            new BoundTransactionState<GH_Document, byte[]>();
        private static string _transactionName;
        private static GH_Document _boundDocument;
        private static byte[] _lastAgentSnapshot;
        private static string _lastPath;
        private static bool _managedMutation;
        private static bool _completing;
        public static void ObserveSaved() { if (!_completing) AbandonActive(); }
        public static void BeforeMutation() { Reconcile(); _managedMutation = true; }
        public static void AfterMutation() { if (_boundDocument != null && State.IsActive) { _lastAgentSnapshot = DocumentSnapshots.Serialize(_boundDocument); _lastPath = _boundDocument.FilePath; if (_lastAgentSnapshot == null) AbandonActive(); } _managedMutation = false; }
        public static void Reconcile() {
            if (!State.IsActive || _managedMutation) return;
            if (_lastAgentSnapshot == null || _boundDocument == null || _boundDocument != Instances.ActiveCanvas?.Document || _boundDocument.FilePath != _lastPath
                || !DocumentSnapshots.AreEqual(_lastAgentSnapshot, DocumentSnapshots.Serialize(_boundDocument))) AbandonActive();
        }
        public static void AbandonExternal() { if (!_managedMutation) AbandonActive(); }
        public static void AbandonActive() {
            if (State.IsActive) State.Complete((_, __) => true);
            _boundDocument = null; _lastAgentSnapshot = null; _transactionName = null;
            DocumentSession.Advance("grasshopper", null, "abandoned");
        }
        public static string CommitActive() => Commit(_boundDocument);

        public static bool IsActive => State.IsActive;

        public static string Begin(GH_Document doc, string name = "Hopper agent")
        {
            if (doc == null)
                return "beginAgentTransaction error: document is null";

            if (State.IsActive)
            {
                if (State.IsBoundTo(doc))
                    return "beginAgentTransaction: transaction already active";
                AbandonActive();
            }

            var snapshot = DocumentSnapshots.Serialize(doc);
            if (snapshot == null)
                return "beginAgentTransaction error: failed to snapshot document";

            State.Begin(doc, snapshot);
            _boundDocument = doc; _lastAgentSnapshot = snapshot; _lastPath = doc.FilePath;

            DocumentSession.Advance("grasshopper", GrasshopperDocumentOperations.Instance.ActiveId, "active");
            _transactionName = string.IsNullOrWhiteSpace(name) ? "Hopper agent" : name;
            return "beginAgentTransaction: started";
        }

        public static string Commit(GH_Document doc)
        {
            if (!State.IsBoundTo(doc))
                return "commitAgentTransaction: no active transaction";

            var previousManaged = _managedMutation;
            _managedMutation = true;
            _completing = true;
            try
            {
                return State.Complete((boundDocument, beforeSnapshot) =>
                {
                    var afterSnapshot = DocumentSnapshots.Serialize(boundDocument);
                    if (afterSnapshot == null)
                        return "commitAgentTransaction error: failed to snapshot document";

                    if (DocumentSnapshots.AreEqual(beforeSnapshot, afterSnapshot))
                        return "commitAgentTransaction: no canvas changes";

                    var action = new DocumentSnapshotUndoAction(beforeSnapshot, afterSnapshot);
                    boundDocument.UndoUtil.RecordEvent(_transactionName, action);
                    return "commitAgentTransaction: recorded undo";
                });
            }
            finally
            {
                _managedMutation = previousManaged;
                _completing = false;
                _transactionName = null;
                _boundDocument = null; _lastAgentSnapshot = null;
                DocumentSession.Advance("grasshopper", null, "idle");
            }
        }

        public static string Cancel(GH_Document doc)
        {
            if (!State.IsBoundTo(doc))
                return "cancelAgentTransaction: no active transaction";

            return CancelActive();
        }

        public static string CancelActive()
        {
            Reconcile();
            if (!State.IsActive)
                return "cancelAgentTransaction: no active transaction";

            var previousManaged = _managedMutation;
            _managedMutation = true;
            _completing = true;
            try
            {
                return State.Complete((document, beforeSnapshot) =>
                {
                    DocumentSnapshots.Apply(document, beforeSnapshot);
                    return "cancelAgentTransaction: reverted canvas";
                });
            }
            finally
            {
                _managedMutation = previousManaged;
                _completing = false;
                _transactionName = null;
                _boundDocument = null; _lastAgentSnapshot = null;
                DocumentSession.Advance("grasshopper", null, "idle");
            }
        }
    }
}
