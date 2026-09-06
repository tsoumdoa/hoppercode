using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Hopper.Core.Protocol;

public enum RpcOperation
{
    listRhinoDocuments,
    getRhinoDocument,
    getRhinoDocumentSettings,
    listGrasshopperDocuments,
    getGrasshopperDocument,
    getGrasshopperDocumentSettings,
    browseDocumentFiles,
    getDocumentTransactionState,
    manageRhinoDocument,
    manageGrasshopperDocument,

    getRuntimeStatus,
    getOperationResult,
    listAllComponents,
    getCurrentCanvas,
    getCanvasErrors,
    listScriptParams,
    getScriptCode,
    queryRhinoObjects,
    captureRhinoView,
    getParamRhinoGeometry,
    lifecycleHandshake,
    startGrasshopper,
    cancelOperation,
    applyGraph,
    runRhinoScript,
    controlRhinoView,
    addComponent,
    deleteComponent,
    connectWire,
    disconnectWire,
    moveComponent,
    renameComponent,
    setComponentLocked,
    setComponentHidden,
    addGroup,
    removeFromGroup,
    deleteGroup,
    changeGroupColor,
    renameGroup,
    changeGroupStyle,
    createSlider,
    editSliderRange,
    setSliderValue,
    createPanel,
    setPanelParams,
    setPanelText,
    createToggle,
    setToggleValue,
    createSwatch,
    setSwatchColor,
    createScribble,
    setScribbleText,
    createValueList,
    setValueListSelected,
    createScriptNode,
    setScriptCode,
    syncScriptParams,
    addScriptInput,
    removeScriptInput,
    addScriptOutput,
    removeScriptOutput,
    editParamProps,
    beginAgentTransaction,
    commitAgentTransaction,
    cancelAgentTransaction,
    beginRhinoAgentTransaction,
    commitRhinoAgentTransaction,
    cancelRhinoAgentTransaction,
    setParamRhinoGeometry,
}

public enum RpcOperationClass
{
    Query,
    Control,
    Mutation,
}

public enum RpcResultClass
{
    completed,
    failed,
    busy,
    deadline_exceeded_before_start,
    cancelled_before_start,
    capability_unavailable,
    no_active_grasshopper_document,
    shutting_down,
}

public enum NodeLocalResultClass
{
    outcome_unknown,
}

public enum RpcReasonCode
{
    OK,
    AUTH_INVALID,
    PROTOCOL_VERSION_UNSUPPORTED,
    LIFECYCLE_INSTANCE_STALE,
    MALFORMED_REQUEST,
    UNKNOWN_OPERATION,
    OPERATION_ID_REQUIRED,
    OPERATION_ID_FORBIDDEN,
    START_DEADLINE_EXCEEDED,
    DISPATCHER_BUSY,
    RESULT_STORE_FULL,
    CANCELLED_BEFORE_START,
    CAPABILITY_UNAVAILABLE,
    GRASSHOPPER_NOT_INSTALLED,
    GRASSHOPPER_START_FAILED,
    NO_ACTIVE_GRASSHOPPER_DOCUMENT,
    SHUTTING_DOWN,
    OPERATION_FAILED,
    OPERATION_RESULT_TOO_LARGE,
    CANCELLATION_REJECTED_ALREADY_STARTED,
    HANDSHAKE_REJECTED,
    INTERNAL_ERROR,
}

public enum LifecycleState
{
    stopped,
    starting,
    running,
    stopping,
    faulted,
}

public enum GrasshopperState
{
    not_installed,
    not_loaded,
    loading,
    ready,
    failed,
}

public enum HandshakeState
{
    disconnected,
    connecting,
    live,
    failed,
}

public enum StartGrasshopperState
{
    start_requested,
    already_ready,
}

public enum OperationLookupState
{
    pending,
    not_found,
    terminal,
}

public enum OperationPhase
{
    queued,
    running,
}

public enum CancelOperationState
{
    cancelled_before_start,
    already_cancelled,
    rejected_already_started,
    not_found,
}

