using System.Linq;
using System.Text.Json;
using Hopper.Core.Protocol;
using Hopper.Core.Operations;
using Hopper.Rhino.Host;
using Rhino;

namespace rhino_zmq_poc
{
    internal sealed class RhinoOperationExecutor : IRhinoOperationExecutor, IRhinoDocumentExecutor
    {
        private readonly RhinoDocumentOperations _documents = RhinoDocumentOperations.Instance;
        public object CurrentSettings => RhinoDoc.ActiveDoc == null ? null : _documents.ReadSettings(null);
        public OperationResultV2 DocumentOperation(RpcOperation operation, JsonElement args) => _documents.Execute(operation, args);

        public OperationDocumentStatus DocumentStatus
        {
            get
            {
                var document = RhinoDoc.ActiveDoc;
                return document == null
                    ? OperationDocumentStatus.None
                    : new OperationDocumentStatus(true, document.Name);
            }
        }

        public RhinoObjectQueryExecution QueryObjects(RhinoObjectQueryArguments arguments)
        {
            var query = new QueryRhinoObjectsParams
            {
                SelectionOnly = arguments.SelectionOnly,
                Layer = arguments.Layer,
                ObjectIds = arguments.ObjectIds?.ToList(),
                ObjectType = arguments.ObjectType,
            };
            var objects = RhinoObjectQuery.Query(RhinoDoc.ActiveDoc, query)
                .Select(item => new RhinoObjectResult(
                    item.ObjectId,
                    item.Name,
                    item.Layer,
                    item.ObjectType))
                .ToArray();
            return new RhinoObjectQueryExecution(true, objects);
        }

        public RhinoScriptExecution RunScript(RhinoScriptArguments arguments)
        {
            _documents.ValidateExpected(arguments.ExpectedDocument);
            var result = RhinoScriptExecutor.Run(new RunRhinoScriptParams
            {
                Mode = arguments.Mode,
                Source = arguments.Source,
                Echo = arguments.Echo,
            });
            return new RhinoScriptExecution(
                result.Ok,
                result.Output ?? "",
                result.Error ?? "");
        }

        public RhinoCaptureExecution CaptureView(RhinoCaptureArguments arguments) =>
            ViewportOperations.Capture(RhinoDoc.ActiveDoc, arguments);

        public RhinoControlExecution ControlView(RhinoControlArguments arguments) =>
            ViewportOperations.Control(RhinoDoc.ActiveDoc, arguments);

        public RhinoTransactionExecution BeginTransaction(string name)
        {
            var result = RhinoAgentTransaction.Begin(RhinoDoc.ActiveDoc, name);
            if (!result.Contains(" error:")) DocumentSession.Advance("rhino", _documents.ActiveId, "active");
            return Transaction(result);
        }

        public RhinoTransactionExecution CommitTransaction() { var result = Transaction(RhinoAgentTransaction.CommitActive()); DocumentSession.Advance("rhino", null, "idle"); return result; }

        public RhinoTransactionExecution CancelTransaction() { var result = Transaction(RhinoAgentTransaction.CancelActive()); DocumentSession.Advance("rhino", null, "idle"); return result; }

        public void CleanupOpenTransactions() => RhinoAgentTransaction.CancelActive();

        private static RhinoTransactionExecution Transaction(string result)
        {
            var succeeded = result.IndexOf(" error:", System.StringComparison.OrdinalIgnoreCase) < 0;
            return new RhinoTransactionExecution(
                succeeded,
                result,
                succeeded ? null : result);
        }
    }
}
