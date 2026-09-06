using System;
using System.Collections.Generic;
using System.Text.Json;
using Grasshopper;
using Grasshopper.Kernel;
using Hopper.Core.Grasshopper;
using Hopper.Core.Operations;
using Hopper.Core.Protocol;
using Hopper.Core.Runtime;

namespace rhino_zmq_poc
{
    /// <summary>
    /// Adapts the existing Grasshopper operations to the Rhino-owned RPC runtime.
    /// It owns no sockets, child processes, or lifecycle state.
    /// </summary>
    public sealed class GrasshopperOperationAdapter : IGrasshopperAdapter, IDisposable
    {
        private static readonly HashSet<RpcOperation> QueryOperations = new HashSet<RpcOperation>
        {
            RpcOperation.listAllComponents,
            RpcOperation.getCurrentCanvas,
            RpcOperation.getCanvasErrors,
            RpcOperation.listScriptParams,
            RpcOperation.getScriptCode,
            RpcOperation.getParamRhinoGeometry,
            RpcOperation.listGrasshopperDocuments,
            RpcOperation.getGrasshopperDocument,
            RpcOperation.getGrasshopperDocumentSettings,
        };

        private static readonly HashSet<RpcOperation> MutationOperations = new HashSet<RpcOperation>
        {
            RpcOperation.applyGraph,
            RpcOperation.manageGrasshopperDocument,
            RpcOperation.addComponent,
            RpcOperation.deleteComponent,
            RpcOperation.connectWire,
            RpcOperation.disconnectWire,
            RpcOperation.moveComponent,
            RpcOperation.renameComponent,
            RpcOperation.setComponentLocked,
            RpcOperation.setComponentHidden,
            RpcOperation.addGroup,
            RpcOperation.removeFromGroup,
            RpcOperation.deleteGroup,
            RpcOperation.changeGroupColor,
            RpcOperation.renameGroup,
            RpcOperation.changeGroupStyle,
            RpcOperation.createSlider,
            RpcOperation.editSliderRange,
            RpcOperation.setSliderValue,
            RpcOperation.createPanel,
            RpcOperation.setPanelParams,
            RpcOperation.setPanelText,
            RpcOperation.createToggle,
            RpcOperation.setToggleValue,
            RpcOperation.createSwatch,
            RpcOperation.setSwatchColor,
            RpcOperation.createScribble,
            RpcOperation.setScribbleText,
            RpcOperation.createValueList,
            RpcOperation.setValueListSelected,
            RpcOperation.createScriptNode,
            RpcOperation.setScriptCode,
            RpcOperation.syncScriptParams,
            RpcOperation.addScriptInput,
            RpcOperation.removeScriptInput,
            RpcOperation.addScriptOutput,
            RpcOperation.removeScriptOutput,
            RpcOperation.editParamProps,
            RpcOperation.beginAgentTransaction,
            RpcOperation.commitAgentTransaction,
            RpcOperation.cancelAgentTransaction,
            RpcOperation.setParamRhinoGeometry,
        };

        private readonly CommandExecutor _commands = new CommandExecutor(_ => { });
        private readonly UiRequestDispatcher _queries = CreateQueryDispatcher();
        private readonly IHostDocumentStatusSink _documentStatus;
        private ActiveGrasshopperDocumentTracker _documents;

        public GrasshopperOperationAdapter()
            : this(HostOperationRegistries.DocumentStatus)
        {
        }

        internal GrasshopperOperationAdapter(IHostDocumentStatusSink documentStatus)
        {
            _documentStatus = documentStatus ?? throw new ArgumentNullException(nameof(documentStatus));
            DocumentSession.ReconcileGrasshopper = AgentTransaction.Reconcile;
        }

        internal void Start()
        {
            if (_documents != null)
                return;
            _documents = new ActiveGrasshopperDocumentTracker(_documentStatus);
            _documents.Start();
        }

        public OperationDocumentStatus DocumentStatus
        {
            get
            {
                var document = ActiveDocument;
                return document == null
                    ? OperationDocumentStatus.None
                    : new OperationDocumentStatus(
                        true,
                        string.IsNullOrWhiteSpace(document.FilePath)
                            ? "Untitled"
                            : document.FilePath);
            }
        }

        public bool CanExecute(RpcOperation operation) =>
            QueryOperations.Contains(operation) || MutationOperations.Contains(operation);