public sealed record RpcRequestV2
{
    public int ProtocolVersion { get; init; }
    public string LifecycleInstanceId { get; init; } = string.Empty;
    public string RequestId { get; init; } = string.Empty;
    public string Token { get; init; } = string.Empty;
    public RpcOperation Operation { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? OperationId { get; init; }
    public long StartDeadlineAt { get; init; }
    public JsonElement Args { get; init; }
}

public sealed record OperationResultV2
{
    public RpcResultClass Class { get; init; }
    public RpcReasonCode ReasonCode { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Message { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public JsonElement? Data { get; init; }
}

public abstract record RpcResponseV2
{
    public int ProtocolVersion { get; init; }
    public string RequestId { get; init; } = string.Empty;
}

public sealed record OperationResponseV2 : RpcResponseV2
{
    public string LifecycleInstanceId { get; init; } = string.Empty;
    public RpcOperation Operation { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? OperationId { get; init; }
    public OperationResultV2 Result { get; init; } = new();
}

public sealed record ProtocolErrorResponseV2 : RpcResponseV2
{
    public string ErrorType { get; init; } = "protocol_error";
    public string? LifecycleInstanceId { get; init; }
    public string? Operation { get; init; }
    public OperationResultV2 Result { get; init; } = new();
}

public sealed record LifecycleHandshakeArgsV2
{
    public int NodeProcessId { get; init; }
    public string NodeVersion { get; init; } = string.Empty;
    public string ClientIdentity { get; init; } = string.Empty;
}

public sealed record OperationReferenceArgsV2
{
    public string OperationId { get; init; } = string.Empty;
}

public sealed record LifecycleHandshakeDataV2
{
    public HandshakeState Handshake { get; init; }
    public long StatusRevision { get; init; }
}

public sealed record StartGrasshopperDataV2
{
    public StartGrasshopperState State { get; init; }
}

public sealed record OperationLookupDataV2
{
    public OperationLookupState State { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public OperationPhase? Phase { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public OperationResultV2? Result { get; init; }
}

public sealed record CancelOperationDataV2
{
    public CancelOperationState State { get; init; }
}

public sealed record RuntimeErrorV2
{
    public RpcReasonCode Code { get; init; }
    public string Message { get; init; } = string.Empty;
}

public sealed record LifecycleStatusV2
{
    public LifecycleState State { get; init; }
    public long ChangedAt { get; init; }
    public RuntimeErrorV2? Reason { get; init; }
}

public sealed record TransportStatusV2
{
    public bool Ready { get; init; }
    public string? LifecycleInstanceId { get; init; }
}

public sealed record HostStatusV2
{
    public LifecycleState State { get; init; }
    public int? ProcessId { get; init; }
    public string? NodePath { get; init; }
    public string? NodeVersion { get; init; }
    public HandshakeState Handshake { get; init; }
    public int HealthFailureCount { get; init; }
}

public sealed record DocumentStatusV2
{
    public bool ActiveDocument { get; init; }
    public string? DocumentName { get; init; }
}

public sealed record GrasshopperStatusV2
{
    public GrasshopperState State { get; init; }
    public bool ActiveDocument { get; init; }
    public string? DocumentName { get; init; }
}

public sealed record DispatcherStatusV2
{
    public bool AcceptingExternalWork { get; init; }
    public int Depth { get; init; }
    public int Capacity { get; init; }
}

public sealed record ComponentErrorsV2
{
    public RuntimeErrorV2? Transport { get; init; }
    public RuntimeErrorV2? Host { get; init; }
    public RuntimeErrorV2? Rhino { get; init; }
    public RuntimeErrorV2? Grasshopper { get; init; }
    public RuntimeErrorV2? Dispatcher { get; init; }
}

public sealed record RuntimeStatusV2
{
    public int ProtocolVersion { get; init; }
    public long Revision { get; init; }
    public long ObservedAt { get; init; }
    public LifecycleStatusV2 Lifecycle { get; init; } = new();
    public TransportStatusV2 Transport { get; init; } = new();
    public HostStatusV2 Host { get; init; } = new();
    public DocumentStatusV2 Rhino { get; init; } = new();
    public GrasshopperStatusV2 Grasshopper { get; init; } = new();
    public DispatcherStatusV2 Dispatcher { get; init; } = new();
    public ComponentErrorsV2 Errors { get; init; } = new();
}

public sealed record ContractParseResult<T>(T? Value, IReadOnlyList<string> Errors)
{
    public bool IsValid => Errors.Count == 0;
}

public static class RpcV2Operations
{
    public static readonly RpcOperation[] Query =
    {
        RpcOperation.listRhinoDocuments,
        RpcOperation.getRhinoDocument,
        RpcOperation.getRhinoDocumentSettings,
        RpcOperation.listGrasshopperDocuments,
        RpcOperation.getGrasshopperDocument,
        RpcOperation.getGrasshopperDocumentSettings,
        RpcOperation.browseDocumentFiles,
        RpcOperation.getDocumentTransactionState,

        RpcOperation.getRuntimeStatus,
        RpcOperation.getOperationResult,
        RpcOperation.listAllComponents,
        RpcOperation.getCurrentCanvas,
        RpcOperation.getCanvasErrors,
        RpcOperation.listScriptParams,
        RpcOperation.getScriptCode,
        RpcOperation.queryRhinoObjects,
        RpcOperation.captureRhinoView,
        RpcOperation.getParamRhinoGeometry,
    };

    public static readonly RpcOperation[] Control =
    {
        RpcOperation.lifecycleHandshake,
        RpcOperation.startGrasshopper,
        RpcOperation.cancelOperation,
    };

    public static readonly RpcOperation[] Mutation =
    {
        RpcOperation.manageRhinoDocument,
        RpcOperation.manageGrasshopperDocument,

        RpcOperation.applyGraph,
        RpcOperation.runRhinoScript,
        RpcOperation.controlRhinoView,
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
        RpcOperation.beginRhinoAgentTransaction,
        RpcOperation.commitRhinoAgentTransaction,
        RpcOperation.cancelRhinoAgentTransaction,
        RpcOperation.setParamRhinoGeometry,
    };

    private static readonly HashSet<RpcOperation> QuerySet = Query.ToHashSet();
    private static readonly HashSet<RpcOperation> ControlSet = Control.ToHashSet();

    public static RpcOperationClass Classify(RpcOperation operation)
    {
        if (QuerySet.Contains(operation)) return RpcOperationClass.Query;
        return ControlSet.Contains(operation) ? RpcOperationClass.Control : RpcOperationClass.Mutation;
    }
}

public static class RouterDealerFramingV2
{
    public const string Transport = "zeromq-router-dealer";
    public const string PayloadEncoding = "utf-8-json";
    public const bool DelimiterFrame = false;
    public static readonly string[] DealerSends = { "payload" };
    public static readonly string[] RouterReceives = { "routingIdentity", "payload" };
    public static readonly string[] RouterSends = { "routingIdentity", "payload" };
    public static readonly string[] DealerReceives = { "payload" };
    public const string RoutingIdentityEncoding = "opaque-bytes";
    public const string RoutingIdentityLifetime = "stable-for-node-process";
    public const bool RoutingIdentityIncludedInJson = false;
}

public static class RpcV2Contract
{
    public const int ProtocolVersion = 2;
    public const string UncorrelatedRequestPolicy = "drop";
    private const long MaxSafeInteger = 9_007_199_254_740_991;
    private static readonly Regex IdentifierPattern = new("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$", RegexOptions.CultureInvariant);
    private static readonly Regex TokenPattern = new("^[A-Za-z0-9_-]{32,128}$", RegexOptions.CultureInvariant);
    private static readonly Regex NodeVersionPattern = new("^v?[0-9]+\\.[0-9]+\\.[0-9]+$", RegexOptions.CultureInvariant);
    public static readonly IReadOnlySet<RpcReasonCode> ProtocolErrorReasonCodes = new HashSet<RpcReasonCode>
    {
        RpcReasonCode.AUTH_INVALID,
        RpcReasonCode.PROTOCOL_VERSION_UNSUPPORTED,
        RpcReasonCode.LIFECYCLE_INSTANCE_STALE,
        RpcReasonCode.MALFORMED_REQUEST,
        RpcReasonCode.UNKNOWN_OPERATION,
        RpcReasonCode.OPERATION_ID_REQUIRED,
        RpcReasonCode.OPERATION_ID_FORBIDDEN,
    };

    private static readonly IReadOnlyDictionary<RpcResultClass, HashSet<RpcReasonCode>> ReasonsByClass =
        new Dictionary<RpcResultClass, HashSet<RpcReasonCode>>
        {
            [RpcResultClass.completed] = new() { RpcReasonCode.OK },
            [RpcResultClass.failed] = new()
            {
                RpcReasonCode.AUTH_INVALID,
                RpcReasonCode.PROTOCOL_VERSION_UNSUPPORTED,
                RpcReasonCode.LIFECYCLE_INSTANCE_STALE,
                RpcReasonCode.MALFORMED_REQUEST,
                RpcReasonCode.UNKNOWN_OPERATION,
                RpcReasonCode.OPERATION_ID_REQUIRED,
                RpcReasonCode.OPERATION_ID_FORBIDDEN,
                RpcReasonCode.GRASSHOPPER_START_FAILED,
                RpcReasonCode.OPERATION_FAILED,
                RpcReasonCode.OPERATION_RESULT_TOO_LARGE,
                RpcReasonCode.CANCELLATION_REJECTED_ALREADY_STARTED,
                RpcReasonCode.HANDSHAKE_REJECTED,
                RpcReasonCode.INTERNAL_ERROR,
            },
            [RpcResultClass.busy] = new() { RpcReasonCode.DISPATCHER_BUSY, RpcReasonCode.RESULT_STORE_FULL },
            [RpcResultClass.deadline_exceeded_before_start] = new() { RpcReasonCode.START_DEADLINE_EXCEEDED },
            [RpcResultClass.cancelled_before_start] = new() { RpcReasonCode.CANCELLED_BEFORE_START },
            [RpcResultClass.capability_unavailable] = new()
            {
                RpcReasonCode.CAPABILITY_UNAVAILABLE,
                RpcReasonCode.GRASSHOPPER_NOT_INSTALLED,
            },
            [RpcResultClass.no_active_grasshopper_document] = new() { RpcReasonCode.NO_ACTIVE_GRASSHOPPER_DOCUMENT },
            [RpcResultClass.shutting_down] = new() { RpcReasonCode.SHUTTING_DOWN },
        };

    public static JsonSerializerOptions JsonOptions { get; } = CreateJsonOptions();

    public static bool IsReasonAllowed(RpcResultClass resultClass, RpcReasonCode reasonCode) =>
        ReasonsByClass[resultClass].Contains(reasonCode);

    public static ContractParseResult<RpcRequestV2> ParseRequest(string json)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            var errors = ValidateRequest(document.RootElement);
            if (errors.Count > 0) return new(null, errors);
            return new(JsonSerializer.Deserialize<RpcRequestV2>(json, JsonOptions), Array.Empty<string>());
        }
        catch (JsonException exception)
        {
            return new(null, new[] { exception.Message });
        }
    }

    public static ContractParseResult<RpcResponseV2> ParseResponse(string json)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            var protocolError = root.ValueKind == JsonValueKind.Object && root.TryGetProperty("errorType", out _);
            var errors = protocolError ? ValidateProtocolError(root) : ValidateOperationResponse(root);
            if (errors.Count > 0) return new(null, errors);
            RpcResponseV2? value = protocolError
                ? JsonSerializer.Deserialize<ProtocolErrorResponseV2>(json, JsonOptions)
                : JsonSerializer.Deserialize<OperationResponseV2>(json, JsonOptions);
            return new(value, Array.Empty<string>());
        }
        catch (JsonException exception)
        {
            return new(null, new[] { exception.Message });
        }
    }

    public static string SerializeRequest(RpcRequestV2 request)
    {
        var json = JsonSerializer.Serialize(request, JsonOptions);
        var parsed = ParseRequest(json);
        if (!parsed.IsValid) throw new InvalidOperationException(string.Join("; ", parsed.Errors));
        return json;
    }

    public static string SerializeResponse(RpcResponseV2 response)
    {
        var json = JsonSerializer.Serialize(response, response.GetType(), JsonOptions);
        var parsed = ParseResponse(json);
        if (!parsed.IsValid) throw new InvalidOperationException(string.Join("; ", parsed.Errors));
        return json;
    }

    private static JsonSerializerOptions CreateJsonOptions()
    {
        var options = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            PropertyNameCaseInsensitive = false,
            DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        };
        options.Converters.Add(new JsonStringEnumConverter(namingPolicy: null, allowIntegerValues: false));
        return options;
    }

