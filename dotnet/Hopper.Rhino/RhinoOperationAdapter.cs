#nullable enable

using System;
using System.Collections.Generic;
using System.Text.Json;
using Hopper.Core.Operations;
using Hopper.Core.Lifecycle;
using Hopper.Core.Protocol;
using Hopper.Core.Time;

namespace Hopper.Rhino.Host;

public sealed record RhinoObjectQueryArguments(
    bool? SelectionOnly,
    string? Layer,
    IReadOnlyList<string>? ObjectIds,
    string? ObjectType);

public sealed record RhinoScriptArguments(
    string? Mode,
    string? Source,
    bool Echo, ExpectedDocument? ExpectedDocument = null);

public sealed record RhinoObjectResult(
    string ObjectId,
    string Name,
    string Layer,
    string ObjectType);

public sealed record RhinoObjectQueryExecution(
    bool Succeeded,
    IReadOnlyList<RhinoObjectResult> Objects,
    string? Error = null);

public sealed record RhinoScriptExecution(
    bool Succeeded,
    string Output,
    string Error);

public interface IRhinoDocumentExecutor
{
    OperationResultV2 DocumentOperation(RpcOperation operation, JsonElement args);
    object? CurrentSettings { get; }
}

public interface IRhinoOperationExecutor
{
    OperationDocumentStatus DocumentStatus { get; }
    RhinoObjectQueryExecution QueryObjects(RhinoObjectQueryArguments arguments);
    RhinoScriptExecution RunScript(RhinoScriptArguments arguments);
    RhinoCaptureExecution CaptureView(RhinoCaptureArguments arguments);
    RhinoControlExecution ControlView(RhinoControlArguments arguments);
    RhinoTransactionExecution BeginTransaction(string? name);
    RhinoTransactionExecution CommitTransaction();
    RhinoTransactionExecution CancelTransaction();
    void CleanupOpenTransactions();
}

public sealed class RhinoOperationAdapter : IRhinoOperationAdapter, IAgentTransactionCleanup
{
    private readonly IRhinoOperationExecutor _executor;
    private readonly IHopperClock _clock;

    public RhinoOperationAdapter(IRhinoOperationExecutor executor, IHopperClock clock)
    {
        _executor = executor ?? throw new ArgumentNullException(nameof(executor));
        _clock = clock ?? throw new ArgumentNullException(nameof(clock));
    }

    public OperationDocumentStatus DocumentStatus => _executor.DocumentStatus;

    public bool CanExecute(RpcOperation operation) =>
        operation is RpcOperation.queryRhinoObjects
            or RpcOperation.runRhinoScript
            or RpcOperation.captureRhinoView
            or RpcOperation.controlRhinoView
            or RpcOperation.beginRhinoAgentTransaction
            or RpcOperation.commitRhinoAgentTransaction
            or RpcOperation.cancelRhinoAgentTransaction
            or RpcOperation.listRhinoDocuments
            or RpcOperation.getRhinoDocument
            or RpcOperation.getRhinoDocumentSettings
            or RpcOperation.manageRhinoDocument;

    public OperationResultV2 Execute(RpcRequestV2 request)
    {
        ArgumentNullException.ThrowIfNull(request);
        try
        {
            if (_executor is IRhinoDocumentExecutor documents && request.Operation is RpcOperation.listRhinoDocuments or RpcOperation.getRhinoDocument or RpcOperation.getRhinoDocumentSettings or RpcOperation.manageRhinoDocument)
                return documents.DocumentOperation(request.Operation, request.Args);
            DocumentSession.ValidateSegment("rhino", request.Args);
            return request.Operation switch
            {
                RpcOperation.queryRhinoObjects => QueryObjects(request.Args),
                RpcOperation.runRhinoScript => RunScript(request.Args),
                RpcOperation.captureRhinoView => CaptureView(request.Args),
                RpcOperation.controlRhinoView => ControlView(request.Args),
                RpcOperation.beginRhinoAgentTransaction => BeginTransaction(request.Args),
                RpcOperation.commitRhinoAgentTransaction => Transaction(_executor.CommitTransaction()),
                RpcOperation.cancelRhinoAgentTransaction => Transaction(_executor.CancelTransaction()),
                _ => Failure($"Rhino operation '{request.Operation}' is not supported by this adapter."),
            };
        }
        catch (Exception exception)
        {
            return Failure(exception is DocumentOperationException domain ? $"{domain.Code}: {domain.Message}" : $"Invalid {request.Operation} request: {exception.Message}");
        }
    }