        public OperationResultV2 Execute(RpcRequestV2 request)
        {
            if (request == null)
                throw new ArgumentNullException(nameof(request));

            if (request.Operation is RpcOperation.listGrasshopperDocuments or RpcOperation.getGrasshopperDocument or RpcOperation.getGrasshopperDocumentSettings or RpcOperation.manageGrasshopperDocument)
                return GrasshopperDocumentOperations.Instance.Execute(request.Operation, request.Args);
            var document = ActiveDocument;
            if (document == null)
                return Failure(
                    RpcResultClass.no_active_grasshopper_document,
                    RpcReasonCode.NO_ACTIVE_GRASSHOPPER_DOCUMENT,
                    "No active Grasshopper document is available.");

            try
            {
                AgentTransaction.Reconcile();
                DocumentSession.ValidateSegment("grasshopper", request.Args);
                if (MutationOperations.Contains(request.Operation)) AgentTransaction.BeforeMutation();
                if (QueryOperations.Contains(request.Operation))
                {
                    if (!_queries.TryDispatch(
                        request.Operation.ToString(),
                        document,
                        request.Args,
                        out var response))
                    {
                        return Failure(
                            RpcResultClass.failed,
                            RpcReasonCode.UNKNOWN_OPERATION,
                            $"No Grasshopper query handles '{request.Operation}'.");
                    }
                    return FromJson(response);
                }

                if (request.Operation == RpcOperation.applyGraph)
                {
                    if (!_queries.TryDispatch("applyGraph", document, request.Args, out var response))
                        throw new InvalidOperationException("The applyGraph handler is unavailable.");
                    return FromJson(response);
                }

                var command = new GhCommand
                {
                    Action = request.Operation.ToString(),
                    Params = request.Args,
                };
                var result = _commands.Execute(document, command);
                if (IsFailure(result))
                    return Failure(RpcResultClass.failed, RpcReasonCode.OPERATION_FAILED, result);

                return Completed(JsonSerializer.SerializeToElement(
                    new { result, transaction = DocumentSession.Segment("grasshopper") },
                    RpcV2Contract.JsonOptions));
            }
            catch (Exception exception)
            {
                return Failure(
                    RpcResultClass.failed,
                    RpcReasonCode.OPERATION_FAILED,
                    $"{exception.GetType().Name}: {exception.Message}");
            }
            finally { if (MutationOperations.Contains(request.Operation)) AgentTransaction.AfterMutation(); }
        }

        public void CleanupOpenTransactions()
        {
            AgentTransaction.CancelActive();
        }

        private GH_Document ActiveDocument => _documents?.ActiveDocument
            ?? Instances.ActiveCanvas?.Document;

        public void Dispose()
        {
            _documents?.Dispose();
            _documents = null;
        }

        private static UiRequestDispatcher CreateQueryDispatcher()
        {
            var dispatcher = new UiRequestDispatcher();
            dispatcher.Register("listAllComponents", new ListAllComponentsHandler());
            dispatcher.Register("getCurrentCanvas", new GetCurrentCanvasHandler());
            dispatcher.Register("getCanvasErrors", new GetCanvasErrorsHandler());
            dispatcher.Register("applyGraph", new ApplyGraphHandler());
            dispatcher.Register("listScriptParams", new ListScriptParamsHandler());
            dispatcher.Register("getScriptCode", new GetScriptCodeHandler());
            dispatcher.Register("getParamRhinoGeometry", new GetParamRhinoGeometryHandler());
            return dispatcher;
        }

        private static OperationResultV2 FromJson(string response)
        {
            using var document = JsonDocument.Parse(response);
            var root = document.RootElement;
            if (root.ValueKind == JsonValueKind.Object
                && root.TryGetProperty("error", out var error))
            {
                return Failure(
                    RpcResultClass.failed,
                    RpcReasonCode.OPERATION_FAILED,
                    error.GetString() ?? "Grasshopper operation failed.");
            }
            if (root.ValueKind == JsonValueKind.Object
                && root.TryGetProperty("ok", out var ok)
                && ok.ValueKind == JsonValueKind.False)
            {
                return Failure(
                    RpcResultClass.failed,
                    RpcReasonCode.OPERATION_FAILED,
                    "Grasshopper operation did not complete successfully.",
                    root.Clone());
            }

            var data = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(root.GetRawText());
            data["transaction"] = JsonSerializer.SerializeToElement(DocumentSession.Segment("grasshopper"), RpcV2Contract.JsonOptions);
            data["settings"] = JsonSerializer.SerializeToElement(GrasshopperDocumentOperations.Instance.CurrentSettings, RpcV2Contract.JsonOptions);
            return Completed(JsonSerializer.SerializeToElement(data, RpcV2Contract.JsonOptions));
        }

        private static bool IsFailure(string result) =>
            result.IndexOf(" error", StringComparison.OrdinalIgnoreCase) >= 0
            || result.IndexOf(": invalid", StringComparison.OrdinalIgnoreCase) >= 0
            || result.StartsWith("Invalid ", StringComparison.OrdinalIgnoreCase)
            || result.StartsWith("Unknown ", StringComparison.OrdinalIgnoreCase);

        private static OperationResultV2 Completed(JsonElement data) => new OperationResultV2
        {
            Class = RpcResultClass.completed,
            ReasonCode = RpcReasonCode.OK,
            Data = data,
        };

        private static OperationResultV2 Failure(
            RpcResultClass resultClass,
            RpcReasonCode reason,
            string message) => new OperationResultV2
        {
            Class = resultClass,
            ReasonCode = reason,
            Message = message,
        };

        private static OperationResultV2 Failure(
            RpcResultClass resultClass,
            RpcReasonCode reason,
            string message,
            JsonElement data) => new OperationResultV2
        {
            Class = resultClass,
            ReasonCode = reason,
            Message = message,
            Data = data,
        };
    }
}