    private static List<string> ValidateRequest(JsonElement root)
    {
        var errors = new List<string>();
        if (!RequireObject(root, "request", errors)) return errors;
        if (!TryReadOperation(root, out var operation)) errors.Add("operation is unknown");
        var operationClass = operation is null ? (RpcOperationClass?)null : RpcV2Operations.Classify(operation.Value);
        var allowed = new HashSet<string>
        {
            "protocolVersion", "lifecycleInstanceId", "requestId", "token", "operation", "startDeadlineAt", "args",
        };
        if (operationClass == RpcOperationClass.Mutation) allowed.Add("operationId");
        RequireExactProperties(root, allowed, "request", errors);
        RequireProtocolVersion(root, errors);
        RequireIdentifier(root, "lifecycleInstanceId", errors);
        RequireIdentifier(root, "requestId", errors);
        RequirePattern(root, "token", TokenPattern, errors);
        RequireSafeInteger(root, "startDeadlineAt", 0, errors);
        if (!root.TryGetProperty("args", out var args) || args.ValueKind != JsonValueKind.Object)
        {
            errors.Add("args must be an object");
        }
        else if (operation is not null)
        {
            ValidateOperationArgs(operation.Value, args, errors);
        }
        if (operationClass == RpcOperationClass.Mutation) RequireIdentifier(root, "operationId", errors);
        return errors;
    }

