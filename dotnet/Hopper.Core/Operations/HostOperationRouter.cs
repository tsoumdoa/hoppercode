using Hopper.Core.Grasshopper;
using Hopper.Core.Protocol;
using Hopper.Core.Transport;

namespace Hopper.Core.Operations;

public sealed class HostOperationRouter : IRpcOperationHandler
{
    private readonly RhinoOperationRegistry _rhino;
    private readonly GrasshopperCapabilityRegistry _grasshopper;

    public HostOperationRouter(
        RhinoOperationRegistry rhino,
        GrasshopperCapabilityRegistry grasshopper)
    {
        _rhino = rhino ?? throw new ArgumentNullException(nameof(rhino));
        _grasshopper = grasshopper ?? throw new ArgumentNullException(nameof(grasshopper));
    }

    public OperationResultV2 Execute(RpcRequestV2 request)
    {
        ArgumentNullException.ThrowIfNull(request);

        if (request.Operation == RpcOperation.browseDocumentFiles) {
            try { return DocumentSession.Result(DocumentFiles.Browse(request.Args)); }
            catch (Exception error) { return DocumentSession.Result(new { ok = false, error = new { code = error is DocumentOperationException domain ? domain.Code : "FILE_SYSTEM_ERROR", message = error.Message } }); }
        }
        if (request.Operation == RpcOperation.getDocumentTransactionState)
            { DocumentSession.ReconcileGrasshopper?.Invoke(); return DocumentSession.Result(DocumentSession.Segment(request.Args.GetProperty("owner").GetString()!)); }
        if (request.Operation == RpcOperation.listGrasshopperDocuments && !_grasshopper.TryGetAdapter(out _))
            return DocumentSession.Result(new { documents = Array.Empty<object>(), activeDocumentId = (string?)null,
                lifecycleInstanceId = DocumentSession.LifecycleInstanceId, capabilities = new { loaded = false, state = _grasshopper.Status.StateName } });
        if (_rhino.TryGetAdapter(out var rhino) && rhino!.CanExecute(request.Operation))
            return rhino.Execute(request);

        if (_grasshopper.TryGetAdapter(out var grasshopper)
            && grasshopper!.CanExecute(request.Operation))
        {
            if (!grasshopper.DocumentStatus.HasActiveDocument && request.Operation is not (RpcOperation.listGrasshopperDocuments or RpcOperation.getGrasshopperDocument or RpcOperation.getGrasshopperDocumentSettings or RpcOperation.manageGrasshopperDocument))
            {
                return Failure(
                    RpcResultClass.no_active_grasshopper_document,
                    RpcReasonCode.NO_ACTIVE_GRASSHOPPER_DOCUMENT,
                    "No active Grasshopper document is available.");
            }
            return grasshopper.Execute(request);
        }

        var capability = _grasshopper.Status;
        if (capability.State != GrasshopperCapabilityState.Ready)
        {
            var reason = capability.State == GrasshopperCapabilityState.NotInstalled
                ? RpcReasonCode.GRASSHOPPER_NOT_INSTALLED
                : RpcReasonCode.CAPABILITY_UNAVAILABLE;
            return Failure(
                RpcResultClass.capability_unavailable,
                reason,
                $"Grasshopper is {capability.StateName}.");
        }

        return Failure(
            RpcResultClass.failed,
            RpcReasonCode.UNKNOWN_OPERATION,
            $"No adapter handles operation '{request.Operation}'.");
    }

    private static OperationResultV2 Failure(
        RpcResultClass resultClass,
        RpcReasonCode reason,
        string message) => new()
        {
            Class = resultClass,
            ReasonCode = reason,
            Message = message,
        };
}

public sealed class RegisteredGrasshopperTransactionCleanup : Lifecycle.IAgentTransactionCleanup
{
    private readonly GrasshopperCapabilityRegistry _registry;

    public RegisteredGrasshopperTransactionCleanup(GrasshopperCapabilityRegistry registry)
    {
        _registry = registry ?? throw new ArgumentNullException(nameof(registry));
    }

    public void CleanupOpenTransactions()
    {
        if (_registry.TryGetAdapter(out var adapter))
            adapter!.CleanupOpenTransactions();
    }
}