    private OperationResultV2 QueryObjects(JsonElement args)
    {
        var arguments = args.Deserialize<RhinoObjectQueryArguments>(RpcV2Contract.JsonOptions)
            ?? throw new InvalidOperationException("Query arguments are required.");
        var execution = _executor.QueryObjects(arguments);
        var data = new
        {
            type = "queryRhinoObjects.response",
            timestamp = _clock.UtcNow.ToUnixTimeMilliseconds(),
            objects = execution.Objects,
            settings = (_executor as IRhinoDocumentExecutor)?.CurrentSettings,
        };
        return execution.Succeeded
            ? Completed(data)
            : Failure(execution.Error ?? "Rhino object query failed.", data);
    }

    private OperationResultV2 RunScript(JsonElement args)
    {
        var arguments = args.Deserialize<RhinoScriptArguments>(RpcV2Contract.JsonOptions)
            ?? throw new InvalidOperationException("Script arguments are required.");
        var settings = (_executor as IRhinoDocumentExecutor)?.CurrentSettings;
        var execution = _executor.RunScript(arguments);
        var data = new
        {
            type = "runRhinoScript.response",
            timestamp = _clock.UtcNow.ToUnixTimeMilliseconds(),
            ok = execution.Succeeded,
            output = execution.Output,
            error = execution.Error,
            settings,
            transaction = DocumentSession.Segment("rhino"),
        };
        return execution.Succeeded
            ? Completed(data)
            : Failure(execution.Error, data);
    }

    private OperationResultV2 CaptureView(JsonElement args)
    {
        var arguments = args.Deserialize<RhinoCaptureArguments>(RpcV2Contract.JsonOptions)
            ?? throw new InvalidOperationException("Capture arguments are required.");
        var execution = _executor.CaptureView(arguments);
        var data = new
        {
            type = "captureRhinoView.response",
            timestamp = _clock.UtcNow.ToUnixTimeMilliseconds(),
            ok = execution.Succeeded,
            imageBase64 = execution.ImageBase64,
            mediaType = execution.MediaType,
            error = execution.Error,
            metadata = execution.Metadata,
        };
        return execution.Succeeded
            ? Completed(data)
            : Failure(execution.Error ?? "Rhino view capture failed.", data);
    }

    private OperationResultV2 ControlView(JsonElement args)
    {
        var arguments = args.Deserialize<RhinoControlArguments>(RpcV2Contract.JsonOptions)
            ?? throw new InvalidOperationException("View control arguments are required.");
        var execution = _executor.ControlView(arguments);
        var data = new
        {
            type = "controlRhinoView.response",
            timestamp = _clock.UtcNow.ToUnixTimeMilliseconds(),
            ok = execution.Succeeded,
            error = execution.Error,
            message = execution.Message,
            metadata = execution.Metadata,
        };
        return execution.Succeeded
            ? Completed(data)
            : Failure(execution.Error ?? "Rhino view control failed.", data);
    }

    private OperationResultV2 BeginTransaction(JsonElement args)
    {
        var name = args.ValueKind == JsonValueKind.Object
            && args.TryGetProperty("name", out var nameProperty)
            && nameProperty.ValueKind == JsonValueKind.String
                ? nameProperty.GetString()
                : null;
        return Transaction(_executor.BeginTransaction(name));
    }

    private static OperationResultV2 Transaction(RhinoTransactionExecution execution)
    {
        var data = new { result = execution.Result, transaction = DocumentSession.Segment("rhino") };
        return execution.Succeeded
            ? Completed(data)
            : Failure(execution.Error ?? execution.Result, data);
    }

    public void CleanupOpenTransactions() => _executor.CleanupOpenTransactions();

    private static OperationResultV2 Completed<T>(T data) => new()
    {
        Class = RpcResultClass.completed,
        ReasonCode = RpcReasonCode.OK,
        Data = JsonSerializer.SerializeToElement(data, RpcV2Contract.JsonOptions),
    };

    private static OperationResultV2 Failure(string message) => new()
    {
        Class = RpcResultClass.failed,
        ReasonCode = RpcReasonCode.OPERATION_FAILED,
        Message = message,
    };

    private static OperationResultV2 Failure<T>(string message, T data) => new()
    {
        Class = RpcResultClass.failed,
        ReasonCode = RpcReasonCode.OPERATION_FAILED,
        Message = message,
        Data = JsonSerializer.SerializeToElement(data, RpcV2Contract.JsonOptions),
    };
}