    private static List<string> ValidateOperationResponse(JsonElement root)
    {
        var errors = new List<string>();
        if (!RequireObject(root, "response", errors)) return errors;
        if (!TryReadOperation(root, out var operation)) errors.Add("operation is unknown");
        var operationClass = operation is null ? (RpcOperationClass?)null : RpcV2Operations.Classify(operation.Value);
        var allowed = new HashSet<string> { "protocolVersion", "lifecycleInstanceId", "requestId", "operation", "result" };
        if (operationClass == RpcOperationClass.Mutation) allowed.Add("operationId");
        RequireExactProperties(root, allowed, "response", errors);
        RequireProtocolVersion(root, errors);
        RequireIdentifier(root, "lifecycleInstanceId", errors);
        RequireIdentifier(root, "requestId", errors);
        if (operationClass == RpcOperationClass.Mutation) RequireIdentifier(root, "operationId", errors);
        if (!root.TryGetProperty("result", out var result) || !ValidateResult(result, errors)) return errors;
        if (operation is not null && result.GetProperty("class").GetString() == nameof(RpcResultClass.completed))
        {
            ValidateCompletedData(operation.Value, result, errors);
        }
        return errors;
    }

    private static List<string> ValidateProtocolError(JsonElement root)
    {
        var errors = new List<string>();
        if (!RequireObject(root, "protocol error", errors)) return errors;
        RequireExactProperties(root, new HashSet<string>
        {
            "protocolVersion", "requestId", "errorType", "lifecycleInstanceId", "operation", "result",
        }, "protocol error", errors);
        RequireProtocolVersion(root, errors);
        RequireIdentifier(root, "requestId", errors);
        if (!root.TryGetProperty("errorType", out var errorType) || errorType.ValueKind != JsonValueKind.String || errorType.GetString() != "protocol_error")
            errors.Add("errorType must be protocol_error");
        if (!root.TryGetProperty("lifecycleInstanceId", out var lifecycle)
            || lifecycle.ValueKind != JsonValueKind.Null && !IsIdentifier(lifecycle))
            errors.Add("lifecycleInstanceId must be null or valid");
        if (!root.TryGetProperty("operation", out var operation)
            || operation.ValueKind != JsonValueKind.Null
            && (operation.ValueKind != JsonValueKind.String || operation.GetString() is not { Length: > 0 and <= 128 }))
            errors.Add("operation must be null or a non-empty string up to 128 characters");
        if (!root.TryGetProperty("result", out var result) || result.ValueKind != JsonValueKind.Object)
        {
            errors.Add("result must be an object");
            return errors;
        }
        RequireExactProperties(result, new HashSet<string> { "class", "reasonCode", "message" }, "protocol error result", errors);
        if (!TryReadEnum(result, "class", out RpcResultClass resultClass) || resultClass != RpcResultClass.failed)
            errors.Add("protocol error result class must be failed");
        if (!TryReadEnum(result, "reasonCode", out RpcReasonCode reason) || !ProtocolErrorReasonCodes.Contains(reason))
            errors.Add("protocol error reasonCode is invalid");
        RequireNonEmptyString(result, "message", errors);
        return errors;
    }

    private static void ValidateOperationArgs(RpcOperation operation, JsonElement args, List<string> errors)
    {
        switch (operation)
        {
            case RpcOperation.lifecycleHandshake:
                RequireExactProperties(args, new HashSet<string> { "nodeProcessId", "nodeVersion", "clientIdentity" }, "handshake args", errors);
                RequireSafeInteger(args, "nodeProcessId", 1, errors, int.MaxValue);
                RequirePattern(args, "nodeVersion", NodeVersionPattern, errors);
                RequireIdentifier(args, "clientIdentity", errors);
                break;
            case RpcOperation.getRuntimeStatus:
            case RpcOperation.startGrasshopper:
                RequireExactProperties(args, new HashSet<string>(), "empty args", errors);
                break;
            case RpcOperation.getOperationResult:
            case RpcOperation.cancelOperation:
                RequireExactProperties(args, new HashSet<string> { "operationId" }, "operation reference args", errors);
                RequireIdentifier(args, "operationId", errors);
                break;
        }
    }

    private static bool ValidateResult(JsonElement result, List<string> errors)
    {
        if (!RequireObject(result, "result", errors)) return false;
        RequireAllowedAndRequiredProperties(
            result,
            new HashSet<string> { "class", "reasonCode", "message", "data" },
            new HashSet<string> { "class", "reasonCode" },
            "result",
            errors);
        if (!TryReadEnum(result, "class", out RpcResultClass resultClass))
        {
            errors.Add("result class is invalid");
            return false;
        }
        if (!TryReadEnum(result, "reasonCode", out RpcReasonCode reason) || !ReasonsByClass[resultClass].Contains(reason))
            errors.Add("result class and reasonCode do not agree");
        if (result.TryGetProperty("message", out var message) && message.ValueKind != JsonValueKind.String)
            errors.Add("result message must be a string");
        return true;
    }

    private static void ValidateCompletedData(RpcOperation operation, JsonElement result, List<string> errors)
    {
        if (operation is not (RpcOperation.lifecycleHandshake or RpcOperation.getRuntimeStatus or RpcOperation.startGrasshopper
            or RpcOperation.getOperationResult or RpcOperation.cancelOperation)) return;
        if (!result.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Object)
        {
            errors.Add("completed internal operation data must be an object");
            return;
        }
        switch (operation)
        {
            case RpcOperation.lifecycleHandshake:
                RequireExactProperties(data, new HashSet<string> { "handshake", "statusRevision" }, "handshake data", errors);
                if (!data.TryGetProperty("handshake", out var handshake) || handshake.GetString() != "live") errors.Add("handshake must be live");
                RequireSafeInteger(data, "statusRevision", 0, errors);
                break;
            case RpcOperation.getRuntimeStatus:
                ValidateRuntimeStatus(data, errors);
                break;
            case RpcOperation.startGrasshopper:
                RequireExactProperties(data, new HashSet<string> { "state" }, "startGrasshopper data", errors);
                if (!TryReadEnum(data, "state", out StartGrasshopperState _)) errors.Add("startGrasshopper state is invalid");
                break;
            case RpcOperation.getOperationResult:
                ValidateOperationLookup(data, errors);
                break;
            case RpcOperation.cancelOperation:
                RequireExactProperties(data, new HashSet<string> { "state" }, "cancelOperation data", errors);
                if (!TryReadEnum(data, "state", out CancelOperationState _)) errors.Add("cancelOperation state is invalid");
                break;
        }
    }

    private static void ValidateOperationLookup(JsonElement data, List<string> errors)
    {
        if (!TryReadEnum(data, "state", out OperationLookupState state))
        {
            errors.Add("operation lookup state is invalid");
            return;
        }
        switch (state)
        {
            case OperationLookupState.pending:
                RequireExactProperties(data, new HashSet<string> { "state", "phase" }, "pending operation lookup", errors);
                if (!TryReadEnum(data, "phase", out OperationPhase _)) errors.Add("operation lookup phase is invalid");
                break;
            case OperationLookupState.not_found:
                RequireExactProperties(data, new HashSet<string> { "state" }, "not-found operation lookup", errors);
                break;
            case OperationLookupState.terminal:
                RequireExactProperties(data, new HashSet<string> { "state", "result" }, "terminal operation lookup", errors);
                if (!data.TryGetProperty("result", out var result)) errors.Add("terminal lookup result is required");
                else ValidateResult(result, errors);
                break;
        }
    }

    private static void ValidateRuntimeStatus(JsonElement status, List<string> errors)
    {
        RequireExactProperties(status, new HashSet<string>
        {
            "protocolVersion", "revision", "observedAt", "lifecycle", "transport", "host",
            "rhino", "grasshopper", "dispatcher", "errors",
        }, "runtime status", errors);
        RequireProtocolVersion(status, errors);
        RequireSafeInteger(status, "revision", 0, errors);
        RequireSafeInteger(status, "observedAt", 0, errors);
        if (RequireObjectProperty(status, "lifecycle", out var lifecycle, errors))
        {
            RequireExactProperties(lifecycle, new HashSet<string> { "state", "changedAt", "reason" }, "lifecycle status", errors);
            if (!TryReadEnum(lifecycle, "state", out LifecycleState _)) errors.Add("lifecycle state is invalid");
            RequireSafeInteger(lifecycle, "changedAt", 0, errors);
            ValidateNullableRuntimeError(lifecycle, "reason", errors);
        }
        if (RequireObjectProperty(status, "transport", out var transport, errors))
        {
            RequireExactProperties(transport, new HashSet<string> { "ready", "lifecycleInstanceId" }, "transport status", errors);
            RequireBoolean(transport, "ready", errors);
            if (!transport.TryGetProperty("lifecycleInstanceId", out var instance)
                || instance.ValueKind != JsonValueKind.Null && !IsIdentifier(instance)) errors.Add("transport lifecycleInstanceId is invalid");
        }
        if (RequireObjectProperty(status, "host", out var host, errors))
        {
            RequireExactProperties(host, new HashSet<string>
            {
                "state", "processId", "nodePath", "nodeVersion", "handshake", "healthFailureCount",
            }, "host status", errors);
            if (!TryReadEnum(host, "state", out LifecycleState _)) errors.Add("host state is invalid");
            RequireNullableInteger(host, "processId", 1, errors);
            RequireNullableString(host, "nodePath", errors);
            RequireNullableString(host, "nodeVersion", errors);
            if (!TryReadEnum(host, "handshake", out HandshakeState _)) errors.Add("host handshake is invalid");
            RequireSafeInteger(host, "healthFailureCount", 0, errors, int.MaxValue);
        }
        if (RequireObjectProperty(status, "rhino", out var rhino, errors))
        {
            ValidateDocumentStatus(rhino, "rhino", errors);
        }
        if (RequireObjectProperty(status, "grasshopper", out var grasshopper, errors))
        {
            RequireExactProperties(grasshopper, new HashSet<string> { "state", "activeDocument", "documentName" }, "grasshopper status", errors);
            if (!TryReadEnum(grasshopper, "state", out GrasshopperState _)) errors.Add("grasshopper state is invalid");
            RequireBoolean(grasshopper, "activeDocument", errors);
            RequireNullableString(grasshopper, "documentName", errors);
        }
        if (RequireObjectProperty(status, "dispatcher", out var dispatcher, errors))
        {
            RequireExactProperties(dispatcher, new HashSet<string> { "acceptingExternalWork", "depth", "capacity" }, "dispatcher status", errors);
            RequireBoolean(dispatcher, "acceptingExternalWork", errors);
            var depth = ReadSafeInteger(dispatcher, "depth", 0, errors, int.MaxValue);
            var capacity = ReadSafeInteger(dispatcher, "capacity", 1, errors, int.MaxValue);
            if (depth is not null && capacity is not null && depth > capacity) errors.Add("dispatcher depth exceeds capacity");
        }
        if (RequireObjectProperty(status, "errors", out var componentErrors, errors))
        {
            RequireExactProperties(componentErrors, new HashSet<string> { "transport", "host", "rhino", "grasshopper", "dispatcher" }, "component errors", errors);
            foreach (var name in new[] { "transport", "host", "rhino", "grasshopper", "dispatcher" })
                ValidateNullableRuntimeError(componentErrors, name, errors);
        }
    }

    private static void ValidateDocumentStatus(JsonElement value, string label, List<string> errors)
    {
        RequireExactProperties(value, new HashSet<string> { "activeDocument", "documentName" }, $"{label} status", errors);
        RequireBoolean(value, "activeDocument", errors);
        RequireNullableString(value, "documentName", errors);
    }

    private static void ValidateNullableRuntimeError(JsonElement parent, string propertyName, List<string> errors)
    {
        if (!parent.TryGetProperty(propertyName, out var value))
        {
            errors.Add($"{propertyName} is required");
            return;
        }
        if (value.ValueKind == JsonValueKind.Null) return;
        if (!RequireObject(value, propertyName, errors)) return;
        RequireExactProperties(value, new HashSet<string> { "code", "message" }, propertyName, errors);
        if (!TryReadEnum(value, "code", out RpcReasonCode _)) errors.Add($"{propertyName} code is invalid");
        RequireNonEmptyString(value, "message", errors);
    }

    private static bool RequireObjectProperty(JsonElement parent, string name, out JsonElement value, List<string> errors)
    {
        if (!parent.TryGetProperty(name, out value) || value.ValueKind != JsonValueKind.Object)
        {
            errors.Add($"{name} must be an object");
            return false;
        }
        return true;
    }

    private static bool RequireObject(JsonElement value, string label, List<string> errors)
    {
        if (value.ValueKind == JsonValueKind.Object) return true;
        errors.Add($"{label} must be an object");
        return false;
    }

    private static void RequireExactProperties(JsonElement value, HashSet<string> expected, string label, List<string> errors)
    {
        var actual = value.EnumerateObject().Select(property => property.Name).ToHashSet(StringComparer.Ordinal);
        if (!actual.SetEquals(expected)) errors.Add($"{label} fields are not exact");
    }

    private static void RequireAllowedAndRequiredProperties(
        JsonElement value,
        HashSet<string> allowed,
        HashSet<string> required,
        string label,
        List<string> errors)
    {
        var actual = value.EnumerateObject().Select(property => property.Name).ToHashSet(StringComparer.Ordinal);
        if (!actual.IsSubsetOf(allowed) || !required.IsSubsetOf(actual)) errors.Add($"{label} fields are invalid");
    }

    private static void RequireProtocolVersion(JsonElement value, List<string> errors)
    {
        if (!value.TryGetProperty("protocolVersion", out var version)
            || version.ValueKind != JsonValueKind.Number
            || !version.TryGetInt32(out var number) || number != ProtocolVersion)
            errors.Add("protocolVersion must be 2");
    }

    private static bool TryReadOperation(JsonElement root, out RpcOperation? operation)
    {
        operation = null;
        if (!root.TryGetProperty("operation", out var value) || value.ValueKind != JsonValueKind.String) return false;
        if (!Enum.TryParse<RpcOperation>(value.GetString(), ignoreCase: false, out var parsed)
            || !Enum.IsDefined(typeof(RpcOperation), parsed)) return false;
        operation = parsed;
        return true;
    }

    private static bool TryReadEnum<T>(JsonElement root, string name, out T value) where T : struct, Enum
    {
        value = default;
        return root.TryGetProperty(name, out var element)
            && element.ValueKind == JsonValueKind.String
            && Enum.TryParse(element.GetString(), ignoreCase: false, out value)
            && Enum.IsDefined(typeof(T), value);
    }

    private static void RequireIdentifier(JsonElement root, string name, List<string> errors)
    {
        if (!root.TryGetProperty(name, out var value) || !IsIdentifier(value)) errors.Add($"{name} is invalid");
    }

    private static bool IsIdentifier(JsonElement value)
    {
        return value.ValueKind == JsonValueKind.String && IdentifierPattern.IsMatch(value.GetString()!);
    }

    private static void RequirePattern(JsonElement root, string name, Regex pattern, List<string> errors)
    {
        if (!root.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.String || !pattern.IsMatch(value.GetString()!))
            errors.Add($"{name} is invalid");
    }

    private static void RequireNonEmptyString(JsonElement root, string name, List<string> errors)
    {
        if (!root.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.String || value.GetString()!.Length == 0)
            errors.Add($"{name} must be a non-empty string");
    }

    private static void RequireNullableString(JsonElement root, string name, List<string> errors)
    {
        if (!root.TryGetProperty(name, out var value)
            || value.ValueKind is not (JsonValueKind.String or JsonValueKind.Null)) errors.Add($"{name} must be a string or null");
    }

    private static void RequireBoolean(JsonElement root, string name, List<string> errors)
    {
        if (!root.TryGetProperty(name, out var value)
            || value.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) errors.Add($"{name} must be boolean");
    }

    private static void RequireNullableInteger(JsonElement root, string name, long minimum, List<string> errors)
    {
        if (!root.TryGetProperty(name, out var value))
        {
            errors.Add($"{name} is required");
            return;
        }
        if (value.ValueKind == JsonValueKind.Null) return;
        if (value.ValueKind != JsonValueKind.Number
            || !value.TryGetInt64(out var number)
            || number < minimum
            || number > int.MaxValue)
            errors.Add($"{name} is invalid");
    }

    private static void RequireSafeInteger(
        JsonElement root,
        string name,
        long minimum,
        List<string> errors,
        long maximum = MaxSafeInteger)
    {
        _ = ReadSafeInteger(root, name, minimum, errors, maximum);
    }

    private static long? ReadSafeInteger(
        JsonElement root,
        string name,
        long minimum,
        List<string> errors,
        long maximum = MaxSafeInteger)
    {
        if (!root.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.Number
            || !value.TryGetInt64(out var number)
            || number < minimum || number > maximum)
        {
            errors.Add($"{name} is invalid");
            return null;
        }
        return number;
    }
}
